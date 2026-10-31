set client_encoding = 'UTF8'; -- arquivo em UTF-8 (acentos das mensagens)
-- ===========================================================================
-- Teste: webhook account_update (migration 20261105090000).
-- ONDE RODAR: só cópia LOCAL crm_rx7_*. Termina em ROLLBACK.
--
--  A1–A6  coexistência: ACCOUNT_OFFBOARDED pausa (sem apagar nada), "Retomar"
--         barrado, ACCOUNT_RECONNECTED retoma só o que o AVANTE pausou
--  D1–D5  desvinculação: só o servidor lê tokens/desconecta; desconexão apaga o
--         token e mantém conversas; nova conexão limpa o aviso
--  P1–P3  permissões e isolamento entre empresas
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
create function public._recusa(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'aceito';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$$;
grant execute on function public._recusa(text) to authenticated, service_role;
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
  g_a   uuid := '60000000-0000-4000-8000-0000000000a1';
  c_a   uuid := '60000000-0000-4000-8000-0000000000a2';
  g_b   uuid := '60000000-0000-4000-8000-0000000000b1';
  t_a   uuid := 'a9bc5b35-0515-49d7-b5d6-4db635003d35';
  t_b   uuid := '82c2cd79-b9aa-4b4d-8de9-88d51065ca7f';
  w1 constant text := '640000000000001';
  w2 constant text := '640000000000002';
  fa1 uuid; ea1 uuid; fb1 uuid; eb1 uuid;
  n_co uuid; n_cl uuid; n_b uuid; v_sec uuid; v_ts timestamptz; v_conv integer;
  v_j jsonb; v_r text; v_b boolean;
begin
  perform public._como(null, null);
  select id into fa1 from public.funis where tenant_id = t_a and padrao;
  select id into ea1 from public.etapas_funil where funil_id = fa1 and etapa_inicial;
  select id into fb1 from public.funis where tenant_id = t_b and padrao;
  select id into eb1 from public.etapas_funil where funil_id = fb1 and etapa_inicial;
  update public.plataforma_integracoes set whatsapp_oficial = true;

  -- Empresa A: um número em coexistência e um Cloud API (registrado) na MESMA conta W1. Empresa B: conta W2.
  perform public._servico();
  n_co := public.whatsapp_salvar_numero(t_a, g_a, '540000000000001', w1, '+55 11 4400-0001', 'Alfa', 'token-coex-alfa-xxxx', 'WA App', fa1, ea1, c_a, 'coexistencia');
  n_cl := public.whatsapp_salvar_numero(t_a, g_a, '540000000000002', w1, '+55 11 4400-0002', 'Alfa', 'token-cloud-alfa-xxx', 'WA API', fa1, ea1, c_a);
  perform public.whatsapp_registro_reservar(n_cl);
  perform public.whatsapp_registro_resultado(n_cl, true, null);
  n_b := public.whatsapp_salvar_numero(t_b, g_b, '540000000000003', w2, '+55 21 4400-0003', 'Beta', 'token-coex-beta-xxxx', 'WA B', fb1, eb1, g_b, 'coexistencia');
  v_j := public.whatsapp_registrar_entrada('540000000000001', 'wamid.AU1', '5511955550001', 'Ana Coex', 'text', 'Oi', now());
  perform public._como(null, null);
  perform public._ok((select count(*) = 3 from public.whatsapp_numeros where id in (n_co, n_cl, n_b) and situacao = 'conectado'), 'A0 três números conectados (coexistência A, Cloud API A, coexistência B)');
  select count(*) into v_conv from public.conversas where whatsapp_numero_id = n_co;

  -- ================================================================= A1–A6 coexistência
  perform public._servico();
  v_j := public.whatsapp_coexistencia_evento(w1, 'ACCOUNT_OFFBOARDED');
  perform public._como(null, null);
  perform public._ok(v_j = '{"resultado": "pausado", "numeros": 1}'::jsonb, 'A1 ACCOUNT_OFFBOARDED: só o número em coexistência da conta é afetado');
  perform public._ok((select situacao = 'pausado' and meta_pausou and meta_desligado_em is not null and vault_secret_id is not null
                             and ultimo_erro like 'A Meta desligou temporariamente%' from public.whatsapp_numeros where id = n_co),
                     'A1 ...fica PAUSADO pela Meta, com aviso no painel e o token mantido');
  perform public._ok((select status = 'pausada' from public.fontes_leads where id = (select fonte_id from public.whatsapp_numeros where id = n_co)),
                     'A1 ...a fonte de leads também pausa');
  perform public._ok((select situacao = 'conectado' and not meta_pausou and meta_desligado_em is null from public.whatsapp_numeros where id = n_cl),
                     'A1 ...o número Cloud API da mesma conta não muda');
  perform public._ok((select situacao = 'conectado' from public.whatsapp_numeros where id = n_b), 'A1 ...nem o número da empresa B');
  perform public._ok((select count(*) from public.conversas where whatsapp_numero_id = n_co) = v_conv, 'A1 ...nenhuma conversa apagada');
  perform public._ok(exists (select 1 from public.whatsapp_eventos_conta where waba_id = w1 and evento = 'ACCOUNT_OFFBOARDED' and resultado = 'pausado' and numeros = 1),
                     'A1 ...aviso registrado');

  perform public._servico();
  perform public._ok(not exists (select 1 from public.whatsapp_obter_token(n_co)), 'A2 pausado pela Meta: credencial de envio negada (nada sai)');
  perform public._como(g_a, 'teste-alfa');
  v_r := public._recusa(format('select public.whatsapp_acao(%L, %L)', n_co, 'retomar'));
  perform public._ok(v_r like '23514: A Meta desligou este número temporariamente%', 'A2 "Retomar" do Administrador barrado até a Meta reconectar');

  perform public._como(null, null);
  select meta_desligado_em into v_ts from public.whatsapp_numeros where id = n_co;
  perform public._servico();
  perform public.whatsapp_coexistencia_evento(w1, 'ACCOUNT_OFFBOARDED');
  perform public._como(null, null);
  perform public._ok((select meta_desligado_em = v_ts and meta_pausou and situacao = 'pausado' from public.whatsapp_numeros where id = n_co),
                     'A3 aviso repetido: nada muda (idempotente)');

  perform public._servico();
  v_j := public.whatsapp_coexistencia_evento(w1, 'ACCOUNT_RECONNECTED');
  perform public._como(null, null);
  perform public._ok(v_j ->> 'resultado' = 'retomado'
                     and (select situacao = 'conectado' and not meta_pausou and meta_desligado_em is null and ultimo_erro is null from public.whatsapp_numeros where id = n_co),
                     'A4 ACCOUNT_RECONNECTED: volta a CONECTADO, aviso limpo');
  perform public._ok((select status = 'ativa' from public.fontes_leads where id = (select fonte_id from public.whatsapp_numeros where id = n_co)), 'A4 ...a fonte volta a ativa');
  perform public._servico();
  perform public._ok(exists (select 1 from public.whatsapp_obter_token(n_co)), 'A4 ...e a credencial de envio volta');
  v_j := public.whatsapp_coexistencia_evento(w1, 'ACCOUNT_RECONNECTED');
  perform public._ok(v_j ->> 'resultado' = 'sem_numero', 'A4 ...reconexão repetida não muda nada');

  -- pausa do Administrador é respeitada (antes ou durante o desligamento)
  perform public._como(g_a, 'teste-alfa');
  perform public.whatsapp_acao(n_co, 'pausar');
  perform public._servico();
  perform public.whatsapp_coexistencia_evento(w1, 'ACCOUNT_OFFBOARDED');
  perform public.whatsapp_coexistencia_evento(w1, 'ACCOUNT_RECONNECTED');
  perform public._como(null, null);
  perform public._ok((select situacao = 'pausado' and not meta_pausou and meta_desligado_em is null from public.whatsapp_numeros where id = n_co),
                     'A5 número pausado pelo Administrador continua pausado depois da reconexão da Meta');
  perform public._como(g_a, 'teste-alfa');
  perform public.whatsapp_acao(n_co, 'retomar');
  perform public._servico();
  perform public.whatsapp_coexistencia_evento(w1, 'ACCOUNT_OFFBOARDED');
  perform public._como(g_a, 'teste-alfa');
  perform public.whatsapp_acao(n_co, 'pausar');
  perform public._servico();
  perform public.whatsapp_coexistencia_evento(w1, 'ACCOUNT_RECONNECTED');
  perform public._como(null, null);
  perform public._ok((select situacao = 'pausado' and not meta_pausou from public.whatsapp_numeros where id = n_co),
                     'A5 ...pausar à mão DURANTE o desligamento também impede a retomada automática');
  perform public._como(g_a, 'teste-alfa');
  perform public.whatsapp_acao(n_co, 'retomar');

  perform public._servico();
  v_j := public.whatsapp_coexistencia_evento('649999999999999', 'ACCOUNT_OFFBOARDED');
  perform public._ok(v_j ->> 'resultado' = 'sem_numero', 'A6 conta sem número no AVANTE: só registra');
  v_r := public._recusa($q$select public.whatsapp_coexistencia_evento('abc', 'ACCOUNT_OFFBOARDED')$q$);
  perform public._ok(v_r like '22023:%', 'A6 conta inválida recusada');
  v_r := public._recusa(format('select public.whatsapp_coexistencia_evento(%L, %L)', w1, 'PARTNER_REMOVED'));
  perform public._ok(v_r like '22023:%', 'A6 desvinculação não passa por aqui (precisa da conferência na Meta)');

  -- ================================================================= D1–D5 desvinculação
  perform public._ok((select count(*) = 2 and bool_and(token like 'token-%') from public.whatsapp_numeros_da_waba(w1)),
                     'D1 servidor recebe os números da conta com o token (para conferir na Meta)');
  perform public._ok(not exists (select 1 from public.whatsapp_numeros_da_waba(w1) where numero_id = n_b), 'D1 ...nunca o número de outra conta');

  perform public._como(null, null);
  select vault_secret_id into v_sec from public.whatsapp_numeros where id = n_cl;
  perform public._servico();
  v_b := public.whatsapp_desvincular_numero(n_cl, 'A empresa desvinculou o AVANTE desta conta do WhatsApp. Nada foi apagado; para voltar a usar, conecte o número de novo.');
  perform public._como(null, null);
  perform public._ok(v_b and (select situacao = 'desconectado' and vault_secret_id is null and desconectado_em is not null
                                     and desconexao_motivo like 'A empresa desvinculou%' and ultimo_erro like 'A empresa desvinculou%'
                                from public.whatsapp_numeros where id = n_cl),
                     'D2 acesso confirmado como encerrado: DESCONECTADO com o motivo');
  perform public._ok(not exists (select 1 from vault.secrets where id = v_sec), 'D2 ...o token sai do Vault');
  perform public._ok((select status = 'pausada' from public.fontes_leads where id = (select fonte_id from public.whatsapp_numeros where id = n_cl)), 'D2 ...a fonte pausa (não é excluída)');
  perform public._ok(exists (select 1 from public.admin_auditoria where acao = 'whatsapp_desconectado_pela_meta' and tenant_id = t_a), 'D2 ...auditado');
  perform public._servico();
  perform public._ok(not public.whatsapp_desvincular_numero(n_cl, 'de novo'), 'D3 repetido: nada a fazer');
  perform public._ok((select count(*) = 1 from public.whatsapp_numeros_da_waba(w1)), 'D3 ...e o número desconectado sai da lista da conta');

  perform public.whatsapp_avisar_numero(n_co, 'A Meta informou que o app WhatsApp Business se desconectou da API.');
  perform public.whatsapp_avisar_numero(n_cl, 'não deve gravar');
  perform public._como(null, null);
  perform public._ok((select ultimo_erro like 'A Meta informou%' and situacao = 'conectado' from public.whatsapp_numeros where id = n_co),
                     'D4 acesso mantido: só o aviso no painel, o número continua conectado');
  perform public._ok((select ultimo_erro like 'A empresa desvinculou%' from public.whatsapp_numeros where id = n_cl), 'D4 ...aviso não sobrescreve número desconectado');

  perform public._servico();
  perform public.whatsapp_salvar_numero(t_a, g_a, '540000000000002', w1, '+55 11 4400-0002', 'Alfa', 'token-cloud-alfa-novo', 'WA API', fa1, ea1, c_a);
  perform public._como(null, null);
  perform public._ok((select situacao = 'conectado' and desconectado_em is null and desconexao_motivo is null and not meta_pausou and meta_desligado_em is null
                        from public.whatsapp_numeros where id = n_cl),
                     'D5 nova conexão pelo Embedded Signup: volta a conectado e limpa o motivo');
  perform public._servico();
  perform public.whatsapp_coexistencia_evento(w2, 'ACCOUNT_OFFBOARDED');
  perform public.whatsapp_salvar_numero(t_b, g_b, '540000000000003', w2, '+55 21 4400-0003', 'Beta', 'token-coex-beta-novo', 'WA B', fb1, eb1, g_b, 'coexistencia');
  perform public._como(null, null);
  perform public._ok((select situacao = 'conectado' and meta_desligado_em is null and not meta_pausou from public.whatsapp_numeros where id = n_b),
                     'D5 ...coexistência refeita durante o desligamento: novo token limpa o estado');

  perform public._servico();
  perform public.whatsapp_registrar_evento_conta(w1, 'PARTNER_REMOVED', $s$x'; drop table--$s$, 'user', 'acesso_mantido', 2);
  perform public._como(null, null);
  perform public._ok((select motivo = 'XDROPTABLE' and iniciado_por = 'USER' from public.whatsapp_eventos_conta where evento = 'PARTNER_REMOVED' order by id desc limit 1),
                     'D6 motivo e origem gravados só como códigos (sem texto livre do aviso)');

  -- ================================================================= P1–P3 permissões e isolamento
  perform public._como(g_a, 'teste-alfa');
  foreach v_r in array array[
    format('select * from public.whatsapp_numeros_da_waba(%L)', w1),
    format('select public.whatsapp_desvincular_numero(%L, %L)', n_co, 'x'),
    format('select public.whatsapp_avisar_numero(%L, %L)', n_co, 'x'),
    format('select public.whatsapp_coexistencia_evento(%L, %L)', w1, 'ACCOUNT_OFFBOARDED'),
    format('select public.whatsapp_registrar_evento_conta(%L, %L, null, null, %L, 0)', w1, 'ACCOUNT_DELETED', 'sem_numero'),
    'select count(*) from public.whatsapp_eventos_conta'] loop
    perform public._ok(public._recusa(v_r) like '42501:%', 'P1 Administrador não chama: ' || left(v_r, 60));
  end loop;
  perform public._como(null, null);
  perform public._ok((select situacao = 'conectado' from public.whatsapp_numeros where id = n_co), 'P2 ...e nada mudou no número');
  perform public._ok(not exists (select 1 from information_schema.role_table_grants
                                   where table_name = 'whatsapp_eventos_conta' and grantee in ('anon', 'authenticated')),
                     'P3 registro dos avisos sem acesso para usuários');

  raise notice 'whatsapp_account_update_test.sql: todas as asserções passaram.';
end;
$$;

rollback;
