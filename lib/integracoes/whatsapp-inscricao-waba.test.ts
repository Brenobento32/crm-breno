import { describe, expect, it } from 'vitest'

import { tratarIntegracoes, type Dependencias, type ErroBanco } from '../../supabase/functions/_shared/integracoes-servico.ts'
import * as whatsappCloud from '../../supabase/functions/_shared/whatsapp-cloud.ts'

/**
 * Inscrição do app na conta do WhatsApp (WABA) do cliente — o AVANTE NUNCA retira a
 * inscrição na Meta (nenhum DELETE /subscribed_apps), para não cortar outro número
 * legítimo da mesma conta, de qualquer empresa:
 *  - cadastro recusado pelo banco → só registra a limpeza pendente (o banco decide se a conta está livre);
 *  - cadastro aceito → inscreve de novo, de forma idempotente, depois de salvar;
 *  - "Desconectar" continua só no banco (whatsapp_acao), que registra a pendência.
 * Banco e Meta são falsos; nada sai da máquina.
 */
const BASE = 'http://local/functions/v1/integracoes'
const GRAPH = 'https://meta.falsa/v23.0'
const T_A = '11111111-1111-4111-8111-111111111111'
const NUMERO = '66666666-6666-4666-8666-666666666666'
const FUNIL = '77777777-7777-4777-8777-777777777777'
const ETAPA = '88888888-8888-4888-8888-888888888888'
const RESP = '99999999-9999-4999-8999-999999999999'
const WABA = '10000000001'
const PHONE = '20000000002'
const INSCRICAO = `${GRAPH}/${WABA}/subscribed_apps`

type Chamada = { nome: string; args?: Record<string, unknown> }
type Resp = { data: unknown; error: ErroBanco }
type Rpcs = Record<string, (args?: Record<string, unknown>) => Resp>
type Externa = { url: string; metodo: string; auth: string | null }

function metaFalsa(posts: Response[] = []): (url: string, metodo: string) => Response {
  let i = 0
  return (url, metodo) => {
    if (url.includes('/oauth/access_token')) return Response.json({ access_token: 'tok-novo' })
    if (url.includes(`/${WABA}/phone_numbers`)) return Response.json({ data: [{ id: PHONE, display_phone_number: '+55 11 90000-0002', verified_name: 'Empresa A' }] })
    if (url === INSCRICAO && metodo === 'POST') return posts[i++] ?? Response.json({ success: true })
    if (url.endsWith(`/${PHONE}/register`)) return Response.json({ success: true })
    if (url.includes('/smb_app_data')) return Response.json({ request_id: 'req-1' })
    return new Response('{}', { status: 404 })
  }
}

function montar(opts: { admin?: Rpcs; usuario?: Rpcs; posts?: Response[] } = {}) {
  const admin: Chamada[] = []
  const externas: Externa[] = []
  const ordem: string[] = []
  const rpc = (mapa: Rpcs | undefined, registro: Chamada[], quem: string) => (nome: string, args?: Record<string, unknown>) => {
    registro.push({ nome, args })
    ordem.push(`${quem}:${nome}`)
    const f = mapa?.[nome]
    return Promise.resolve(f ? f(args) : { data: null, error: null })
  }
  const meta = metaFalsa(opts.posts)
  const deps: Dependencias = {
    admin: { rpc: rpc(opts.admin, admin, 'admin') },
    comoUsuario: () => ({
      rpc: rpc({ exigir_administrador_integracoes: () => ({ data: T_A, error: null }), ...opts.usuario }, [], 'usuario'),
      auth: { getUser: async () => ({ data: { user: { id: 'u-admin' } }, error: null }) },
    }),
    buscar: async (url, init) => {
      const metodo = String(init?.method ?? 'GET')
      externas.push({ url: String(url), metodo, auth: new Headers(init?.headers).get('Authorization') })
      ordem.push(`meta:${metodo} ${String(url).replace(GRAPH, '')}`)
      return meta(String(url), metodo)
    },
    google: null,
    meta: { graphUrl: GRAPH, appId: 'app', appSecret: 'segredo-app', configId: 'cfg', verifyToken: 'verifica' },
    segredoEstado: 'segredo-de-estado-com-pelo-menos-32-caracteres!!',
    segredoCron: 'segredo-do-agendador-com-32-caracteres-ou-mais',
    urlApp: 'https://avante.local',
  }
  return { deps, admin, externas, ordem }
}

const post = (rota: string, corpo: unknown) =>
  new Request(`${BASE}${rota}`, { method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: JSON.stringify(corpo) })
const concluir = (extra: Record<string, unknown> = {}) =>
  post('/whatsapp/concluir', { code: 'code-unico', wabaId: WABA, phoneNumberId: PHONE, funil: FUNIL, etapa: ETAPA, responsavel: RESP, ...extra })

const nuncaRetira = (e: Externa[]) => e.every((x) => x.metodo !== 'DELETE')
const inscricoes = (e: Externa[]) => e.filter((x) => x.url === INSCRICAO && x.metodo === 'POST')
const salvo = { whatsapp_salvar_numero: () => ({ data: NUMERO, error: null }) }

describe('o AVANTE nunca retira a inscrição na Meta', () => {
  it('não existe função de retirada (DELETE /subscribed_apps) na comunicação com a Meta', () => {
    expect(Object.keys(whatsappCloud)).not.toContain('desinscreverApp')
  })

  it('não existe rota de desconexão pelo servidor: Desconectar continua só no banco', async () => {
    const m = montar()
    const r = await tratarIntegracoes(post('/whatsapp/desconectar', { numero: NUMERO }), m.deps)
    expect(r.status).toBe(404)
    expect(m.externas).toHaveLength(0)
  })
})

describe('cadastro recusado pelo banco', () => {
  const recusa = { whatsapp_salvar_numero: () => ({ data: null, error: { code: 'RX010', message: 'Limite de números de WhatsApp do plano atingido.' } }) }

  it('mantém a inscrição, registra a limpeza pendente e devolve o erro do banco', async () => {
    const m = montar({ admin: recusa })
    const r = await tratarIntegracoes(concluir(), m.deps)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(await r.json()).toMatchObject({ ok: false, mensagem: 'Limite de números de WhatsApp do plano atingido.' })
    expect(nuncaRetira(m.externas)).toBe(true)
    expect(inscricoes(m.externas)).toHaveLength(1)
    expect(m.admin.find((c) => c.nome === 'whatsapp_inscricao_pendencia')?.args).toEqual({
      p_tenant: T_A,
      p_numero: null,
      p_waba_id: WABA,
      p_origem: 'cadastro_recusado',
    })
    expect(JSON.stringify(m.admin.find((c) => c.nome === 'whatsapp_inscricao_pendencia'))).not.toContain('tok-')
  })

  it('falha ao registrar a pendência não muda o erro que o Administrador vê', async () => {
    const m = montar({ admin: { ...recusa, whatsapp_inscricao_pendencia: () => ({ data: null, error: { code: 'XX000', message: 'falha' } }) } })
    const r = await tratarIntegracoes(concluir(), m.deps)
    expect(await r.json()).toMatchObject({ ok: false, mensagem: 'Limite de números de WhatsApp do plano atingido.' })
    expect(nuncaRetira(m.externas)).toBe(true)
  })
})

describe('cadastro aceito: inscrição idempotente depois de salvar', () => {
  it('inscreve antes de salvar e de novo depois, com o token da conta', async () => {
    const m = montar({ admin: salvo })
    const r = await tratarIntegracoes(concluir(), m.deps)
    expect(r.status).toBe(200)
    const insc = inscricoes(m.externas)
    expect(insc).toHaveLength(2)
    expect(insc.every((x) => x.auth === 'Bearer tok-novo')).toBe(true)
    const salvar = m.ordem.indexOf('admin:whatsapp_salvar_numero')
    const posicoes = m.ordem.flatMap((o, i) => (o === `meta:POST /${WABA}/subscribed_apps` ? [i] : []))
    expect(posicoes[0]).toBeLessThan(salvar)
    expect(posicoes[1]).toBeGreaterThan(salvar)
    expect(nuncaRetira(m.externas)).toBe(true)
    expect(m.admin.some((c) => c.nome === 'whatsapp_inscricao_pendencia')).toBe(false)
  })

  it('a segunda inscrição falhar não desfaz o cadastro (a primeira foi aceita)', async () => {
    const m = montar({ admin: salvo, posts: [Response.json({ success: true }), new Response('erro', { status: 500 })] })
    const r = await tratarIntegracoes(concluir(), m.deps)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, numero: NUMERO })
    expect(nuncaRetira(m.externas)).toBe(true)
  })

  it('coexistência: também inscreve de novo depois de salvar, e nunca retira', async () => {
    const m = montar({ admin: salvo })
    const r = await tratarIntegracoes(concluir({ modo: 'coexistencia' }), m.deps)
    expect(r.status).toBe(200)
    expect(inscricoes(m.externas)).toHaveLength(2)
    expect(nuncaRetira(m.externas)).toBe(true)
  })

  it('primeira inscrição recusada pela Meta: nada é salvo (como antes)', async () => {
    const m = montar({ admin: salvo, posts: [Response.json({ error: { code: 200, message: 'sem permissão' } }, { status: 403 })] })
    const r = await tratarIntegracoes(concluir(), m.deps)
    expect(r.status).toBe(502)
    expect(m.admin.some((c) => c.nome === 'whatsapp_salvar_numero')).toBe(false)
    expect(nuncaRetira(m.externas)).toBe(true)
  })
})
