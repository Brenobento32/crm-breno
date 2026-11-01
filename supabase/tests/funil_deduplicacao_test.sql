set client_encoding = 'UTF8'; -- arquivo em UTF-8 (acentos das mensagens)
-- ===========================================================================
-- Teste: deduplicação de leads de planilha e data real do envio
-- (migration 20261108090000). ONDE RODAR: só cópia LOCAL crm_rx7_*.
-- Termina em ROLLBACK.
--
--  U1 mesmo lead da Meta em duas abas: uma negociação, respostas não repetidas
--  U2 mesmo WhatsApp em envios diferentes: reaproveita, guarda as novas respostas,
--     não volta de etapa, não altera o cliente
--  U3 mesmo e-mail (outra caixa/espaços): reaproveita
--  U4 telefone de um cliente e e-mail de outro: não une, fica com o do telefone,
--     marca para revisão, nenhum cliente alterado
--  U5 sincronização repetida: nada muda
--  U6 ID da Meta: "l:" aceito; "ag:"/"c:"/curto recusados
--  U7 data do envio vai para data_formulario; inválida é ignorada
--  U8 lead fechado não volta para a entrada: oportunidade nova, a antiga intacta
--  U9 isolamento: mesmo telefone e mesmo ID da Meta em outra empresa não se misturam
-- ===========================================================================
begin;

do $$
begin
  if current_database() not like 'crm_rx7_%' then
    raise exception 'Teste só para cópia local crm_rx7_* (banco atual: %).', current_database();
  end if;
end;
$$;

do $lim$
begin
  if to_regclass('public.empresa_limites') is not null then
    execute $x$insert into public.empresa_limites (tenant_id, recurso, limite, motivo)
             select t.id, r, 100, 'ambiente local de teste' from public.tenants t cross join unnest(array['fontes', 'numeros_whatsapp', 'funis']) r
              where t.tipo = 'assinante' on conflict (tenant_id, recurso) do nothing$x$;
  end if;
end;
$lim$;

create function public._como(p_uid uuid, p_slug text)
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  if p_uid is null then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.headers', '', true);
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'session_id', 's1')::text, true);
  perform set_config('request.headers', case when p_slug is null then '{}' else json_build_object('x-rx7-tenant', p_slug)::text end, true);
  perform set_config('role', 'authenticated', true);
end;
$$;
grant execute on function public._como(uuid, text) to authenticated, service_role;
create function public._ok(p_cond boolean, p_nome text)
returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'FALHOU: %', p_nome; end if;
  raise notice 'ok  %', p_nome;
end;
$$;
grant execute on function public._ok(boolean, text) to authenticated, service_role;
create function public._servico()
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.headers', '{}', true);
  perform set_config('role', 'service_role', true);
end;
$$;
grant execute on function public._servico() to authenticated, service_role;

do $$
declare
  g_a  uuid := '60000000-0000-4000-8000-0000000000a1';
  c_a  uuid := '60000000-0000-4000-8000-0000000000a2';
  g_b  uuid := '60000000-0000-4000-8000-0000000000b1';
  t_a  uuid := 'a9bc5b35-0515-49d7-b5d6-4db635003d35';
  t_b  uuid := '82c2cd79-b9aa-4b4d-8de9-88d51065ca7f';
  fa uuid; ea uuid; ea_real uuid; ea_ganha uuid; fb uuid; eb uuid;
  conta_a uuid; conta_b uuid; s1 uuid; s2 uuid; sb uuid;
  v_dono text; v_j jsonb; v_neg uuid; v_neg2 uuid; v_cli uuid; v_cli_a uuid; v_cli_b uuid; v_n integer; v_antes text;
  lote1 jsonb;
begin
  perform public._como(null, null);
  select id into fa from public.funis where tenant_id = t_a and padrao;
  select id into ea from public.etapas_funil where funil_id = fa and etapa_inicial;
  select id into ea_real from public.etapas_funil where funil_id = fa and nome = 'Reunião realizada';
  select id into ea_ganha from public.etapas_funil where funil_id = fa and tipo = 'ganha';
  select id into fb from public.funis where tenant_id = t_b and padrao;
  select id into eb from public.etapas_funil where funil_id = fb and etapa_inicial;
  insert into public.plataforma_integracoes_empresas (tipo, tenant_id) values ('google_sheets', t_a), ('google_sheets', t_b)
  on conflict do nothing;

  perform public._servico();
  conta_a := public.google_salvar_conta(t_a, g_a, 'planilhas-u@alfa.test', 'refresh-token-u-xxxxxxxxx', array['openid', 'email', 'https://www.googleapis.com/auth/drive.file']);
  conta_b := public.google_salvar_conta(t_b, g_b, 'planilhas-u@beta.test', 'refresh-token-u-xxxxxxxxx', array['openid', 'email', 'https://www.googleapis.com/auth/drive.file']);
  perform public._como(g_a, 'teste-alfa');
  s1 := public.sheets_criar_fonte(conta_a, 'planilha-u-aaaaaaaaaaaaaaaaaaaaaa', 'Leads U', 11, 'Formulário Clínica', 1,
                                  '{"nome":"Nome","telefone":"Telefone","email":"Email","meta_lead_id":"id"}', 'id', true, 'Clínica', fa, ea, g_a);
  s2 := public.sheets_criar_fonte(conta_a, 'planilha-u-aaaaaaaaaaaaaaaaaaaaaa', 'Leads U', 12, 'Formulário Ótica', 1,
                                  '{"nome":"Nome","telefone":"Telefone","email":"Email","meta_lead_id":"id"}', 'id', true, 'Ótica', fa, ea, g_a);
  perform public._como(g_b, 'teste-beta');
  sb := public.sheets_criar_fonte(conta_b, 'planilha-u-bbbbbbbbbbbbbbbbbbbbbb', 'Leads B', 0, 'Leads', 1,
                                  '{"nome":"Nome","telefone":"Telefone","meta_lead_id":"id"}', 'id', true, 'B', fb, eb, g_b);

  -- ================================================================= U6/U7 primeira leitura da aba 1
  perform public._servico();
  lote1 := jsonb_build_array(
    jsonb_build_object('chave', 'id:l:111111111111111', 'linha', 2, 'nome', 'Paula', 'telefone', 'p:+5511955551001', 'email', 'paula@ex.test',
                       'meta_lead_id', 'l:111111111111111', 'data_envio', '2026-10-30T13:00:00.000Z',
                       'respostas', '[{"pergunta":"Qual o seu orçamento?","resposta":"R$ 5 mil"},{"pergunta":"created_time","resposta":"2026-10-30T10:00:00-03:00"}]'::jsonb),
    jsonb_build_object('chave', 'id:ag:2', 'linha', 3, 'nome', 'Rui', 'telefone', '11955551002',
                       'meta_lead_id', 'ag:120254490122630204', 'data_envio', 'ontem à tarde',
                       'respostas', '[{"pergunta":"Qual o seu orçamento?","resposta":"R$ 10 mil"}]'::jsonb),
    jsonb_build_object('chave', 'id:c:3', 'linha', 4, 'nome', 'Sol', 'telefone', '11955551003', 'meta_lead_id', 'c:120254490122630204'));
  v_j := public.sheets_processar_linhas(s1, lote1, true);
  perform public._como(null, null);
  perform public._ok((v_j ->> 'importadas')::integer = 3, 'U0 aba 1: 3 leads novos importados');
  select n.id, n.cliente_id into v_neg, v_cli from public.negociacoes n join public.clientes c on c.id = n.cliente_id
   where n.tenant_id = t_a and c.telefone = '5511955551001';
  perform public._ok((select atribuicao ->> 'meta_lead_id' = '111111111111111' from public.negociacoes where id = v_neg), 'U6 "l:" + 15 dígitos aceito e guardado só com os dígitos');
  perform public._ok((select count(*) = 0 from public.negociacoes n join public.clientes c on c.id = n.cliente_id
                       where n.tenant_id = t_a and c.telefone in ('5511955551002', '5511955551003') and n.atribuicao ? 'meta_lead_id'),
                     'U6 ...ID de anúncio ("ag:") e de campanha ("c:") nunca viram ID do lead');
  perform public._ok((select atribuicao ->> 'data_formulario' = '2026-10-30T13:00:00Z' from public.negociacoes where id = v_neg), 'U7 data real do envio guardada em data_formulario (UTC)');
  perform public._ok((select not (n.atribuicao ? 'data_formulario') from public.negociacoes n join public.clientes c on c.id = n.cliente_id
                       where n.tenant_id = t_a and c.telefone = '5511955551002'), 'U7 ...data inválida ignorada (nunca inventada)');

  -- ================================================================= U5 mesma leitura de novo
  select count(*) into v_n from public.negociacao_respostas where tenant_id = t_a;
  perform public._servico();
  v_j := public.sheets_processar_linhas(s1, lote1, false);
  perform public._como(null, null);
  perform public._ok((v_j ->> 'importadas')::integer = 0 and (v_j ->> 'existentes')::integer = 0, 'U5 sincronização repetida: nenhuma linha reprocessada');
  perform public._ok((select count(*) from public.negociacao_respostas where tenant_id = t_a) = v_n, 'U5 ...nenhuma resposta duplicada');

  -- ================================================================= U1 mesmo lead da Meta na aba 2
  perform public._servico();
  v_j := public.sheets_processar_linhas(s2, jsonb_build_array(
    jsonb_build_object('chave', 'id:l:111111111111111', 'linha', 2, 'nome', 'Paula', 'telefone', '5511955551001', 'meta_lead_id', '111111111111111',
                       'respostas', '[{"pergunta":"Qual o seu orçamento?","resposta":"R$ 5 mil"}]'::jsonb)), true);
  perform public._como(null, null);
  perform public._ok((v_j ->> 'existentes')::integer = 1 and (v_j ->> 'importadas')::integer = 0, 'U1 mesmo leadgen_id em outra aba: reconhecido como o mesmo lead');
  perform public._ok((select count(*) from public.negociacoes where cliente_id = v_cli) = 1, 'U1 ...uma negociação só');
  perform public._ok((select count(*) from public.negociacao_respostas where negociacao_id = v_neg) = 2, 'U1 ...respostas não repetidas');

  -- ================================================================= U2 mesmo WhatsApp, outro envio, etapa avançada
  perform public._como(g_a, 'teste-alfa');
  perform public.mover_negociacao(v_neg, ea_real, 1000);
  perform public._como(null, null);
  select owner_id::text into v_dono from public.negociacoes where id = v_neg;
  select concat_ws('|', nome, telefone, email, empresa) into v_antes from public.clientes where id = v_cli;
  perform public._servico();
  v_j := public.sheets_processar_linhas(s2, jsonb_build_array(
    jsonb_build_object('chave', 'id:l:111111111111999', 'linha', 3, 'nome', 'PAULA NOVA', 'telefone', '(11) 95555-1001', 'email', 'outro@ex.test',
                       'meta_lead_id', 'l:111111111111999', 'data_envio', '2026-11-01T12:00:00Z',
                       'respostas', '[{"pergunta":"Tipo de lente","resposta":"Multifocal"}]'::jsonb)), false);
  perform public._como(null, null);
  perform public._ok((v_j ->> 'existentes')::integer = 1, 'U2 mesmo WhatsApp em outro envio: lead reaproveitado');
  perform public._ok((select count(*) from public.negociacoes where cliente_id = v_cli) = 1, 'U2 ...nenhuma negociação nova');
  perform public._ok((select etapa_id = ea_real and owner_id::text is not distinct from v_dono from public.negociacoes where id = v_neg), 'U2 ...não volta para Lead Novo; responsável mantido');
  perform public._ok((select concat_ws('|', nome, telefone, email, empresa) from public.clientes where id = v_cli) = v_antes, 'U2 ...dados do cliente não sobrescritos');
  perform public._ok(exists (select 1 from public.negociacao_respostas where negociacao_id = v_neg and pergunta = 'Tipo de lente' and resposta = 'Multifocal')
                     and exists (select 1 from public.negociacao_respostas where negociacao_id = v_neg and pergunta = 'Qual o seu orçamento?'),
                     'U2 ...respostas novas guardadas no histórico, as antigas preservadas');
  perform public._ok((select atribuicao -> 'origens_adicionais' @> '[{"meta_lead_id": "111111111111999", "enviado_em": "2026-11-01T12:00:00Z", "aba": "Formulário Ótica"}]'
                        and atribuicao ->> 'data_formulario' = '2026-10-30T13:00:00Z'
                        from public.negociacoes where id = v_neg),
                     'U2 ...origem, data e ID do novo envio registrados; data de entrada original mantida');

  -- ================================================================= U3 mesmo e-mail
  perform public._servico();
  v_j := public.sheets_processar_linhas(s1, jsonb_build_array(
    jsonb_build_object('chave', 'id:l:222222222222222', 'linha', 5, 'nome', 'Paula', 'email', '  PAULA@EX.TEST ', 'meta_lead_id', 'l:222222222222222')), false);
  perform public._como(null, null);
  perform public._ok((v_j ->> 'existentes')::integer = 1 and (select count(*) from public.clientes where tenant_id = t_a and lower(email) = 'paula@ex.test') = 1,
                     'U3 mesmo e-mail (caixa e espaços diferentes): reaproveitado, sem cliente novo');

  -- ================================================================= U4 telefone de A, e-mail de B
  insert into public.clientes (tenant_id, tipo_cliente, nome, telefone, owner_id) values (t_a, 'pessoa_fisica', 'Cliente do telefone', '5511966660001', c_a) returning id into v_cli_a;
  insert into public.clientes (tenant_id, tipo_cliente, nome, email, owner_id) values (t_a, 'pessoa_fisica', 'Cliente do e-mail', 'email@ex.test', c_a) returning id into v_cli_b;
  select count(*) into v_n from public.clientes where tenant_id = t_a;
  perform public._servico();
  v_j := public.sheets_processar_linhas(s1, jsonb_build_array(
    jsonb_build_object('chave', 'id:l:333333333333333', 'linha', 6, 'nome', 'Misto', 'telefone', '11966660001', 'email', 'email@ex.test', 'meta_lead_id', 'l:333333333333333')), false);
  perform public._como(null, null);
  perform public._ok((select count(*) from public.clientes where tenant_id = t_a) = v_n, 'U4 telefone e e-mail de clientes diferentes: nenhum cliente criado nem unido');
  select id into v_neg2 from public.negociacoes where tenant_id = t_a and atribuicao ->> 'meta_lead_id' = '333333333333333';
  perform public._ok((select cliente_id = v_cli_a and (atribuicao ->> 'contato_divergente')::boolean from public.negociacoes where id = v_neg2),
                     'U4 ...fica com o cliente do telefone e marca para revisão');
  perform public._ok((select email is null and nome = 'Cliente do telefone' from public.clientes where id = v_cli_a)
                     and (select telefone is null and nome = 'Cliente do e-mail' from public.clientes where id = v_cli_b),
                     'U4 ...nenhum dos dois clientes alterado');

  -- ================================================================= U8 lead fechado
  perform public._como(g_a, 'teste-alfa');
  update public.negociacoes set etapa_id = ea_ganha where id = v_neg2;
  perform public._como(null, null);
  perform public._servico();
  v_j := public.sheets_processar_linhas(s1, jsonb_build_array(
    jsonb_build_object('chave', 'id:l:444444444444444', 'linha', 7, 'nome', 'Misto', 'telefone', '11966660001', 'meta_lead_id', 'l:444444444444444')), false);
  perform public._como(null, null);
  perform public._ok((select etapa_id = ea_ganha from public.negociacoes where id = v_neg2), 'U8 negociação fechada não volta para a entrada');
  perform public._ok((v_j ->> 'novas_oportunidades')::integer = 1 and (select count(*) from public.negociacoes where cliente_id = v_cli_a) = 2,
                     'U8 ...novo envio vira oportunidade nova do mesmo cliente (sem cliente duplicado)');

  -- ================================================================= U9 outra empresa
  perform public._servico();
  v_j := public.sheets_processar_linhas(sb, jsonb_build_array(
    jsonb_build_object('chave', 'id:l:111111111111111', 'linha', 2, 'nome', 'Paula em B', 'telefone', '5511955551001', 'meta_lead_id', 'l:111111111111111')), true);
  perform public._como(null, null);
  perform public._ok((v_j ->> 'importadas')::integer = 1, 'U9 mesmo telefone e mesmo ID da Meta em B: lead novo de B');
  perform public._ok((select c.tenant_id = t_b from public.negociacoes n join public.clientes c on c.id = n.cliente_id
                       where n.tenant_id = t_b and n.atribuicao ->> 'meta_lead_id' = '111111111111111'),
                     'U9 ...cliente de B, nunca o de A');
  perform public._como(g_b, 'teste-beta');
  perform public._ok(not exists (select 1 from public.negociacao_respostas where negociacao_id = v_neg), 'U9 ...B não lê as respostas de A');

  raise notice 'funil_deduplicacao_test.sql: todas as asserções passaram.';
end;
$$;

rollback;
