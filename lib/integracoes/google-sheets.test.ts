import { describe, expect, it } from 'vitest'

import {
  DURACAO_MAXIMA_CANAL_MS,
  ErroCanal,
  ErroGoogle,
  conferirTokenDoCanal,
  criarCanal,
  encerrarCanal,
  tokenDoCanal,
  emailDoIdToken,
  extrairPlanilhaDoLink,
  lerLinhas,
  lerMetadados,
  mapeamentoValido,
  montarLeads,
  renovarAcesso,
  sugerirMapeamento,
  urlDeAutorizacao,
  type ConfigGoogle,
} from '../../supabase/functions/_shared/google-sheets.ts'

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc'
const cfg: ConfigGoogle = {
  clientId: 'cliente.apps.googleusercontent.com',
  clientSecret: 'segredo',
  redirectUri: 'https://exemplo.supabase.co/functions/v1/integracoes/google/callback',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  sheetsUrl: 'https://sheets.googleapis.com/v4',
}
const resposta = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status })

describe('link da planilha', () => {
  it('aceita link do Google Sheets (com e sem gid) e o ID puro', () => {
    expect(extrairPlanilhaDoLink(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=123`)).toEqual({ planilhaId: ID, gid: 123 })
    expect(extrairPlanilhaDoLink(`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=7#gid=7`)).toEqual({ planilhaId: ID, gid: 7 })
    expect(extrairPlanilhaDoLink(`https://docs.google.com/spreadsheets/d/${ID}`)).toEqual({ planilhaId: ID, gid: null })
    expect(extrairPlanilhaDoLink(`  ${ID}  `)).toEqual({ planilhaId: ID, gid: null })
  })

  it('recusa outros domínios, http e documentos que não são planilhas', () => {
    expect(extrairPlanilhaDoLink(`http://docs.google.com/spreadsheets/d/${ID}/edit`)).toBeNull()
    expect(extrairPlanilhaDoLink(`https://docs.google.com.evil.com/spreadsheets/d/${ID}/edit`)).toBeNull()
    expect(extrairPlanilhaDoLink(`https://docs.google.com/document/d/${ID}/edit`)).toBeNull()
    expect(extrairPlanilhaDoLink('nada')).toBeNull()
    expect(extrairPlanilhaDoLink('')).toBeNull()
  })
})

describe('OAuth do Google', () => {
  it('pede só openid, email e drive.file, com acesso offline e state', () => {
    const u = new URL(urlDeAutorizacao(cfg, 'estado-assinado'))
    expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('state')).toBe('estado-assinado')
    expect(u.searchParams.get('redirect_uri')).toBe(cfg.redirectUri)
    expect(u.searchParams.get('scope')).not.toContain('spreadsheets')
  })

  it('lê o e-mail verificado do id_token', () => {
    const corpo = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    expect(emailDoIdToken(`x.${corpo({ email: 'Admin@Empresa.com', email_verified: true })}.y`)).toBe('admin@empresa.com')
    expect(emailDoIdToken(`x.${corpo({ email: 'a@b.com', email_verified: false })}.y`)).toBeNull()
    expect(emailDoIdToken('quebrado')).toBeNull()
    expect(emailDoIdToken(undefined)).toBeNull()
  })

  it('invalid_grant vira erro de autorização (reconectar), não erro genérico', async () => {
    const buscar = async () => resposta(400, { error: 'invalid_grant' })
    await expect(renovarAcesso(buscar, cfg, 'r')).rejects.toMatchObject({ tipo: 'autorizacao' })
    const ok = async () => resposta(200, { access_token: 'novo' })
    expect(await renovarAcesso(ok, cfg, 'r')).toBe('novo')
  })
})

describe('Sheets API', () => {
  it('403/404 pede autorização do arquivo; 429 é cota; 401 é autorização', async () => {
    for (const [status, tipo] of [
      [403, 'sem_acesso'],
      [404, 'sem_acesso'],
      [429, 'cota'],
      [401, 'autorizacao'],
      [500, 'rede'],
    ] as const) {
      const e = await lerMetadados(async () => resposta(status, {}), cfg, 't', ID).catch((x) => x)
      expect(e).toBeInstanceOf(ErroGoogle)
      expect(e.tipo).toBe(tipo)
    }
  })

  it('lê abas e linhas com faixa entre aspas e numeração real da linha', async () => {
    const pedidas: string[] = []
    const buscar = async (url: string) => {
      pedidas.push(url)
      if (url.includes('/values/'))
        return resposta(200, { values: [['Nome', 'Telefone'], ['Ana', '11 99999-0001'], [], ['Bia', '11 99999-0002']] })
      return resposta(200, { properties: { title: 'Leads' }, sheets: [{ properties: { sheetId: 0, title: "Página 1's", gridProperties: { rowCount: 10, columnCount: 3 } } }] })
    }
    const meta = await lerMetadados(buscar, cfg, 't', ID)
    expect(meta).toEqual({ titulo: 'Leads', abas: [{ id: 0, titulo: "Página 1's", linhas: 10, colunas: 3 }] })
    const r = await lerLinhas(buscar, cfg, 't', ID, "Página 1's", 2, 100)
    // Faixa limitada à grade real da aba (10 linhas × 3 colunas): o Google recusa faixa maior com 400.
    expect(decodeURIComponent(pedidas[2])).toContain("'Página 1''s'!A2:C10")
    expect(r.cabecalho).toEqual(['Nome', 'Telefone'])
    expect(r.linhas.map((l) => l.numero)).toEqual([3, 4, 5])
  })

  it('aba com espaço no nome, grade grande e aba inexistente', async () => {
    const pedidas: string[] = []
    const buscar = async (url: string) => {
      pedidas.push(decodeURIComponent(url))
      if (url.includes('/values/')) return resposta(200, { values: [['Nome', 'E-mail']] })
      return resposta(200, {
        sheets: [
          { properties: { sheetId: 7, title: ' Leads Meta ', gridProperties: { rowCount: 5000, columnCount: 80 } } },
          { properties: { sheetId: 8, title: 'Outra', gridProperties: { rowCount: 3, columnCount: 2 } } },
        ],
      })
    }
    // A tela e o banco guardam o nome sem os espaços das pontas: a faixa usa o nome REAL da aba.
    await lerLinhas(buscar, cfg, 't', ID, 'Leads Meta', 1, 100)
    expect(pedidas[1]).toContain("' Leads Meta '!A1:AZ101")
    // Cabeçalho além da grade: nada a ler (sem pedir faixa inválida ao Google).
    expect(await lerLinhas(buscar, cfg, 't', ID, 'Outra', 4, 100)).toEqual({ cabecalho: [], linhas: [] })
    const e = await lerLinhas(buscar, cfg, 't', ID, 'Sumiu', 1, 10).catch((x) => x)
    expect(e).toBeInstanceOf(ErroGoogle)
    expect(e.tipo).toBe('invalido')
  })

  it('400 do Google: a mensagem dele aparece (sem token), para diagnosticar', async () => {
    const buscar = async () => resposta(400, { error: { code: 400, message: "Unable to parse range: 'X'!A1:AZ6" } })
    const e = await lerMetadados(buscar, cfg, 'token-secreto', ID).catch((x) => x)
    expect(e).toBeInstanceOf(ErroGoogle)
    expect(e.message).toBe("O Google Sheets respondeu 400: Unable to parse range: 'X'!A1:AZ6")
    expect(e.message).not.toContain('token-secreto')
  })
})

describe('mapeamento de colunas', () => {
  it('sugere nome, telefone, e-mail e a coluna identificadora', () => {
    const s = sugerirMapeamento(['Carimbo de data/hora', 'Nome completo', 'WhatsApp', 'E-mail', 'Empresa'])
    expect(s.mapeamento).toEqual({ nome: 'Nome completo', telefone: 'WhatsApp', email: 'E-mail', empresa: 'Empresa' })
    expect(s.chave).toBe('Carimbo de data/hora')
  })

  it('exige telefone ou e-mail e colunas existentes', () => {
    expect(mapeamentoValido({ nome: 'Nome' }, ['Nome'])).toMatch(/Telefone ou de E-mail/)
    expect(mapeamentoValido({ telefone: 'Fone' }, ['Telefone'])).toMatch(/não existe/)
    expect(mapeamentoValido({ telefone: 'Telefone' }, ['Telefone'])).toBeNull()
  })

  // Cabeçalho real do export dos Lead Ads da Meta (como na planilha da Rio X7).
  const META = ['id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic', 'platform', 'Nome', 'Email', 'Telefone']

  it('export dos Lead Ads: sugere a coluna "id" como ID do lead (nunca ad_id) e como chave', () => {
    const s = sugerirMapeamento(META)
    expect(s.mapeamento.meta_lead_id).toBe('id')
    expect(s.chave).toBe('id')
    // Planilha comum com coluna "id" não vira ID de lead da Meta.
    expect(sugerirMapeamento(['id', 'Nome', 'Telefone']).mapeamento.meta_lead_id).toBeUndefined()
  })

  it('lê a data real do envio e ignora ad_id escolhido como ID do lead (a conexão segue sincronizando)', async () => {
    const linha = { numero: 2, valores: ['l:123456789012345', '2026-10-30T10:00:00-03:00', 'ag:120254490122630204', 'Vídeo', 'as:1', 'Público', 'c:1', 'RX7 | FORMS', 'f:1', 'Form', 'false', 'ig', 'Ana', 'ana@x.com', 'p:+5511999990001'] }
    const certo = (await montarLeads(META, [linha], { nome: 'Nome', email: 'Email', telefone: 'Telefone', meta_lead_id: 'id' }, 'id')).leads[0]
    expect(certo.meta_lead_id).toBe('l:123456789012345')
    expect(certo.data_envio).toBe('2026-10-30T13:00:00.000Z')
    expect(certo.respostas.some((r) => r.pergunta === 'created_time')).toBe(true)
    const errado = (await montarLeads(META, [linha], { nome: 'Nome', email: 'Email', telefone: 'Telefone', meta_lead_id: 'ad_id' }, 'id')).leads[0]
    expect(errado.meta_lead_id).toBeNull()
    expect(mapeamentoValido({ telefone: 'Telefone', meta_lead_id: 'ad_id' }, META)).toBeNull()
  })

  it('sem coluna de data do envio: data_envio fica vazia (o funil usa a data de entrada de sempre)', async () => {
    const { leads } = await montarLeads(['Nome', 'Telefone'], [{ numero: 2, valores: ['Ana', '11999990001'] }], { nome: 'Nome', telefone: 'Telefone' }, null)
    expect(leads[0].data_envio).toBeNull()
  })
})

describe('chave estável (idempotência)', () => {
  const cab = ['ID', 'Nome', 'Telefone', 'Email']
  const m = { nome: 'Nome', telefone: 'Telefone', email: 'Email' }
  const linhas = [
    { numero: 2, valores: ['10', 'Ana', '(11) 99999-0001', 'ana@x.com'] },
    { numero: 3, valores: ['11', 'Bia', '11999990002', ''] },
    { numero: 4, valores: ['', '', '', ''] },
  ]

  it('com coluna identificadora: a chave é o ID, não a linha', async () => {
    const { leads, vazias } = await montarLeads(cab, linhas, m, 'ID')
    expect(leads.map((l) => l.chave)).toEqual(['id:10', 'id:11'])
    expect(vazias).toBe(1)
    const reordenadas = [linhas[1], { ...linhas[0], numero: 9 }]
    expect((await montarLeads(cab, reordenadas, m, 'ID')).leads.map((l) => l.chave).sort()).toEqual(['id:10', 'id:11'])
  })

  it('sem coluna identificadora: impressão digital do contato, imune a reordenar/inserir/apagar linhas', async () => {
    const a = (await montarLeads(cab, linhas, m, null)).leads
    const inserida = [{ numero: 2, valores: ['', 'Nova', '21988887777', ''] }, ...linhas.map((l) => ({ ...l, numero: l.numero + 1 }))]
    const b = (await montarLeads(cab, inserida, m, null)).leads
    expect(b.filter((l) => a.some((x) => x.chave === l.chave)).length).toBe(2)
    // formatação do telefone e caixa do e-mail não mudam a chave
    const formatada = [{ numero: 2, valores: ['', 'ANA', '11 99999 0001', 'ANA@X.COM'] }]
    expect((await montarLeads(cab, formatada, m, null)).leads[0].chave).toBe(a[0].chave)
  })

  it('a mesma chave duas vezes na leitura entra uma vez só', async () => {
    const dup = [linhas[0], { ...linhas[0], numero: 8 }]
    expect((await montarLeads(cab, dup, m, 'ID')).leads).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ avisos do Drive (files.watch)
describe('avisos do Google Drive (files.watch)', () => {
  const SEGREDO = 'segredo-de-estado-com-pelo-menos-32-caracteres!!'
  const CANAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const FONTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  it('token do canal: devolve a fonte só para o MESMO canal e a mesma assinatura', async () => {
    const t = await tokenDoCanal(SEGREDO, CANAL, FONTE)
    expect(t.startsWith(`${FONTE}.`)).toBe(true)
    expect(await conferirTokenDoCanal(SEGREDO, CANAL, t)).toBe(FONTE)
    expect(await conferirTokenDoCanal(SEGREDO, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', t)).toBeNull() // outro canal
    expect(await conferirTokenDoCanal('outro-segredo-com-pelo-menos-32-caracteres!!', CANAL, t)).toBeNull()
    expect(await conferirTokenDoCanal(SEGREDO, CANAL, t.replace(FONTE, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'))).toBeNull() // fonte trocada
    expect(await conferirTokenDoCanal(SEGREDO, CANAL, '')).toBeNull()
    expect(await conferirTokenDoCanal(SEGREDO, 'nao-uuid', t)).toBeNull()
  })

  it('criarCanal: pede web_hook com id, endereço, token e no máximo 1 dia', async () => {
    let pedido: { url: string; corpo: Record<string, string>; auth: string | null } | null = null
    const buscar = async (url: string, init?: RequestInit) => {
      pedido = { url, corpo: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') }
      return resposta(200, { resourceId: 'res123', expiration: String(Date.now() + 86_400_000) })
    }
    const antes = Date.now()
    const r = await criarCanal(buscar, { ...cfg, driveUrl: 'https://drive.falso/v3' }, 'ya29.acesso', {
      planilhaId: ID, canalId: CANAL, endereco: 'https://exemplo.supabase.co/functions/v1/integracoes/google/notificacao', token: 'tok', duracaoMs: 9e9,
    })
    expect(pedido!.url).toBe(`https://drive.falso/v3/files/${ID}/watch?supportsAllDrives=true`)
    expect(pedido!.auth).toBe('Bearer ya29.acesso')
    expect(pedido!.corpo).toMatchObject({ id: CANAL, type: 'web_hook', token: 'tok' })
    expect(Number(pedido!.corpo.expiration) - antes).toBeLessThanOrEqual(DURACAO_MAXIMA_CANAL_MS + 1000)
    expect(r.resourceId).toBe('res123')
  })

  it('criarCanal: classifica as recusas do Google', async () => {
    const com = (status: number) => criarCanal(async () => resposta(status, {}), cfg, 't', { planilhaId: ID, canalId: CANAL, endereco: 'https://x', token: 't' })
    await expect(com(400)).rejects.toMatchObject({ definitivo: true }) // endereço recusado
    await expect(com(404)).rejects.toMatchObject({ definitivo: true }) // arquivo sem acesso
    await expect(com(401)).rejects.toMatchObject({ autorizacao: true, definitivo: false })
    await expect(com(503)).rejects.toMatchObject({ definitivo: false })
    await expect(com(503)).rejects.toBeInstanceOf(ErroCanal)
  })

  it('encerrarCanal: 404 (já vencido) conta como encerrado; falha de rede não', async () => {
    expect(await encerrarCanal(async () => new Response(null, { status: 204 }), cfg, 't', { canalId: CANAL, resourceId: 'r' })).toBe('encerrado')
    expect(await encerrarCanal(async () => resposta(404, {}), cfg, 't', { canalId: CANAL, resourceId: 'r' })).toBe('encerrado')
    expect(await encerrarCanal(async () => { throw new Error('rede') }, cfg, 't', { canalId: CANAL, resourceId: 'r' })).toBe('falhou')
  })
})
