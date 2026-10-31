-- ===========================================================================
-- Inscrição do app AVANTE na conta do WhatsApp (WABA) de cada cliente
-- (depende de 20261105090000).
--
-- Decisão de segurança: o AVANTE NUNCA retira sozinho a inscrição na Meta
-- (DELETE /<WABA>/subscribed_apps). Retirar pode cortar as notificações de outro
-- número legítimo da mesma conta, inclusive de outra empresa, se houver corrida com
-- uma conexão em andamento. Em vez disso:
--   * "Desconectar" revoga a credencial e o vínculo local (como antes), audita e,
--     se a conta ficou sem número ativo, registra a LIMPEZA PENDENTE na auditoria;
--   * cadastro recusado pelo banco depois da inscrição: o servidor registra a mesma
--     pendência (a inscrição fica na Meta);
--   * webhook de número desconectado é ignorado por inteiro: mensagens, ecos,
--     histórico, contatos (já eram), e agora também status e andamento do histórico.
-- "Em uso" = qualquer número NÃO desconectado da conta, com ou sem token, em
-- qualquer empresa. Nenhuma função nova é chamável por anon/authenticated.
-- ===========================================================================

-- Conta em uso por algum número não desconectado (qualquer empresa, com ou sem token).
create function public.whatsapp_waba_em_uso(p_waba_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.whatsapp_numeros where waba_id = p_waba_id and situacao <> 'desconectado');
$$;

-- Registra que a inscrição do app na conta pode ser limpa na Meta (só se a conta
-- não tem número ativo agora). Não chama a Meta. Quem limpar depois confere de novo.
-- Devolve true quando registrou a pendência.
create function public.whatsapp_inscricao_pendencia(p_tenant uuid, p_numero uuid, p_waba_id text, p_origem text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_origem is null or p_origem not in ('desconexao', 'cadastro_recusado')
     or p_waba_id is null or p_waba_id !~ '^[0-9]{5,30}$'
     or not exists (select 1 from public.tenants where id = p_tenant) then
    raise exception 'Registro de inscrição inválido.' using errcode = '22023';
  end if;
  -- Número informado precisa ser da mesma empresa e da mesma conta.
  if p_numero is not null and not exists (
    select 1 from public.whatsapp_numeros where id = p_numero and tenant_id = p_tenant and waba_id = p_waba_id) then
    raise exception 'Número não encontrado nesta empresa.' using errcode = 'P0002';
  end if;
  if public.whatsapp_waba_em_uso(p_waba_id) then return false; end if;
  insert into public.admin_auditoria (ator_id, acao, tenant_id, detalhes)
  values (null, 'whatsapp_inscricao_limpeza_pendente', p_tenant,
          jsonb_build_object('origem', p_origem, 'waba', p_waba_id, 'numero', p_numero));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ações do Administrador (mesmo corpo de 20261105090000). Novo: ao desconectar
-- um número que ainda não estava desconectado, registra a pendência de limpeza
-- da inscrição se a conta ficou sem número ativo. Desconectar de novo não repete.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_acao(p_numero uuid, p_acao text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.exigir_administrador_integracoes();
  v_n      public.whatsapp_numeros;
begin
  select * into v_n from public.whatsapp_numeros where id = p_numero and tenant_id = v_tenant for update;
  if v_n.id is null then raise exception 'Número não encontrado nesta empresa.' using errcode = 'P0002'; end if;
  if p_acao = 'pausar' then
    update public.whatsapp_numeros set situacao = 'pausado' where id = p_numero and situacao = 'conectado';
    update public.whatsapp_numeros set meta_pausou = false where id = p_numero and meta_pausou;
    update public.fontes_leads set status = 'pausada' where id = v_n.fonte_id and status = 'ativa';
  elsif p_acao = 'retomar' then
    if v_n.situacao = 'desconectado' then raise exception 'Conecte o número de novo.' using errcode = '23514'; end if;
    if v_n.situacao = 'pendente_registro' then
      raise exception 'Conclua o registro do número na Meta antes de usá-lo.' using errcode = '23514';
    end if;
    if v_n.meta_desligado_em is not null then
      raise exception 'A Meta desligou este número temporariamente (troca de aparelho ou novo registro no app WhatsApp Business). Ele volta sozinho quando a Meta reconectar.'
        using errcode = '23514';
    end if;
    update public.whatsapp_numeros set situacao = 'conectado' where id = p_numero;
    update public.fontes_leads set status = 'ativa' where id = v_n.fonte_id and status = 'pausada';
  elsif p_acao = 'desconectar' then
    if v_n.vault_secret_id is not null then delete from vault.secrets where id = v_n.vault_secret_id; end if;
    update public.whatsapp_numeros set situacao = 'desconectado', vault_secret_id = null where id = p_numero;
    update public.fontes_leads set status = 'pausada' where id = v_n.fonte_id and status = 'ativa';
    if v_n.situacao <> 'desconectado' then
      perform public.whatsapp_inscricao_pendencia(v_tenant, p_numero, v_n.waba_id, 'desconexao');
    end if;
  elsif p_acao = 'revisar_cobranca' then
    -- O Administrador confirma que revisou o aviso da Meta; continua "somente gratuitos".
    update public.whatsapp_numeros set bloqueado_por_cobranca = false where id = p_numero;
  else
    raise exception 'Ação inválida.' using errcode = '22023';
  end if;
  insert into public.admin_auditoria (ator_id, acao, tenant_id, detalhes)
  values ((select auth.uid()), 'whatsapp_' || p_acao, v_tenant, jsonb_build_object('numero', p_numero));
end;
$$;

-- ---------------------------------------------------------------------------
-- Webhook de número desconectado: ignorado por inteiro.
-- Status: a função atual (20261031090000) vira interna, sem nenhuma permissão, e
-- a de mesmo nome só confere o número antes de chamá-la.
-- ---------------------------------------------------------------------------
alter function public.whatsapp_registrar_status(text, text, text, boolean, text, text, text)
  rename to whatsapp_registrar_status_interno;
revoke all on function public.whatsapp_registrar_status_interno(text, text, text, boolean, text, text, text)
  from public, anon, authenticated, service_role;

create function public.whatsapp_registrar_status(
  p_phone_number_id text, p_wa_message_id text, p_status text, p_cobravel boolean, p_categoria text, p_erro text,
  p_tipo_preco text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_situacao text;
begin
  select situacao into v_situacao from public.whatsapp_numeros where phone_number_id = p_phone_number_id;
  if v_situacao is null then return jsonb_build_object('ignorado', 'numero_desconhecido'); end if;
  if v_situacao = 'desconectado' then return jsonb_build_object('ignorado', 'numero_desconectado'); end if;
  return public.whatsapp_registrar_status_interno(p_phone_number_id, p_wa_message_id, p_status, p_cobravel, p_categoria, p_erro, p_tipo_preco);
end;
$$;

-- Andamento do histórico (mesmo corpo de 20261104090000, com a trava do número).
create or replace function public.whatsapp_historico_andamento(p_phone_number_id text, p_fase integer, p_progresso integer, p_recusado boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n public.whatsapp_numeros;
begin
  select * into v_n from public.whatsapp_numeros where phone_number_id = p_phone_number_id;
  if v_n.id is null or v_n.situacao = 'desconectado' then return; end if;
  insert into public.whatsapp_sincronizacoes (numero_id, tipo, situacao, fase, progresso)
  values (v_n.id, 'historico',
          case when p_recusado then 'recusada' when p_progresso >= 100 and p_fase >= 2 then 'concluida' else 'recebendo' end,
          p_fase, least(greatest(p_progresso, 0), 100))
  on conflict (numero_id, tipo) do update
    set situacao = excluded.situacao, fase = coalesce(excluded.fase, public.whatsapp_sincronizacoes.fase),
        progresso = coalesce(excluded.progresso, public.whatsapp_sincronizacoes.progresso),
        erro = case when p_recusado then 'A empresa não compartilhou o histórico no app WhatsApp Business.' end,
        atualizada_em = now();
end;
$$;

do $perm$
declare
  f text;
begin
  foreach f in array array[
    'public.whatsapp_waba_em_uso(text)',
    'public.whatsapp_inscricao_pendencia(uuid, uuid, text, text)',
    'public.whatsapp_registrar_status(text, text, text, boolean, text, text, text)',
    'public.whatsapp_historico_andamento(text, integer, integer, boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$perm$;
