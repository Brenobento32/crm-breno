set client_encoding = 'UTF8'; -- arquivo em UTF-8 (acentos das mensagens)
-- ===========================================================================
-- Teste: inscrição do app na WABA (migration 20261106090000).
-- ONDE RODAR: só cópia LOCAL crm_rx7_*. Termina em ROLLBACK.
--
--  U1–U6  "em uso": qualquer número não desconectado da conta, com ou sem token,
--         pendente de registro incluído, em qualquer empresa
--  D1–D5  "Desconectar": revoga credencial e vínculo, audita; pendência de limpeza
--         só quando a conta fica sem número ativo; repetir não duplica
--  C1–C3  cadastro recusado: pendência só com a conta livre; validações
--  W1–W6  webhook de número desconectado ignorado por inteiro (mensagem, status,
--         ecos, histórico, andamento, contatos); o número ativo da mesma conta segue
--  P1–P3  permissões: nada novo chamável por authenticated/anon; a função interna de
--         status nem pelo service_role
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
create function public._pendencias(p_waba text)
returns integer language sql as $$
  select count(*)::integer from public.admin_auditoria where acao = 'whatsapp_inscricao_limpeza_pendente' and detalhes ->> 'waba' = p_waba;
$$;
grant execute on function public._pendencias(text) to authenticated, service_role, anon;

do $$
declare
  g_a   uuid := '60000000-0000-4000-8000-0000000000a1';
  c_a   uuid := '60000000-0000-4000-8000-0000000000a2';
  g_b   uuid := '60000000-0000-4000-8000-0000000000b1';
  t_a   uuid := 'a9bc5b35-0515-49d7-b5d6-4db635003d35';
  t_b   uuid := '82c2cd79-b9aa-4b4d-8de9-88d51065ca7f';
  w1 constant text := '650000000000001';   -- conta compartilhada pelas empresas A e B
  w2 constant text := '650000000000002';   -- conta só da empresa A (número sem token)
  w3 constant text := '650000000000003';   -- conta livre (cadastro recusado)
  fa1 uuid; ea1 uuid; fb1 uuid; eb1 uuid;
  n_a uuid; n_b uuid; n_t uuid; n_p uuid; n_x uuid;
  v_j jsonb; v_r text; v_st text; v_n integer; v_conv integer; v_msgs integer;
begin
  perform public._como(null, null);
  select id into fa1 from public.funis where tenant_id = t_a and padrao;
  select id into ea1 from public.etapas_funil where funil_id = fa1 and etapa_inicial;
  select id into fb1 from public.funis where tenant_id = t_b and padrao;
  select id into eb1 from public.etapas_funil where funil_id = fb1 and etapa_inicial;
  update public.plataforma_integracoes set whatsapp_oficial = true;

  perform public._servico();
  n_a := public.whatsapp_salvar_numero(t_a, g_a, '550000000000001', w1, '+55 11 4500-0001', 'Alfa', 'tok-insc-alfa-xxxxxx', 'WA A', fa1, ea1, c_a, 'coexistencia');
  n_b := public.whatsapp_salvar_numero(t_b, g_b, '550000000000002', w1, '+55 21 4500-0002', 'Beta', 'tok-insc-beta-xxxxxx', 'WA B', fb1, eb1, g_b, 'coexistencia');
  n_t := public.whatsapp_salvar_numero(t_a, g_a, '550000000000003', w2, '+55 11 4500-0003', 'Alfa', 'tok-insc-semtok-xxxx', 'WA T', fa1, ea1, c_a, 'coexistencia');
  n_p := public.whatsapp_salvar_numero(t_a, g_a, '550000000000004', w2, '+55 11 4500-0004', 'Alfa', 'tok-insc-pend-xxxxxx', 'WA P', fa1, ea1, c_a);
  -- Mensagens recebidas antes (para conferir que nada é apagado nem muda depois).
  v_j := public.whatsapp_registrar_entrada('550000000000001', 'wamid.IW1', '5511955551001', 'Ana', 'text', 'Oi A', now());
  v_j := public.whatsapp_registrar_entrada('550000000000002', 'wamid.IW2', '5521955552002', 'Bia', 'text', 'Oi B', now());
  perform public._como(null, null);
  -- Número ativo SEM token (estado que nenhuma regra do banco proíbe).
  delete from vault.secrets where id = (select vault_secret_id from public.whatsapp_numeros where id = n_t);
  update public.whatsapp_numeros set vault_secret_id = null where id = n_t;

  -- ================================================================= U1–U6 em uso
  perform public._servico();
  perform public._ok(public.whatsapp_waba_em_uso(w1), 'U1 conta compartilhada A+B: em uso');
  perform public._ok(public.whatsapp_waba_em_uso(w2), 'U2 conta com número sem token e número pendente: em uso');
  perform public._ok(not public.whatsapp_waba_em_uso(w3), 'U3 conta sem número: livre');
  perform public._ok((select situacao = 'pendente_registro' from public.whatsapp_numeros where id = n_p), 'U4 (número P pendente de registro)');
  perform public._ok(not exists (select 1 from public.whatsapp_numeros_da_waba(w2) where numero_id = n_t),
                     'U5 (o número sem token não aparece na lista com credencial…)');
  perform public._ok(public.whatsapp_waba_em_uso(w2), 'U6 …mas conta como em uso');

  -- ================================================================= D1–D5 Desconectar
  perform public._como(null, null);
  select count(*) into v_conv from public.conversas where whatsapp_numero_id in (n_a, n_b);
  select count(*) into v_msgs from public.mensagens where whatsapp_numero_id in (n_a, n_b);
  perform public._como(g_a, 'teste-alfa');
  perform public.whatsapp_acao(n_a, 'desconectar');
  perform public._como(null, null);
  perform public._ok((select situacao = 'desconectado' and vault_secret_id is null from public.whatsapp_numeros where id = n_a),
                     'D1 A desconecta: credencial revogada e vínculo local desfeito');
  perform public._ok(exists (select 1 from public.admin_auditoria where acao = 'whatsapp_desconectar' and tenant_id = t_a and detalhes ->> 'numero' = n_a::text),
                     'D1 …auditado como antes');
  perform public._ok(public._pendencias(w1) = 0, 'D2 conta ainda usada pela empresa B: NENHUMA pendência de limpeza');
  perform public._ok((select situacao = 'conectado' and vault_secret_id is not null from public.whatsapp_numeros where id = n_b),
                     'D2 …e o número da empresa B segue conectado, com token');

  perform public._como(g_b, 'teste-beta');
  v_r := public._recusa(format('select public.whatsapp_acao(%L, %L)', n_a, 'desconectar'));
  perform public._ok(v_r like 'P0002:%', 'D3 empresa B não desconecta número da empresa A');
  perform public.whatsapp_acao(n_b, 'desconectar');
  perform public._como(null, null);
  perform public._ok(public._pendencias(w1) = 1
                     and exists (select 1 from public.admin_auditoria where acao = 'whatsapp_inscricao_limpeza_pendente' and tenant_id = t_b
                                  and detalhes ->> 'origem' = 'desconexao' and detalhes ->> 'numero' = n_b::text and detalhes::text not like '%tok-%'),
                     'D4 último número da conta: pendência registrada na empresa B, sem token');
  perform public._como(g_b, 'teste-beta');
  perform public.whatsapp_acao(n_b, 'desconectar');
  perform public._como(null, null);
  perform public._ok(public._pendencias(w1) = 1, 'D5 desconectar de novo: não duplica a pendência');
  perform public._ok((select count(*) from public.conversas where whatsapp_numero_id in (n_a, n_b)) = v_conv
                     and (select count(*) from public.mensagens where whatsapp_numero_id in (n_a, n_b)) = v_msgs,
                     'D5 conversas e mensagens preservadas');

  perform public._como(g_a, 'teste-alfa');
  perform public.whatsapp_acao(n_p, 'desconectar');
  perform public._como(null, null);
  perform public._ok(public._pendencias(w2) = 0, 'D5 conta W2 ainda tem número ativo SEM token: nenhuma pendência');

  -- ================================================================= C1–C3 cadastro recusado
  perform public._servico();
  perform public._ok(public.whatsapp_inscricao_pendencia(t_a, null, w3, 'cadastro_recusado') and public._pendencias(w3) = 1,
                     'C1 cadastro recusado com a conta livre: pendência registrada');
  perform public._ok(not public.whatsapp_inscricao_pendencia(t_a, null, w2, 'cadastro_recusado') and public._pendencias(w2) = 0,
                     'C2 cadastro recusado numa conta em uso: nada registrado');
  v_r := public._recusa(format('select public.whatsapp_inscricao_pendencia(%L, %L, %L, %L)', t_a, n_b, w1, 'desconexao'));
  perform public._ok(v_r like 'P0002:%', 'C3 número de outra empresa: recusado');
  v_r := public._recusa(format('select public.whatsapp_inscricao_pendencia(%L, %L, %L, %L)', t_a, n_a, w3, 'desconexao'));
  perform public._ok(v_r like 'P0002:%', 'C3 conta diferente da do número: recusado');
  v_r := public._recusa(format('select public.whatsapp_inscricao_pendencia(%L, %L, %L, %L)', t_a, null, w3, 'outra'));
  perform public._ok(v_r like '22023:%', 'C3 origem fora da lista: recusado');

  -- ================================================================= W1–W6 webhook de número desconectado
  perform public._como(null, null);
  select status::text into v_st from public.mensagens where whatsapp_message_id = 'wamid.IW1';
  select count(*) into v_msgs from public.mensagens where whatsapp_numero_id = n_a;
  perform public._servico();
  v_j := public.whatsapp_registrar_entrada('550000000000001', 'wamid.IW9', '5511955551001', 'Ana', 'text', 'conteudo secreto', now());
  perform public._ok(v_j ->> 'ignorado' = 'numero_desconectado', 'W1 mensagem nova para número desconectado: ignorada');
  v_j := public.whatsapp_registrar_status('550000000000001', 'wamid.IW1', 'read', true, 'service', null, 'regular');
  perform public._ok(v_j ->> 'ignorado' = 'numero_desconectado', 'W2 status para número desconectado: ignorado');
  v_j := public.whatsapp_registrar_mensagens_app('550000000000001', 'eco_app',
           jsonb_build_array(jsonb_build_object('id', 'wamid.IW8', 'telefone', '5511955551001', 'da_empresa', true, 'tipo', 'text', 'texto', 'eco secreto')));
  perform public._ok(v_j ->> 'ignorado' = 'numero_desconectado', 'W3 eco do app: ignorado');
  perform public.whatsapp_historico_andamento('550000000000001', 1, 50, false);
  perform public._ok(public.whatsapp_registrar_contatos_app('550000000000001', jsonb_build_array(jsonb_build_object('telefone', '5511955551009', 'nome', 'X'))) = 0,
                     'W4 contatos do app: ignorados');
  perform public._como(null, null);
  perform public._ok(not exists (select 1 from public.whatsapp_sincronizacoes where numero_id = n_a and tipo = 'historico'),
                     'W5 andamento do histórico: nada gravado');
  perform public._ok((select count(*) from public.mensagens where whatsapp_numero_id = n_a) = v_msgs
                     and not exists (select 1 from public.mensagens where conteudo like '%secreto%')
                     and (select status::text from public.mensagens where whatsapp_message_id = 'wamid.IW1') is not distinct from v_st,
                     'W5 nenhum conteúdo gravado, status antigo intacto');
  perform public._ok((select coalesce(sum(cobradas), 0) = 0 from public.whatsapp_franquia where numero_id = n_a)
                     and not exists (select 1 from public.whatsapp_consumo where numero_id = n_a and cobrancas_meta > 0),
                     'W5 cobrança não contada para número desconectado');

  -- Número ATIVO segue normal (o wrapper não muda o comportamento dele).
  perform public._servico();
  n_x := public.whatsapp_salvar_numero(t_b, g_b, '550000000000005', w1, '+55 21 4500-0005', 'Beta', 'tok-insc-beta2-xxxxx', 'WA B2', fb1, eb1, g_b, 'coexistencia');
  v_j := public.whatsapp_registrar_entrada('550000000000005', 'wamid.IW5', '5521955552005', 'Caio', 'text', 'Oi B2', now());
  perform public._ok(v_j ->> 'ignorado' is null, 'W6 número ativo da mesma conta: mensagem entra');
  v_j := public.whatsapp_registrar_status('550000000000005', 'wamid.IW5', 'read', false, null, null, null);
  perform public._ok(v_j ->> 'ignorado' is null and v_j ? 'mensagem', 'W6 …e o status é processado pela função de sempre');
  perform public.whatsapp_historico_andamento('550000000000005', 1, 40, false);
  perform public._como(null, null);
  perform public._ok(exists (select 1 from public.whatsapp_sincronizacoes where numero_id = n_x and tipo = 'historico' and progresso = 40),
                     'W6 …e o andamento do histórico é gravado');

  -- ================================================================= P1–P3 permissões
  perform public._como(g_a, 'teste-alfa');
  v_r := public._recusa(format('select public.whatsapp_waba_em_uso(%L)', w1));
  perform public._ok(v_r like '42501:%', 'P1 authenticated: whatsapp_waba_em_uso recusado');
  v_r := public._recusa(format('select public.whatsapp_inscricao_pendencia(%L, %L, %L, %L)', t_a, null, w3, 'cadastro_recusado'));
  perform public._ok(v_r like '42501:%', 'P1 authenticated: whatsapp_inscricao_pendencia recusado');
  v_r := public._recusa(format('select public.whatsapp_registrar_status(%L, %L, %L, %L, %L, %L, %L)', '550000000000005', 'wamid.IW5', 'read', false, null, null, null));
  perform public._ok(v_r like '42501:%', 'P1 authenticated: whatsapp_registrar_status recusado');
  perform public._como(null, null);
  perform set_config('role', 'anon', true);
  v_r := public._recusa(format('select public.whatsapp_waba_em_uso(%L)', w1));
  perform set_config('role', 'postgres', true);
  perform public._ok(v_r like '42501:%', 'P2 anon: recusado');
  perform public._servico();
  v_r := public._recusa(format('select public.whatsapp_registrar_status_interno(%L, %L, %L, %L, %L, %L, %L)', '550000000000005', 'wamid.IW5', 'read', false, null, null, null));
  perform public._ok(v_r like '42501:%', 'P3 a função interna de status não é chamável nem pelo service_role');
  perform public._como(null, null);
end;
$$;

rollback;
