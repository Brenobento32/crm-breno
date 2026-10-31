-- ===========================================================================
-- WhatsApp: webhook `account_update` (coexistência e desvinculação da conta).
-- Depende de 20261104090000. NÃO PUBLICADA.
--
-- O que a Meta avisa e o que o AVANTE faz (documentação oficial, 31/10/2026):
--  * ACCOUNT_OFFBOARDED: o número em coexistência saiu da API por troca de
--    aparelho ou novo registro no app. É TEMPORÁRIO: a Meta reconecta sozinha
--    (ACCOUNT_RECONNECTED), mantendo o acesso à conta e os webhooks.
--    → o número é PAUSADO (não envia, não vira lead) e não pode ser "retomado"
--      à mão até a Meta reconectar. Nada é apagado; o token é mantido.
--  * ACCOUNT_RECONNECTED: volta ao normal. → só retoma o que o AVANTE pausou
--    por causa do desligamento (pausa feita pelo Administrador continua).
--  * PARTNER_REMOVED / PARTNER_APP_UNINSTALLED / ACCOUNT_DELETED: a empresa
--    desvinculou o parceiro, tirou as permissões do app ou a conta foi
--    excluída. O aviso NÃO diz com segurança qual parceiro foi removido, então
--    o servidor confere o acesso na própria Meta com o token de cada número:
--    só desconecta (e apaga o token do Vault) se a Meta confirmar que o acesso
--    acabou. Se o acesso continua, só registra (e avisa no painel quando a
--    Meta informou desconexão do app).
--
-- A empresa é sempre descoberta pelo `waba_id` gravado no banco, nunca pelo
-- corpo do aviso. Funções só para o servidor (service_role).
-- ===========================================================================

alter table public.whatsapp_numeros
  add column meta_desligado_em timestamptz,
  add column meta_pausou       boolean not null default false,
  add column desconectado_em   timestamptz,
  add column desconexao_motivo text check (desconexao_motivo is null or length(desconexao_motivo) <= 300);

comment on column public.whatsapp_numeros.meta_desligado_em is
  'A Meta avisou ACCOUNT_OFFBOARDED (coexistência: troca de aparelho ou novo registro no app). Volta a null com ACCOUNT_RECONNECTED ou nova conexão.';
comment on column public.whatsapp_numeros.meta_pausou is
  'A pausa atual foi feita pelo AVANTE por causa do desligamento da Meta (ACCOUNT_RECONNECTED retoma). Pausa do Administrador: false.';
comment on column public.whatsapp_numeros.desconexao_motivo is
  'Por que o número foi desconectado pelo aviso da Meta (desvinculação, permissões removidas, conta excluída).';

-- Registro dos avisos de conta recebidos (auditoria; só o servidor lê e grava).
create table public.whatsapp_eventos_conta (
  id           bigint generated always as identity primary key,
  recebido_em  timestamptz not null default now(),
  waba_id      text not null check (waba_id ~ '^[0-9]{5,30}$'),
  evento       text not null check (evento in ('PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED', 'ACCOUNT_DELETED',
                                                'ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED')),
  motivo       text check (motivo is null or motivo ~ '^[A-Z0-9_]{1,80}$'),
  iniciado_por text check (iniciado_por is null or iniciado_por ~ '^[A-Z0-9_]{1,40}$'),
  resultado    text not null check (resultado in ('pausado', 'retomado', 'desconectado', 'acesso_mantido', 'sem_numero')),
  numeros      integer not null default 0 check (numeros >= 0)
);
create index whatsapp_eventos_conta_waba on public.whatsapp_eventos_conta (waba_id, recebido_em desc);
alter table public.whatsapp_eventos_conta enable row level security;
revoke all on public.whatsapp_eventos_conta from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Nova conexão (troca do token pelo Embedded Signup) zera o estado do aviso.
-- ---------------------------------------------------------------------------
create function public.whatsapp_numeros_limpa_aviso_meta()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.situacao = 'desconectado' and new.situacao <> 'desconectado')
     or (new.vault_secret_id is not null and new.vault_secret_id is distinct from old.vault_secret_id) then
    new.meta_desligado_em := null;
    new.meta_pausou := false;
    new.desconectado_em := null;
    new.desconexao_motivo := null;
  end if;
  return new;
end;
$$;
revoke all on function public.whatsapp_numeros_limpa_aviso_meta() from public, anon, authenticated;
create trigger whatsapp_numeros_limpa_aviso_meta before update of situacao, vault_secret_id on public.whatsapp_numeros
  for each row execute function public.whatsapp_numeros_limpa_aviso_meta();

-- ---------------------------------------------------------------------------
-- Registro de um aviso (interno do servidor).
-- ---------------------------------------------------------------------------
create function public.whatsapp_registrar_evento_conta(
  p_waba_id text, p_evento text, p_motivo text, p_iniciado_por text, p_resultado text, p_numeros integer)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.whatsapp_eventos_conta (waba_id, evento, motivo, iniciado_por, resultado, numeros)
  values (p_waba_id, p_evento,
          nullif(left(regexp_replace(upper(coalesce(p_motivo, '')), '[^A-Z0-9_]', '', 'g'), 80), ''),
          nullif(left(regexp_replace(upper(coalesce(p_iniciado_por, '')), '[^A-Z0-9_]', '', 'g'), 40), ''),
          p_resultado, greatest(coalesce(p_numeros, 0), 0));
$$;

-- ---------------------------------------------------------------------------
-- Coexistência: ACCOUNT_OFFBOARDED (pausa) e ACCOUNT_RECONNECTED (retoma).
-- Vale mesmo com o WhatsApp desligado na plataforma (só torna o número MAIS
-- restrito ou devolve o estado anterior). Idempotente: aviso repetido não muda nada.
-- ---------------------------------------------------------------------------
create function public.whatsapp_coexistencia_evento(p_waba_id text, p_evento text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n   public.whatsapp_numeros;
  v_qtd integer := 0;
  v_res text;
begin
  if p_waba_id is null or p_waba_id !~ '^[0-9]{5,30}$' then raise exception 'Conta do WhatsApp inválida.' using errcode = '22023'; end if;
  if p_evento is null or p_evento not in ('ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED') then
    raise exception 'Evento inválido.' using errcode = '22023';
  end if;
  for v_n in
    select * from public.whatsapp_numeros
     where waba_id = p_waba_id and modo_conexao = 'coexistencia' and situacao <> 'desconectado'
     order by id for update
  loop
    if p_evento = 'ACCOUNT_OFFBOARDED' then
      update public.whatsapp_numeros
         set meta_desligado_em = coalesce(meta_desligado_em, now()),
             meta_pausou = meta_pausou or situacao = 'conectado',
             situacao = case when situacao = 'conectado' then 'pausado' else situacao end,
             ultimo_erro = 'A Meta desligou temporariamente este número da API (troca de aparelho ou novo registro no app WhatsApp Business). '
                           || 'Ele volta sozinho quando a Meta reconectar.',
             ultimo_erro_em = now()
       where id = v_n.id;
      if v_n.situacao = 'conectado' then
        update public.fontes_leads set status = 'pausada' where id = v_n.fonte_id and status = 'ativa';
      end if;
      v_qtd := v_qtd + 1;
    elsif v_n.meta_desligado_em is not null then
      update public.whatsapp_numeros
         set situacao = case when v_n.meta_pausou and situacao = 'pausado' then 'conectado' else situacao end,
             meta_desligado_em = null, meta_pausou = false, ultimo_erro = null, ultimo_erro_em = null, ultimo_evento_em = now()
       where id = v_n.id;
      if v_n.meta_pausou and v_n.situacao = 'pausado' then
        update public.fontes_leads set status = 'ativa' where id = v_n.fonte_id and status = 'pausada';
      end if;
      v_qtd := v_qtd + 1;
    end if;
  end loop;
  v_res := case when v_qtd = 0 then 'sem_numero' when p_evento = 'ACCOUNT_OFFBOARDED' then 'pausado' else 'retomado' end;
  perform public.whatsapp_registrar_evento_conta(p_waba_id, p_evento, null, null, v_res, v_qtd);
  return jsonb_build_object('resultado', v_res, 'numeros', v_qtd);
end;
$$;

-- ---------------------------------------------------------------------------
-- Desvinculação: números da conta com credencial, para o servidor conferir o
-- acesso na Meta (o token sai só para esse servidor; nunca para a tela).
-- ---------------------------------------------------------------------------
create function public.whatsapp_numeros_da_waba(p_waba_id text)
returns table (numero_id uuid, modo text, token text)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.modo_conexao, s.decrypted_secret::text
    from public.whatsapp_numeros n join vault.decrypted_secrets s on s.id = n.vault_secret_id
   where n.waba_id = p_waba_id and n.situacao <> 'desconectado'
   order by n.id;
$$;

-- A Meta confirmou que o acesso acabou: desconecta e apaga o token (como o
-- "Desconectar" do Administrador). Conversas, leads e histórico continuam.
create function public.whatsapp_desvincular_numero(p_numero uuid, p_motivo text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n public.whatsapp_numeros;
begin
  select * into v_n from public.whatsapp_numeros where id = p_numero for update;
  if v_n.id is null or v_n.situacao = 'desconectado' then return false; end if;
  if v_n.vault_secret_id is not null then delete from vault.secrets where id = v_n.vault_secret_id; end if;
  update public.whatsapp_numeros
     set situacao = 'desconectado', vault_secret_id = null, meta_desligado_em = null, meta_pausou = false,
         desconectado_em = now(), desconexao_motivo = left(coalesce(p_motivo, 'A Meta informou que o acesso a esta conta acabou.'), 300),
         ultimo_erro = left(coalesce(p_motivo, 'A Meta informou que o acesso a esta conta acabou.'), 300), ultimo_erro_em = now()
   where id = p_numero;
  update public.fontes_leads set status = 'pausada' where id = v_n.fonte_id and status = 'ativa';
  insert into public.admin_auditoria (ator_id, acao, tenant_id, detalhes)
  values (null, 'whatsapp_desconectado_pela_meta', v_n.tenant_id, jsonb_build_object('numero', p_numero));
  return true;
end;
$$;

-- O acesso continua, mas a Meta avisou desconexão do app: só um aviso no painel.
create function public.whatsapp_avisar_numero(p_numero uuid, p_aviso text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.whatsapp_numeros set ultimo_erro = left(p_aviso, 300), ultimo_erro_em = now()
   where id = p_numero and situacao <> 'desconectado' and p_aviso is not null;
$$;

-- ---------------------------------------------------------------------------
-- Ações do Administrador: durante o desligamento da Meta o número não pode ser
-- "retomado"; pausar à mão faz a reconexão da Meta NÃO retomar sozinho.
-- (Mesmo corpo de 20261103090000, com essas duas regras.)
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

-- Permissões: tudo do aviso de conta é só do servidor.
do $perm$
declare
  f text;
begin
  foreach f in array array[
    'public.whatsapp_registrar_evento_conta(text, text, text, text, text, integer)',
    'public.whatsapp_coexistencia_evento(text, text)',
    'public.whatsapp_numeros_da_waba(text)',
    'public.whatsapp_desvincular_numero(uuid, text)',
    'public.whatsapp_avisar_numero(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$perm$;
