/**
 * Google Sheets — peças puras (Web Crypto + fetch injetado): rodam no Deno
 * (Edge Function `integracoes`) e no Node (testes e emulador local).
 *
 * Escopo: `drive.file` (o app só enxerga as planilhas que o próprio usuário
 * escolheu no seletor do Google) + `openid email`. Um link sozinho não dá
 * acesso a planilha privada: se a leitura voltar 403/404, a tela pede para o
 * usuário autorizar aquele arquivo no seletor oficial (Google Picker).
 */

export const ESCOPOS_GOOGLE_SHEETS = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'] as const

export type ConfigGoogle = {
  clientId: string
  clientSecret: string
  redirectUri: string
  authUrl: string // https://accounts.google.com/o/oauth2/v2/auth
  tokenUrl: string // https://oauth2.googleapis.com/token
  revokeUrl: string // https://oauth2.googleapis.com/revoke
  sheetsUrl: string // https://sheets.googleapis.com/v4
  /** Drive API (avisos de alteração: files.watch / channels.stop). Padrão: https://www.googleapis.com/drive/v3 */
  driveUrl?: string
}

export const DRIVE_URL_PADRAO = 'https://www.googleapis.com/drive/v3'

export type Busca = (entrada: string, init?: RequestInit) => Promise<Response>

export class ErroGoogle extends Error {
  readonly tipo: 'autorizacao' | 'sem_acesso' | 'cota' | 'invalido' | 'rede'
  constructor(tipo: 'autorizacao' | 'sem_acesso' | 'cota' | 'invalido' | 'rede', mensagem: string) {
    super(mensagem)
    this.tipo = tipo
  }
}

// ----------------------------------------------------------------- link
const ID_PLANILHA = /^[A-Za-z0-9_-]{20,120}$/

/** ID (e aba, se houver `gid`) a partir do link colado — ou do próprio ID. */
export function extrairPlanilhaDoLink(texto: string): { planilhaId: string; gid: number | null } | null {
  const bruto = (texto ?? '').trim()
  if (ID_PLANILHA.test(bruto)) return { planilhaId: bruto, gid: null }
  let url: URL
  try {
    url = new URL(bruto)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null
  const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,120})(?:\/|$)/.exec(url.pathname)
  if (!m) return null
  const gidTexto = url.searchParams.get('gid') ?? /(?:^|[#&])gid=(\d{1,12})/.exec(url.hash)?.[1] ?? null
  const gid = gidTexto && /^\d{1,12}$/.test(gidTexto) ? Number(gidTexto) : null
  return { planilhaId: m[1], gid }
}

// ----------------------------------------------------------------- OAuth
export function urlDeAutorizacao(cfg: ConfigGoogle, state: string, dicaEmail?: string | null): string {
  const u = new URL(cfg.authUrl)
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: ESCOPOS_GOOGLE_SHEETS.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    ...(dicaEmail ? { login_hint: dicaEmail } : {}),
  }).toString()
  return u.toString()
}

type Tokens = { access_token: string; refresh_token?: string; scope?: string; id_token?: string; expires_in?: number }

async function lerJson(r: Response): Promise<Record<string, unknown>> {
  try {
    return (await r.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function trocarCodigo(buscar: Busca, cfg: ConfigGoogle, code: string): Promise<Tokens> {
  const r = await buscar(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  })
  const corpo = await lerJson(r)
  if (!r.ok || typeof corpo.access_token !== 'string') throw new ErroGoogle('autorizacao', 'O Google recusou a autorização.')
  return corpo as Tokens
}

export async function renovarAcesso(buscar: Busca, cfg: ConfigGoogle, refreshToken: string): Promise<string> {
  const r = await buscar(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
    }).toString(),
  })
  const corpo = await lerJson(r)
  if (r.status === 400 || r.status === 401) {
    // invalid_grant: o usuário revogou ou a autorização expirou → reconectar.
    throw new ErroGoogle('autorizacao', 'A autorização do Google expirou ou foi revogada. Conecte a conta de novo.')
  }
  if (!r.ok || typeof corpo.access_token !== 'string') throw new ErroGoogle('rede', 'Falha ao renovar o acesso ao Google.')
  return corpo.access_token
}

export async function revogar(buscar: Busca, cfg: ConfigGoogle, token: string): Promise<void> {
  await buscar(`${cfg.revokeUrl}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined)
}

/** E-mail do `id_token` (veio direto do endpoint de token, por TLS: não precisa validar assinatura aqui). */
export function emailDoIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  const partes = idToken.split('.')
  if (partes.length !== 3) return null
  try {
    const json = JSON.parse(atob(partes[1].replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((partes[1].length + 3) % 4)))
    return typeof json.email === 'string' && json.email_verified !== false ? json.email.toLowerCase() : null
  } catch {
    return null
  }
}

// ----------------------------------------------------------------- Sheets API
async function chamarSheets(buscar: Busca, url: string, accessToken: string): Promise<Record<string, unknown>> {
  let r: Response
  try {
    r = await buscar(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch {
    throw new ErroGoogle('rede', 'Não foi possível falar com o Google Sheets.')
  }
  if (r.status === 401) throw new ErroGoogle('autorizacao', 'A autorização do Google expirou. Conecte a conta de novo.')
  if (r.status === 403 || r.status === 404) {
    throw new ErroGoogle('sem_acesso', 'O AVANTE ainda não tem acesso a esta planilha. Autorize o arquivo no seletor do Google.')
  }
  if (r.status === 429) throw new ErroGoogle('cota', 'Limite de uso do Google atingido. Tentaremos de novo mais tarde.')
  if (!r.ok) {
    // A mensagem do Google (ex.: faixa inválida) vai para o log e para o Administrador; nunca token nem conteúdo de linha.
    let detalhe = ''
    try {
      const c = (await r.json()) as { error?: { message?: unknown } }
      detalhe = typeof c?.error?.message === 'string' ? c.error.message.slice(0, 200) : ''
    } catch {
      detalhe = ''
    }
    console.error('google sheets:', r.status, detalhe)
    throw new ErroGoogle('rede', `O Google Sheets respondeu ${r.status}${detalhe ? `: ${detalhe}` : '.'}`)
  }
  return lerJson(r)
}

export type Aba = { id: number; titulo: string; linhas: number; colunas: number }

export async function lerMetadados(
  buscar: Busca,
  cfg: ConfigGoogle,
  accessToken: string,
  planilhaId: string,
): Promise<{ titulo: string; abas: Aba[] }> {
  const campos = encodeURIComponent('properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))')
  const c = await chamarSheets(buscar, `${cfg.sheetsUrl}/spreadsheets/${encodeURIComponent(planilhaId)}?fields=${campos}`, accessToken)
  const props = c.properties as { title?: string } | undefined
  const abas = ((c.sheets as unknown[]) ?? []).flatMap((s) => {
    const p = (s as { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } })
      .properties
    return p && typeof p.sheetId === 'number' && typeof p.title === 'string'
      ? [{ id: p.sheetId, titulo: p.title, linhas: p.gridProperties?.rowCount ?? 0, colunas: p.gridProperties?.columnCount ?? 0 }]
      : []
  })
  return { titulo: String(props?.title ?? 'Planilha'), abas }
}

/** Faixa A1 de uma aba com aspas (nomes com espaço ou acento). */
function faixa(aba: string, inicio: number, fim: number, colunaFinal = 'AZ'): string {
  return `'${aba.replaceAll("'", "''")}'!A${inicio}:${colunaFinal}${fim}`
}

/** Letra(s) da coluna em A1: 1 → A, 26 → Z, 52 → AZ. */
function letraDaColuna(n: number): string {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}

/** Até quantas colunas o AVANTE lê por aba (AZ). */
const MAX_COLUNAS = 52

/**
 * Nome exato e grade real da aba. O Google responde 400 quando a faixa passa da grade
 * (abas criadas por integrações ou CSV têm só as linhas/colunas usadas) ou quando o nome
 * não confere (ex.: espaço no começo/fim do nome, que formulários e telas costumam cortar).
 */
async function gradeDaAba(
  buscar: Busca,
  cfg: ConfigGoogle,
  accessToken: string,
  planilhaId: string,
  aba: string,
): Promise<{ titulo: string; linhas: number | null; colunas: number | null }> {
  const campos = encodeURIComponent('sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))')
  const c = await chamarSheets(buscar, `${cfg.sheetsUrl}/spreadsheets/${encodeURIComponent(planilhaId)}?fields=${campos}`, accessToken)
  const abas = ((c.sheets as unknown[]) ?? []).flatMap((s) => {
    const p = (s as { properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }).properties
    return p && typeof p.title === 'string' ? [p] : []
  })
  const alvo = abas.find((p) => p.title === aba) ?? abas.find((p) => p.title!.trim() === aba.trim())
  if (!alvo) throw new ErroGoogle('invalido', `A aba "${aba}" não foi encontrada nesta planilha (foi renomeada ou excluída?).`)
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  return { titulo: alvo.title!, linhas: n(alvo.gridProperties?.rowCount), colunas: n(alvo.gridProperties?.columnCount) }
}

export async function lerLinhas(
  buscar: Busca,
  cfg: ConfigGoogle,
  accessToken: string,
  planilhaId: string,
  aba: string,
  linhaCabecalho: number,
  maxLinhas: number,
): Promise<{ cabecalho: string[]; linhas: { numero: number; valores: string[] }[] }> {
  const grade = await gradeDaAba(buscar, cfg, accessToken, planilhaId, aba)
  if (grade.linhas !== null && linhaCabecalho > grade.linhas) return { cabecalho: [], linhas: [] }
  // Nunca pede além da grade real da aba (linhas e colunas): o Google recusaria com 400.
  const ate = Math.min(linhaCabecalho + Math.max(1, Math.min(maxLinhas, 5000)), grade.linhas ?? Number.MAX_SAFE_INTEGER)
  const colunaFinal = letraDaColuna(Math.min(MAX_COLUNAS, grade.colunas ?? MAX_COLUNAS))
  const url =
    `${cfg.sheetsUrl}/spreadsheets/${encodeURIComponent(planilhaId)}/values/${encodeURIComponent(faixa(grade.titulo, linhaCabecalho, ate, colunaFinal))}` +
    '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE'
  const c = await chamarSheets(buscar, url, accessToken)
  const valores = ((c.values as unknown[][]) ?? []).map((l) => (l ?? []).map((v) => (v == null ? '' : String(v))))
  const [cabecalho = [], ...resto] = valores
  return {
    cabecalho: cabecalho.map((h) => h.trim()),
    linhas: resto.map((v, i) => ({ numero: linhaCabecalho + 1 + i, valores: v })),
  }
}

// ----------------------------------------------------------------- mapeamento
export const CAMPOS_SUPORTADOS = ['nome', 'telefone', 'email', 'empresa', 'meta_lead_id'] as const
export type Campo = (typeof CAMPOS_SUPORTADOS)[number]
export type Mapeamento = Partial<Record<Campo, string>>

const normalizar = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const PISTAS: Record<Campo, RegExp> = {
  nome: /^(nome( completo)?|seu nome|nome do (cliente|lead|contato)|name|full name|cliente|contato)$/,
  telefone: /(telefone|celular|whats ?app|whats|fone|phone|contato telefonico)/,
  email: /(e ?mail|email|correio)/,
  empresa: /^(empresa|nome da empresa|company|organizacao|negocio)$/,
  // ID do lead dos Lead Ads da Meta (planilha alimentada pelos formulários nativos). Nunca inventado.
  meta_lead_id: /^(id do lead|lead id|leadgen id|id lead meta|meta lead id|id do lead meta)$/,
}
const PISTAS_CHAVE = /^(id|codigo|identificador|carimbo de data hora|timestamp|data hora do envio|submission id|response id)$/

/** Sugestão automática a partir do cabeçalho (o Administrador confirma ou ajusta). */
export function sugerirMapeamento(cabecalho: string[]): { mapeamento: Mapeamento; chave: string | null } {
  const mapeamento: Mapeamento = {}
  for (const campo of CAMPOS_SUPORTADOS) {
    const achado = cabecalho.find((h) => h && PISTAS[campo].test(normalizar(h)) && !Object.values(mapeamento).includes(h))
    if (achado) mapeamento[campo] = achado
  }
  const chave = cabecalho.find((h) => h && PISTAS_CHAVE.test(normalizar(h))) ?? null
  return { mapeamento, chave }
}

export function mapeamentoValido(m: Mapeamento, cabecalho: string[]): string | null {
  const usados = Object.entries(m).filter(([, v]) => v)
  if (!m.telefone && !m.email) return 'Escolha ao menos a coluna de Telefone ou de E-mail.'
  for (const [campo, coluna] of usados) {
    if (!CAMPOS_SUPORTADOS.includes(campo as Campo)) return `Campo desconhecido: ${campo}.`
    if (!cabecalho.includes(coluna as string)) return `A coluna "${coluna}" não existe nesta aba.`
  }
  return null
}

// ----------------------------------------------------------------- chave estável
async function sha256Hex(texto: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const soDigitos = (s: string) => s.replace(/\D/g, '')

export type LinhaLead = {
  chave: string
  linha: number
  nome: string | null
  telefone: string | null
  email: string | null
  empresa: string | null
  meta_lead_id: string | null
  /** Todas as outras perguntas da linha (cabeçalho → resposta), na ordem da planilha. Vazias ficam de fora. */
  respostas: { pergunta: string; resposta: string }[]
}

/**
 * Pergunta/resposta de uma linha: tudo que não virou nome/telefone/e-mail/
 * empresa/ID do lead. Cabeçalho vazio vira "Coluna N"; cabeçalho repetido fica
 * repetido (o banco numera e guarda os dois).
 */
export function respostasDaLinha(cabecalho: string[], valores: string[], m: Mapeamento): { pergunta: string; resposta: string }[] {
  const contato = new Set([m.nome, m.telefone, m.email, m.empresa, m.meta_lead_id].filter((c): c is string => Boolean(c)))
  const saida: { pergunta: string; resposta: string }[] = []
  const total = Math.max(cabecalho.length, valores.length)
  for (let i = 0; i < total && saida.length < 200; i++) {
    const titulo = (cabecalho[i] ?? '').trim()
    // A coluna mapeada é a primeira com esse título (a mesma regra de montarLeads).
    if (titulo && contato.has(titulo) && cabecalho.indexOf(titulo) === i) continue
    const resposta = (valores[i] ?? '').trim()
    if (!resposta) continue
    saida.push({ pergunta: (titulo || `Coluna ${i + 1}`).slice(0, 500), resposta: resposta.slice(0, 5000) })
  }
  return saida
}

/**
 * Linhas → leads com CHAVE ESTÁVEL por fonte (idempotência):
 *  - com coluna identificadora (ID, carimbo de data/hora de formulário…): a chave é esse valor;
 *  - sem ela: impressão digital do contato (telefone + e-mail + nome normalizados).
 * Reordenar, inserir ou apagar linhas não muda a chave. Limitação documentada:
 * sem coluna identificadora, duas linhas com o MESMO contato contam como um só.
 */
export async function montarLeads(
  cabecalho: string[],
  linhas: { numero: number; valores: string[] }[],
  m: Mapeamento,
  colunaChave: string | null,
): Promise<{ leads: LinhaLead[]; vazias: number }> {
  const indice = (coluna?: string | null) => (coluna ? cabecalho.indexOf(coluna) : -1)
  const ix = { nome: indice(m.nome), telefone: indice(m.telefone), email: indice(m.email), empresa: indice(m.empresa), metaLead: indice(m.meta_lead_id), chave: indice(colunaChave) }
  const valor = (l: string[], i: number) => (i >= 0 ? (l[i] ?? '').trim() : '') || null
  const leads: LinhaLead[] = []
  let vazias = 0
  for (const l of linhas) {
    const nome = valor(l.valores, ix.nome)
    const telefone = valor(l.valores, ix.telefone)
    const email = valor(l.valores, ix.email)
    if (!telefone && !email) {
      vazias++
      continue
    }
    const id = valor(l.valores, ix.chave)
    const chave = id
      ? `id:${id.slice(0, 180)}`
      : `fp:${await sha256Hex([soDigitos(telefone ?? ''), (email ?? '').toLowerCase(), normalizar(nome ?? '')].join('|'))}`
    leads.push({
      chave,
      linha: l.numero,
      nome,
      telefone,
      email,
      empresa: valor(l.valores, ix.empresa),
      meta_lead_id: valor(l.valores, ix.metaLead),
      respostas: respostasDaLinha(cabecalho, l.valores, m),
    })
  }
  // A mesma chave duas vezes na leitura: fica a primeira.
  const vistos = new Set<string>()
  return { leads: leads.filter((x) => (vistos.has(x.chave) ? false : (vistos.add(x.chave), true))), vazias }
}

// ----------------------------------------------------------------- Drive: avisos de alteração (files.watch)
/**
 * Monitoramento oficial do Google Drive para UMA planilha (mesmo OAuth, escopo
 * drive.file: o arquivo já foi liberado no seletor). O Google chama o endereço
 * do AVANTE quando o arquivo muda; o aviso vem vazio ("mudou"), então quem lê
 * as linhas continua sendo a fila normal.
 *
 * Limites documentados pelo Google: canal de arquivo dura no máximo 1 dia e
 * não é renovável (cria-se outro); o aviso não garante tempo de entrega — para
 * planilhas, alterações costumam ser agrupadas e avisadas com atraso de alguns
 * minutos. Por isso o agendador periódico continua como contingência.
 */
export const DURACAO_MAXIMA_CANAL_MS = 24 * 60 * 60 * 1000

const codificador = new TextEncoder()
function base64Url(bytes: Uint8Array): string {
  let binario = ''
  for (const b of bytes) binario += String.fromCharCode(b)
  return btoa(binario).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
async function hmac(segredo: string, texto: string): Promise<string> {
  if (segredo.length < 32) throw new Error('Segredo curto demais para assinar o canal (mínimo 32 caracteres).')
  const chave = await crypto.subtle.importKey('raw', codificador.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', chave, codificador.encode(texto))))
}

/** Token do canal (volta em X-Goog-Channel-Token): `<fonte>.<HMAC(canal:fonte)>`. Não é segredo do Google; prova que o canal é nosso. */
export async function tokenDoCanal(segredo: string, canalId: string, fonteId: string): Promise<string> {
  return `${fonteId}.${await hmac(segredo, `drive-canal:${canalId}:${fonteId}`)}`
}

/** Confere o token do aviso em tempo constante; devolve a fonte só se a assinatura bater com ESTE canal. */
export async function conferirTokenDoCanal(segredo: string, canalId: string, token: string): Promise<string | null> {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{20,100})$/i.exec(token ?? '')
  if (!m || !/^[0-9a-f-]{36}$/i.test(canalId ?? '')) return null
  const esperado = await tokenDoCanal(segredo, canalId.toLowerCase(), m[1].toLowerCase())
  const recebido = `${m[1].toLowerCase()}.${m[2]}`
  if (esperado.length !== recebido.length) return null
  let d = 0
  for (let i = 0; i < esperado.length; i++) d |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i)
  return d === 0 ? m[1].toLowerCase() : null
}

export type CanalCriado = { resourceId: string; expiraEm: string }

/** Erro do Google ao criar o canal: `definitivo` = endereço/recurso recusado (não adianta insistir logo). */
export class ErroCanal extends Error {
  readonly definitivo: boolean
  readonly autorizacao: boolean
  constructor(mensagem: string, definitivo: boolean, autorizacao = false) {
    super(mensagem)
    this.definitivo = definitivo
    this.autorizacao = autorizacao
  }
}

export async function criarCanal(
  buscar: Busca,
  cfg: ConfigGoogle,
  accessToken: string,
  p: { planilhaId: string; canalId: string; endereco: string; token: string; duracaoMs?: number },
): Promise<CanalCriado> {
  const duracao = Math.min(Math.max(p.duracaoMs ?? DURACAO_MAXIMA_CANAL_MS, 60_000), DURACAO_MAXIMA_CANAL_MS)
  let r: Response
  try {
    r = await buscar(`${cfg.driveUrl ?? DRIVE_URL_PADRAO}/files/${encodeURIComponent(p.planilhaId)}/watch?supportsAllDrives=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.canalId, type: 'web_hook', address: p.endereco, token: p.token, expiration: String(Date.now() + duracao) }),
    })
  } catch {
    throw new ErroCanal('Não foi possível falar com o Google Drive.', false)
  }
  const c = await lerJson(r)
  if (r.status === 401) throw new ErroCanal('A autorização do Google expirou. Conecte a conta de novo.', false, true)
  if (r.status === 403 || r.status === 404) {
    throw new ErroCanal('O Google não liberou o monitoramento desta planilha (acesso do arquivo).', true)
  }
  if (r.status === 400) {
    // Ex.: push.webhookUrlUnauthorized / webhookUrlNotHttps — configuração do endereço, não da planilha.
    throw new ErroCanal('O Google recusou o endereço de avisos do AVANTE. A leitura periódica continua.', true)
  }
  if (r.status === 429) throw new ErroCanal('Limite de uso do Google atingido. Tentaremos de novo.', false)
  if (!r.ok || typeof c.resourceId !== 'string') throw new ErroCanal(`O Google Drive respondeu ${r.status}.`, false)
  const expira = Number(c.expiration)
  return { resourceId: c.resourceId, expiraEm: new Date(Number.isFinite(expira) && expira > 0 ? expira : Date.now() + duracao).toISOString() }
}

/** Encerra o canal no Google. Canal já vencido/inexistente (404) conta como encerrado. */
export async function encerrarCanal(
  buscar: Busca,
  cfg: ConfigGoogle,
  accessToken: string,
  p: { canalId: string; resourceId: string },
): Promise<'encerrado' | 'falhou'> {
  try {
    const r = await buscar(`${cfg.driveUrl ?? DRIVE_URL_PADRAO}/channels/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.canalId, resourceId: p.resourceId }),
    })
    return r.ok || r.status === 404 ? 'encerrado' : 'falhou'
  } catch {
    return 'falhou'
  }
}

/** Estados que o Google manda para arquivo (X-Goog-Resource-State). */
export const ESTADOS_AVISO = ['sync', 'add', 'remove', 'update', 'trash', 'untrash'] as const
