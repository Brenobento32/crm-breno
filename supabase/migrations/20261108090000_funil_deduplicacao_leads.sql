-- ===========================================================================
-- Funil: deduplicação de leads de integrações (Google Sheets / WhatsApp) e
-- data real do envio.
--
-- 1. ID do lead da Meta (leadgen_id) também identifica o lead: o mesmo lead
--    chegando por outra aba/planilha (ou já recebido pelos Lead Ads) não cria
--    outra negociação nem duplica as respostas.
-- 2. Telefone e e-mail apontando para clientes DIFERENTES: nunca une. Fica
--    com o cliente do telefone (sempre o mesmo critério, aqui e no núcleo),
--    não altera nenhum dos dois e marca `contato_divergente` para revisão.
-- 3. Travas por telefone e por e-mail separadas (antes era o par
--    telefone|e-mail: envios simultâneos do mesmo contato, um com e-mail e
--    outro sem, podiam criar o cliente duas vezes).
-- 4. Planilha: ID da Meta só no formato do lead (dígitos ou "l:" + dígitos);
--    "ag:", "as:", "c:", "f:" (anúncio, conjunto, campanha, formulário) são
--    recusados. Data do envio (`data_envio`, ISO, lida da planilha) vai para
--    `atribuicao.data_formulario`, a data que o funil usa para ordenar e filtrar.
--
-- Não altera nenhum lead já existente (sem backfill). Sem mudança de RLS.
-- ===========================================================================

create index if not exists negociacoes_meta_lead_id
  on public.negociacoes (tenant_id, (atribuicao ->> 'meta_lead_id'))
  where atribuicao ? 'meta_lead_id';

-- ---------------------------------------------------------------------------
-- Núcleo: mesmo corpo de 20261104090000, mudam só as travas e a escolha do
-- cliente quando telefone e e-mail apontam para clientes diferentes.
-- ---------------------------------------------------------------------------
create or replace function public.ingerir_lead_nucleo(
  p_tenant uuid, p_origem public.origem_negociacao, p_external_id text,
  p_funil uuid, p_etapa uuid, p_responsavel uuid, p_nicho uuid, p_formulario uuid,
  p_nome text, p_telefone text, p_email text, p_empresa text, p_instagram text,
  p_respostas jsonb, p_atribuicao jsonb)
returns table (cliente_id uuid, negociacao_id uuid, criado boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nome          text := public.normalizar_texto(p_nome, 200);
  v_tel           text := public.normalizar_telefone(p_telefone);
  v_email         text := public.normalizar_email(p_email);
  v_empresa       text := public.normalizar_texto(p_empresa, 200);
  v_insta         text := public.normalizar_texto(p_instagram, 200);
  v_ext           text := public.normalizar_texto(p_external_id, 300);
  v_cliente_id    uuid;
  v_negociacao_id uuid;
  v_criado        boolean := false;
  v_item          jsonb;
  v_pergunta_id   uuid;
  v_resposta      text;
  v_soltas        jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from public.tenants t
                  where t.id = p_tenant and t.tipo <> 'arquivo' and t.status in ('ativo', 'teste')) then
    raise exception 'Empresa indisponível para receber leads.' using errcode = '42501';
  end if;
  if v_ext is null then
    raise exception 'external_id é obrigatório.' using errcode = '22023';
  end if;
  if v_nome is null then
    v_nome := coalesce(v_tel, v_email);
  end if;
  if v_tel is null and v_email is null then
    raise exception 'Informe ao menos telefone ou e-mail válidos.' using errcode = '22023';
  end if;
  if p_atribuicao is not null and jsonb_typeof(p_atribuicao) <> 'object' then
    raise exception 'atribuicao precisa ser um objeto JSON.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.etapas_funil e
                  where e.id = p_etapa and e.funil_id = p_funil and e.tenant_id = p_tenant and e.ativo and e.tipo = 'aberta') then
    raise exception 'Etapa de entrada inválida.' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':lead:' || p_origem || ':' || v_ext, 0));

  select n.cliente_id, n.id into v_cliente_id, v_negociacao_id
    from public.negociacoes n
   where n.tenant_id = p_tenant and n.origem = p_origem and n.external_id = v_ext
     for update;

  if v_negociacao_id is not null then
    update public.clientes
       set nome = coalesce(v_nome, nome), empresa = coalesce(v_empresa, empresa), telefone = coalesce(v_tel, telefone),
           email = coalesce(v_email, email), instagram = coalesce(v_insta, instagram)
     where id = v_cliente_id and tenant_id = p_tenant and deleted_at is null;
    update public.negociacoes
       set atribuicao = coalesce(p_atribuicao, atribuicao)
     where id = v_negociacao_id and tenant_id = p_tenant;
  else
    -- Uma trava por telefone e outra por e-mail (sempre nessa ordem): dois envios do mesmo
    -- contato, um com e-mail e outro sem, esperam um pelo outro.
    if v_tel is not null then
      perform pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':contato_tel:' || v_tel, 0));
    end if;
    if v_email is not null then
      perform pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':contato_email:' || v_email, 0));
    end if;

    -- Telefone primeiro; e-mail só se o telefone não achou ninguém. Nunca une dois clientes.
    select c.id into v_cliente_id
      from public.clientes c
     where c.tenant_id = p_tenant
       and c.deleted_at is null
       and ((v_tel is not null and (c.telefone = v_tel or c.whatsapp = v_tel))
            or (v_email is not null and lower(c.email) = v_email))
     -- coalesce: em "desc" o NULL viria primeiro e o cliente sem telefone passaria na frente.
     order by coalesce(v_tel is not null and (c.telefone = v_tel or c.whatsapp = v_tel), false) desc, c.created_at
     limit 1
     for update;

    if v_cliente_id is null then
      insert into public.clientes (tenant_id, tipo_cliente, nome, empresa, telefone, whatsapp, email, instagram, owner_id)
      values (p_tenant, 'pessoa_fisica', v_nome, v_empresa, v_tel,
              case when p_origem = 'whatsapp' then v_tel end, v_email, v_insta, p_responsavel)
      returning id into v_cliente_id;
    end if;

    insert into public.negociacoes (tenant_id, cliente_id, owner_id, etapa_id, origem, nicho_id, formulario_id, external_id, atribuicao)
    values (p_tenant, v_cliente_id, null, p_etapa, p_origem, p_nicho, p_formulario, v_ext, p_atribuicao)
    returning id into v_negociacao_id;
    v_criado := true;
  end if;

  for v_item in select * from jsonb_array_elements(case when jsonb_typeof(p_respostas) = 'array' then p_respostas else '[]'::jsonb end) loop
    v_pergunta_id := null;
    v_resposta := left(v_item ->> 'resposta', 5000);
    continue when v_resposta is null or btrim(v_resposta) = '';
    if p_formulario is not null then
      select p.id into v_pergunta_id
        from public.perguntas p
       where p.formulario_id = p_formulario and p.tenant_id = p_tenant and p.ativo
         and btrim(p.texto) = btrim(v_item ->> 'pergunta_externa');
    end if;
    if v_pergunta_id is null then
      v_soltas := v_soltas || jsonb_build_array(jsonb_build_object('pergunta', v_item ->> 'pergunta_externa', 'resposta', v_resposta));
      continue;
    end if;

    insert into public.respostas_lead (negociacao_id, pergunta_id, resposta_texto, resposta_opcao)
    select v_negociacao_id, v_pergunta_id,
           case when p.tipo = 'texto_livre' then v_resposta end,
           case when p.tipo <> 'texto_livre' then v_resposta end
      from public.perguntas p
     where p.id = v_pergunta_id
    on conflict (negociacao_id, pergunta_id) do update
      set resposta_texto = excluded.resposta_texto, resposta_opcao = excluded.resposta_opcao;
  end loop;
  perform public.registrar_respostas_lead(p_tenant, v_negociacao_id, null, v_ext, v_soltas);

  return query select v_cliente_id, v_negociacao_id, v_criado;
end;
$$;
revoke all on function public.ingerir_lead_nucleo(uuid, public.origem_negociacao, text, uuid, uuid, uuid, uuid, uuid,
  text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Destino único (Google Sheets e WhatsApp). Resultado:
--   importada | nova_oportunidade | contato_existente | reenvio (mesmo evento)
--   | mesmo_lead_meta (mesmo leadgen_id já recebido por outra fonte da empresa).
-- ---------------------------------------------------------------------------
create or replace function public.ingerir_lead_integracao(
  p_fonte uuid, p_external_id text, p_nome text, p_telefone text, p_email text, p_empresa text, p_atribuicao jsonb)
returns table (resultado text, cliente_id uuid, negociacao_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_f      public.fontes_leads;
  v_tel    text := public.normalizar_telefone(p_telefone);
  v_email  text := public.normalizar_email(p_email);
  v_lead   text := nullif(btrim(coalesce(p_atribuicao ->> 'meta_lead_id', '')), '');
  v_cli    uuid;
  v_cli_t  uuid;
  v_cli_e  uuid;
  v_diverg boolean := false;
  v_neg    uuid;
  v_origem public.origem_negociacao;
  v_r      record;
  v_neg_re uuid;
  v_cli_re uuid;
  v_ext    text;
  v_atrib  jsonb;
begin
  select * into v_f from public.fontes_leads f where f.id = p_fonte;
  if v_f.id is null or v_f.status <> 'ativa' or v_f.tipo not in ('google_sheets', 'whatsapp_cloud') then
    raise exception 'Integração inativa ou inexistente.' using errcode = '42501';
  end if;
  if v_lead is not null and v_lead !~ '^[0-9]{15,17}$' then v_lead := null; end if;
  v_origem := case when v_f.tipo = 'whatsapp_cloud' then 'whatsapp' else 'formulario' end;
  v_ext := v_f.id::text || ':' || p_external_id;
  v_atrib := coalesce(p_atribuicao, '{}'::jsonb) - 'meta_lead_id'
             || jsonb_strip_nulls(jsonb_build_object('fonte', v_f.tipo, 'fonte_id', v_f.id, 'meta_lead_id', v_lead));

  -- Travas, sempre na mesma ordem: lead da Meta, telefone, e-mail. Envios simultâneos do
  -- mesmo lead (duas abas, sincronização repetida, planilha + WhatsApp) passam um por vez.
  if v_lead is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_f.tenant_id::text || ':meta_lead:' || v_lead, 0));
  end if;
  if v_tel is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_f.tenant_id::text || ':contato_tel:' || v_tel, 0));
    select c.id into v_cli_t from public.clientes c
     where c.tenant_id = v_f.tenant_id and c.deleted_at is null and (c.telefone = v_tel or c.whatsapp = v_tel)
     order by c.created_at limit 1;
  end if;
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_f.tenant_id::text || ':contato_email:' || v_email, 0));
    select c.id into v_cli_e from public.clientes c
     where c.tenant_id = v_f.tenant_id and c.deleted_at is null and lower(c.email) = v_email
     order by c.created_at limit 1;
  end if;
  -- Telefone e e-mail de clientes diferentes: fica com o do telefone, sem unir nem alterar nenhum.
  v_cli := coalesce(v_cli_t, v_cli_e);
  v_diverg := v_cli_t is not null and v_cli_e is not null and v_cli_t <> v_cli_e;
  if v_diverg then
    v_atrib := v_atrib || jsonb_build_object('contato_divergente', true);
  end if;

  -- Mesmo evento de novo (linha já importada, mensagem reenviada pela Meta): devolve o mesmo.
  select n.id, n.cliente_id into v_neg_re, v_cli_re
    from public.negociacoes n
   where n.tenant_id = v_f.tenant_id and n.origem = v_origem and n.external_id = v_ext;
  if v_neg_re is not null then
    return query select 'reenvio'::text, v_cli_re, v_neg_re;
    return;
  end if;

  -- Mesmo lead da Meta já recebido nesta empresa (outra aba, outra planilha ou Lead Ads).
  if v_lead is not null then
    select n.id, n.cliente_id into v_neg_re, v_cli_re
      from public.negociacoes n
     where n.tenant_id = v_f.tenant_id
       and (n.atribuicao ->> 'meta_lead_id' = v_lead
            or n.atribuicao ->> 'leadgen_id' = v_lead
            or n.atribuicao -> 'origens_adicionais' @> jsonb_build_array(jsonb_build_object('meta_lead_id', v_lead)))
     order by n.created_at
     limit 1;
    if v_neg_re is not null then
      insert into public.ingestao_eventos (tenant_id, fonte_id, external_id, resultado, negociacao_id)
      values (v_f.tenant_id, v_f.id, left(p_external_id, 300), 'atualizado', v_neg_re);
      return query select 'mesmo_lead_meta'::text, v_cli_re, v_neg_re;
      return;
    end if;
  end if;

  -- Cliente da empresa com negociação ABERTA no funil de destino: reaproveita (etapa e responsável intactos).
  if v_cli is not null then
    select n.id into v_neg
      from public.negociacoes n join public.etapas_funil e on e.id = n.etapa_id
     where n.tenant_id = v_f.tenant_id and n.cliente_id = v_cli and e.funil_id = v_f.funil_id and e.tipo = 'aberta'
       and n.excluida_em is null and n.arquivada_em is null
     order by n.created_at desc limit 1;
    if v_neg is not null then
      update public.negociacoes
         set atribuicao = jsonb_set(coalesce(atribuicao, '{}'::jsonb), '{origens_adicionais}',
               coalesce(atribuicao -> 'origens_adicionais', '[]'::jsonb)
               || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                    'fonte_id', v_f.id, 'fonte', v_f.tipo, 'em', now(),
                    'enviado_em', p_atribuicao ->> 'data_formulario', 'aba', p_atribuicao ->> 'aba',
                    'meta_lead_id', v_lead, 'ctwa_clid', p_atribuicao ->> 'ctwa_clid',
                    'anuncio_id', p_atribuicao ->> 'anuncio_id',
                    'contato_divergente', case when v_diverg then true end))))
       where id = v_neg;
      insert into public.ingestao_eventos (tenant_id, fonte_id, external_id, resultado, negociacao_id)
      values (v_f.tenant_id, v_f.id, left(p_external_id, 300), 'atualizado', v_neg);
      update public.fontes_leads set ultimo_lead_em = now() where id = v_f.id;
      return query select 'contato_existente'::text, v_cli, v_neg;
      return;
    end if;
  end if;

  -- Sem negociação aberta nesse funil: oportunidade nova (cliente reaproveitado, se existir).
  select * into v_r from public.ingerir_lead_nucleo(
    v_f.tenant_id, v_origem, v_ext,
    v_f.funil_id, v_f.etapa_id, v_f.responsavel_id, v_f.nicho_id, v_f.formulario_id,
    p_nome, p_telefone, p_email, p_empresa, null, null, v_atrib);
  insert into public.ingestao_eventos (tenant_id, fonte_id, external_id, resultado, negociacao_id)
  values (v_f.tenant_id, v_f.id, left(p_external_id, 300), case when v_r.criado then 'criado' else 'atualizado' end, v_r.negociacao_id);
  update public.fontes_leads set ultimo_lead_em = now() where id = v_f.id;
  return query select case when not v_r.criado then 'contato_existente' when v_cli is not null then 'nova_oportunidade' else 'importada' end,
                      v_r.cliente_id, v_r.negociacao_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Planilhas: mesmo corpo de 20261104090000 + ID da Meta estrito, data do envio
-- e respostas não repetidas quando o lead da Meta já existia.
-- ---------------------------------------------------------------------------
create or replace function public.sheets_processar_linhas(p_fonte uuid, p_linhas jsonb, p_primeira boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_g        public.fontes_google_sheets;
  v_item     jsonb;
  v_chave    text;
  v_visto    public.fontes_google_sheets_linhas;
  v_r        record;
  v_codigo   text;
  v_msg      text;
  v_import   integer := 0;
  v_novas    integer := 0;
  v_exist    integer := 0;
  v_ignor    integer := 0;
  v_invalid  integer := 0;
  v_erros    integer := 0;
  v_baseline boolean;
  v_lead     text;
  v_bruto    text;
  v_envio    text;
begin
  select * into v_g from public.fontes_google_sheets where fonte_id = p_fonte;
  if v_g.fonte_id is null then raise exception 'Planilha inexistente.' using errcode = 'P0002'; end if;
  v_baseline := coalesce(p_primeira, false) and not v_g.importar_existentes;

  for v_item in select * from jsonb_array_elements(coalesce(p_linhas, '[]'::jsonb)) loop
    v_chave := left(btrim(coalesce(v_item ->> 'chave', '')), 200);
    continue when v_chave = '';
    select * into v_visto from public.fontes_google_sheets_linhas where fonte_id = p_fonte and chave = v_chave;
    continue when v_visto.fonte_id is not null and (v_visto.resultado <> 'erro' or v_visto.tentativas >= 5);

    if v_baseline then
      insert into public.fontes_google_sheets_linhas (fonte_id, chave, resultado, linha)
      values (p_fonte, v_chave, 'ignorada_inicial', (v_item ->> 'linha')::integer)
      on conflict (fonte_id, chave) do nothing;
      v_ignor := v_ignor + 1;
      continue;
    end if;

    -- ID do lead da Meta: só dígitos (15 a 17) ou "l:" + dígitos, como no export dos Lead Ads.
    -- Outros prefixos ("ag:" anúncio, "as:" conjunto, "c:" campanha, "f:" formulário) não são lead.
    v_bruto := lower(regexp_replace(coalesce(v_item ->> 'meta_lead_id', ''), '\s', '', 'g'));
    v_lead := case when v_bruto ~ '^(l:)?[0-9]{15,17}$' then regexp_replace(v_bruto, '^l:', '') end;

    -- Data do envio (ISO com fuso, já interpretada no fuso de São Paulo pela leitura da planilha).
    v_envio := null;
    if coalesce(v_item ->> 'data_envio', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$' then
      begin
        v_envio := to_char((v_item ->> 'data_envio')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
      exception when others then
        v_envio := null;
      end;
    end if;

    begin
      select * into v_r from public.ingerir_lead_integracao(
        p_fonte, 'gs:' || v_chave, v_item ->> 'nome', v_item ->> 'telefone', v_item ->> 'email', v_item ->> 'empresa',
        jsonb_strip_nulls(jsonb_build_object('planilha', v_g.planilha_nome, 'aba', v_g.aba_nome, 'meta_lead_id', v_lead,
                                             'data_formulario', v_envio)));
      -- Mesmo lead da Meta já recebido por outra fonte: as respostas já estão lá; não repete.
      if v_r.resultado <> 'mesmo_lead_meta' then
        perform public.registrar_respostas_lead(v_g.tenant_id, v_r.negociacao_id, p_fonte, 'gs:' || v_chave, v_item -> 'respostas');
      end if;
      insert into public.fontes_google_sheets_linhas (fonte_id, chave, resultado, negociacao_id, linha)
      values (p_fonte, v_chave, case when v_r.resultado in ('importada', 'nova_oportunidade') then 'importada' else 'contato_existente' end,
              v_r.negociacao_id, (v_item ->> 'linha')::integer)
      on conflict (fonte_id, chave) do update
        set resultado = excluded.resultado, negociacao_id = excluded.negociacao_id, ultimo_erro = null, ultima_vez_em = now();
      if v_r.resultado = 'importada' then v_import := v_import + 1;
      elsif v_r.resultado = 'nova_oportunidade' then v_novas := v_novas + 1;
      else v_exist := v_exist + 1; end if;
    exception when others then
      get stacked diagnostics v_codigo = returned_sqlstate, v_msg = message_text;
      insert into public.fontes_google_sheets_linhas (fonte_id, chave, resultado, linha, ultimo_erro)
      values (p_fonte, v_chave, case when v_codigo = '22023' then 'invalida' else 'erro' end, (v_item ->> 'linha')::integer, left(v_msg, 300))
      on conflict (fonte_id, chave) do update
        set resultado = excluded.resultado, ultimo_erro = excluded.ultimo_erro, ultima_vez_em = now(),
            tentativas = public.fontes_google_sheets_linhas.tentativas + 1;
      insert into public.ingestao_eventos (tenant_id, fonte_id, external_id, resultado, erro_codigo, erro_mensagem)
      values (v_g.tenant_id, p_fonte, left('gs:' || v_chave, 300), 'erro', v_codigo, left(v_msg, 300));
      if v_codigo = '22023' then v_invalid := v_invalid + 1; else v_erros := v_erros + 1; end if;
    end;
  end loop;

  update public.fontes_google_sheets
     set total_importados = total_importados + v_import + v_novas, total_existentes = total_existentes + v_exist,
         total_erros = total_erros + v_erros + v_invalid
   where fonte_id = p_fonte;
  return jsonb_build_object('importadas', v_import + v_novas, 'novas_oportunidades', v_novas, 'existentes', v_exist,
                            'ignoradas_inicio', v_ignor, 'invalidas', v_invalid, 'erros', v_erros);
end;
$$;
