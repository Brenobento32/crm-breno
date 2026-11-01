set client_encoding = 'UTF8'; -- arquivo em UTF-8 (acentos das mensagens)
-- ===========================================================================
-- Teste: Meta Ads multiempresa (migration 20261107090000).
-- ONDE RODAR: só cópia LOCAL crm_rx7_*. Termina em ROLLBACK.
--
--  C1–C4  conexão: token só no Vault e só para o servidor; portfólio de uma empresa só
--  A1–A4  contas de anúncios: uma empresa por conta; remover libera
--  P1–P5  Páginas → fontes de Lead Ads: uma empresa por Página; cota/permissão da Central;
--         webhook ignorado com o Meta Ads desligado
--  M1–M5  métricas e painel: só a empresa da sessão; leads/vendas/faturamento do CRM
--  D1–D3  desconectar: apaga tokens, revoga as Páginas do login, mantém histórico
--  R1–R4  regras: chave global, plano, Administrador; permissões das funções
-- ===========================================================================
begin;

do $$
begin
  if current_database() not like 'crm_rx7_%' then
    raise exception 'Teste só para cópia local crm_rx7_* (banco atual: %).', current_database();
  end if;
end;
$$;

insert into public.empresa_limites (tenant_id, recurso, limite, motivo)
select t.id, r, 100, 'ambiente local de teste' from public.tenants t cross join unnest(array['fontes', 'numeros_whatsapp', 'funis']) r
 where t.tipo = 'assinante' on conflict (tenant_id, recurso) do nothing;
-- As duas empresas de teste no Business (Meta Ads incluído no plano).
insert into public.assinaturas (tenant_id, plano_id, status)
select t.id, p.id, 'ativa' from public.tenants t, public.planos p
 where t.slug in ('teste-alfa', 'teste-beta') and p.codigo = 'business'
on conflict (tenant_id) do update set plano_id = excluded.plano_id, status = excluded.status;

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
grant execute on function public._como(uuid, text) to authenticated, service_role, anon;
create function public._ok(p_cond boolean, p_nome text)
returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'FALHOU: %', p_nome; end if;
  raise notice 'ok  %', p_nome;
end;
$$;
grant execute on function public._ok(boolean, text) to authenticated, service_role, anon;
create function public._recusa(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'aceito';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$$;
grant execute on function public._recusa(text) to authenticated, service_role, anon;
create function public._servico()
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.headers', '{}', true);
  perform set_config('role', 'service_role', true);
end;
$$;
grant execute on function public._servico() to authenticated, service_role, anon;

do $$
declare
  g_a   uuid := '60000000-0000-4000-8000-0000000000a1';
  c_a   uuid := '60000000-0000-4000-8000-0000000000a2';
  v_a   uuid := '60000000-0000-4000-8000-0000000000a4';
  g_b   uuid := '60000000-0000-4000-8000-0000000000b1';
  t_a   uuid := 'a9bc5b35-0515-49d7-b5d6-4db635003d35';
  t_b   uuid := '82c2cd79-b9aa-4b4d-8de9-88d51065ca7f';
  n1 constant text := '510000000000001';  -- portfólio do cliente A
  n2 constant text := '510000000000002';  -- portfólio do cliente B
  k1 constant text := '810000000000001';  -- conta de anúncios
  p1 constant text := '710000000000001';  -- Página
  camp constant text := '910000000000001';
  fa1 uuid; ea1 uuid; fb1 uuid; eb1 uuid;
  v_fonte uuid; v_fonte2 uuid; v_conta uuid; v_neg uuid; v_sec uuid; v_r text; v_n integer; v_j jsonb;
begin
  perform public._como(null, null);
  select id into fa1 from public.funis where tenant_id = t_a and padrao;
  select id into ea1 from public.etapas_funil where funil_id = fa1 and etapa_inicial;
  select id into fb1 from public.funis where tenant_id = t_b and padrao;
  select id into eb1 from public.etapas_funil where funil_id = fb1 and etapa_inicial;
  update public.plataforma_integracoes set meta_conversoes = true;

  -- ================================================================= C1–C4 conexão
  perform public._servico();
  perform public.meta_ads_salvar_conexao(t_a, g_a, n1, 'tok-bisu-alfa-xxxxxxxxxxxx');
  perform public._ok((select token = 'tok-bisu-alfa-xxxxxxxxxxxx' and negocio_id = n1 from public.meta_ads_credencial(t_a)),
                     'C1 token do portfólio do cliente A guardado no Vault e lido só pelo servidor');
  perform public._ok(not exists (select 1 from public.meta_ads_credencial(t_b)), 'C2 empresa B não vê credencial da A');
  v_r := public._recusa(format('select public.meta_ads_salvar_conexao(%L, %L, %L, %L)', t_b, g_b, n1, 'tok-bisu-beta-xxxxxxxxxxxx'));
  perform public._ok(v_r like '23505:%', 'C3 mesmo portfólio em outra empresa: recusado');
  perform public.meta_ads_salvar_conexao(t_b, g_b, n2, 'tok-bisu-beta-xxxxxxxxxxxx');
  select vault_secret_id into v_sec from public.meta_ads_conexoes where tenant_id = t_a;
  perform public.meta_ads_salvar_conexao(t_a, g_a, n1, 'tok-bisu-alfa-novo-xxxxxxxx');
  perform public._ok((select token = 'tok-bisu-alfa-novo-xxxxxxxx' from public.meta_ads_credencial(t_a)), 'C4 reautorizar troca o token');
  perform public._como(null, null);
  perform public._ok(not exists (select 1 from vault.secrets where id = v_sec), 'C4 …e apaga o anterior do Vault');
  perform public._servico();

  -- ================================================================= A1–A4 contas de anúncios
  perform public._ok(public.meta_ads_salvar_contas(t_a, g_a, jsonb_build_array(jsonb_build_object('id', k1, 'nome', 'Conta A', 'moeda', 'BRL'))) = 1,
                     'A1 conta de anúncios ligada à empresa A');
  v_r := public._recusa(format('select public.meta_ads_salvar_contas(%L, %L, %L::jsonb)', t_b, g_b, jsonb_build_array(jsonb_build_object('id', k1))));
  perform public._ok(v_r like '23505:%', 'A2 mesma conta em outra empresa: recusada');
  perform public.meta_ads_salvar_contas(t_a, g_a, '[]'::jsonb);
  perform public._ok(public.meta_ads_salvar_contas(t_b, g_b, jsonb_build_array(jsonb_build_object('id', k1))) = 1,
                     'A3 a empresa A removeu a conta: B pode usá-la');
  perform public.meta_ads_salvar_contas(t_b, g_b, '[]'::jsonb);
  perform public.meta_ads_salvar_contas(t_a, g_a, jsonb_build_array(jsonb_build_object('id', k1, 'nome', 'Conta A', 'moeda', 'BRL')));
  select id into v_conta from public.meta_ads_contas where tenant_id = t_a and conta_id = k1 and ativa;
  v_r := public._recusa(format('select public.meta_ads_salvar_contas(%L, %L, %L::jsonb)', t_a, g_a, '[{"id":"abc"}]'));
  perform public._ok(v_r like '22023:%', 'A4 ID de conta inválido: recusado');

  -- ================================================================= P1–P5 Páginas (Lead Ads)
  v_fonte := public.meta_ads_salvar_pagina(t_a, g_a, p1, 'Página A', 'tok-pagina-alfa-xxxxxxxxxx', fa1, ea1, c_a);
  perform public._ok((select tipo = 'meta_lead_ads' and status = 'ativa' and validada_em is not null and vault_secret_id is not null
                             and configuracao ->> 'page_id' = p1 and configuracao ->> 'origem' = 'login_empresas' and tenant_id = t_a
                        from public.fontes_leads where id = v_fonte),
                     'P1 Página vira fonte de Lead Ads da empresa A, validada, com token no Vault');
  v_r := public._recusa(format('select public.meta_ads_salvar_pagina(%L, %L, %L, %L, %L, %L, %L, %L)', t_b, g_b, p1, 'X', 'tok-pagina-beta-xxxxxxxxxx', fb1, eb1, g_b));
  perform public._ok(v_r like '23505:%', 'P2 mesma Página em outra empresa: recusada');
  v_fonte2 := public.meta_ads_salvar_pagina(t_a, g_a, p1, 'Página A', 'tok-pagina-alfa-2-xxxxxxxx', fa1, ea1, c_a);
  perform public._ok(v_fonte2 = v_fonte and (select count(*) = 1 from public.fontes_leads where tipo = 'meta_lead_ads' and configuracao ->> 'page_id' = p1),
                     'P3 conectar de novo atualiza a mesma fonte (sem duplicar)');
  perform public._ok(exists (select 1 from public.fonte_por_provedor('meta_lead_ads', p1) where id = v_fonte),
                     'P4 webhook encontra a fonte com o Meta Ads habilitado');
  perform public._como(null, null);
  update public.plataforma_integracoes set meta_conversoes = false;
  perform public._servico();
  perform public._ok(not exists (select 1 from public.fonte_por_provedor('meta_lead_ads', p1)),
                     'P5 Meta Ads desligado na plataforma: webhook de lead ignorado');
  perform public._como(null, null);
  update public.plataforma_integracoes set meta_conversoes = true;

  -- ================================================================= M1–M5 métricas e painel
  perform public._servico();
  perform public._ok(exists (select 1 from public.meta_ads_contas_para_sincronizar(10) where conta_ref = v_conta),
                     'M1 conta da empresa A na fila de leitura de métricas');
  v_n := public.meta_ads_registrar_metricas(v_conta, jsonb_build_array(
           jsonb_build_object('dia', '2026-10-30', 'campanhaId', camp, 'campanhaNome', 'Campanha 1', 'investimento', 300, 'impressoes', 1000, 'cliques', 40, 'leads', 6,
                              'conversoesMeta', 3, 'valorConversoesMeta', 2100.5),
           jsonb_build_object('dia', '2026-10-31', 'campanhaId', camp, 'campanhaNome', 'Campanha 1', 'investimento', 200, 'impressoes', 800, 'cliques', 20, 'leads', 4),
           jsonb_build_object('dia', 'ontem', 'campanhaId', camp)));
  perform public._ok(v_n = 2 and (select ultima_sincronizacao_em is not null from public.meta_ads_conexoes where tenant_id = t_a),
                     'M2 métricas gravadas (linha inválida descartada)');
  -- Lead do formulário da campanha entra no funil da A; depois vira venda.
  select negociacao_id into v_neg from public.ingerir_lead_fonte(v_fonte, '1000000000000001', 'Ana Lead', '11955550001', 'ana@exemplo.com', null, null, '[]'::jsonb,
           jsonb_build_object('source', 'meta_lead_ads', 'leadgen_id', '1000000000000001', 'page_id', p1, 'campaign_id', camp));
  perform public._ok(v_neg is not null, 'M3 lead de Lead Ads entra no funil da empresa A');
  perform public._como(null, null);
  perform set_config('session_replication_role', 'replica', true);
  insert into public.fechamentos (negociacao_id, valor_vendido, contrato_enviado, contrato_assinado, status_pagamento, status_onboarding,
                                  fechado_por, data_fechamento, responsavel_id, tenant_id)
  values (v_neg, 1500, false, false, 'pendente', 'nao_iniciado', g_a, current_date, c_a, t_a);
  perform set_config('session_replication_role', 'origin', true);

  perform public._como(g_a, 'teste-alfa');
  select to_jsonb(x) into v_j from public.meta_ads_painel(date '2026-10-01', current_date) x where x.campanha_id = camp;
  perform public._ok((v_j ->> 'investimento')::numeric = 500 and (v_j ->> 'leads_meta')::int = 10 and (v_j ->> 'leads_crm')::int = 1
                     and (v_j ->> 'vendas')::int = 1 and (v_j ->> 'faturamento')::numeric = 1500,
                     'M4 painel da A: investimento e leads da Meta + leads, venda e faturamento do CRM');
  perform public._ok((v_j ->> 'conversoes_meta')::int = 3 and (v_j ->> 'valor_conversoes_meta')::numeric = 2100.5
                     and (v_j ->> 'faturamento')::numeric = 1500,
                     'M4b atribuição da Meta em colunas próprias, sem alterar o faturamento do CRM');
  perform public._como(g_b, 'teste-beta');
  perform public._ok(not exists (select 1 from public.meta_ads_painel(date '2026-10-01', current_date)), 'M5 painel da B não mostra nada da A');
  v_j := public.meta_ads_da_empresa();
  perform public._ok(v_j -> 'conexao' ->> 'negocio_id' = n2 and jsonb_array_length(v_j -> 'contas') = 0 and jsonb_array_length(v_j -> 'paginas') = 0
                     and v_j::text not like '%tok-%',
                     'M5 estado da B: só o portfólio dela, sem token');

  -- ================================================================= R1–R4 regras e permissões
  perform public._como(c_a, 'teste-alfa');
  v_r := public._recusa('select public.meta_ads_painel(current_date - 7, current_date)');
  perform public._ok(v_r like '42501:%', 'R1 closer não vê o painel (só Administrador/gerente)');
  perform public._como(g_a, 'teste-alfa');
  v_r := public._recusa(format('select * from public.meta_ads_credencial(%L)', t_a));
  perform public._ok(v_r like '42501:%', 'R2 Administrador (authenticated) não lê token nem da própria empresa');
  v_r := public._recusa(format('select public.meta_ads_salvar_conexao(%L, %L, %L, %L)', t_a, g_a, n1, 'tok-xxxxxxxxxxxxxxxxxxxxxx'));
  perform public._ok(v_r like '42501:%', 'R2 …nem grava conexão direto');
  perform public._como(null, null);
  perform set_config('role', 'anon', true);
  v_r := public._recusa('select public.meta_ads_painel(current_date - 7, current_date)');
  perform set_config('role', 'postgres', true);
  perform public._ok(v_r like '42501:%', 'R3 anon: recusado');
  perform public._servico();
  v_r := public._recusa(format('select public.meta_ads_salvar_conexao(%L, %L, %L, %L)', t_a, c_a, n1, 'tok-xxxxxxxxxxxxxxxxxxxxxx'));
  perform public._ok(v_r like '42501:%', 'R4 usuário que não administra integrações: recusado');
  perform public._como(null, null);
  update public.assinaturas set plano_id = (select id from public.planos where codigo = 'starter') where tenant_id = t_b;
  perform public._servico();
  v_r := public._recusa(format('select public.meta_ads_salvar_contas(%L, %L, %L::jsonb)', t_b, g_b, '[]'));
  perform public._ok(v_r like 'RX003:%' or v_r like 'RX030:%', 'R4 plano sem Meta Ads: recusado');

  -- ================================================================= D1–D3 desconectar
  perform public._como(g_a, 'teste-alfa');
  perform public.meta_ads_desconectar();
  perform public._como(null, null);
  perform public._ok((select situacao = 'desconectada' and vault_secret_id is null from public.meta_ads_conexoes where tenant_id = t_a)
                     and not exists (select 1 from public.meta_ads_contas where tenant_id = t_a and ativa),
                     'D1 desconectar apaga o token e para as contas');
  perform public._ok((select status = 'revogada' and vault_secret_id is null from public.fontes_leads where id = v_fonte),
                     'D2 a Página do login deixa de receber leads (fonte revogada, token apagado)');
  perform public._ok(exists (select 1 from public.negociacoes where id = v_neg) and exists (select 1 from public.meta_ads_metricas where tenant_id = t_a),
                     'D3 leads e métricas já gravadas continuam');
  update public.assinaturas set plano_id = (select id from public.planos where codigo = 'business') where tenant_id = t_b;
  perform public._servico();
  perform public.meta_ads_salvar_conexao(t_b, g_b, n1, 'tok-bisu-beta-n1-xxxxxxxxx');
  perform public._ok((select negocio_id = n1 from public.meta_ads_credencial(t_b)), 'D3 portfólio desconectado da A pode ser ligado a outra empresa');
end;
$$;

rollback;
