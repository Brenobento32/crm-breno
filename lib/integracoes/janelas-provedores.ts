/**
 * Janelas oficiais dos provedores, abertas no navegador do Administrador:
 *  - Google Picker (seletor de arquivos): com o escopo `drive.file`, o AVANTE
 *    só lê a planilha que o próprio usuário escolher aqui — o link sozinho não
 *    libera planilha privada;
 *  - Embedded Signup da Meta (cadastro do WhatsApp Business): devolve um
 *    `code` de uso único e os IDs da conta/número; a troca do code pelo token
 *    acontece SÓ no servidor (Edge Function `integracoes`).
 *
 * No ambiente local o servidor responde `simulado: true` e as mesmas funções
 * abrem as páginas simuladas do emulador (nada sai da máquina).
 *
 * Só navegador (usa `window`). Nenhum segredo passa por aqui: o token de acesso
 * do Google é curto (1 h), restrito a drive.file e não é guardado.
 */

type GooglePicker = {
  DocsView: new (viewId: unknown) => { setMode(m: unknown): unknown; setFileIds?(ids: string): unknown }
  ViewId: { SPREADSHEETS: unknown }
  DocsViewMode: { LIST: unknown }
  PickerBuilder: new () => {
    setAppId(id: string): GooglePickerBuilder
  }
  Action: { PICKED: string; CANCEL: string }
  Response: { ACTION: string; DOCUMENTS: string }
  Document: { ID: string }
}
type GooglePickerBuilder = {
  setAppId(id: string): GooglePickerBuilder
  setOAuthToken(t: string): GooglePickerBuilder
  setDeveloperKey(k: string): GooglePickerBuilder
  addView(v: unknown): GooglePickerBuilder
  setCallback(cb: (dados: Record<string, unknown>) => void): GooglePickerBuilder
  build(): { setVisible(v: boolean): void }
}
type JanelaComSdks = Window & {
  gapi?: { load(lib: string, cb: () => void): void }
  google?: { picker: GooglePicker }
  FB?: {
    init(o: Record<string, unknown>): void
    login(cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>): void
  }
}

const carregados = new Map<string, Promise<void>>()
function carregarScript(src: string): Promise<void> {
  if (!carregados.has(src)) {
    carregados.set(
      src,
      new Promise((ok, falha) => {
        const s = document.createElement('script')
        s.src = src
        s.async = true
        s.crossOrigin = 'anonymous'
        s.onload = () => ok()
        s.onerror = () => {
          carregados.delete(src)
          falha(new Error('Não foi possível carregar a janela do provedor. Confira a conexão e bloqueadores de anúncio.'))
        }
        document.head.appendChild(s)
      }),
    )
  }
  return carregados.get(src)!
}

function popup(url: string, nome: string) {
  const w = window.open(url, nome, 'width=560,height=720,noopener=no')
  if (!w) throw new Error('O navegador bloqueou a janela. Libere pop-ups para este site e tente de novo.')
  return w
}

/** Espera uma mensagem de `origem` que satisfaça `aceitar`, ou a janela fechar. */
function esperarMensagens<T>(origens: (o: string) => boolean, janela: Window | null, aceitar: (dados: unknown, acumulado: Partial<T>) => Partial<T> | 'fim' | null, pronto: (a: Partial<T>) => boolean): Promise<T | null> {
  return new Promise((resolver) => {
    let acumulado: Partial<T> = {}
    const fim = (v: T | null) => {
      window.removeEventListener('message', ouvir)
      clearInterval(vigia)
      resolver(v)
    }
    const ouvir = (ev: MessageEvent) => {
      if (!origens(ev.origin)) return
      let dados: unknown = ev.data
      if (typeof dados === 'string') {
        try {
          dados = JSON.parse(dados)
        } catch {
          return
        }
      }
      const r = aceitar(dados, acumulado)
      if (r === 'fim') return fim(null)
      if (r) acumulado = { ...acumulado, ...r }
      if (pronto(acumulado)) fim(acumulado as T)
    }
    window.addEventListener('message', ouvir)
    // Janela fechada sem concluir = cancelado (com folga para a última mensagem chegar).
    const vigia = setInterval(() => {
      if (janela?.closed) setTimeout(() => fim(pronto(acumulado) ? (acumulado as T) : null), 800)
    }, 500)
  })
}

// ------------------------------------------------------------------ Google Picker
export type AcessoSeletor = { accessToken: string; chaveApi: string; appId: string; simulado?: boolean; urlSeletor?: string }

/** Abre o seletor; devolve o ID da planilha escolhida (ou null se cancelado). */
export async function escolherPlanilhaNoGoogle(acesso: AcessoSeletor, planilhaSugerida?: string | null): Promise<string | null> {
  if (acesso.simulado && acesso.urlSeletor) {
    const u = new URL(acesso.urlSeletor)
    // Fragmento (#): não vai para servidor nem para log.
    u.hash = new URLSearchParams({ token: acesso.accessToken, ...(planilhaSugerida ? { planilha: planilhaSugerida } : {}) }).toString()
    const j = popup(u.toString(), 'seletor-google')
    const r = await esperarMensagens<{ planilhaId: string }>(
      (o) => o === u.origin,
      j,
      (d) => (d && typeof d === 'object' && (d as { origem?: string }).origem === 'seletor-google' ? { planilhaId: String((d as { planilhaId?: string }).planilhaId ?? '') } : null),
      (a) => Boolean(a.planilhaId),
    )
    return r?.planilhaId ?? null
  }

  const w = window as JanelaComSdks
  await carregarScript('https://apis.google.com/js/api.js')
  await new Promise<void>((ok) => w.gapi!.load('picker', ok))
  const g = w.google!.picker
  const visao = new g.DocsView(g.ViewId.SPREADSHEETS)
  visao.setMode(g.DocsViewMode.LIST)
  if (planilhaSugerida && visao.setFileIds) visao.setFileIds(planilhaSugerida)
  return new Promise((resolver) => {
    new g.PickerBuilder()
      .setAppId(acesso.appId)
      .setOAuthToken(acesso.accessToken)
      .setDeveloperKey(acesso.chaveApi)
      .addView(visao)
      .setCallback((dados) => {
        const acao = dados[g.Response.ACTION]
        if (acao === g.Action.PICKED) {
          const doc = (dados[g.Response.DOCUMENTS] as Record<string, string>[] | undefined)?.[0]
          resolver(doc?.[g.Document.ID] ?? null)
        } else if (acao === g.Action.CANCEL) resolver(null)
      })
      .build()
      .setVisible(true)
  })
}

// ------------------------------------------------------------------ Embedded Signup v4 (Meta)
export type ConfigMeta = { appId: string | null; configId: string | null; versaoGraph?: string | null; simulado?: boolean; urlCadastro?: string }
/** 'cloud_api' = número novo (pede registro com PIN); 'coexistencia' = número que já usa o app WhatsApp Business. */
export type ModoConexao = 'cloud_api' | 'coexistencia'
export type CadastroMeta = { code: string; wabaId: string; phoneNumberId: string; modo: ModoConexao }
export type ResultadoCadastroMeta =
  | { tipo: 'concluido'; cadastro: CadastroMeta }
  | { tipo: 'sem_numero' }
  | { tipo: 'cancelado'; etapa: string | null }
  | { tipo: 'erro'; mensagem: string }
  | { tipo: 'nao_suportado' }
type Final = Exclude<ResultadoCadastroMeta, { tipo: 'concluido' }>

export type EventoCadastro =
  | { tipo: 'codigo'; code: string }
  | { tipo: 'ids'; wabaId: string; phoneNumberId: string; modo: ModoConexao }
  | { tipo: 'final'; resultado: Final }

const ID_META = /^\d{5,30}$/

/**
 * Mensagem da janela da Meta → evento (v4: `type: 'WA_EMBEDDED_SIGNUP'`).
 *  - FINISH: número novo escolhido (Cloud API, exige registro com PIN);
 *  - FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING: número do app WhatsApp Business (coexistência);
 *  - FINISH_ONLY_WABA: conta criada, mas nenhum número escolhido;
 *  - outros FINISH_* (migração OBO, só acesso à API): fluxos que o AVANTE não usa;
 *  - CANCEL: abandonado (`current_step`) ou erro relatado pela Meta (`error_message`);
 *  - ERROR: falha na janela.
 */
export function lerEventoCadastro(d: unknown): EventoCadastro | null {
  if (!d || typeof d !== 'object') return null
  const o = d as {
    type?: string
    event?: string
    origem?: string
    code?: string
    data?: { phone_number_id?: unknown; waba_id?: unknown; current_step?: unknown; error_message?: unknown }
  }
  if (o.origem === 'cadastro-meta' && typeof o.code === 'string' && o.code) return { tipo: 'codigo', code: o.code }
  if (o.type !== 'WA_EMBEDDED_SIGNUP' || typeof o.event !== 'string') return null
  const dados = o.data ?? {}
  if (o.event === 'CANCEL') {
    if (typeof dados.error_message === 'string' && dados.error_message.trim()) {
      return { tipo: 'final', resultado: { tipo: 'erro', mensagem: `A Meta interrompeu o cadastro: ${dados.error_message.trim().slice(0, 200)}` } }
    }
    return { tipo: 'final', resultado: { tipo: 'cancelado', etapa: typeof dados.current_step === 'string' ? dados.current_step.slice(0, 60) : null } }
  }
  if (o.event === 'ERROR') return { tipo: 'final', resultado: { tipo: 'erro', mensagem: 'A janela da Meta informou um erro. Tente de novo em instantes.' } }
  if (o.event === 'FINISH_ONLY_WABA') return { tipo: 'final', resultado: { tipo: 'sem_numero' } }
  if (o.event === 'FINISH' || o.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
    const waba = String(dados.waba_id ?? '')
    const phone = String(dados.phone_number_id ?? '')
    if (!ID_META.test(waba) || !ID_META.test(phone)) return { tipo: 'final', resultado: { tipo: 'sem_numero' } }
    return { tipo: 'ids', wabaId: waba, phoneNumberId: phone, modo: o.event === 'FINISH' ? 'cloud_api' : 'coexistencia' }
  }
  if (o.event.startsWith('FINISH')) return { tipo: 'final', resultado: { tipo: 'nao_suportado' } }
  return null
}

export type EstadoCadastro = { code?: string; ids?: Omit<CadastroMeta, 'code'>; final?: Final }

export function aplicarEvento(e: EstadoCadastro, ev: EventoCadastro | null): EstadoCadastro {
  if (!ev) return e
  if (ev.tipo === 'codigo') return { ...e, code: ev.code }
  if (ev.tipo === 'ids') return { ...e, ids: { wabaId: ev.wabaId, phoneNumberId: ev.phoneNumberId, modo: ev.modo } }
  return e.final ? e : { ...e, final: ev.resultado }
}

/** Resultado do que chegou até agora; `encerrado` = janela fechada ou tempo esgotado. Null = ainda falta algo. */
export function resultadoDoCadastro(e: EstadoCadastro, encerrado: boolean): ResultadoCadastroMeta | null {
  if (e.final) return e.final
  if (e.code && e.ids) return { tipo: 'concluido', cadastro: { code: e.code, ...e.ids } }
  return encerrado ? { tipo: 'cancelado', etapa: null } : null
}

/**
 * Parâmetros da janela do cadastro incorporado (v4), como nos exemplos oficiais
 * (`setup: {}`). Pela tabela de versões da Meta, a v4 manda os eventos da janela
 * (FINISH… com `waba_id` e `phone_number_id`) em todos os fluxos; `sessionInfoVersion`
 * só era obrigatório na v2. Fica `'3'` nos dois modos por ser o valor do exemplo oficial
 * de coexistência e o que o verificador da Meta reconhece.
 * `version: 'v4'` fixa a versão, como nos parâmetros que o configurador da Meta gera:
 * a v5 (out/2026) tem outro formato (coexistência ligada por padrão, sem `featureType`
 * nem `sessionInfoVersion`) e só deve entrar com mudança e teste próprios.
 * Coexistência (app WhatsApp Business + Cloud API): `featureType` faz a Meta mostrar a
 * opção de conectar o número do app; número novo continua possível na mesma janela.
 * Conferido no verificador da Meta (31/10/2026) contra a configuração 2263375681228010:
 * v4, cloud_api, sessão 3; coexistência "Ativado" só no cartão B.
 */
export type ExtrasCadastro = {
  setup: Record<string, never>
  version: 'v4'
  sessionInfoVersion: '3'
  featureType?: 'whatsapp_business_app_onboarding'
}
export function extrasDoCadastro(coexistencia: boolean): ExtrasCadastro {
  return coexistencia
    ? { setup: {}, version: 'v4', featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }
    : { setup: {}, version: 'v4', sessionInfoVersion: '3' }
}

const VERSAO_SDK_PADRAO = 'v23.0'
const ORIGENS_META = new Set(['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com'])

/**
 * Abre o cadastro incorporado da Meta (v4: os produtos ficam na configuração do
 * Login do Facebook para Empresas). Com `coexistencia`, pede à Meta o fluxo do app
 * WhatsApp Business (`featureType: whatsapp_business_app_onboarding`). Não lança por cancelamento:
 * devolve o motivo, para a tela dizer o que falta.
 */
export async function cadastrarWhatsappNaMeta(cfg: ConfigMeta, opcoes: { coexistencia?: boolean } = {}): Promise<ResultadoCadastroMeta> {
  let estado: EstadoCadastro = {}
  let janela: Window | null = null
  let origemOk: (o: string) => boolean = (o) => ORIGENS_META.has(o)
  let codigoDoLogin: Promise<string | null> | null = null

  if (cfg.simulado && cfg.urlCadastro) {
    const origem = new URL(cfg.urlCadastro).origin
    origemOk = (o) => o === origem
    const url = new URL(cfg.urlCadastro)
    if (opcoes.coexistencia) url.searchParams.set('preferencia', 'coexistencia')
    janela = popup(url.toString(), 'cadastro-meta')
  } else {
    if (!cfg.appId || !cfg.configId) throw new Error('O app da Meta ainda não foi configurado na plataforma.')
    const w = window as JanelaComSdks
    await carregarScript('https://connect.facebook.net/pt_BR/sdk.js')
    const versao = cfg.versaoGraph && /^v\d+\.\d+$/.test(cfg.versaoGraph) ? cfg.versaoGraph : VERSAO_SDK_PADRAO
    w.FB!.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: versao })
    codigoDoLogin = new Promise<string | null>((ok) =>
      w.FB!.login((r) => ok(r.authResponse?.code ?? null), {
        config_id: cfg.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: extrasDoCadastro(Boolean(opcoes.coexistencia)),
      }),
    )
  }

  return new Promise<ResultadoCadastroMeta>((resolver) => {
    let encerrou = false
    let prazo: ReturnType<typeof setTimeout> | null = null
    const conferir = (fechado: boolean) => {
      const r = resultadoDoCadastro(estado, fechado)
      if (r) terminar(r)
    }
    const ouvir = (ev: MessageEvent) => {
      if (!origemOk(ev.origin)) return
      let dados: unknown = ev.data
      if (typeof dados === 'string') {
        try {
          dados = JSON.parse(dados)
        } catch {
          return
        }
      }
      estado = aplicarEvento(estado, lerEventoCadastro(dados))
      conferir(false)
    }
    // Simulado: janela fechada sem concluir = cancelado (com folga para a última mensagem chegar).
    const vigia = setInterval(() => {
      if (janela?.closed) setTimeout(() => conferir(true), 800)
    }, 500)
    function terminar(r: ResultadoCadastroMeta) {
      if (encerrou) return
      encerrou = true
      window.removeEventListener('message', ouvir)
      clearInterval(vigia)
      if (prazo) clearTimeout(prazo)
      resolver(r)
    }
    window.addEventListener('message', ouvir)
    // Real: o code chega pelo retorno do login; os IDs, por mensagem (até 15 s depois).
    void codigoDoLogin?.then((code) => {
      if (code) estado = { ...estado, code }
      const r = resultadoDoCadastro(estado, !code)
      if (r) return terminar(r)
      prazo = setTimeout(() => conferir(true), 15000)
    })
  })
}

// ------------------------------------------------------------------ Meta Business Extension (Conversões do CRM)
export type ConfigMetaAds = { appId: string | null; idExterno: string; simulado?: boolean; urlMbe?: string }

/**
 * Janela oficial da Meta para ligar o AVANTE ao Gerenciador de Eventos da
 * empresa (canal CONVERSIONS_API). Devolve um code de uso único (ou null se
 * cancelado); o servidor troca pelo token de sistema e guarda no cofre.
 * No modo real depende da permissão `manage_business_extension` liberada pela Meta.
 */
export async function conectarMetaAds(cfg: ConfigMetaAds): Promise<string | null> {
  if (cfg.simulado && cfg.urlMbe) {
    const u = new URL(cfg.urlMbe)
    u.hash = new URLSearchParams({ externo: cfg.idExterno }).toString()
    const j = popup(u.toString(), 'mbe-meta')
    const r = await esperarMensagens<{ code: string }>(
      (o) => o === u.origin,
      j,
      (d) => {
        const o = d as { origem?: string; code?: string; cancelado?: boolean }
        if (!o || o.origem !== 'mbe-meta') return null
        return o.cancelado ? 'fim' : o.code ? { code: o.code } : null
      },
      (a) => Boolean(a.code),
    )
    return r?.code ?? null
  }
  if (!cfg.appId) throw new Error('O app da Meta ainda não foi configurado na plataforma.')
  const w = window as JanelaComSdks
  await carregarScript('https://connect.facebook.net/pt_BR/sdk.js')
  w.FB!.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: 'v23.0' })
  return new Promise<string | null>((ok) =>
    w.FB!.login((r) => ok(r.authResponse?.code ?? null), {
      scope: 'manage_business_extension',
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: { external_business_id: cfg.idExterno, timezone: 'America/Sao_Paulo', currency: 'BRL', business_vertical: 'ECOMMERCE', channel: 'CONVERSIONS_API' },
        business_config: { business: { name: 'AVANTE CRM' } },
        repeat: false,
      },
    }),
  )
}

// ------------------------------------------------------------------ Meta Ads: Login do Facebook para Empresas
export type ConfigLoginMetaAds = { appId: string | null; configIdLogin: string | null; simulado?: boolean; urlLogin?: string }

/**
 * Janela oficial do Login do Facebook para Empresas (configuração do Meta Ads, token
 * BISU). A empresa escolhe, no PRÓPRIO portfólio, as Páginas, contas de anúncios e
 * datasets que libera; nada é transferido para a BM da Rio X7. Devolve o code de uso
 * único (ou null se cancelado); o servidor troca pelo token e guarda no cofre.
 */
export async function conectarMetaAdsLogin(cfg: ConfigLoginMetaAds): Promise<string | null> {
  if (cfg.simulado && cfg.urlLogin) {
    // Só no ambiente local (o servidor de produção nunca responde `simulado`).
    const u = new URL(cfg.urlLogin)
    const j = popup(u.toString(), 'login-meta-ads')
    const r = await esperarMensagens<{ code: string }>(
      (o) => o === u.origin,
      j,
      (d) => {
        const o = d as { origem?: string; code?: string; cancelado?: boolean }
        if (!o || o.origem !== 'login-meta-ads') return null
        return o.cancelado ? 'fim' : o.code ? { code: o.code } : null
      },
      (a) => Boolean(a.code),
    )
    return r?.code ?? null
  }
  if (!cfg.appId || !cfg.configIdLogin) throw new Error('O login do Meta Ads ainda não foi configurado na plataforma.')
  const w = window as JanelaComSdks
  await carregarScript('https://connect.facebook.net/pt_BR/sdk.js')
  w.FB!.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: VERSAO_SDK_PADRAO })
  return new Promise<string | null>((ok) =>
    w.FB!.login((r) => ok(r.authResponse?.code ?? null), {
      config_id: cfg.configIdLogin!,
      response_type: 'code',
      override_default_response_type: true,
    }),
  )
}
