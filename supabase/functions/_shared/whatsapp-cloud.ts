/**
 * WhatsApp Business Platform (Cloud API oficial da Meta) — peças puras.
 * Rodam no Deno (Edge Function `integracoes`) e no Node (testes/emulador).
 *
 * Nada aqui decide empresa: o webhook traz o `phone_number_id` (assinado pela
 * Meta) e o banco resolve a empresa pelo vínculo único desse número.
 */

export type Busca = (entrada: string, init?: RequestInit) => Promise<Response>

export type ConfigMeta = {
  graphUrl: string // https://graph.facebook.com/v23.0
  appId: string
  appSecret: string
  configId: string // configuração do Embedded Signup (WhatsApp)
  /** Configuração do Login do Facebook para Empresas para Meta Ads (token BISU). Vazio = só MBE. */
  configIdAds?: string
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

export type MensagemRecebida = {
  phoneNumberId: string
  waMessageId: string
  de: string
  nome: string | null
  tipo: string
  texto: string | null
  recebidaEm: string | null
  /** Anúncio Click-to-WhatsApp (só quando a Meta manda o objeto `referral` na mensagem). */
  referral: { ctwa_clid?: string; source_id?: string; source_type?: string; source_url?: string } | null
}

export type StatusMensagem = {
  phoneNumberId: string
  waMessageId: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  cobravel: boolean | null
  categoria: string | null
  /** pricing.type: free_customer_service (dentro da franquia), regular (cobrada), free_entry_point… */
  tipoPreco: string | null
  erro: string | null
}

/** Mensagens recebidas e status de envio de um POST do webhook (objeto whatsapp_business_account). */
export function extrairEventosWhatsapp(corpo: unknown): { mensagens: MensagemRecebida[]; status: StatusMensagem[] } {
  const mensagens: MensagemRecebida[] = []
  const status: StatusMensagem[] = []
  const raiz = obj(corpo)
  if (raiz?.object !== 'whatsapp_business_account') return { mensagens, status }
  for (const entrada of lista(raiz.entry)) {
    for (const mudanca of lista(obj(entrada)?.changes)) {
      const m = obj(mudanca)
      if (m?.field !== 'messages') continue
      const valor = obj(m.value)
      const phoneNumberId = texto(obj(valor?.metadata)?.phone_number_id)
      if (!valor || !phoneNumberId || !/^[0-9]{5,30}$/.test(phoneNumberId)) continue
      const contatos = lista(valor.contacts).map(obj).filter((c): c is Obj => c !== null)
      for (const msg of lista(valor.messages).map(obj)) {
        const id = texto(msg?.id)
        const de = texto(msg?.from)
        if (!msg || !id || !de) continue
        const contato = contatos.find((c) => texto(c.wa_id) === de)
        const tipo = texto(msg.type) ?? 'desconhecido'
        const ts = texto(msg.timestamp)
        const ref = obj(msg.referral)
        const referral = ref
          ? Object.fromEntries(
              (['ctwa_clid', 'source_id', 'source_type', 'source_url'] as const).flatMap((k) => {
                const v = texto(ref[k])
                return v ? [[k, v.slice(0, 500)]] : []
              }),
            )
          : null
        mensagens.push({
          phoneNumberId,
          waMessageId: id,
          de,
          nome: texto(obj(contato?.profile)?.name),
          tipo,
          texto: tipo === 'text' ? texto(obj(msg.text)?.body) : null,
          recebidaEm: ts && /^\d{9,11}$/.test(ts) ? new Date(Number(ts) * 1000).toISOString() : null,
          referral: referral && Object.keys(referral).length ? referral : null,
        })
      }
      for (const st of lista(valor.statuses).map(obj)) {
        const id = texto(st?.id)
        const s = texto(st?.status)
        if (!st || !id || !s || !['sent', 'delivered', 'read', 'failed'].includes(s)) continue
        const preco = obj(st.pricing)
        const erro = obj(lista(st.errors)[0])
        status.push({
          phoneNumberId,
          waMessageId: id,
          status: s as StatusMensagem['status'],
          cobravel: typeof preco?.billable === 'boolean' ? preco.billable : null,
          categoria: texto(preco?.category),
          tipoPreco: texto(preco?.type),
          erro: erro ? `${texto(erro.code) ?? erro.code ?? ''} ${texto(erro.title) ?? ''}`.trim().slice(0, 300) || null : null,
        })
      }
    }
  }
  return { mensagens, status }
}

export class ErroMeta extends Error {
  readonly codigo: string
  constructor(codigo: string, mensagem: string) {
    super(mensagem)
    this.codigo = codigo
  }
}

async function chamarGraph(buscar: Busca, url: string, init: RequestInit): Promise<Obj> {
  let r: Response
  try {
    r = await buscar(url, init)
  } catch {
    throw new ErroMeta('rede', 'Não foi possível falar com a Meta.')
  }
  let corpo: Obj = {}
  try {
    corpo = ((await r.json()) as Obj) ?? {}
  } catch {
    corpo = {}
  }
  if (!r.ok) {
    const e = obj(corpo.error)
    throw new ErroMeta(String(e?.code ?? r.status), String(e?.message ?? `A Meta respondeu ${r.status}.`).slice(0, 300))
  }
  return corpo
}

/** Envio de TEXTO LIVRE (só dentro da janela de 24 h — quem decide é o banco antes daqui). */
export async function enviarTexto(
  buscar: Busca,
  cfg: Pick<ConfigMeta, 'graphUrl'>,
  token: string,
  phoneNumberId: string,
  para: string,
  corpo: string,
): Promise<string> {
  const r = await chamarGraph(buscar, `${cfg.graphUrl}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: para, type: 'text', text: { body: corpo } }),
  })
  const id = texto(obj(lista(r.messages)[0])?.id)
  if (!id) throw new ErroMeta('sem_id', 'A Meta não devolveu o identificador da mensagem.')
  return id
}

/** Embedded Signup: troca o `code` do navegador por um token de negócio (servidor → Meta). */
export async function trocarCodigoEmbedded(buscar: Busca, cfg: ConfigMeta, code: string): Promise<string> {
  const u = new URL(`${cfg.graphUrl}/oauth/access_token`)
  u.search = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code }).toString()
  const r = await chamarGraph(buscar, u.toString(), { method: 'GET' })
  const token = texto(r.access_token)
  if (!token) throw new ErroMeta('sem_token', 'A Meta não devolveu o token de acesso.')
  return token
}

/** Confere que o número pertence à conta (WABA) autorizada e devolve os dados públicos dele. */
export async function conferirNumero(
  buscar: Busca,
  cfg: Pick<ConfigMeta, 'graphUrl'>,
  token: string,
  wabaId: string,
  phoneNumberId: string,
): Promise<{ numeroExibicao: string | null; nomeVerificado: string | null }> {
  const r = await chamarGraph(buscar, `${cfg.graphUrl}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const numero = lista(r.data)
    .map(obj)
    .find((n) => texto(n?.id) === phoneNumberId)
  if (!numero) throw new ErroMeta('numero_fora_da_conta', 'Este número não pertence à conta WhatsApp autorizada.')
  return { numeroExibicao: texto(numero.display_phone_number), nomeVerificado: texto(numero.verified_name) }
}

/**
 * Registro do número na Cloud API (passo obrigatório depois do Embedded Signup,
 * exceto coexistência): POST /<PHONE_NUMBER_ID>/register com PIN de 6 dígitos,
 * que vira a verificação em duas etapas do número.
 *
 * O PIN só passa por aqui: não vai para log, mensagem de erro nem banco. Os erros
 * da Meta viram textos nossos (o texto da Meta não é repassado, por segurança).
 */
export const PIN_VALIDO = /^\d{6}$/

const ERROS_REGISTRO: Record<string, string> = {
  '133005': 'PIN incorreto. Se este número já tem verificação em duas etapas, use o PIN atual dele (ou desative e crie um novo no WhatsApp Manager).',
  '133006': 'A Meta ainda precisa verificar este número (código por SMS ou ligação). Conclua a verificação na janela da Meta e tente de novo.',
  '133008': 'Muitas tentativas de PIN para este número. Aguarde o tempo indicado pela Meta e tente de novo.',
  '133009': 'PIN enviado rápido demais. Aguarde alguns instantes e tente de novo.',
  '133015': 'Este número foi removido há pouco e a Meta ainda está concluindo a remoção. Aguarde 5 minutos e tente de novo.',
  '133016': 'A Meta bloqueou novos pedidos de registro deste número por 72 horas (limite de 10 pedidos em 72 h, contando os que falharam). O AVANTE não tentará de novo antes disso.',
}

export function mensagemDeRegistro(codigo: string): string {
  return ERROS_REGISTRO[codigo] ?? `A Meta recusou o registro do número (código ${codigo.replace(/[^0-9a-z_]/gi, '').slice(0, 12) || 'desconhecido'}). Tente de novo em instantes.`
}

export async function registrarNumero(
  buscar: Busca,
  cfg: Pick<ConfigMeta, 'graphUrl'>,
  token: string,
  phoneNumberId: string,
  pin: string,
): Promise<void> {
  if (!PIN_VALIDO.test(pin)) throw new ErroMeta('pin_invalido', 'O PIN precisa ter exatamente 6 números.')
  let r: Response
  try {
    r = await buscar(`${cfg.graphUrl}/${encodeURIComponent(phoneNumberId)}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    })
  } catch {
    throw new ErroMeta('rede', 'Não foi possível falar com a Meta.')
  }
  if (r.ok) return
  let codigo = String(r.status)
  try {
    const e = obj(((await r.json()) as Obj)?.error)
    if (e?.code !== undefined) codigo = String(e.code)
  } catch {
    /* corpo sem JSON */
  }
  throw new ErroMeta(codigo, mensagemDeRegistro(codigo))
}

/** Inscreve o app da plataforma nos eventos da conta (webhook de mensagens). */
export async function inscreverApp(buscar: Busca, cfg: Pick<ConfigMeta, 'graphUrl'>, token: string, wabaId: string): Promise<void> {
  await chamarGraph(buscar, `${cfg.graphUrl}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

/**
 * Coexistência (app WhatsApp Business + Cloud API): depois da conexão, a Meta
 * dá 24 h para pedir, UMA vez por tipo, a sincronização dos contatos
 * (`smb_app_state_sync`) e do histórico (`history`). A resposta só confirma o
 * pedido; o histórico só chega se a empresa aceitar compartilhar no app.
 */
export async function pedirSincronizacaoApp(
  buscar: Busca,
  cfg: Pick<ConfigMeta, 'graphUrl'>,
  token: string,
  phoneNumberId: string,
  tipo: 'smb_app_state_sync' | 'history',
): Promise<string | null> {
  const r = await chamarGraph(buscar, `${cfg.graphUrl}/${encodeURIComponent(phoneNumberId)}/smb_app_data`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: tipo }),
  })
  return texto(r.request_id)?.slice(0, 120) ?? null
}

export type MensagemApp = { id: string; telefone: string; da_empresa: boolean; tipo: string; texto: string | null; em: string | null; status: string | null }
export type EventosCoexistencia = {
  ecos: { phoneNumberId: string; itens: MensagemApp[] }[]
  historico: { phoneNumberId: string; fase: number | null; progresso: number | null; recusado: boolean; itens: MensagemApp[] }[]
  contatos: { phoneNumberId: string; itens: { telefone: string; nome: string | null; acao: 'add' | 'remove' }[] }[]
}

const soDigitos = (v: string) => v.replace(/\D/g, '')
const quando = (ts: string | null) => (ts && /^\d{9,11}$/.test(ts) ? new Date(Number(ts) * 1000).toISOString() : null)
const numero = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null)

function mensagemApp(m: Obj, cliente: string, daEmpresa: boolean): MensagemApp | null {
  const id = texto(m.id)
  if (!id || !/^\d{8,15}$/.test(cliente)) return null
  const tipo = (texto(m.type) ?? 'desconhecido').slice(0, 40)
  return {
    id: id.slice(0, 200),
    telefone: cliente,
    da_empresa: daEmpresa,
    tipo,
    texto: tipo === 'text' ? (texto(obj(m.text)?.body)?.slice(0, 4096) ?? null) : null,
    em: quando(texto(m.timestamp)),
    status: texto(obj(m.history_context)?.status),
  }
}

/** Webhooks específicos da coexistência: ecos do app, histórico e contatos. */
export function extrairEventosCoexistencia(corpo: unknown): EventosCoexistencia {
  const saida: EventosCoexistencia = { ecos: [], historico: [], contatos: [] }
  const raiz = obj(corpo)
  if (raiz?.object !== 'whatsapp_business_account') return saida
  for (const entrada of lista(raiz.entry)) {
    for (const mudanca of lista(obj(entrada)?.changes)) {
      const m = obj(mudanca)
      const valor = obj(m?.value)
      const meta = obj(valor?.metadata)
      const phoneNumberId = texto(meta?.phone_number_id)
      if (!m || !valor || !phoneNumberId || !/^[0-9]{5,30}$/.test(phoneNumberId)) continue
      const empresa = soDigitos(texto(meta?.display_phone_number) ?? '')
      if (m.field === 'smb_message_echoes') {
        const itens = lista(valor.message_echoes)
          .map(obj)
          .flatMap((e) => (e ? [mensagemApp(e, soDigitos(texto(e.to) ?? ''), true)] : []))
          .filter((x): x is MensagemApp => x !== null)
        if (itens.length) saida.ecos.push({ phoneNumberId, itens })
      } else if (m.field === 'history') {
        for (const h of lista(valor.history).map(obj)) {
          if (!h) continue
          const recusado = lista(h.errors).some((e) => String(obj(e)?.code ?? '') === '2593109')
          const md = obj(h.metadata)
          const itens: MensagemApp[] = []
          for (const t of lista(h.threads).map(obj)) {
            const cliente = soDigitos(texto(t?.id) ?? '')
            for (const msg of lista(t?.messages).map(obj)) {
              if (!msg) continue
              const de = soDigitos(texto(msg.from) ?? '')
              // Quem mandou: comparar o remetente com o número da empresa (documentação da Meta).
              const item = mensagemApp(msg, cliente, Boolean(empresa) && de === empresa)
              if (item) itens.push(item)
            }
          }
          saida.historico.push({ phoneNumberId, fase: numero(md?.phase), progresso: numero(md?.progress), recusado, itens })
        }
      } else if (m.field === 'smb_app_state_sync') {
        const itens = lista(valor.state_sync)
          .map(obj)
          .flatMap((c) => {
            const contato = obj(c?.contact)
            const tel = soDigitos(texto(contato?.phone_number) ?? '')
            if (!c || texto(c.type) !== 'contact' || !/^\d{8,15}$/.test(tel)) return []
            const nome = (texto(contato?.full_name) ?? texto(contato?.first_name))?.slice(0, 200) ?? null
            return [{ telefone: tel, nome, acao: texto(c.action) === 'remove' ? ('remove' as const) : ('add' as const) }]
          })
        if (itens.length) saida.contatos.push({ phoneNumberId, itens })
      }
    }
  }
  return saida
}

// ---------------------------------------------------------------------------
// account_update: avisos da Meta sobre a CONTA (coexistência e desvinculação).
// ---------------------------------------------------------------------------
export type EventoConta =
  | { tipo: 'coexistencia'; evento: 'ACCOUNT_OFFBOARDED' | 'ACCOUNT_RECONNECTED'; wabaId: string }
  | {
      tipo: 'desvinculo'
      evento: 'PARTNER_REMOVED' | 'PARTNER_APP_UNINSTALLED' | 'ACCOUNT_DELETED'
      wabaId: string
      motivo: string | null
      iniciadoPor: string | null
    }

const ID_META = /^[0-9]{5,30}$/
const codigoMeta = (v: unknown, max: number) => {
  const t = texto(v)?.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, max)
  return t ? t : null
}

/**
 * Avisos `account_update` que mudam o estado de um número no AVANTE. Os demais
 * eventos desse campo (limites, verificação, preço…) são ignorados.
 * - PARTNER_*: a conta vem de `waba_info.waba_id` (o `entry.id` desses avisos é
 *   o do parceiro, não o da conta) — nunca do `entry.id`.
 * - ACCOUNT_*: a Meta manda só o evento; a conta é o `entry.id`.
 * - PARTNER_APP_UNINSTALLED de OUTRO app (outro parceiro na mesma conta) é ignorado.
 */
export function extrairEventosConta(corpo: unknown, appId: string | null): EventoConta[] {
  const saida: EventoConta[] = []
  const raiz = obj(corpo)
  if (raiz?.object !== 'whatsapp_business_account') return saida
  for (const entrada of lista(raiz.entry)) {
    const e = obj(entrada)
    for (const mudanca of lista(e?.changes)) {
      const m = obj(mudanca)
      const valor = obj(m?.value)
      if (m?.field !== 'account_update' || !valor) continue
      const evento = texto(valor.event)
      const info = obj(valor.waba_info)
      if (evento === 'ACCOUNT_OFFBOARDED' || evento === 'ACCOUNT_RECONNECTED') {
        const wabaId = texto(info?.waba_id) ?? texto(e?.id)
        if (wabaId && ID_META.test(wabaId)) saida.push({ tipo: 'coexistencia', evento, wabaId })
      } else if (evento === 'PARTNER_REMOVED' || evento === 'PARTNER_APP_UNINSTALLED' || evento === 'ACCOUNT_DELETED') {
        const wabaId = evento === 'ACCOUNT_DELETED' ? (texto(info?.waba_id) ?? texto(e?.id)) : texto(info?.waba_id)
        if (!wabaId || !ID_META.test(wabaId)) continue
        if (evento === 'PARTNER_APP_UNINSTALLED') {
          const app = texto(info?.partner_app_id)
          if (app && appId && app !== appId) continue
        }
        const desc = obj(valor.disconnection_info)
        saida.push({ tipo: 'desvinculo', evento, wabaId, motivo: codigoMeta(desc?.reason, 80), iniciadoPor: codigoMeta(desc?.initiated_by, 40) })
      }
    }
  }
  return saida
}

/** Códigos da Graph API que significam "este token não acessa mais esta conta". */
const ACESSO_PERDIDO = new Set(['190', '200', '10', '100'])

/**
 * Confere na Meta se o token do número ainda acessa a conta. `true`/`false`
 * só quando a Meta responde com certeza; rede, limite de chamadas ou erro da
 * Meta lançam `ErroMeta` (o aviso é reprocessado depois, nada é desconectado).
 */
export async function acessoAContaWhatsapp(buscar: Busca, cfg: Pick<ConfigMeta, 'graphUrl'>, token: string, wabaId: string): Promise<boolean> {
  try {
    await chamarGraph(buscar, `${cfg.graphUrl}/${encodeURIComponent(wabaId)}?fields=id`, { headers: { Authorization: `Bearer ${token}` } })
    return true
  } catch (e) {
    if (e instanceof ErroMeta && ACESSO_PERDIDO.has(e.codigo)) return false
    throw e
  }
}

const MOTIVOS_APP: Record<string, string> = {
  ACCOUNT_DISCONNECTED: 'a conta foi desconectada no app',
  PRIMARY_INACTIVITY: 'o app ficou muito tempo sem uso no celular',
  COMPANION_INACTIVITY: 'a API ficou muito tempo sem uso',
  BUSINESS_DOWNGRADE: 'o número deixou de usar o app WhatsApp Business',
  CHANGE_NUMBER: 'o número foi trocado no app',
  USER_RE_REGISTERED: 'o número foi registrado de novo no app',
}

/** Texto para o painel quando a Meta confirma que o acesso acabou. */
export function textoDesvinculo(evento: 'PARTNER_REMOVED' | 'PARTNER_APP_UNINSTALLED' | 'ACCOUNT_DELETED', motivo: string | null): string {
  const causa =
    evento === 'ACCOUNT_DELETED'
      ? 'A Meta informou que a conta do WhatsApp foi excluída'
      : evento === 'PARTNER_APP_UNINSTALLED'
        ? 'A empresa removeu as permissões do AVANTE na Meta'
        : 'A empresa desvinculou o AVANTE desta conta do WhatsApp'
  const detalhe = motivo && MOTIVOS_APP[motivo] ? ` (${MOTIVOS_APP[motivo]})` : ''
  return `${causa}${detalhe}. Nada foi apagado; para voltar a usar, conecte o número de novo.`
}

/** Aviso quando a Meta informa desconexão do app, mas o acesso à conta continua. */
export function textoAvisoDesconexaoApp(motivo: string): string {
  return `A Meta informou que o app WhatsApp Business se desconectou da API${MOTIVOS_APP[motivo] ? ` (${MOTIVOS_APP[motivo]})` : ''}. Confira no celular e, se preciso, conecte o número de novo.`
}

/** Número de telefone para a API (só dígitos, com DDI). */
export function telefoneParaApi(telefone: string): string | null {
  const d = (telefone ?? '').replace(/\D/g, '')
  return /^[0-9]{10,15}$/.test(d) ? d : null
}

/**
 * Mensagens de SERVIÇO do mês segundo a própria Meta (pricing analytics da WABA),
 * para conferir a franquia gratuita (1.000/mês por número desde 01/10/2026).
 * Soma o volume diário com categoria SERVICE (gratuitas e cobradas) do número.
 * Formato da resposta a confirmar na homologação: se não vier como esperado,
 * lança erro — e o banco mantém o envio bloqueado ("não confirmado").
 */
export async function lerServicoDoMes(
  buscar: Busca,
  cfg: Pick<ConfigMeta, 'graphUrl'>,
  token: string,
  wabaId: string,
  numeroExibicao: string | null,
  inicioUnix: number,
  fimUnix: number,
): Promise<number> {
  const digitos = (numeroExibicao ?? '').replace(/[^0-9]/g, '')
  const campo =
    `pricing_analytics.start(${inicioUnix}).end(${Math.max(fimUnix, inicioUnix + 1)}).granularity(DAILY)` +
    (digitos ? `.phone_numbers(["${digitos}"])` : '') +
    '.dimensions(["PRICING_CATEGORY","PRICING_TYPE"])'
  const r = await chamarGraph(buscar, `${cfg.graphUrl}/${encodeURIComponent(wabaId)}?fields=${encodeURIComponent(campo)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const pa = obj(r.pricing_analytics)
  if (!pa || !Array.isArray(pa.data)) throw new ErroMeta('formato', 'A Meta não devolveu o consumo do mês no formato esperado.')
  let total = 0
  for (const bloco of lista(pa.data)) {
    for (const p of lista(obj(bloco)?.data_points).map(obj)) {
      if (!p) continue
      const categoria = String(p.pricing_category ?? '').toUpperCase()
      if (!categoria) throw new ErroMeta('formato', 'Consumo da Meta sem categoria: não dá para separar mensagens de serviço.')
      if (categoria === 'SERVICE' && typeof p.volume === 'number' && p.volume >= 0) total += p.volume
    }
  }
  return total
}
