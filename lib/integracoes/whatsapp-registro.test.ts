import { describe, expect, it } from 'vitest'

import { tratarIntegracoes, type Dependencias, type ErroBanco } from '../../supabase/functions/_shared/integracoes-servico.ts'
import { ErroMeta, mensagemDeRegistro, registrarNumero } from '../../supabase/functions/_shared/whatsapp-cloud.ts'

import { aplicarEvento, extrasDoCadastro, lerEventoCadastro, resultadoDoCadastro, type EstadoCadastro } from './janelas-provedores'

/**
 * Conexão oficial do WhatsApp: Embedded Signup v4 → registro do número com
 * PIN → só então "conectado". Banco e Meta são falsos; nada sai da máquina.
 */
const BASE = 'http://local/functions/v1/integracoes'
const GRAPH = 'https://meta.falsa/v23.0'
const T_A = '11111111-1111-4111-8111-111111111111'
const NUMERO = '66666666-6666-4666-8666-666666666666'
const FUNIL = '77777777-7777-4777-8777-777777777777'
const ETAPA = '88888888-8888-4888-8888-888888888888'
const RESP = '99999999-9999-4999-8999-999999999999'
const PIN = '123456'
const WABA = '10000000001'
const PHONE = '20000000002'

type Chamada = { nome: string; args?: Record<string, unknown> }
type Resp = { data: unknown; error: ErroBanco }
type Rpcs = Record<string, (args?: Record<string, unknown>) => Resp>
type Externa = { url: string; corpo: string | null }

/** Meta falsa: token, número da conta, assinatura de webhook e registro (com códigos de erro configuráveis). */
function metaFalsa(registro: { status: number; corpo: unknown } = { status: 200, corpo: { success: true } }) {
  return (url: string): Response => {
    if (url.includes('/oauth/access_token')) return Response.json({ access_token: 'tok-novo' })
    if (url.includes(`/${WABA}/phone_numbers`)) return Response.json({ data: [{ id: PHONE, display_phone_number: '+55 11 90000-0002', verified_name: 'Empresa A' }] })
    if (url.includes(`/${WABA}/subscribed_apps`)) return Response.json({ success: true })
    if (url.endsWith(`/${PHONE}/register`)) return Response.json(registro.corpo, { status: registro.status })
    return new Response('{}', { status: 404 })
  }
}

function montar(opts: { admin?: Rpcs; usuario?: Rpcs; buscar?: (url: string) => Response } = {}) {
  const chamadasAdmin: Chamada[] = []
  const chamadasUsuario: Chamada[] = []
  const externas: Externa[] = []
  const rpc = (mapa: Rpcs | undefined, registro: Chamada[]) => (nome: string, args?: Record<string, unknown>) => {
    registro.push({ nome, args })
    const f = mapa?.[nome]
    return Promise.resolve(f ? f(args) : { data: null, error: null })
  }
  const deps: Dependencias = {
    admin: { rpc: rpc(opts.admin, chamadasAdmin) },
    comoUsuario: () => ({
      rpc: rpc({ exigir_administrador_integracoes: () => ({ data: T_A, error: null }), ...opts.usuario }, chamadasUsuario),
      auth: { getUser: async () => ({ data: { user: { id: 'u-admin' } }, error: null }) },
    }),
    buscar: async (url, init) => {
      externas.push({ url: String(url), corpo: typeof init?.body === 'string' ? init.body : null })
      return (opts.buscar ?? metaFalsa())(String(url))
    },
    google: null,
    meta: { graphUrl: GRAPH, appId: 'app', appSecret: 'segredo-app', configId: 'cfg', verifyToken: 'verifica' },
    segredoEstado: 'segredo-de-estado-com-pelo-menos-32-caracteres!!',
    segredoCron: 'segredo-do-agendador-com-32-caracteres-ou-mais',
    urlApp: 'https://avante.local',
  }
  return { deps, chamadasAdmin, chamadasUsuario, externas }
}

const post = (rota: string, corpo: unknown) =>
  new Request(`${BASE}${rota}`, { method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: JSON.stringify(corpo) })
const concluir = (extra: Record<string, unknown> = {}) =>
  post('/whatsapp/concluir', { code: 'code-unico', wabaId: WABA, phoneNumberId: PHONE, funil: FUNIL, etapa: ETAPA, responsavel: RESP, pin: PIN, ...extra })

/** Banco falso com o estado do número: pendente até o resultado do registro dizer o contrário. */
function bancoDoNumero(inicial: 'novo' | 'pendente' | 'conectado' = 'novo') {
  let situacao: string | null = inicial === 'novo' ? null : inicial === 'pendente' ? 'pendente_registro' : 'conectado'
  const admin: Rpcs = {
    whatsapp_salvar_numero: () => {
      situacao ??= 'pendente_registro'
      return { data: NUMERO, error: null }
    },
    whatsapp_token_registro: () => ({ data: situacao === 'pendente_registro' ? 'tok-guardado' : null, error: null }),
    whatsapp_registro_reservar: () =>
      situacao === 'pendente_registro' ? { data: PHONE, error: null } : { data: null, error: { code: '23514', message: 'Este número não está aguardando registro.' } },
    whatsapp_registro_resultado: (a) => {
      if (situacao === 'pendente_registro' && a?.p_ok) situacao = 'conectado'
      return { data: situacao, error: null }
    },
  }
  const usuario: Rpcs = {
    whatsapp_conexao_recente: () => ({
      data: situacao ? [{ numero_id: NUMERO, situacao, numero_exibicao: '+55 11 90000-0002', nome_verificado: 'Empresa A' }] : [],
      error: null,
    }),
    whatsapp_preparar_registro: () =>
      situacao === 'pendente_registro' ? { data: PHONE, error: null } : { data: null, error: { code: '23514', message: 'Este número não está aguardando registro.' } },
  }
  return { admin, usuario, situacao: () => situacao }
}

const semPin = (x: unknown) => !JSON.stringify(x ?? null).includes(PIN)

// ------------------------------------------------------------------ Graph API
describe('registro do número na Cloud API', () => {
  it('envia POST /<PHONE_NUMBER_ID>/register com messaging_product e o PIN', async () => {
    const chamadas: { url: string; init?: RequestInit }[] = []
    await registrarNumero(
      async (url, init) => {
        chamadas.push({ url: String(url), init })
        return Response.json({ success: true })
      },
      { graphUrl: GRAPH },
      'tok',
      PHONE,
      PIN,
    )
    expect(chamadas).toHaveLength(1)
    expect(chamadas[0].url).toBe(`${GRAPH}/${PHONE}/register`)
    expect(chamadas[0].init?.method).toBe('POST')
    expect(JSON.parse(String(chamadas[0].init?.body))).toEqual({ messaging_product: 'whatsapp', pin: PIN })
  })

  it.each(['12345', '1234567', 'abcdef', '12 456', ''])('recusa PIN inválido (%j) sem chamar a Meta', async (pin) => {
    let chamou = false
    await expect(
      registrarNumero(
        async () => {
          chamou = true
          return Response.json({})
        },
        { graphUrl: GRAPH },
        'tok',
        PHONE,
        pin,
      ),
    ).rejects.toMatchObject({ codigo: 'pin_invalido' })
    expect(chamou).toBe(false)
  })

  it('PIN incorreto (133005) vira texto nosso, sem o PIN nem o texto da Meta', async () => {
    const e = await registrarNumero(async () => Response.json({ error: { code: 133005, message: `Two step verification PIN mismatch ${PIN}` } }, { status: 400 }), { graphUrl: GRAPH }, 'tok', PHONE, PIN).catch((x) => x)
    expect(e).toBeInstanceOf(ErroMeta)
    expect(e.codigo).toBe('133005')
    expect(e.message).toMatch(/PIN incorreto/)
    expect(e.message).not.toContain(PIN)
    expect(e.message).not.toMatch(/mismatch/i)
  })

  it('mapeia os códigos de registro da Meta e trata código desconhecido', () => {
    expect(mensagemDeRegistro('133006')).toMatch(/verificar este número/)
    expect(mensagemDeRegistro('133008')).toMatch(/Muitas tentativas de PIN/)
    expect(mensagemDeRegistro('133015')).toMatch(/5 minutos/)
    expect(mensagemDeRegistro('133016')).toMatch(/72 horas/)
    expect(mensagemDeRegistro('999<script>')).toBe('A Meta recusou o registro do número (código 999script). Tente de novo em instantes.')
  })

  it('falha de rede vira erro "rede"', async () => {
    const e = await registrarNumero(
      async () => {
        throw new Error('offline')
      },
      { graphUrl: GRAPH },
      'tok',
      PHONE,
      PIN,
    ).catch((x) => x)
    expect(e).toMatchObject({ codigo: 'rede' })
  })
})

// ------------------------------------------------------------------ Embedded Signup v4 (eventos da janela)
describe('eventos do Embedded Signup v4', () => {
  const ev = (event: string, data: object = {}) => ({ type: 'WA_EMBEDDED_SIGNUP', event, data })
  const final = (evs: unknown[], code?: string, encerrado = true) => {
    let e: EstadoCadastro = code ? { code } : {}
    for (const x of evs) e = aplicarEvento(e, lerEventoCadastro(x))
    return resultadoDoCadastro(e, encerrado)
  }

  it('FINISH com número = número novo na Cloud API (pede registro)', () => {
    expect(final([ev('FINISH', { waba_id: WABA, phone_number_id: PHONE })], 'c1')).toEqual({
      tipo: 'concluido',
      cadastro: { code: 'c1', wabaId: WABA, phoneNumberId: PHONE, modo: 'cloud_api' },
    })
  })

  it('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING = coexistência (número do app WhatsApp Business)', () => {
    const r = final([ev('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', { waba_id: WABA, phone_number_id: PHONE })], 'c1')
    expect(r).toMatchObject({ tipo: 'concluido', cadastro: { modo: 'coexistencia' } })
  })

  it('concluir sem número escolhido não conecta nada', () => {
    expect(final([ev('FINISH_ONLY_WABA', { waba_id: WABA })], 'c1')).toEqual({ tipo: 'sem_numero' })
    expect(final([ev('FINISH', { waba_id: WABA })], 'c1')).toEqual({ tipo: 'sem_numero' })
  })

  it('cancelamento informa a etapa; erro relatado pela Meta vira "erro"', () => {
    expect(final([ev('CANCEL', { current_step: 'PHONE_NUMBER_SETUP' })])).toEqual({ tipo: 'cancelado', etapa: 'PHONE_NUMBER_SETUP' })
    expect(final([ev('CANCEL', { error_message: 'Business ineligible', error_code: '524126' })])).toMatchObject({ tipo: 'erro', mensagem: expect.stringContaining('Business ineligible') })
    expect(final([ev('ERROR')])).toMatchObject({ tipo: 'erro' })
  })

  it('fluxos que o AVANTE não usa (migração OBO, só acesso à API) não conectam', () => {
    expect(final([ev('FINISH_OBO_MIGRATION', { waba_id: WABA, phone_number_id: PHONE })], 'c1')).toEqual({ tipo: 'nao_suportado' })
    expect(final([ev('FINISH_GRANT_ONLY_API_ACCESS', { waba_id: WABA })], 'c1')).toEqual({ tipo: 'nao_suportado' })
  })

  it('janela fechada sem code = cancelado; sem fechar, ainda espera', () => {
    expect(final([ev('FINISH', { waba_id: WABA, phone_number_id: PHONE })])).toEqual({ tipo: 'cancelado', etapa: null })
    expect(final([ev('FINISH', { waba_id: WABA, phone_number_id: PHONE })], undefined, false)).toBeNull()
  })

  it('ignora mensagens que não são do cadastro e IDs malformados', () => {
    expect(lerEventoCadastro({ type: 'OUTRA', event: 'FINISH' })).toBeNull()
    expect(lerEventoCadastro('x')).toBeNull()
    expect(lerEventoCadastro(ev('FINISH', { waba_id: '../x', phone_number_id: PHONE }))).toEqual({ tipo: 'final', resultado: { tipo: 'sem_numero' } })
  })

  it('o primeiro final vale (evento repetido não troca o resultado)', () => {
    expect(final([ev('CANCEL', { current_step: 'A' }), ev('FINISH_ONLY_WABA')], 'c1')).toEqual({ tipo: 'cancelado', etapa: 'A' })
  })
})

// ------------------------------------------------------------------ servidor: /whatsapp/concluir e /whatsapp/registrar
describe('conexão do número (servidor)', () => {
  it('fluxo completo: troca o code, confere o número, assina o webhook, registra com PIN e só então "conectado"', async () => {
    const b = bancoDoNumero()
    const { deps, chamadasAdmin, externas } = montar({ admin: b.admin, usuario: b.usuario })
    const r = await tratarIntegracoes(concluir(), deps)
    const corpo = await r.json()
    expect(r.status).toBe(200)
    expect(corpo).toMatchObject({ ok: true, numero: NUMERO, situacao: 'conectado', modo: 'cloud_api' })
    // Inscrição antes de salvar e, de novo (idempotente), depois de salvar.
    expect(externas.map((e) => new URL(e.url).pathname)).toEqual([
      '/v23.0/oauth/access_token',
      `/v23.0/${WABA}/phone_numbers`,
      `/v23.0/${WABA}/subscribed_apps`,
      `/v23.0/${WABA}/subscribed_apps`,
      `/v23.0/${PHONE}/register`,
    ])
    expect(chamadasAdmin.find((c) => c.nome === 'whatsapp_salvar_numero')?.args).toMatchObject({ p_modo: 'cloud_api', p_phone_number_id: PHONE })
    expect(chamadasAdmin.find((c) => c.nome === 'whatsapp_registro_resultado')?.args).toEqual({ p_numero: NUMERO, p_ok: true, p_erro: null, p_codigo: null })
    // O pedido é contado ANTES de chamar a Meta (limite de 10 por número em 72 h).
    const nomes = chamadasAdmin.map((c) => c.nome)
    expect(nomes.indexOf('whatsapp_registro_reservar')).toBeLessThan(nomes.indexOf('whatsapp_registro_resultado'))
    expect(nomes.indexOf('whatsapp_registro_reservar')).toBeGreaterThan(-1)
    // PIN: só no corpo do registro para a Meta; nunca no banco nem na resposta.
    expect(externas.filter((e) => e.corpo?.includes(PIN)).map((e) => new URL(e.url).pathname)).toEqual([`/v23.0/${PHONE}/register`])
    expect(semPin(chamadasAdmin)).toBe(true)
    expect(semPin(corpo)).toBe(true)
  })

  it('PIN inválido é recusado ANTES de usar o code (nada sai para a Meta)', async () => {
    const { deps, externas, chamadasAdmin } = montar(bancoDoNumero())
    const r = await tratarIntegracoes(concluir({ pin: '12a456' }), deps)
    expect(r.status).toBe(422)
    expect((await r.json()).codigo).toBe('pin_invalido')
    expect(externas).toEqual([])
    expect(chamadasAdmin).toEqual([])
  })

  it('PIN incorreto na Meta: número salvo mas PENDENTE (não operacional), com o motivo', async () => {
    const b = bancoDoNumero()
    const { deps, chamadasAdmin } = montar({ ...b, buscar: metaFalsa({ status: 400, corpo: { error: { code: 133005, message: 'PIN mismatch' } } }) })
    const r = await tratarIntegracoes(concluir(), deps)
    const corpo = await r.json()
    expect(r.status).toBe(200)
    expect(corpo).toMatchObject({ ok: true, situacao: 'pendente_registro', pendencia: expect.stringMatching(/PIN incorreto/) })
    expect(chamadasAdmin.find((c) => c.nome === 'whatsapp_registro_resultado')?.args).toMatchObject({ p_ok: false, p_erro: expect.stringMatching(/PIN incorreto/) })
    expect(b.situacao()).toBe('pendente_registro')
    expect(semPin(chamadasAdmin)).toBe(true)
  })

  it('falha genérica de registro (500 da Meta) também deixa pendente', async () => {
    const b = bancoDoNumero()
    const { deps } = montar({ ...b, buscar: metaFalsa({ status: 500, corpo: {} }) })
    const corpo = await (await tratarIntegracoes(concluir(), deps)).json()
    expect(corpo).toMatchObject({ situacao: 'pendente_registro', pendencia: expect.stringMatching(/recusou o registro/) })
  })

  it('sem PIN: salva pendente e não tenta registrar', async () => {
    const b = bancoDoNumero()
    const { deps, externas, chamadasAdmin } = montar(b)
    const corpo = await (await tratarIntegracoes(concluir({ pin: undefined }), deps)).json()
    expect(corpo).toMatchObject({ situacao: 'pendente_registro', pendencia: expect.stringMatching(/PIN/) })
    expect(externas.some((e) => e.url.endsWith('/register'))).toBe(false)
    expect(chamadasAdmin.some((c) => c.nome === 'whatsapp_registro_resultado')).toBe(false)
  })

  it('coexistência (número do app WhatsApp Business): conecta sem registro e ignora o PIN', async () => {
    const admin: Rpcs = { whatsapp_salvar_numero: () => ({ data: NUMERO, error: null }) }
    const { deps, externas, chamadasAdmin } = montar({ admin, usuario: { whatsapp_conexao_recente: () => ({ data: [], error: null }) } })
    const corpo = await (await tratarIntegracoes(concluir({ modo: 'coexistencia' }), deps)).json()
    expect(corpo).toMatchObject({ ok: true, situacao: 'conectado', modo: 'coexistencia' })
    expect(externas.some((e) => e.url.endsWith('/register'))).toBe(false)
    expect(chamadasAdmin.find((c) => c.nome === 'whatsapp_salvar_numero')?.args).toMatchObject({ p_modo: 'coexistencia' })
  })

  it('retorno repetido de um número já conectado: devolve o estado, sem trocar o code de novo', async () => {
    const b = bancoDoNumero('conectado')
    const { deps, externas, chamadasAdmin } = montar(b)
    const corpo = await (await tratarIntegracoes(concluir(), deps)).json()
    expect(corpo).toMatchObject({ ok: true, situacao: 'conectado', repetido: true })
    expect(externas).toEqual([])
    expect(chamadasAdmin).toEqual([])
  })

  it('retorno repetido de um número pendente: só registra (com o token guardado), sem trocar o code', async () => {
    const b = bancoDoNumero('pendente')
    const { deps, externas, chamadasAdmin } = montar(b)
    const corpo = await (await tratarIntegracoes(concluir(), deps)).json()
    expect(corpo).toMatchObject({ situacao: 'conectado', repetido: true })
    expect(externas.map((e) => new URL(e.url).pathname)).toEqual([`/v23.0/${PHONE}/register`])
    expect(chamadasAdmin.map((c) => c.nome)).toEqual(['whatsapp_token_registro', 'whatsapp_registro_reservar', 'whatsapp_registro_resultado'])
  })

  it('reconexão de número já registrado nesta empresa: não pede registro de novo', async () => {
    let chamadas = 0
    const usuario: Rpcs = {
      // 1ª consulta (antes de salvar): nada recente; 2ª (depois de salvar): já conectado.
      whatsapp_conexao_recente: () => ({ data: chamadas++ === 0 ? [] : [{ numero_id: NUMERO, situacao: 'conectado', numero_exibicao: null, nome_verificado: null }], error: null }),
    }
    const { deps, externas } = montar({ admin: { whatsapp_salvar_numero: () => ({ data: NUMERO, error: null }) }, usuario })
    const corpo = await (await tratarIntegracoes(concluir(), deps)).json()
    expect(corpo).toMatchObject({ situacao: 'conectado' })
    expect(externas.some((e) => e.url.endsWith('/register'))).toBe(false)
  })

  it('número de outra empresa: 409 e nada é registrado', async () => {
    const admin: Rpcs = { whatsapp_salvar_numero: () => ({ data: null, error: { code: '23505', message: 'Este número já está conectado a outra empresa.' } }) }
    const { deps, externas } = montar({ admin, usuario: { whatsapp_conexao_recente: () => ({ data: [], error: null }) } })
    const r = await tratarIntegracoes(concluir(), deps)
    expect(r.status).toBe(409)
    expect((await r.json()).mensagem).toMatch(/outra empresa/)
    expect(externas.some((e) => e.url.endsWith('/register'))).toBe(false)
  })

  it('limite de tentativas (RX010) no retorno repetido: não chama a Meta', async () => {
    const usuario: Rpcs = {
      whatsapp_conexao_recente: () => ({ data: [{ numero_id: NUMERO, situacao: 'pendente_registro', numero_exibicao: null, nome_verificado: null }], error: null }),
      whatsapp_preparar_registro: () => ({ data: null, error: { code: 'RX010', message: 'Muitas tentativas de registro deste número. Aguarde 1 hora e confira o PIN.' } }),
    }
    const { deps, externas } = montar({ usuario })
    const corpo = await (await tratarIntegracoes(concluir(), deps)).json()
    expect(corpo).toMatchObject({ situacao: 'pendente_registro', pendencia: expect.stringMatching(/Muitas tentativas/) })
    expect(externas).toEqual([])
  })
})

describe('limite de pedidos de registro da Meta (10 por número em 72 h)', () => {
  it('limite do AVANTE atingido (8 em 72 h): não chama a Meta e explica quando libera', async () => {
    const b = bancoDoNumero('pendente')
    b.admin.whatsapp_registro_reservar = () => ({
      data: null,
      error: { code: 'RX010', message: 'Este número já teve 8 pedidos de registro em 72 horas. Para não chegar ao bloqueio da Meta (10 pedidos), a próxima tentativa fica liberada a partir de 31/10 às 18:00.' },
    })
    const { deps, externas, chamadasAdmin } = montar(b)
    const r = await tratarIntegracoes(post('/whatsapp/registrar', { numero: NUMERO, pin: PIN }), deps)
    expect(await r.json()).toMatchObject({ ok: true, situacao: 'pendente_registro', pendencia: expect.stringMatching(/8 pedidos de registro em 72 horas/) })
    expect(externas).toEqual([])
    expect(chamadasAdmin.some((c) => c.nome === 'whatsapp_registro_resultado')).toBe(false)
  })

  it('133016 da Meta: repassa o código ao banco (bloqueio de 72 h) e explica na tela', async () => {
    const b = bancoDoNumero('pendente')
    const { deps, chamadasAdmin } = montar({ ...b, buscar: metaFalsa({ status: 400, corpo: { error: { code: 133016, message: 'Account register deregister rate limit exceeded' } } }) })
    const corpo = await (await tratarIntegracoes(post('/whatsapp/registrar', { numero: NUMERO, pin: PIN }), deps)).json()
    expect(corpo).toMatchObject({ situacao: 'pendente_registro', pendencia: expect.stringMatching(/72 horas/) })
    expect(chamadasAdmin.find((c) => c.nome === 'whatsapp_registro_resultado')?.args).toMatchObject({ p_ok: false, p_codigo: '133016' })
    expect(semPin(chamadasAdmin)).toBe(true)
  })

  it('falha de rede também conta como pedido e é registrada com código "rede"', async () => {
    const b = bancoDoNumero('pendente')
    const { deps, chamadasAdmin } = montar({
      ...b,
      buscar: () => {
        throw new Error('offline')
      },
    })
    await tratarIntegracoes(post('/whatsapp/registrar', { numero: NUMERO, pin: PIN }), deps)
    expect(chamadasAdmin.map((c) => c.nome)).toContain('whatsapp_registro_reservar')
    expect(chamadasAdmin.find((c) => c.nome === 'whatsapp_registro_resultado')?.args).toMatchObject({ p_ok: false, p_codigo: 'rede' })
  })
})

describe('nova tentativa de registro (/whatsapp/registrar)', () => {
  it('pendente + PIN certo → conectado', async () => {
    const b = bancoDoNumero('pendente')
    const { deps, externas } = montar(b)
    const r = await tratarIntegracoes(post('/whatsapp/registrar', { numero: NUMERO, pin: PIN }), deps)
    expect(await r.json()).toMatchObject({ ok: true, numero: NUMERO, situacao: 'conectado' })
    expect(externas.map((e) => new URL(e.url).pathname)).toEqual([`/v23.0/${PHONE}/register`])
    expect(b.situacao()).toBe('conectado')
  })

  it('PIN errado → continua pendente, com o motivo', async () => {
    const b = bancoDoNumero('pendente')
    const { deps } = montar({ ...b, buscar: metaFalsa({ status: 400, corpo: { error: { code: 133005 } } }) })
    const corpo = await (await tratarIntegracoes(post('/whatsapp/registrar', { numero: NUMERO, pin: PIN }), deps)).json()
    expect(corpo).toMatchObject({ situacao: 'pendente_registro', pendencia: expect.stringMatching(/PIN incorreto/) })
    expect(b.situacao()).toBe('pendente_registro')
  })

  it('PIN malformado ou número inválido: 422 sem banco nem Meta', async () => {
    const { deps, externas, chamadasUsuario } = montar(bancoDoNumero('pendente'))
    expect((await tratarIntegracoes(post('/whatsapp/registrar', { numero: NUMERO, pin: '12345' }), deps)).status).toBe(422)
    expect((await tratarIntegracoes(post('/whatsapp/registrar', { numero: 'x', pin: PIN }), deps)).status).toBe(422)
    expect(externas).toEqual([])
    expect(chamadasUsuario.some((c) => c.nome === 'whatsapp_preparar_registro')).toBe(false)
  })

  it('número que não é desta empresa (P0002) ou já conectado (23514): erro claro, sem chamar a Meta', async () => {
    for (const [code, status] of [
      ['P0002', 404],
      ['23514', 422],
      ['RX010', 429],
    ] as const) {
      const { deps, externas } = montar({ usuario: { whatsapp_preparar_registro: () => ({ data: null, error: { code, message: 'regra' } }) } })
      const r = await tratarIntegracoes(post('/whatsapp/registrar', { numero: NUMERO, pin: PIN }), deps)
      expect(r.status).toBe(status)
      expect(externas).toEqual([])
    }
  })

  it('quem não é Administrador não registra', async () => {
    const { deps, externas } = montar({ usuario: { exigir_administrador_integracoes: () => ({ data: null, error: { code: '42501', message: 'Somente o Administrador.' } }) } })
    const r = await tratarIntegracoes(post('/whatsapp/registrar', { numero: NUMERO, pin: PIN }), deps)
    expect(r.status).toBe(403)
    expect(externas).toEqual([])
  })
})

describe('configuração pública da janela', () => {
  it('devolve a versão da Graph API do servidor (fonte única) só quando disponível', async () => {
    const lig = montar({ usuario: { integracoes_habilitadas: () => ({ data: [{ whatsapp_oficial: true }], error: null }) } })
    expect(await (await tratarIntegracoes(post('/whatsapp/config', {}), lig.deps)).json()).toMatchObject({ disponivel: true, versaoGraph: 'v23.0' })
    const des = montar({ usuario: { integracoes_habilitadas: () => ({ data: [{ whatsapp_oficial: false }], error: null }) } })
    expect(await (await tratarIntegracoes(post('/whatsapp/config', {}), des.deps)).json()).toMatchObject({ disponivel: false, versaoGraph: null, appId: null })
  })
})

describe('parâmetros da janela da Meta (Embedded Signup v4)', () => {
  it('API Oficial: v4 fixa, sem coexistência', () => {
    const e = extrasDoCadastro(false)
    expect(e).toEqual({ setup: {}, version: 'v4', sessionInfoVersion: '3' })
    expect(e).not.toHaveProperty('featureType')
  })
  it('Aplicativo existente: pede o fluxo de coexistência da v4', () => {
    expect(extrasDoCadastro(true)).toEqual({ setup: {}, version: 'v4', featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' })
  })
  it('lê os IDs dos dois modos e não aceita o fluxo sem número', () => {
    const ev = (event: string, data: object) => lerEventoCadastro({ type: 'WA_EMBEDDED_SIGNUP', event, data })
    expect(ev('FINISH', { waba_id: '123456', phone_number_id: '654321' })).toEqual({ tipo: 'ids', wabaId: '123456', phoneNumberId: '654321', modo: 'cloud_api' })
    expect(ev('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', { waba_id: '123456', phone_number_id: '654321' })).toMatchObject({ modo: 'coexistencia' })
    expect(ev('FINISH_ONLY_WABA', { waba_id: '123456' })).toEqual({ tipo: 'final', resultado: { tipo: 'sem_numero' } })
    expect(ev('FINISH_GRANT_ONLY_API_ACCESS', {})).toEqual({ tipo: 'final', resultado: { tipo: 'nao_suportado' } })
  })
})
