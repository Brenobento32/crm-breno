/**
 * Meta Ads multiempresa — Login do Facebook para Empresas (token BISU).
 * Peças puras (fetch injetado): rodam no Deno (Edge Function `integracoes`) e no Node (testes).
 *
 * Cada empresa cliente autoriza, na janela oficial da Meta e no PRÓPRIO portfólio
 * (mesmo fora da BM da Rio X7), os ativos que quer liberar: datasets (Conversions
 * API), Páginas (Lead Ads) e contas de anúncios (métricas). Nada é transferido para
 * a BM da Rio X7; o cliente revoga em Configurações do negócio › Apps conectados.
 *
 * O token BISU (usuário do sistema de integração empresarial) só enxerga os ativos
 * que a empresa liberou. Toda chamada leva appsecret_proof. Nada aqui cria, edita
 * ou gasta em campanhas: só leitura de ativos e métricas e a inscrição da Página
 * no app para receber leads (campo `leadgen`).
 */
import { provaDoApp } from './meta-conversoes.ts'

export type Busca = (entrada: string, init?: RequestInit) => Promise<Response>
export type ConfigAds = { graphUrl: string; appId: string; appSecret: string }

export class ErroMetaAds extends Error {
  readonly codigo: string
  constructor(codigo: string, mensagem: string) {
    super(mensagem)
    this.codigo = codigo
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const texto = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null)
const ID = /^[0-9]{5,30}$/
const id = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && ID.test(String(v)) ? String(v) : null)

async function chamar(buscar: Busca, cfg: ConfigAds, caminho: string, token: string, init: RequestInit = {}): Promise<Obj> {
  const u = new URL(`${cfg.graphUrl}${caminho}`)
  u.searchParams.set('appsecret_proof', await provaDoApp(token, cfg.appSecret))
  let r: Response
  try {
    r = await buscar(u.toString(), { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } })
  } catch {
    throw new ErroMetaAds('rede', 'Não foi possível falar com a Meta.')
  }
  let corpo: Obj = {}
  try {
    corpo = (obj(await r.json()) ?? {}) as Obj
  } catch {
    corpo = {}
  }
  if (!r.ok) {
    const e = obj(corpo.error)
    const codigo = String(e?.code ?? r.status)
    // 190 = token inválido/revogado (a empresa removeu o app): reconectar.
    const msg = codigo === '190' ? 'A autorização da Meta expirou ou foi removida pela empresa. Conecte de novo.' : `A Meta recusou a chamada (${codigo}).`
    throw new ErroMetaAds(codigo, msg)
  }
  return corpo
}

/** Todas as páginas de uma lista paginada (limite de segurança de páginas). */
async function todos(buscar: Busca, cfg: ConfigAds, caminho: string, token: string, maxPaginas = 10): Promise<Obj[]> {
  const itens: Obj[] = []
  let depois: string | null = null
  for (let i = 0; i < maxPaginas; i++) {
    const sep = caminho.includes('?') ? '&' : '?'
    const c = await chamar(buscar, cfg, depois ? `${caminho}${sep}after=${encodeURIComponent(depois)}` : caminho, token)
    for (const x of lista(c.data)) {
      const o = obj(x)
      if (o) itens.push(o)
    }
    depois = texto(obj(obj(c.paging)?.cursors)?.after, 500)
    if (!depois || !obj(c.paging)?.next) break
  }
  return itens
}

/** code da janela (response_type=code) → token BISU da empresa cliente. Sem redirect_uri (SDK JS). */
export async function trocarCodigoLogin(buscar: Busca, cfg: ConfigAds, code: string): Promise<string> {
  const u = new URL(`${cfg.graphUrl}/oauth/access_token`)
  u.search = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code }).toString()
  let r: Response
  try {
    r = await buscar(u.toString(), { method: 'GET' })
  } catch {
    throw new ErroMetaAds('rede', 'Não foi possível falar com a Meta.')
  }
  const c = (obj(await r.json().catch(() => null)) ?? {}) as Obj
  const token = texto(c.access_token, 1000)
  if (!r.ok || !token) throw new ErroMetaAds('autorizacao', 'A Meta não confirmou a autorização. Tente conectar de novo.')
  return token
}

/** Portfólio (BM) da empresa cliente dono do token BISU. */
export async function negocioDoCliente(buscar: Busca, cfg: ConfigAds, token: string): Promise<string> {
  const c = await chamar(buscar, cfg, '/me?fields=client_business_id', token)
  const negocio = id(c.client_business_id)
  if (!negocio) throw new ErroMetaAds('sem_negocio', 'A Meta não informou o portfólio da empresa. Use o login de um administrador do portfólio.')
  return negocio
}

export type Dataset = { id: string; nome: string | null }
export type Pagina = { id: string; nome: string | null }
export type ContaAnuncios = { id: string; nome: string | null; moeda: string | null; ativa: boolean }
export type AtivosLiberados = { negocioId: string; datasets: Dataset[]; paginas: Pagina[]; contas: ContaAnuncios[] }

const unicos = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()]

/**
 * Só o que a empresa liberou para o app nesta autorização (o token BISU não
 * enxerga mais nada). Datasets: próprios e compartilhados com o portfólio.
 */
export async function ativosLiberados(buscar: Busca, cfg: ConfigAds, token: string, negocioId: string): Promise<AtivosLiberados> {
  const [proprios, compartilhados, paginas, contas] = await Promise.all([
    todos(buscar, cfg, `/${negocioId}/owned_pixels?fields=id,name&limit=100`, token),
    todos(buscar, cfg, `/${negocioId}/client_pixels?fields=id,name&limit=100`, token).catch(() => [] as Obj[]),
    todos(buscar, cfg, '/me/accounts?fields=id,name&limit=100', token),
    todos(buscar, cfg, '/me/adaccounts?fields=account_id,name,currency,account_status&limit=100', token),
  ])
  const ds = [...proprios, ...compartilhados].flatMap((d) => (id(d.id) ? [{ id: id(d.id)!, nome: texto(d.name) }] : []))
  return {
    negocioId,
    datasets: unicos(ds),
    paginas: unicos(paginas.flatMap((p) => (id(p.id) ? [{ id: id(p.id)!, nome: texto(p.name) }] : []))),
    contas: unicos(
      contas.flatMap((a) =>
        id(a.account_id) ? [{ id: id(a.account_id)!, nome: texto(a.name), moeda: texto(a.currency, 3), ativa: Number(a.account_status) === 1 }] : [],
      ),
    ),
  }
}

/** Token da Página (necessário para ler os leads dela e inscrevê-la no app). */
export async function tokenDaPagina(buscar: Busca, cfg: ConfigAds, token: string, paginaId: string): Promise<{ token: string; nome: string | null }> {
  const c = await chamar(buscar, cfg, `/${encodeURIComponent(paginaId)}?fields=access_token,name`, token)
  const t = texto(c.access_token, 1000)
  if (!t) throw new ErroMetaAds('sem_token_pagina', 'A Meta não liberou o acesso a esta Página. Confira se ela foi incluída na autorização.')
  return { token: t, nome: texto(c.name) }
}

/** Inscreve a Página no app para receber os leads dos formulários (POST /<PAGE>/subscribed_apps). */
export async function inscreverPaginaLeads(buscar: Busca, cfg: ConfigAds, tokenPagina: string, paginaId: string): Promise<void> {
  const c = await chamar(buscar, cfg, `/${encodeURIComponent(paginaId)}/subscribed_apps?subscribed_fields=leadgen`, tokenPagina, { method: 'POST' })
  if (c.success !== true) throw new ErroMetaAds('inscricao', 'A Meta não confirmou a inscrição da Página para receber leads.')
}

/** Tipos de ação que a Meta usa para "lead" (formulário nativo e pixel). */
const ACOES_LEAD = new Set(['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'leadgen_grouped'])

export type MetricaCampanha = {
  dia: string // AAAA-MM-DD
  campanhaId: string
  campanhaNome: string | null
  investimento: number
  impressoes: number
  cliques: number
  leads: number
  /** Compras atribuídas PELA META (modelo e janela de atribuição dela), não as vendas do CRM. */
  conversoesMeta: number
  valorConversoesMeta: number
}

const numero = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Leads informados pela Meta: o maior entre os tipos de "lead" (eles se sobrepõem; nunca soma). */
export function leadsDasAcoes(acoes: unknown): number {
  let maior = 0
  for (const a of lista(acoes)) {
    const o = obj(a)
    if (o && typeof o.action_type === 'string' && ACOES_LEAD.has(o.action_type)) maior = Math.max(maior, numero(o.value))
  }
  return Math.round(maior)
}

/** Tipos de ação de "compra" que a Meta atribui ao anúncio (pixel, CAPI, offline, no app); eles se sobrepõem. */
const ACOES_COMPRA = new Set([
  'omni_purchase',
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_web_purchase',
  'onsite_conversion.purchase',
  'offline_conversion.purchase',
])

/** Maior valor entre os tipos de compra (actions = quantidade, action_values = valor); nunca soma. */
export function comprasDasAcoes(acoes: unknown): number {
  let maior = 0
  for (const a of lista(acoes)) {
    const o = obj(a)
    if (o && typeof o.action_type === 'string' && ACOES_COMPRA.has(o.action_type)) maior = Math.max(maior, numero(o.value))
  }
  return maior
}

/**
 * Métricas por campanha e por dia de UMA conta de anúncios (Marketing API, leitura).
 * Período curto (dias) e só campos agregados; nada de dados pessoais.
 */
export async function metricasDaConta(
  buscar: Busca,
  cfg: ConfigAds,
  token: string,
  contaId: string,
  periodo: { desde: string; ate: string },
): Promise<MetricaCampanha[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodo.desde) || !/^\d{4}-\d{2}-\d{2}$/.test(periodo.ate)) throw new ErroMetaAds('periodo', 'Período inválido.')
  const intervalo = encodeURIComponent(JSON.stringify({ since: periodo.desde, until: periodo.ate }))
  const linhas = await todos(
    buscar,
    cfg,
    `/act_${encodeURIComponent(contaId)}/insights?level=campaign&time_increment=1&time_range=${intervalo}` +
      '&fields=campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,date_start&limit=200',
    token,
    20,
  )
  return linhas.flatMap((l) => {
    const campanhaId = id(l.campaign_id)
    const dia = typeof l.date_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.date_start) ? l.date_start : null
    if (!campanhaId || !dia) return []
    return [
      {
        dia,
        campanhaId,
        campanhaNome: texto(l.campaign_name),
        investimento: Math.round(numero(l.spend) * 100) / 100,
        impressoes: Math.round(numero(l.impressions)),
        cliques: Math.round(numero(l.clicks)),
        leads: leadsDasAcoes(l.actions),
        conversoesMeta: Math.round(comprasDasAcoes(l.actions)),
        valorConversoesMeta: Math.round(comprasDasAcoes(l.action_values) * 100) / 100,
      },
    ]
  })
}

/** Campos do lead (Lead Ads) que identificam a origem: campanha, conjunto, anúncio, formulário e plataforma. */
export const CAMPOS_LEAD =
  'field_data,created_time,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,platform,is_organic'

/** Atribuição gravada na negociação (sem dados pessoais; IDs e nomes da campanha). */
export function atribuicaoDoLead(leadgenId: string, paginaId: string, lead: Record<string, unknown>): Record<string, string> {
  const a: Record<string, string> = { source: 'meta_lead_ads', leadgen_id: leadgenId, page_id: paginaId }
  for (const k of ['form_id', 'ad_id', 'adset_id', 'campaign_id'] as const) {
    const v = id(lead[k])
    if (v) a[k] = v
  }
  for (const k of ['ad_name', 'adset_name', 'campaign_name'] as const) {
    const v = texto(lead[k], 200)
    if (v) a[k] = v
  }
  const plat = texto(lead.platform, 20)?.toLowerCase()
  if (plat === 'fb' || plat === 'ig' || plat === 'facebook' || plat === 'instagram') a.platform = plat === 'facebook' ? 'fb' : plat === 'instagram' ? 'ig' : plat
  if (typeof lead.is_organic === 'boolean') a.is_organic = String(lead.is_organic)
  if (typeof lead.created_time === 'string') a.created_time = lead.created_time.slice(0, 40)
  return a
}

/** Respostas do formulário além de nome/telefone/e-mail/empresa, no formato de negociacao_respostas. */
export function respostasDoLead(fieldData: unknown): { pergunta_externa: string; resposta: string }[] {
  const basicos = new Set(['full_name', 'nome_completo', 'nome', 'first_name', 'last_name', 'phone_number', 'telefone', 'whatsapp', 'celular', 'email', 'e-mail', 'company_name', 'empresa'])
  const saida: { pergunta_externa: string; resposta: string }[] = []
  for (const item of lista(fieldData)) {
    const o = obj(item)
    const nome = texto(o?.name, 200)
    if (!nome || basicos.has(nome.toLowerCase())) continue
    const valores = lista(o?.values).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    if (valores.length) saida.push({ pergunta_externa: nome, resposta: valores.join(', ').slice(0, 2000) })
  }
  return saida.slice(0, 50)
}
