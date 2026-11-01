-- ===========================================================================
-- Meta Ads multiempresa (depende de 20261106090000). LOCAL — não publicada.
--
-- Cada empresa cliente conecta, pelo Login do Facebook para Empresas (token BISU
-- do PRÓPRIO portfólio, mesmo fora da BM da Rio X7), os ativos que liberou:
--   * dataset  → Conversões do CRM (reaproveita capi_salvar_conexao / fila CAPI);
--   * Páginas  → Lead Ads: cada Página vira uma fonte `meta_lead_ads` com o token
--                da Página (já existente: fonte_por_provedor / ingerir_lead_fonte);
--   * contas de anúncios → painel de campanhas (métricas da Marketing API).
--
-- Isolamento (nunca cruza empresas):
--   * portfólio, conta de anúncios, Página e dataset ativos pertencem a UMA empresa;
--   * tokens só no Vault, lidos só pelo servidor (service_role);
--   * painel e estado só da empresa da sessão (tenant_atual), Administrador/gerente;
--   * Lead Ads segue a permissão "Meta Ads" da Central (chave global, plano,
--     exceção) e a cota de fontes; desligado = webhook ignorado.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Lead Ads dentro da Central (integração "Meta Ads" = meta_conversoes)
-- ---------------------------------------------------------------------------
create or replace function public.integracao_da_fonte(p_tipo public.fonte_lead_tipo)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_tipo in ('formulario_rx7', 'webhook', 'respondi') then 'formularios'
              when p_tipo = 'google_sheets' then 'google_sheets'
              when p_tipo = 'whatsapp_cloud' then 'whatsapp_oficial'
              when p_tipo = 'meta_lead_ads' then 'meta_conversoes' end
$$;

-- Webhook de Lead Ads só acha a fonte com a integração habilitada para a empresa.
create or replace function public.fonte_por_provedor(p_tipo public.fonte_lead_tipo, p_ref text)
returns table (id uuid, vault_secret_id uuid, configuracao jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.vault_secret_id, f.configuracao
    from public.fontes_leads f
   where f.tipo = p_tipo
     and f.status = 'ativa'
     and f.validada_em is not null
     and p_tipo in ('meta_lead_ads', 'whatsapp_cloud')
     and f.configuracao ->> (case when p_tipo = 'meta_lead_ads' then 'page_id' else 'phone_number_id' end) = p_ref
     and (p_tipo <> 'meta_lead_ads' or public.integracao_habilitada('meta_conversoes', f.tenant_id));
$$;

-- ---------------------------------------------------------------------------
-- 2. Tabelas (sem acesso direto: tudo por função)
-- ---------------------------------------------------------------------------
create table public.meta_ads_conexoes (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null unique references public.tenants (id) on delete cascade,
  negocio_id              text not null check (negocio_id ~ '^[0-9]{5,30}$'),
  vault_secret_id         uuid,
  situacao                text not null default 'ativa' check (situacao in ('ativa', 'erro_autorizacao', 'desconectada')),
  conectado_por           uuid references auth.users (id) on delete set null,
  conectado_em            timestamptz not null default now(),
  ultima_sincronizacao_em timestamptz,
  ultimo_erro             text check (ultimo_erro is null or length(ultimo_erro) <= 300),
  ultimo_erro_em          timestamptz,
  unique (tenant_id, id)
);
-- Um portfólio do cliente serve a uma só empresa do AVANTE.
create unique index meta_ads_negocio_unico on public.meta_ads_conexoes (negocio_id) where situacao <> 'desconectada';
alter table public.meta_ads_conexoes enable row level security;
revoke all on public.meta_ads_conexoes from public, anon, authenticated;

create table public.meta_ads_contas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  conexao_id  uuid not null,
  conta_id    text not null check (conta_id ~ '^[0-9]{5,30}$'),
  nome        text check (nome is null or length(nome) <= 200),
  moeda       text check (moeda is null or moeda ~ '^[A-Z]{3}$'),
  ativa       boolean not null default true,
  criado_em   timestamptz not null default now(),
  unique (tenant_id, conta_id),
  foreign key (tenant_id, conexao_id) references public.meta_ads_conexoes (tenant_id, id) on delete cascade
);
-- Uma conta de anúncios ativa pertence a uma só empresa.
create unique index meta_ads_conta_unica on public.meta_ads_contas (conta_id) where ativa;
alter table public.meta_ads_contas enable row level security;
revoke all on public.meta_ads_contas from public, anon, authenticated;

create table public.meta_ads_metricas (
  conta_ref     uuid not null references public.meta_ads_contas (id) on delete cascade,
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  dia           date not null,
  campanha_id   text not null check (campanha_id ~ '^[0-9]{5,30}$'),
  campanha_nome text check (campanha_nome is null or length(campanha_nome) <= 200),
  investimento  numeric(14, 2) not null default 0 check (investimento >= 0),
  impressoes    bigint not null default 0 check (impressoes >= 0),
  cliques       bigint not null default 0 check (cliques >= 0),
  leads         integer not null default 0 check (leads >= 0),
  -- Compras atribuídas PELA META (modelo e janela dela). Não são as vendas do CRM: servem só
  -- para comparar com o resultado medido no funil.
  conversoes_meta       integer not null default 0 check (conversoes_meta >= 0),
  valor_conversoes_meta numeric(14, 2) not null default 0 check (valor_conversoes_meta >= 0),
  atualizado_em timestamptz not null default now(),
  primary key (conta_ref, dia, campanha_id)
);
create index meta_ads_metricas_tenant on public.meta_ads_metricas (tenant_id, dia);
alter table public.meta_ads_metricas enable row level security;
revoke all on public.meta_ads_metricas from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Servidor (Edge Function, service_role)
-- ---------------------------------------------------------------------------
create function public.meta_ads_exigir(p_tenant uuid, p_usuario uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.exigir_integracao_habilitada('meta_conversoes', p_tenant);
  if not public.usuario_administra_integracoes(p_usuario, p_tenant) then
    raise exception 'Usuário não administra as integrações desta empresa.' using errcode = '42501';
  end if;
  if not public.meta_conversoes_elegivel(p_tenant) then
    raise exception 'Meta Ads está disponível no plano Business; outros planos só com liberação da Rio X7.' using errcode = 'RX003';
  end if;
end;
$$;

-- Conexão (token BISU no Vault). Reconectar troca o token; outro portfólio desconecta os ativos antigos.
create function public.meta_ads_salvar_conexao(p_tenant uuid, p_usuario uuid, p_negocio_id text, p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_atual  public.meta_ads_conexoes;
  v_secret uuid;
  v_id     uuid;
begin
  perform public.meta_ads_exigir(p_tenant, p_usuario);
  if p_negocio_id is null or p_negocio_id !~ '^[0-9]{5,30}$' then raise exception 'Portfólio inválido.' using errcode = '22023'; end if;
  if p_token is null or length(p_token) < 20 then raise exception 'Token inválido.' using errcode = '22023'; end if;
  if exists (select 1 from public.meta_ads_conexoes where negocio_id = p_negocio_id and tenant_id <> p_tenant and situacao <> 'desconectada') then
    raise exception 'Este portfólio da Meta já está conectado a outra empresa.' using errcode = '23505';
  end if;
  select * into v_atual from public.meta_ads_conexoes where tenant_id = p_tenant for update;
  if v_atual.id is not null and v_atual.vault_secret_id is not null then delete from vault.secrets where id = v_atual.vault_secret_id; end if;
  if v_atual.id is not null and v_atual.negocio_id <> p_negocio_id then
    update public.meta_ads_contas set ativa = false where tenant_id = p_tenant and ativa;
  end if;
  v_secret := vault.create_secret(p_token, null, 'meta-ads ' || p_tenant::text);
  insert into public.meta_ads_conexoes (tenant_id, negocio_id, vault_secret_id, situacao, conectado_por)
  values (p_tenant, p_negocio_id, v_secret, 'ativa', p_usuario)
  on conflict (tenant_id) do update
     set negocio_id = excluded.negocio_id, vault_secret_id = excluded.vault_secret_id, situacao = 'ativa',
         conectado_por = excluded.conectado_por, conectado_em = now(), ultimo_erro = null, ultimo_erro_em = null
  returning id into v_id;
  insert into public.admin_auditoria (ator_id, acao, tenant_id, detalhes)
  values (p_usuario, 'meta_ads_conectada', p_tenant, jsonb_build_object('conexao', v_id, 'negocio', p_negocio_id));
  return v_id;
end;
$$;

-- Token da conexão ativa DESTA empresa (só servidor).
create function public.meta_ads_credencial(p_tenant uuid)
returns table (conexao_id uuid, negocio_id text, token text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.negocio_id, s.decrypted_secret::text
    from public.meta_ads_conexoes c join vault.decrypted_secrets s on s.id = c.vault_secret_id
   where c.tenant_id = p_tenant and c.situacao = 'ativa';
$$;

-- Contas de anúncios escolhidas (o servidor já conferiu que a Meta as liberou para este token).
-- p_contas: [{ "id": "123", "nome": "...", "moeda": "BRL" }]. Contas fora da lista deixam de ser usadas.
create function public.meta_ads_salvar_contas(p_tenant uuid, p_usuario uuid, p_contas jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_con  public.meta_ads_conexoes;
  v_item jsonb;
  v_id   text;
  v_ids  text[] := '{}';
begin
  perform public.meta_ads_exigir(p_tenant, p_usuario);
  select * into v_con from public.meta_ads_conexoes where tenant_id = p_tenant and situacao = 'ativa' for update;
  if v_con.id is null then raise exception 'Conecte o Meta Ads primeiro.' using errcode = '23514'; end if;
  if jsonb_typeof(coalesce(p_contas, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_contas, '[]'::jsonb)) > 50 then
    raise exception 'Lista de contas inválida.' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_contas, '[]'::jsonb)) loop
    v_id := v_item ->> 'id';
    if v_id is null or v_id !~ '^[0-9]{5,30}$' then raise exception 'Conta de anúncios inválida.' using errcode = '22023'; end if;
    if exists (select 1 from public.meta_ads_contas where conta_id = v_id and ativa and tenant_id <> p_tenant) then
      raise exception 'A conta de anúncios % já está conectada a outra empresa.', v_id using errcode = '23505';
    end if;
    insert into public.meta_ads_contas (tenant_id, conexao_id, conta_id, nome, moeda, ativa)
    values (p_tenant, v_con.id, v_id, left(v_item ->> 'nome', 200),
            case when (v_item ->> 'moeda') ~ '^[A-Z]{3}$' then v_item ->> 'moeda' end, true)
    on conflict (tenant_id, conta_id) do update
       set conexao_id = excluded.conexao_id, nome = excluded.nome, moeda = excluded.moeda, ativa = true;
    v_ids := v_ids || v_id;
  end loop;
  update public.meta_ads_contas set ativa = false where tenant_id = p_tenant and ativa and not (conta_id = any (v_ids));
  insert into public.admin_auditoria (ator_id, acao, tenant_id, detalhes)
  values (p_usuario, 'meta_ads_contas_definidas', p_tenant, jsonb_build_object('contas', to_jsonb(v_ids)));
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;

-- Página → fonte de Lead Ads da empresa (token da Página no Vault; destino no funil).
-- Mesma Página de novo nesta empresa: troca token e destino. De outra empresa: recusado.
create function public.meta_ads_salvar_pagina(
  p_tenant uuid, p_usuario uuid, p_pagina_id text, p_nome text, p_token text, p_funil uuid, p_etapa uuid, p_responsavel uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f      public.fontes_leads;
  v_secret uuid;
begin
  perform public.meta_ads_exigir(p_tenant, p_usuario);
  if not exists (select 1 from public.meta_ads_conexoes where tenant_id = p_tenant and situacao = 'ativa') then
    raise exception 'Conecte o Meta Ads primeiro.' using errcode = '23514';
  end if;
  if p_pagina_id is null or p_pagina_id !~ '^[0-9]{5,30}$' then raise exception 'Página inválida.' using errcode = '22023'; end if;
  if p_token is null or length(p_token) < 20 then raise exception 'Token inválido.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('meta-pagina:' || p_pagina_id, 0));
  select * into v_f from public.fontes_leads
   where tipo = 'meta_lead_ads' and configuracao ->> 'page_id' = p_pagina_id and status <> 'revogada' for update;
  if v_f.id is not null and v_f.tenant_id <> p_tenant then
    raise exception 'Esta Página já está conectada a outra empresa.' using errcode = '23505';
  end if;
  v_secret := vault.create_secret(p_token, null, 'meta-pagina ' || p_tenant::text);
  if v_f.id is null then
    insert into public.fontes_leads (tenant_id, tipo, nome, status, funil_id, etapa_id, responsavel_id, configuracao,
                                     vault_secret_id, validada_em, criado_por)
    values (p_tenant, 'meta_lead_ads', left(coalesce(nullif(btrim(p_nome), ''), 'Página ' || p_pagina_id), 80), 'ativa',
            p_funil, p_etapa, p_responsavel,
            jsonb_build_object('page_id', p_pagina_id, 'pagina_nome', left(p_nome, 200), 'origem', 'login_empresas'),
            v_secret, now(), p_usuario)
    returning * into v_f;
  else
    if v_f.vault_secret_id is not null then delete from vault.secrets where id = v_f.vault_secret_id; end if;
    update public.fontes_leads
       set vault_secret_id = v_secret, validada_em = now(), funil_id = p_funil, etapa_id = p_etapa, responsavel_id = p_responsavel,
           configuracao = configuracao || jsonb_build_object('pagina_nome', left(p_nome, 200), 'origem', 'login_empresas'),
           status = 'ativa', ultimo_erro = null, ultimo_erro_em = null
     where id = v_f.id
    returning * into v_f;
  end if;
  insert into public.admin_auditoria (ator_id, acao, tenant_id, detalhes)
  values (p_usuario, 'meta_ads_pagina_conectada', p_tenant, jsonb_build_object('fonte', v_f.id, 'pagina', p_pagina_id));
  return v_f.id;
end;
$$;

-- Lote de contas para sincronizar métricas (empresas com Meta Ads habilitado; mais antigas primeiro).
create function public.meta_ads_contas_para_sincronizar(p_limite integer default 10)
returns table (conta_ref uuid, tenant_id uuid, conta_id text, token text, ultima timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.tenant_id, a.conta_id, s.decrypted_secret::text, c.ultima_sincronizacao_em
    from public.meta_ads_contas a
    join public.meta_ads_conexoes c on c.id = a.conexao_id and c.tenant_id = a.tenant_id
    join vault.decrypted_secrets s on s.id = c.vault_secret_id
   where a.ativa and c.situacao = 'ativa'
     and public.integracao_habilitada('meta_conversoes', a.tenant_id)
     and (c.ultima_sincronizacao_em is null or c.ultima_sincronizacao_em < now() - interval '50 minutes')
   order by c.ultima_sincronizacao_em nulls first, a.id
   limit least(greatest(coalesce(p_limite, 10), 1), 50);
$$;

-- Grava as métricas de UMA conta (linhas da Marketing API já normalizadas pelo servidor).
create function public.meta_ads_registrar_metricas(p_conta_ref uuid, p_linhas jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.meta_ads_contas;
  v_n integer := 0;
  v_l jsonb;
begin
  select * into v_a from public.meta_ads_contas where id = p_conta_ref and ativa;
  if v_a.id is null then return 0; end if;
  if jsonb_typeof(coalesce(p_linhas, '[]'::jsonb)) <> 'array' then raise exception 'Linhas inválidas.' using errcode = '22023'; end if;
  for v_l in select * from jsonb_array_elements(coalesce(p_linhas, '[]'::jsonb)) loop
    continue when (v_l ->> 'campanhaId') !~ '^[0-9]{5,30}$' or (v_l ->> 'dia') !~ '^\d{4}-\d{2}-\d{2}$';
    insert into public.meta_ads_metricas (conta_ref, tenant_id, dia, campanha_id, campanha_nome, investimento, impressoes, cliques, leads,
                                          conversoes_meta, valor_conversoes_meta, atualizado_em)
    values (v_a.id, v_a.tenant_id, (v_l ->> 'dia')::date, v_l ->> 'campanhaId', left(v_l ->> 'campanhaNome', 200),
            greatest(coalesce((v_l ->> 'investimento')::numeric, 0), 0), greatest(coalesce((v_l ->> 'impressoes')::bigint, 0), 0),
            greatest(coalesce((v_l ->> 'cliques')::bigint, 0), 0), greatest(coalesce((v_l ->> 'leads')::integer, 0), 0),
            greatest(coalesce((v_l ->> 'conversoesMeta')::integer, 0), 0),
            greatest(coalesce((v_l ->> 'valorConversoesMeta')::numeric, 0), 0), now())
    on conflict (conta_ref, dia, campanha_id) do update
       set campanha_nome = excluded.campanha_nome, investimento = excluded.investimento, impressoes = excluded.impressoes,
           cliques = excluded.cliques, leads = excluded.leads, conversoes_meta = excluded.conversoes_meta,
           valor_conversoes_meta = excluded.valor_conversoes_meta, atualizado_em = now();
    v_n := v_n + 1;
  end loop;
  update public.meta_ads_conexoes set ultima_sincronizacao_em = now(), ultimo_erro = null, ultimo_erro_em = null
   where id = v_a.conexao_id;
  return v_n;
end;
$$;

-- Falha ao falar com a Meta: registra; autorização revogada (190) pede reconexão.
create function public.meta_ads_registrar_erro(p_tenant uuid, p_erro text, p_autorizacao boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.meta_ads_conexoes
     set ultimo_erro = left(p_erro, 300), ultimo_erro_em = now(),
         ultima_sincronizacao_em = now(),
         situacao = case when p_autorizacao then 'erro_autorizacao' else situacao end
   where tenant_id = p_tenant and situacao = 'ativa';
$$;

-- ---------------------------------------------------------------------------
-- 4. Tela (sessão do Administrador/gerente; só a empresa da sessão)
-- ---------------------------------------------------------------------------
create function public.meta_ads_da_empresa()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.tenant_atual();
  v_c      public.meta_ads_conexoes;
begin
  if v_tenant is null or not public.tem_papel_no_tenant(v_tenant, array['admin_empresa', 'gerente']::public.tenant_papel[]) then
    raise exception 'Somente o Administrador da empresa vê o Meta Ads.' using errcode = '42501';
  end if;
  select * into v_c from public.meta_ads_conexoes where tenant_id = v_tenant;
  return jsonb_build_object(
    'conexao', case when v_c.id is null or v_c.situacao = 'desconectada' then null else jsonb_build_object(
      'situacao', v_c.situacao, 'negocio_id', v_c.negocio_id, 'conectado_em', v_c.conectado_em,
      'ultima_sincronizacao_em', v_c.ultima_sincronizacao_em, 'ultimo_erro', v_c.ultimo_erro) end,
    'contas', coalesce((select jsonb_agg(jsonb_build_object('conta_id', a.conta_id, 'nome', a.nome, 'moeda', a.moeda) order by a.nome)
                          from public.meta_ads_contas a where a.tenant_id = v_tenant and a.ativa), '[]'::jsonb),
    'paginas', coalesce((select jsonb_agg(jsonb_build_object('fonte_id', f.id, 'page_id', f.configuracao ->> 'page_id',
                                  'nome', coalesce(f.configuracao ->> 'pagina_nome', f.nome), 'status', f.status,
                                  'funil_id', f.funil_id, 'etapa_id', f.etapa_id, 'responsavel_id', f.responsavel_id,
                                  'ultimo_lead_em', f.ultimo_lead_em) order by f.nome)
                          from public.fontes_leads f
                         where f.tenant_id = v_tenant and f.tipo = 'meta_lead_ads' and f.status <> 'revogada'), '[]'::jsonb));
end;
$$;

-- Painel por campanha: investimento e leads (Meta) + leads, vendas e faturamento (CRM) da empresa da sessão.
-- Leads do CRM pela campanha da atribuição (Lead Ads); vendas = fechamentos não anulados desses leads.
-- conversoes_meta/valor_conversoes_meta vêm da Meta (atribuição dela) e ficam em colunas separadas.
create function public.meta_ads_painel(p_inicio date, p_fim date)
returns table (conta_id text, campanha_id text, campanha_nome text, investimento numeric, impressoes bigint, cliques bigint,
               leads_meta bigint, leads_crm bigint, vendas bigint, faturamento numeric,
               conversoes_meta bigint, valor_conversoes_meta numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.tenant_atual();
begin
  if v_tenant is null or not public.tem_papel_no_tenant(v_tenant, array['admin_empresa', 'gerente']::public.tenant_papel[]) then
    raise exception 'Somente o Administrador da empresa vê o painel do Meta Ads.' using errcode = '42501';
  end if;
  if p_inicio is null or p_fim is null or p_fim < p_inicio or p_fim - p_inicio > 400 then
    raise exception 'Período inválido (até 400 dias).' using errcode = '22023';
  end if;
  return query
  with m as (
    select a.conta_id, x.campanha_id, max(x.campanha_nome) as campanha_nome, sum(x.investimento) as investimento,
           sum(x.impressoes)::bigint as impressoes, sum(x.cliques)::bigint as cliques, sum(x.leads)::bigint as leads_meta,
           sum(x.conversoes_meta)::bigint as conversoes_meta, sum(x.valor_conversoes_meta) as valor_conversoes_meta
      from public.meta_ads_metricas x join public.meta_ads_contas a on a.id = x.conta_ref
     where x.tenant_id = v_tenant and a.tenant_id = v_tenant and x.dia between p_inicio and p_fim
     group by a.conta_id, x.campanha_id
  ), crm as (
    select n.atribuicao ->> 'campaign_id' as campanha_id, count(*)::bigint as leads_crm,
           count(f.negociacao_id)::bigint as vendas, coalesce(sum(f.valor_vendido), 0) as faturamento
      from public.negociacoes n
      left join public.fechamentos f on f.negociacao_id = n.id and f.anulado_em is null
     where n.tenant_id = v_tenant and n.atribuicao ->> 'source' = 'meta_lead_ads'
       and (n.atribuicao ->> 'campaign_id') ~ '^[0-9]{5,30}$'
       and n.created_at >= p_inicio and n.created_at < p_fim + 1
     group by 1
  )
  select m.conta_id, m.campanha_id, m.campanha_nome, m.investimento, m.impressoes, m.cliques, m.leads_meta,
         coalesce(crm.leads_crm, 0), coalesce(crm.vendas, 0), coalesce(crm.faturamento, 0),
         m.conversoes_meta, m.valor_conversoes_meta
    from m left join crm on crm.campanha_id = m.campanha_id
   order by m.investimento desc, m.campanha_id;
end;
$$;

-- Desconectar: apaga o token, para as métricas e revoga as fontes de Lead Ads criadas pelo login.
-- Leads, negociações e métricas já gravadas ficam.
create function public.meta_ads_desconectar()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.exigir_administrador_integracoes();
  v_c      public.meta_ads_conexoes;
  v_f      record;
begin
  select * into v_c from public.meta_ads_conexoes where tenant_id = v_tenant for update;
  if v_c.id is null or v_c.situacao = 'desconectada' then return; end if;
  if v_c.vault_secret_id is not null then delete from vault.secrets where id = v_c.vault_secret_id; end if;
  update public.meta_ads_conexoes set situacao = 'desconectada', vault_secret_id = null where id = v_c.id;
  update public.meta_ads_contas set ativa = false where tenant_id = v_tenant and ativa;
  for v_f in select id, vault_secret_id from public.fontes_leads
              where tenant_id = v_tenant and tipo = 'meta_lead_ads' and status <> 'revogada'
                and configuracao ->> 'origem' = 'login_empresas' loop
    if v_f.vault_secret_id is not null then delete from vault.secrets where id = v_f.vault_secret_id; end if;
    update public.fontes_leads set status = 'revogada', revogada_em = now(), vault_secret_id = null where id = v_f.id;
  end loop;
  insert into public.admin_auditoria (ator_id, acao, tenant_id, detalhes)
  values ((select auth.uid()), 'meta_ads_desconectada', v_tenant, jsonb_build_object('conexao', v_c.id));
end;
$$;

do $perm$
declare
  f text;
begin
  foreach f in array array[
    'public.meta_ads_exigir(uuid, uuid)',
    'public.meta_ads_salvar_conexao(uuid, uuid, text, text)',
    'public.meta_ads_credencial(uuid)',
    'public.meta_ads_salvar_contas(uuid, uuid, jsonb)',
    'public.meta_ads_salvar_pagina(uuid, uuid, text, text, text, uuid, uuid, uuid)',
    'public.meta_ads_contas_para_sincronizar(integer)',
    'public.meta_ads_registrar_metricas(uuid, jsonb)',
    'public.meta_ads_registrar_erro(uuid, text, boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.meta_ads_da_empresa()',
    'public.meta_ads_painel(date, date)',
    'public.meta_ads_desconectar()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$perm$;
