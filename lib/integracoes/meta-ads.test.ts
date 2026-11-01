import { describe, expect, it } from 'vitest'

import { sincronizarMetricasAds, tratarIntegracoes, type Dependencias, type ErroBanco } from '../../supabase/functions/_shared/integracoes-servico.ts'
import {
  ativosLiberados,
  atribuicaoDoLead,
  comprasDasAcoes,
  leadsDasAcoes,
  metricasDaConta,
  respostasDoLead,
} from '../../supabase/functions/_shared/meta-ads.ts'
import { linhaDoPainel } from './meta-ads-painel'

/**
 * Meta Ads multiempresa (Login do Facebook para Empresas, token BISU): cada empresa
 * autoriza os PRÓPRIOS ativos; o AVANTE só usa o que a Meta liberou para aquele token,
 * nunca devolve tokens e nunca cria/edita campanhas. Banco e Meta são falsos.
 */
const BASE = 'http://local/functions/v1/integracoes'
const GRAPH = 'https://meta.falsa/v23.0'
const T_A = '11111111-1111-4111-8111-111111111111'
const FUNIL = '77777777-7777-4777-8777-777777777777'
const ETAPA = '88888888-8888-4888-8888-888888888888'
const RESP = '99999999-9999-4999-8999-999999999999'
const FONTE = '44444444-4444-4444-8444-444444444444'
const NEGOCIO = '500000000000001'
const DS = '600000000000001'
const PAG = '700000000000001'
const CONTA = '800000000000001'
const CFG = { graphUrl: GRAPH, appId: 'app', appSecret: 'segredo-app' }

type Chamada = { nome: string; args?: Record<string, unknown> }
type Resp = { data: unknown; error: ErroBanco }
type Rpcs = Record<string, (args?: Record<string, unknown>) => Resp>
type Externa = { url: string; metodo: string; auth: string | null }

/** Meta falsa: só o portfólio NEGOCIO, com um dataset, uma Página e uma conta liberados. */
function metaFalsa(sobre: Record<string, () => Response> = {}) {
  return (url: string, metodo: string): Response => {
    const u = new URL(url)
    const p = u.pathname.replace('/v23.0', '')
    const chave = `${metodo} ${p}`
    if (sobre[chave]) return sobre[chave]()
    if (p === '/oauth/access_token') return Response.json({ access_token: 'tok-bisu-cliente-xxxxxxxx' })
    if (p === '/me' && u.searchParams.get('fields') === 'client_business_id') return Response.json({ client_business_id: NEGOCIO, id: '1' })
    if (p === `/${NEGOCIO}/owned_pixels`) return Response.json({ data: [{ id: DS, name: 'Dataset A' }] })
    if (p === `/${NEGOCIO}/client_pixels`) return Response.json({ data: [] })
    if (p === '/me/accounts') return Response.json({ data: [{ id: PAG, name: 'Página A' }] })
    if (p === '/me/adaccounts') return Response.json({ data: [{ account_id: CONTA, name: 'Conta A', currency: 'BRL', account_status: 1 }] })
    if (p === `/${PAG}` && metodo === 'GET') return Response.json({ access_token: 'tok-pagina-xxxxxxxxxxxx', name: 'Página A' })
    if (p === `/${PAG}/subscribed_apps` && metodo === 'POST') return Response.json({ success: true })
    if (p === `/act_${CONTA}/insights`) {
      return Response.json({
        data: [
          {
            campaign_id: '900000000000001',
            campaign_name: 'Campanha 1',
            spend: '150.5',
            impressions: '1000',
            clicks: '40',
            date_start: '2026-10-30',
            actions: [
              { action_type: 'lead', value: '5' },
              { action_type: 'onsite_conversion.lead_grouped', value: '5' },
              { action_type: 'link_click', value: '40' },
              { action_type: 'omni_purchase', value: '2' },
              { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' },
            ],
            action_values: [
              { action_type: 'omni_purchase', value: '900.5' },
              { action_type: 'offsite_conversion.fb_pixel_purchase', value: '900.5' },
            ],
          },
        ],
      })
    }
    return new Response('{}', { status: 404 })
  }
}

function montar(opts: { admin?: Rpcs; meta?: Record<string, () => Response>; semConfigLogin?: boolean } = {}) {
  const admin: Chamada[] = []
  const externas: Externa[] = []
  const ordem: string[] = []
  const meta = metaFalsa(opts.meta)
  const rpc = (mapa: Rpcs | undefined, reg: Chamada[], quem: string) => (nome: string, args?: Record<string, unknown>) => {
    reg.push({ nome, args })
    ordem.push(`${quem}:${nome}`)
    const f = mapa?.[nome]
    return Promise.resolve(f ? f(args) : { data: null, error: null })
  }
  const deps: Dependencias = {
    admin: {
      rpc: rpc(
        { meta_ads_credencial: () => ({ data: [{ negocio_id: NEGOCIO, token: 'tok-bisu-cliente-xxxxxxxx' }], error: null }), meta_ads_salvar_pagina: () => ({ data: FONTE, error: null }), ...opts.admin },
        admin,
        'admin',
      ),
    },
    comoUsuario: () => ({
      rpc: rpc({ exigir_administrador_integracoes: () => ({ data: T_A, error: null }), capi_exigir: () => ({ data: null, error: null }) }, [], 'usuario'),
      auth: { getUser: async () => ({ data: { user: { id: 'u-admin' } }, error: null }) },
    }),
    buscar: async (url, init) => {
      const metodo = String(init?.method ?? 'GET')
      externas.push({ url: String(url), metodo, auth: new Headers(init?.headers).get('Authorization') })
      ordem.push(`meta:${metodo} ${new URL(String(url)).pathname.replace('/v23.0', '')}`)
      return meta(String(url), metodo)
    },
    google: null,
    meta: { graphUrl: GRAPH, appId: 'app', appSecret: 'segredo-app', configId: 'cfg-wa', configIdAds: opts.semConfigLogin ? '' : 'cfg-ads', verifyToken: 'v' },
    segredoEstado: 'segredo-de-estado-com-pelo-menos-32-caracteres!!',
    segredoCron: 'segredo-do-agendador-com-32-caracteres-ou-mais',
    urlApp: 'https://avante.local',
  }
  return { deps, admin, externas, ordem }
}

const post = (rota: string, corpo: unknown = {}) =>
  new Request(`${BASE}${rota}`, { method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: JSON.stringify(corpo) })
const semToken = (x: unknown) => !/tok-/.test(JSON.stringify(x ?? null))
const proibido = (e: Externa[]) => e.filter((x) => x.metodo !== 'GET' && !x.url.includes('/subscribed_apps'))

// ------------------------------------------------------------------ peças puras
describe('leitura da Meta (Marketing API, só leitura)', () => {
  it('ativos: só o que o token liberou; cada chamada leva appsecret_proof', async () => {
    const urls: string[] = []
    const a = await ativosLiberados(
      async (u) => {
        urls.push(String(u))
        return metaFalsa()(String(u), 'GET')
      },
      CFG,
      'tok',
      NEGOCIO,
    )
    expect(a).toEqual({
      negocioId: NEGOCIO,
      datasets: [{ id: DS, nome: 'Dataset A' }],
      paginas: [{ id: PAG, nome: 'Página A' }],
      contas: [{ id: CONTA, nome: 'Conta A', moeda: 'BRL', ativa: true }],
    })
    expect(urls.every((u) => new URL(u).searchParams.get('appsecret_proof')?.length === 64)).toBe(true)
  })

  it('métricas por campanha e dia; leads sem somar tipos que se sobrepõem', async () => {
    const m = await metricasDaConta(async (u) => metaFalsa()(String(u), 'GET'), CFG, 'tok', CONTA, { desde: '2026-10-25', ate: '2026-10-31' })
    expect(m).toEqual([{ dia: '2026-10-30', campanhaId: '900000000000001', campanhaNome: 'Campanha 1', investimento: 150.5, impressoes: 1000, cliques: 40, leads: 5, conversoesMeta: 2, valorConversoesMeta: 900.5 }])
    expect(comprasDasAcoes([{ action_type: 'purchase', value: '1' }, { action_type: 'omni_purchase', value: '3' }, { action_type: 'lead', value: '9' }])).toBe(3)
    expect(leadsDasAcoes([{ action_type: 'lead', value: '3' }, { action_type: 'leadgen_grouped', value: '4' }])).toBe(4)
    await expect(metricasDaConta(async () => Response.json({}), CFG, 'tok', CONTA, { desde: 'ontem', ate: '2026-10-31' })).rejects.toThrow('Período inválido')
  })

  it('lead: atribuição com campanha, conjunto, anúncio, formulário e plataforma; respostas extras', () => {
    const lead = {
      campaign_id: '900000000000001',
      campaign_name: 'Campanha 1',
      adset_id: '910000000000001',
      adset_name: 'Conjunto',
      ad_id: '920000000000001',
      ad_name: 'Anúncio',
      form_id: '930000000000001',
      platform: 'ig',
      is_organic: false,
      created_time: '2026-10-31T10:00:00+0000',
      field_data: [
        { name: 'full_name', values: ['Ana'] },
        { name: 'qual_o_seu_orcamento', values: ['R$ 5 mil'] },
      ],
    }
    expect(atribuicaoDoLead('1000000000000001', PAG, lead)).toEqual({
      source: 'meta_lead_ads',
      leadgen_id: '1000000000000001',
      page_id: PAG,
      campaign_id: '900000000000001',
      campaign_name: 'Campanha 1',
      adset_id: '910000000000001',
      adset_name: 'Conjunto',
      ad_id: '920000000000001',
      ad_name: 'Anúncio',
      form_id: '930000000000001',
      platform: 'ig',
      is_organic: 'false',
      created_time: '2026-10-31T10:00:00+0000',
    })
    expect(respostasDoLead(lead.field_data)).toEqual([{ pergunta_externa: 'qual_o_seu_orcamento', resposta: 'R$ 5 mil' }])
  })

  it('painel: ROAS do CRM e ROAS da Meta separados; CPL pelo lead do CRM; sem divisão por zero', () => {
    const base = { conta_id: CONTA, campanha_id: '1', campanha_nome: null, impressoes: 0, cliques: 0, leads_meta: 0, vendas: 1 }
    expect(
      linhaDoPainel({ ...base, investimento: '300', leads_crm: '6', faturamento: '1500', conversoes_meta: '4', valor_conversoes_meta: '2400' }),
    ).toMatchObject({ cpl: 50, roasCrm: 5, faturamento: 1500, conversoesMeta: 4, valorConversoesMeta: 2400, roasMeta: 8 })
    // A Meta não atribuiu nada: o ROAS do CRM continua o do CRM (nunca usa o valor da Meta).
    expect(linhaDoPainel({ ...base, investimento: '300', leads_crm: '6', faturamento: '1500' })).toMatchObject({ roasCrm: 5, roasMeta: 0 })
    expect(linhaDoPainel({ ...base, investimento: 0, leads_crm: 0, faturamento: 0, valor_conversoes_meta: 100 })).toMatchObject({
      cpl: null,
      roasCrm: null,
      roasMeta: null,
    })
  })
})

// ------------------------------------------------------------------ rotas
describe('conectar pelo Login para Empresas', () => {
  it('troca o code, guarda o token do portfólio do cliente e devolve só IDs e nomes', async () => {
    const m = montar()
    const r = await tratarIntegracoes(post('/meta-ads/login/concluir', { code: 'code-1' }), m.deps)
    const corpo = await r.json()
    expect(r.status).toBe(200)
    expect(corpo).toMatchObject({ ok: true, negocioId: NEGOCIO, datasets: [{ id: DS }], paginas: [{ id: PAG }], contas: [{ id: CONTA }] })
    expect(semToken(corpo)).toBe(true)
    expect(m.admin.find((c) => c.nome === 'meta_ads_salvar_conexao')?.args).toEqual({
      p_tenant: T_A,
      p_usuario: 'u-admin',
      p_negocio_id: NEGOCIO,
      p_token: 'tok-bisu-cliente-xxxxxxxx',
    })
    expect(proibido(m.externas)).toHaveLength(0)
  })

  it('portfólio já ligado a outra empresa: recusa e não lista nada', async () => {
    const m = montar({ admin: { meta_ads_salvar_conexao: () => ({ data: null, error: { code: '23505', message: 'Este portfólio da Meta já está conectado a outra empresa.' } }) } })
    const r = await tratarIntegracoes(post('/meta-ads/login/concluir', { code: 'code-1' }), m.deps)
    expect(r.ok).toBe(false)
    expect(m.externas.some((e) => e.url.includes('owned_pixels'))).toBe(false)
  })

  it('sem a configuração do login na plataforma: 503, nada sai', async () => {
    const m = montar({ semConfigLogin: true })
    const r = await tratarIntegracoes(post('/meta-ads/login/concluir', { code: 'code-1' }), m.deps)
    expect(r.status).toBe(503)
    expect(m.externas).toHaveLength(0)
    const cfg = await (await tratarIntegracoes(post('/meta-ads/config'), m.deps)).json()
    expect(cfg.configIdLogin).toBeNull()
  })
})

describe('escolher ativos: só os que a Meta liberou para este token', () => {
  const escolha = (extra: Record<string, unknown> = {}) => ({
    datasetId: DS,
    paginas: [{ id: PAG, funil: FUNIL, etapa: ETAPA, responsavel: RESP }],
    contas: [CONTA],
    ...extra,
  })

  it('dataset → Conversões do CRM (mesma CAPI); Página salva no banco ANTES de inscrever; contas no painel', async () => {
    const m = montar({ admin: { meta_ads_salvar_contas: () => ({ data: 1, error: null }) } })
    const r = await tratarIntegracoes(post('/meta-ads/login/selecionar', escolha()), m.deps)
    const corpo = await r.json()
    expect(corpo).toEqual({ ok: true, dataset: DS, paginas: [{ id: PAG, situacao: 'conectada' }], contas: 1 })
    expect(semToken(corpo)).toBe(true)
    expect(m.admin.find((c) => c.nome === 'capi_salvar_conexao')?.args).toMatchObject({ p_tenant: T_A, p_business_id: NEGOCIO, p_dataset_id: DS, p_dataset_nome: 'Dataset A' })
    expect(m.admin.find((c) => c.nome === 'meta_ads_salvar_pagina')?.args).toMatchObject({ p_tenant: T_A, p_pagina_id: PAG, p_token: 'tok-pagina-xxxxxxxxxxxx', p_funil: FUNIL })
    expect(m.ordem.indexOf('admin:meta_ads_salvar_pagina')).toBeLessThan(m.ordem.indexOf(`meta:POST /${PAG}/subscribed_apps`))
    const insc = m.externas.find((e) => e.url.includes(`/${PAG}/subscribed_apps`))!
    expect(new URL(insc.url).searchParams.get('subscribed_fields')).toBe('leadgen')
    expect(insc.auth).toBe('Bearer tok-pagina-xxxxxxxxxxxx')
    expect(m.admin.find((c) => c.nome === 'meta_ads_salvar_contas')?.args).toEqual({ p_tenant: T_A, p_usuario: 'u-admin', p_contas: [{ id: CONTA, nome: 'Conta A', moeda: 'BRL' }] })
    expect(proibido(m.externas)).toHaveLength(0)
  })

  it.each([
    ['dataset', { datasetId: '600000000000999' }],
    ['Página', { paginas: [{ id: '700000000000999', funil: FUNIL, etapa: ETAPA, responsavel: RESP }] }],
    ['conta de anúncios', { contas: ['800000000000999'] }],
  ])('%s fora do que a Meta liberou: 403 e nada é salvo', async (_n, extra) => {
    const m = montar()
    const r = await tratarIntegracoes(post('/meta-ads/login/selecionar', escolha(extra)), m.deps)
    expect(r.status).toBe(403)
    expect(m.admin.some((c) => ['capi_salvar_conexao', 'meta_ads_salvar_pagina', 'meta_ads_salvar_contas'].includes(c.nome))).toBe(false)
    expect(m.externas.some((e) => e.metodo === 'POST')).toBe(false)
  })

  it('banco recusa a Página (de outra empresa / cota): não inscreve na Meta', async () => {
    const m = montar({ admin: { meta_ads_salvar_pagina: () => ({ data: null, error: { code: '23505', message: 'Esta Página já está conectada a outra empresa.' } }) } })
    const corpo = await (await tratarIntegracoes(post('/meta-ads/login/selecionar', escolha({ datasetId: null, contas: [] })), m.deps)).json()
    expect(corpo.paginas).toEqual([{ id: PAG, situacao: 'erro', mensagem: 'Esta Página já está conectada a outra empresa.' }])
    expect(m.externas.some((e) => e.url.includes('/subscribed_apps'))).toBe(false)
  })

  it('Meta recusa a inscrição da Página: fonte marcada como não validada (não recebe leads)', async () => {
    const m = montar({ meta: { [`POST /${PAG}/subscribed_apps`]: () => Response.json({ error: { code: 200, message: 'x' } }, { status: 403 }) } })
    const corpo = await (await tratarIntegracoes(post('/meta-ads/login/selecionar', escolha({ datasetId: null, contas: [] })), m.deps)).json()
    expect(corpo.paginas[0]).toMatchObject({ situacao: 'erro' })
    expect(m.admin.find((c) => c.nome === 'marcar_fonte_validada')?.args).toMatchObject({ p_fonte: FONTE, p_valida: false })
  })

  it('Página sem destino completo: 422 antes de qualquer chamada', async () => {
    const m = montar()
    const r = await tratarIntegracoes(post('/meta-ads/login/selecionar', escolha({ paginas: [{ id: PAG, funil: FUNIL }] })), m.deps)
    expect(r.status).toBe(422)
    expect(m.externas).toHaveLength(0)
  })

  it('sem conexão desta empresa: 409', async () => {
    const m = montar({ admin: { meta_ads_credencial: () => ({ data: [], error: null }) } })
    const r = await tratarIntegracoes(post('/meta-ads/login/selecionar', escolha()), m.deps)
    expect(r.status).toBe(409)
    expect(m.externas).toHaveLength(0)
  })
})

describe('métricas no agendador (só leitura)', () => {
  const contas = () => ({ data: [{ conta_ref: 'c1', tenant_id: T_A, conta_id: CONTA, token: 'tok-bisu-cliente-xxxxxxxx', ultima: null }], error: null })

  it('lê a conta e grava as linhas; nada além de GET', async () => {
    const m = montar({ admin: { meta_ads_contas_para_sincronizar: contas, meta_ads_registrar_metricas: () => ({ data: 1, error: null }) } })
    const r = await sincronizarMetricasAds(m.deps, 10, new Date('2026-10-31T15:00:00Z'))
    expect(r).toEqual({ contas: 1, linhas: 1, erros: 0 })
    const ins = m.externas.find((e) => e.url.includes('/insights'))!
    expect(JSON.parse(new URL(ins.url).searchParams.get('time_range')!)).toEqual({ since: '2026-10-02', until: '2026-10-31' })
    expect(m.admin.find((c) => c.nome === 'meta_ads_registrar_metricas')?.args).toMatchObject({ p_conta_ref: 'c1' })
    expect(m.externas.every((e) => e.metodo === 'GET')).toBe(true)
  })

  it('autorização revogada pela empresa (190): pede reconexão, não derruba as outras', async () => {
    const m = montar({
      admin: { meta_ads_contas_para_sincronizar: contas },
      meta: { [`GET /act_${CONTA}/insights`]: () => Response.json({ error: { code: 190, message: 'expired' } }, { status: 400 }) },
    })
    const r = await sincronizarMetricasAds(m.deps)
    expect(r).toMatchObject({ contas: 0, erros: 1 })
    expect(m.admin.find((c) => c.nome === 'meta_ads_registrar_erro')?.args).toMatchObject({ p_tenant: T_A, p_autorizacao: true })
  })
})
