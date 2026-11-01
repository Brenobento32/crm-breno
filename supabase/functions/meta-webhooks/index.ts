/**
 * Edge Function `meta-webhooks` — Facebook/Instagram Lead Ads e WhatsApp Cloud API.
 *
 * Um app da Meta da plataforma (Rio X7) recebe os eventos de todas as
 * empresas; cada empresa conecta a PRÓPRIA página/número com o PRÓPRIO token.
 *
 * Rotas:
 *   GET  /            verificação do webhook (hub.verify_token = META_VERIFY_TOKEN)
 *   POST /            eventos — só com X-Hub-Signature-256 válido (META_APP_SECRET)
 *   POST /validar     (JWT do admin + header da empresa) valida a fonte com o
 *                     provedor usando o token dela; só fonte VALIDADA recebe evento
 *
 * Empresa: nunca do corpo. page_id / phone_number_id (assinados pela Meta) →
 * fonte ativa e validada (`fonte_por_provedor`). Reenvios da Meta são
 * idempotentes (leadgen_id / wa_id por fonte). Responde 200 rápido; erros por
 * lead ficam em `ingestao_eventos`.
 *
 * Deploy com --no-verify-jwt (a Meta não manda JWT; /validar confere o JWT aqui).
 *
 * Secrets: META_APP_SECRET, META_VERIFY_TOKEN, META_GRAPH_VERSION (opcional, padrão v23.0, igual a `integracoes`).
 * Não validado com a Meta real neste código: exige app da Meta, revisão de
 * permissões (leads_retrieval, pages_manage_metadata, whatsapp_business_messaging).
 */
import { createClient } from 'npm:@supabase/supabase-js@2'

import {
  assinaturaMetaValida,
  extrairContatosWhatsapp,
  extrairLeadgen,
  mapearCamposLeadMeta,
  respostaVerificacao,
} from '../_shared/meta.ts'
import { atribuicaoDoLead, CAMPOS_LEAD, respostasDoLead } from '../_shared/meta-ads.ts'
import { provaDoApp } from '../_shared/meta-conversoes.ts'
import { HEADER_TENANT, slugDaRequisicao } from '../_shared/requisicao.ts'

const url = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const appSecret = Deno.env.get('META_APP_SECRET') ?? ''
const verifyToken = Deno.env.get('META_VERIFY_TOKEN') ?? ''
// Mesma versão da Graph da função `integracoes` (fonte única: META_GRAPH_VERSION).
const graph = `https://graph.facebook.com/${Deno.env.get('META_GRAPH_VERSION') || 'v23.0'}`

const LIMITE_BYTES = 256 * 1024

/** Chamada à Graph com o token da Página e appsecret_proof (como o resto das integrações). */
async function graphGet(caminho: string, token: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(`${graph}${caminho}`)
  u.searchParams.set('appsecret_proof', await provaDoApp(token, appSecret))
  return fetch(u.toString(), { ...init, headers: { Authorization: `Bearer ${token}` } })
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

function json(status: number, corpo: Record<string, unknown>) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } })
}
const erro = (status: number, codigo: string, mensagem: string) => json(status, { ok: false, codigo, mensagem })

type FonteProvedor = { id: string; vault_secret_id: string | null; configuracao: { page_id?: string; form_id?: string } }

async function fontePorProvedor(tipo: 'meta_lead_ads' | 'whatsapp_cloud', ref: string): Promise<FonteProvedor | null> {
  const { data } = await admin.rpc('fonte_por_provedor', { p_tipo: tipo, p_ref: ref })
  return (data as FonteProvedor[] | null)?.[0] ?? null
}

async function tokenDaFonte(fonteId: string): Promise<string | null> {
  const { data } = await admin.rpc('fonte_segredo_provedor', { p_fonte: fonteId })
  return typeof data === 'string' && data ? data : null
}

async function ingerir(
  fonteId: string,
  externalId: string,
  dados: { nome: string | null; telefone: string | null; email: string | null; empresa: string | null },
  atribuicao: Record<string, string>,
  respostas: { pergunta_externa: string; resposta: string }[] = [],
) {
  const { error } = await admin.rpc('ingerir_lead_fonte', {
    p_fonte: fonteId,
    p_external_id: externalId,
    p_nome: dados.nome,
    p_telefone: dados.telefone,
    p_email: dados.email,
    p_empresa: dados.empresa,
    p_instagram: null,
    p_respostas: respostas,
    p_atribuicao: atribuicao,
  })
  if (error) console.error('meta-webhooks ingestão:', error.code)
}

/** Lead Ads: busca os campos do lead na Graph API com o token da página da empresa. */
async function processarLeadgen(corpo: unknown): Promise<boolean> {
  let falhou = false
  for (const ev of extrairLeadgen(corpo)) {
    const fonte = await fontePorProvedor('meta_lead_ads', ev.pageId)
    if (!fonte) continue // página sem fonte validada: ignora (nunca adivinha a empresa)
    if (fonte.configuracao.form_id && ev.formId && fonte.configuracao.form_id !== ev.formId) continue
    const token = await tokenDaFonte(fonte.id)
    if (!token) continue
    try {
      const r = await graphGet(`/${ev.leadgenId}?fields=${CAMPOS_LEAD}`, token)
      if (!r.ok) {
        // Resposta 500 no fim: a Meta reenvia e o lead entra depois (idempotente).
        falhou = true
        console.error('meta-webhooks graph lead:', r.status)
        continue
      }
      const lead = (await r.json()) as Record<string, unknown>
      // Campanha, conjunto, anúncio, formulário e plataforma (Facebook/Instagram) do lead; respostas extras na ficha.
      const atribuicao = atribuicaoDoLead(ev.leadgenId, ev.pageId, lead)
      await ingerir(fonte.id, ev.leadgenId, mapearCamposLeadMeta(lead.field_data), atribuicao, respostasDoLead(lead.field_data))
    } catch (e) {
      console.error('meta-webhooks leadgen:', e instanceof Error ? e.message : e)
      falhou = true
    }
  }
  return falhou
}

/**
 * WhatsApp: DESATIVADO aqui. O WhatsApp oficial passou para a Edge Function
 * `integracoes` (/whatsapp/webhook), que grava a conversa, a mensagem e o lead
 * num passo só (idempotente pelo ID da Meta). Manter os dois ligados criaria o
 * lead duas vezes. Esta função fica só para referência do formato antigo.
 */
async function processarWhatsapp(corpo: unknown) {
  if (corpo) return
  for (const c of extrairContatosWhatsapp(corpo)) {
    const fonte = await fontePorProvedor('whatsapp_cloud', c.phoneNumberId)
    if (!fonte) continue
    await ingerir(fonte.id, `wa:${c.waId}`, { nome: c.nome, telefone: c.waId, email: null, empresa: null }, {
      source: 'whatsapp_cloud',
      phone_number_id: c.phoneNumberId,
      ...(c.mensagemId ? { primeira_mensagem_id: c.mensagemId } : {}),
    })
  }
}

/** Valida a fonte com o provedor usando o token da própria empresa. */
async function validar(req: Request): Promise<Response> {
  const authorization = req.headers.get('Authorization')
  const slug = slugDaRequisicao(req.headers)
  if (!authorization || !slug) return erro(401, 'nao_autenticado', 'Sessão ou empresa ausente.')

  const comoUsuario = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization, [HEADER_TENANT]: slug } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: erroAdmin } = await comoUsuario.rpc('exigir_admin_empresa')
  if (erroAdmin) return erro(403, 'sem_permissao', 'Somente o administrador da empresa valida fontes.')

  let fonteId: unknown
  try {
    fonteId = ((await req.json()) as Record<string, unknown>).fonte_id
  } catch {
    fonteId = null
  }
  if (typeof fonteId !== 'string') return erro(400, 'pedido_invalido', 'Informe a fonte.')

  // RLS: só enxerga fonte da empresa da requisição.
  const { data: fonte } = await comoUsuario
    .from('fontes_leads')
    .select('id, tipo, status, configuracao')
    .eq('id', fonteId)
    .maybeSingle()
  if (!fonte || fonte.status === 'revogada' || !['meta_lead_ads', 'whatsapp_cloud'].includes(fonte.tipo)) {
    return erro(404, 'nao_encontrada', 'Fonte não encontrada.')
  }

  const token = await tokenDaFonte(fonte.id)
  if (!token) return erro(409, 'sem_token', 'Cadastre o token do provedor antes de validar.')

  const cfg = fonte.configuracao as { page_id?: string; phone_number_id?: string }
  const ref = fonte.tipo === 'meta_lead_ads' ? cfg.page_id : cfg.phone_number_id
  try {
    // O token precisa enxergar EXATAMENTE esta página/número: prova de posse.
    const r = await graphGet(`/${ref}?fields=id`, token)
    const corpo = (await r.json()) as { id?: string }
    if (!r.ok || corpo.id !== ref) {
      await admin.rpc('marcar_fonte_validada', { p_fonte: fonte.id, p_valida: false, p_erro: 'O token não dá acesso a esta página/número.' })
      return erro(422, 'nao_validada', 'O token não dá acesso a esta página/número.')
    }
    if (fonte.tipo === 'meta_lead_ads') {
      // Assina a página no app para receber o evento leadgen.
      const s = await graphGet(`/${ref}/subscribed_apps?subscribed_fields=leadgen`, token, { method: 'POST' })
      if (!s.ok) {
        await admin.rpc('marcar_fonte_validada', { p_fonte: fonte.id, p_valida: false, p_erro: 'Não foi possível assinar a página no app.' })
        return erro(422, 'nao_validada', 'Não foi possível assinar a página no app da Meta.')
      }
    }
    await admin.rpc('marcar_fonte_validada', { p_fonte: fonte.id, p_valida: true })
    return json(200, { ok: true })
  } catch (e) {
    console.error('meta-webhooks validar:', e instanceof Error ? e.message : e)
    return erro(502, 'provedor', 'Não foi possível falar com a Meta agora.')
  }
}

Deno.serve(async (req) => {
  const caminho = new URL(req.url).pathname

  if (req.method === 'GET') {
    const desafio = respostaVerificacao(new URL(req.url).searchParams, verifyToken)
    return desafio ? new Response(desafio, { status: 200 }) : new Response('forbidden', { status: 403 })
  }
  if (req.method !== 'POST') return erro(405, 'metodo', 'Use POST.')
  if (caminho.endsWith('/validar')) return validar(req)

  const bruto = await req.text()
  if (bruto.length > LIMITE_BYTES) return erro(413, 'grande_demais', 'Payload grande demais.')
  if (!(await assinaturaMetaValida(appSecret, bruto, req.headers.get('x-hub-signature-256')))) {
    return erro(401, 'assinatura_invalida', 'Assinatura inválida.')
  }

  let corpo: unknown
  try {
    corpo = JSON.parse(bruto)
  } catch {
    return erro(400, 'pedido_invalido', 'JSON inválido.')
  }

  const falhou = await processarLeadgen(corpo)
  await processarWhatsapp(corpo)
  // 500 faz a Meta reenviar (só quando a leitura de algum lead falhou); o resto já entrou.
  return falhou ? erro(500, 'reenviar', 'Falha temporária ao ler lead.') : json(200, { ok: true })
})
