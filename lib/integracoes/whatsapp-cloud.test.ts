import { describe, expect, it } from 'vitest'

import {
  ErroMeta,
  acessoAContaWhatsapp,
  conferirNumero,
  enviarTexto,
  extrairEventosConta,
  extrairEventosWhatsapp,
  lerServicoDoMes,
  textoAvisoDesconexaoApp,
  textoDesvinculo,
  telefoneParaApi,
} from '../../supabase/functions/_shared/whatsapp-cloud.ts'

const evento = (valor: object) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...valor } }] }],
})

describe('webhook do WhatsApp Cloud', () => {
  it('extrai mensagem recebida com nome do contato e horário', () => {
    const r = extrairEventosWhatsapp(
      evento({
        metadata: { phone_number_id: '1234567890' },
        contacts: [{ wa_id: '5511999990001', profile: { name: 'Ana' } }],
        messages: [{ id: 'wamid.A', from: '5511999990001', timestamp: '1761580800', type: 'text', text: { body: 'Olá' } }],
      }),
    )
    expect(r.mensagens).toEqual([
      { phoneNumberId: '1234567890', waMessageId: 'wamid.A', de: '5511999990001', nome: 'Ana', tipo: 'text', texto: 'Olá', recebidaEm: '2025-10-27T16:00:00.000Z', referral: null },
    ])
    expect(r.status).toEqual([])
  })

  it('extrai status com cobrança (pricing.billable) e erro', () => {
    const r = extrairEventosWhatsapp(
      evento({
        metadata: { phone_number_id: '1234567890' },
        statuses: [
          { id: 'wamid.B', status: 'delivered', pricing: { billable: false, category: 'service' } },
          { id: 'wamid.C', status: 'sent', pricing: { billable: true, category: 'marketing' } },
          { id: 'wamid.D', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] },
          { id: 'wamid.E', status: 'inventado' },
        ],
      }),
    )
    expect(r.status.map((s) => [s.waMessageId, s.status, s.cobravel, s.categoria])).toEqual([
      ['wamid.B', 'delivered', false, 'service'],
      ['wamid.C', 'sent', true, 'marketing'],
      ['wamid.D', 'failed', null, null],
    ])
    expect(r.status[2].erro).toBe('131047 Re-engagement message')
  })

  it('guarda o referral do anúncio Click-to-WhatsApp e o tipo de preço do status', () => {
    const r = extrairEventosWhatsapp(
      evento({
        metadata: { phone_number_id: '1234567890' },
        messages: [{ id: 'wamid.R', from: '5511999990009', type: 'text', text: { body: 'Vi o anúncio' },
          referral: { source_type: 'ad', source_id: '120200000000001', ctwa_clid: 'ARAkLk...', source_url: 'https://fb.me/x', headline: 'ignorado' } }],
        statuses: [{ id: 'wamid.S', status: 'delivered', pricing: { billable: false, pricing_model: 'PMP', category: 'service', type: 'free_customer_service' } }],
      }),
    )
    expect(r.mensagens[0].referral).toEqual({ ctwa_clid: 'ARAkLk...', source_id: '120200000000001', source_type: 'ad', source_url: 'https://fb.me/x' })
    expect(r.status[0].tipoPreco).toBe('free_customer_service')
  })

  it('ignora outros objetos, campos e phone_number_id inválido', () => {
    expect(extrairEventosWhatsapp({ object: 'page', entry: [] }).mensagens).toEqual([])
    expect(extrairEventosWhatsapp(evento({ metadata: { phone_number_id: 'abc' }, messages: [{ id: 'x', from: '1' }] })).mensagens).toEqual([])
    expect(extrairEventosWhatsapp(null)).toEqual({ mensagens: [], status: [] })
  })
})

describe('Graph API (simulada)', () => {
  const cfg = { graphUrl: 'https://graph.exemplo/v23.0' }

  it('envio de texto livre devolve o ID da Meta; erro da Meta vira ErroMeta', async () => {
    let corpo = ''
    const ok = async (_u: string, init?: RequestInit) => {
      corpo = String(init?.body)
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }))
    }
    expect(await enviarTexto(ok, cfg, 'tok', '123456', '5511999990001', 'oi')).toBe('wamid.OUT')
    expect(JSON.parse(corpo)).toMatchObject({ type: 'text', to: '5511999990001', text: { body: 'oi' } })
    const falha = async () => new Response(JSON.stringify({ error: { code: 131047, message: 'fora da janela' } }), { status: 400 })
    await expect(enviarTexto(falha, cfg, 'tok', '123456', '5511999990001', 'oi')).rejects.toBeInstanceOf(ErroMeta)
  })

  it('número que não pertence à WABA autorizada é recusado', async () => {
    const buscar = async () => new Response(JSON.stringify({ data: [{ id: '999', display_phone_number: '+55 11 0000-0000' }] }))
    await expect(conferirNumero(buscar, cfg, 'tok', '111', '123456')).rejects.toMatchObject({ codigo: 'numero_fora_da_conta' })
    const certo = async () => new Response(JSON.stringify({ data: [{ id: '123456', display_phone_number: '+55 11 3333-4444', verified_name: 'Empresa A' }] }))
    expect(await conferirNumero(certo, cfg, 'tok', '111', '123456')).toEqual({ numeroExibicao: '+55 11 3333-4444', nomeVerificado: 'Empresa A' })
  })

  it('telefone para a API: só dígitos com DDI', () => {
    expect(telefoneParaApi('+55 (11) 99999-0001')).toBe('5511999990001')
    expect(telefoneParaApi('123')).toBeNull()
  })
})

describe('consumo do mês na Meta (franquia de 1.000 mensagens de serviço)', () => {
  const cfg = { graphUrl: 'https://graph.exemplo/v23.0' }
  it('soma só a categoria SERVICE do número, gratuitas e cobradas', async () => {
    let pedido = ''
    const buscar = async (u: string) => {
      pedido = decodeURIComponent(u)
      return new Response(JSON.stringify({ pricing_analytics: { data: [{ data_points: [
        { volume: 300, pricing_category: 'SERVICE', pricing_type: 'FREE_CUSTOMER_SERVICE' },
        { volume: 12, pricing_category: 'SERVICE', pricing_type: 'REGULAR' },
        { volume: 40, pricing_category: 'MARKETING', pricing_type: 'REGULAR' },
      ] }] } }))
    }
    expect(await lerServicoDoMes(buscar, cfg, 't', '111', '+55 11 4000-0001', 1790000000, 1790500000)).toBe(312)
    expect(pedido).toContain('phone_numbers(["551140000001"])')
    expect(pedido).toContain('granularity(DAILY)')
  })
  it('formato inesperado: erro (o banco mantém o envio bloqueado)', async () => {
    await expect(lerServicoDoMes(async () => new Response('{}'), cfg, 't', '111', null, 1, 2)).rejects.toBeInstanceOf(ErroMeta)
    const semCategoria = async () => new Response(JSON.stringify({ pricing_analytics: { data: [{ data_points: [{ volume: 5 }] }] } }))
    await expect(lerServicoDoMes(semCategoria, cfg, 't', '111', null, 1, 2)).rejects.toBeInstanceOf(ErroMeta)
  })
})

describe('account_update (avisos de conta)', () => {
  const conta = (value: object, id = '2949482758682047') => ({ object: 'whatsapp_business_account', entry: [{ id, changes: [{ field: 'account_update', value }] }] })
  it('lê só os eventos que mudam o número; limpa motivo e origem; recusa ID inválido', () => {
    expect(
      extrairEventosConta(conta({ event: 'PARTNER_REMOVED', waba_info: { waba_id: '495709166956424' }, disconnection_info: { reason: "x'; drop--", initiated_by: 'user' } }), 'app'),
    ).toEqual([{ tipo: 'desvinculo', evento: 'PARTNER_REMOVED', wabaId: '495709166956424', motivo: 'XDROP', iniciadoPor: 'USER' }])
    expect(extrairEventosConta(conta({ event: 'ACCOUNT_OFFBOARDED' }, '102290129340398'), 'app')).toEqual([
      { tipo: 'coexistencia', evento: 'ACCOUNT_OFFBOARDED', wabaId: '102290129340398' },
    ])
    expect(extrairEventosConta(conta({ event: 'ACCOUNT_OFFBOARDED' }, 'abc'), 'app')).toEqual([])
    expect(extrairEventosConta(conta({ event: 'DISABLED_UPDATE', ban_info: {} }), 'app')).toEqual([])
    expect(extrairEventosConta({ object: 'page', entry: [] }, 'app')).toEqual([])
    expect(extrairEventosWhatsapp(conta({ event: 'PARTNER_REMOVED' })).mensagens).toEqual([])
  })
  it('acesso: 190/200/10/100 = acabou; sucesso = continua; outro erro lança (nada é decidido)', async () => {
    const cfg = { graphUrl: 'https://meta.falsa/v23.0' }
    const resp = (status: number, corpo: object) => async () => new Response(JSON.stringify(corpo), { status })
    expect(await acessoAContaWhatsapp(resp(200, { id: '1' }), cfg, 't', '495709166956424')).toBe(true)
    for (const code of [190, 200, 10, 100]) expect(await acessoAContaWhatsapp(resp(400, { error: { code } }), cfg, 't', '495709166956424')).toBe(false)
    await expect(acessoAContaWhatsapp(resp(400, { error: { code: 4 } }), cfg, 't', '495709166956424')).rejects.toBeInstanceOf(ErroMeta)
    await expect(acessoAContaWhatsapp(async () => { throw new Error('rede') }, cfg, 't', '495709166956424')).rejects.toBeInstanceOf(ErroMeta)
  })
  it('textos do painel', () => {
    expect(textoDesvinculo('ACCOUNT_DELETED', null)).toBe('A Meta informou que a conta do WhatsApp foi excluída. Nada foi apagado; para voltar a usar, conecte o número de novo.')
    expect(textoDesvinculo('PARTNER_REMOVED', 'CHANGE_NUMBER')).toContain('(o número foi trocado no app)')
    expect(textoDesvinculo('PARTNER_REMOVED', 'DESCONHECIDO')).not.toContain('(')
    expect(textoAvisoDesconexaoApp('USER_RE_REGISTERED')).toContain('registrado de novo')
  })
})
