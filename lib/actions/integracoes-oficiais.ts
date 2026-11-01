'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { getEmpresaAtual } from '@/lib/dal/empresa'
import {
  acaoPlanilha,
  acaoWhatsapp,
  alterarDestino,
  chamarIntegracoes,
  criarPlanilha,
  type Resultado,
} from '@/lib/dal/integracoes-oficiais'
import { acaoMetaAds, configurarMetaAds, reprocessarEventoMetaAds } from '@/lib/dal/meta-conversoes'

/**
 * Ações das integrações oficiais (Google Sheets e WhatsApp Business).
 * Quem decide permissão, empresa, destino e custo é o banco; aqui só
 * validamos o formato do que veio da tela.
 */

const LISTA = '/configuracoes/integracoes'
const uuid = z.uuid()
const texto = (fd: FormData, campo: string) => {
  const v = fd.get(campo)
  return typeof v === 'string' ? v.trim() : ''
}
function voltar(chave: 'ok' | 'erro', mensagem: string): never {
  revalidatePath(LISTA, 'layout')
  redirect(`${LISTA}?${chave}=${encodeURIComponent(mensagem)}`)
}
const invalido = (mensagem: string) => ({ ok: false as const, codigo: 'dados_invalidos', mensagem })

// ------------------------------------------------------------------ Google
export async function iniciarGoogleAction(): Promise<Resultado<{ url: string }>> {
  const empresa = await getEmpresaAtual()
  return chamarIntegracoes<{ url: string }>('/google/iniciar', { retorno: `/${empresa.slug}${LISTA}/google-sheets` })
}

export type AcessoSeletor = { accessToken: string; chaveApi: string; appId: string; simulado?: boolean; urlSeletor?: string }

/** Token de ACESSO curto (drive.file) só para abrir o seletor oficial do Google no navegador. */
export async function acessoSeletorAction(conta: string): Promise<Resultado<AcessoSeletor>> {
  if (!uuid.safeParse(conta).success) return invalido('Conta inválida.')
  return chamarIntegracoes<AcessoSeletor>('/google/acesso-seletor', { conta })
}

export type Aba = { id: number; titulo: string; linhas: number; colunas: number }
export async function lerPlanilhaAction(conta: string, link: string): Promise<Resultado<{ planilhaId: string; titulo: string; abas: Aba[]; abaSugerida: number | null }> & { planilhaId?: string }> {
  if (!uuid.safeParse(conta).success) return invalido('Escolha a conta Google.')
  if (!link || link.length > 500) return invalido('Cole o link da planilha.')
  return chamarIntegracoes('/google/planilha', { conta, link })
}

export async function lerColunasAction(
  conta: string,
  planilhaId: string,
  aba: string,
  linhaCabecalho: number,
): Promise<Resultado<{ cabecalho: string[]; amostra: string[][]; mapeamento: Record<string, string>; chave: string | null }>> {
  if (!uuid.safeParse(conta).success || !planilhaId || !aba) return invalido('Escolha a planilha e a aba.')
  return chamarIntegracoes('/google/colunas', { conta, planilhaId, aba, linhaCabecalho })
}

const esquemaPlanilha = z.object({
  contaId: z.uuid(),
  planilhaId: z.string().regex(/^[A-Za-z0-9_-]{20,120}$/),
  planilhaNome: z.string().trim().min(1).max(200),
  abaId: z.number().int().min(0),
  abaNome: z.string().trim().min(1).max(100),
  linhaCabecalho: z.number().int().min(1).max(50),
  mapeamento: z.object({
    nome: z.string().max(200).optional(),
    telefone: z.string().max(200).optional(),
    email: z.string().max(200).optional(),
    empresa: z.string().max(200).optional(),
    meta_lead_id: z.string().max(200).optional(),
  }),
  colunaChave: z.string().max(200).nullable(),
  importarExistentes: z.boolean(),
  nome: z.string().trim().min(2, 'Dê um nome à conexão (2 a 80 caracteres).').max(80),
  funilId: z.uuid('Escolha o funil.'),
  etapaId: z.uuid('Escolha a etapa inicial.'),
  responsavelId: z.uuid('Escolha o responsável.'),
})

export type ResumoSincronizacao = { ok: boolean; linhas?: number; importadas?: number; novas_oportunidades?: number; existentes?: number; invalidas?: number; erros?: number; ignoradas_inicio?: number; erro?: string; emAndamento?: boolean }

/** Conecta a aba ao destino escolhido e já faz a primeira sincronização. */
export async function conectarPlanilhaAction(dados: z.input<typeof esquemaPlanilha>): Promise<Resultado<{ id: string; resumo: ResumoSincronizacao | null }>> {
  const p = esquemaPlanilha.safeParse(dados)
  if (!p.success) return invalido(p.error.issues[0]?.message ?? 'Confira os dados da conexão.')
  const m = Object.fromEntries(Object.entries(p.data.mapeamento).filter(([, v]) => v))
  if (!m.telefone && !m.email) return invalido('Escolha ao menos a coluna de Telefone ou de E-mail.')
  const criada = await criarPlanilha({ ...p.data, mapeamento: m })
  if (!criada.ok) return criada
  const sinc = await chamarIntegracoes<{ resultado: ResumoSincronizacao }>('/google/sincronizar', { fonte: criada.id })
  revalidatePath(LISTA, 'layout')
  return { ok: true, id: criada.id, resumo: sinc.ok ? sinc.resultado : { ok: false, erro: sinc.mensagem } }
}

export async function sincronizarAgoraAction(fd: FormData): Promise<void> {
  const fonte = texto(fd, 'fonte')
  if (!uuid.safeParse(fonte).success) voltar('erro', 'Planilha inválida.')
  const r = await chamarIntegracoes<{ resultado: ResumoSincronizacao }>('/google/sincronizar', { fonte })
  if (!r.ok) voltar('erro', r.mensagem)
  const s = r.resultado
  if (!s.ok) voltar('erro', s.erro ?? 'A sincronização falhou.')
  voltar('ok', `Sincronizado: ${s.importadas ?? 0} oportunidade(s) criada(s), ${s.existentes ?? 0} negociação(ões) aberta(s) reaproveitada(s), ${s.invalidas ?? 0} linha(s) sem contato válido.`)
}

const ACOES_PLANILHA = ['pausar', 'retomar', 'reprocessar_erros', 'remover'] as const
export async function acaoPlanilhaAction(fd: FormData): Promise<void> {
  const fonte = texto(fd, 'fonte')
  const acao = texto(fd, 'acao') as (typeof ACOES_PLANILHA)[number]
  if (!uuid.safeParse(fonte).success || !ACOES_PLANILHA.includes(acao)) voltar('erro', 'Ação inválida.')
  const r = await acaoPlanilha(fonte, acao)
  if (!r.ok) voltar('erro', r.mensagem)
  // Pausar/desconectar encerra o aviso do Google na hora; retomar ativa de novo.
  // Se falhar, o agendador faz o mesmo em até 5 minutos (e avisos de fonte pausada são ignorados).
  if (acao !== 'reprocessar_erros') await chamarIntegracoes('/google/monitoramento', { fonte })
  const msg = { pausar: 'Planilha pausada.', retomar: 'Planilha retomada.', reprocessar_erros: 'As linhas com erro serão tentadas de novo na próxima sincronização.', remover: 'Planilha desconectada. Os leads já importados continuam no CRM.' }
  voltar('ok', msg[acao])
}

export async function desconectarGoogleAction(fd: FormData): Promise<void> {
  const conta = texto(fd, 'conta')
  if (!uuid.safeParse(conta).success) voltar('erro', 'Conta inválida.')
  const r = await chamarIntegracoes('/google/desconectar', { conta })
  if (!r.ok) voltar('erro', r.mensagem)
  voltar('ok', 'Conta Google desconectada e acesso revogado. As planilhas dela foram pausadas; os leads importados continuam no CRM.')
}

// ------------------------------------------------------------------ destino (planilha ou WhatsApp)
export async function alterarDestinoAction(fd: FormData): Promise<void> {
  const fonte = texto(fd, 'fonte')
  const [funil, etapa] = texto(fd, 'destino').split('|')
  const responsavel = texto(fd, 'responsavel_id')
  if (![fonte, funil, etapa, responsavel].every((v) => uuid.safeParse(v).success)) voltar('erro', 'Escolha funil, etapa e responsável.')
  const r = await alterarDestino(fonte, funil, etapa, responsavel)
  if (!r.ok) voltar('erro', r.mensagem)
  voltar('ok', 'Destino alterado. Vale para os próximos leads; os que já entraram continuam onde estão.')
}

// ------------------------------------------------------------------ WhatsApp
export async function configWhatsappAction(): Promise<
  Resultado<{ disponivel: boolean; appId: string | null; configId: string | null; versaoGraph?: string | null; simulado?: boolean; urlCadastro?: string }>
> {
  return chamarIntegracoes('/whatsapp/config')
}

/** PIN de 6 números do registro na Cloud API: só repassado à Meta pelo servidor; nunca gravado nem registrado em log. */
const pin = z.string().regex(/^\d{6}$/, 'O PIN tem 6 números.')

const esquemaNumero = z.object({
  code: z.string().min(4).max(2000),
  wabaId: z.string().regex(/^\d{5,30}$/),
  phoneNumberId: z.string().regex(/^\d{5,30}$/),
  modo: z.enum(['cloud_api', 'coexistencia']).default('cloud_api'),
  // Opcional: sem PIN o número fica "Falta registrar" e o Administrador registra pelo painel.
  pin: pin.optional(),
  nome: z.string().trim().max(80).optional(),
  funil: z.uuid('Escolha o funil.'),
  etapa: z.uuid('Escolha a etapa inicial.'),
  responsavel: z.uuid('Escolha o responsável.'),
})

export type SituacaoConexao = { numero: string; situacao: 'conectado' | 'pendente_registro'; pendencia?: string; numeroExibicao?: string | null; nomeVerificado?: string | null; modo?: 'cloud_api' | 'coexistencia' }

export async function concluirWhatsappAction(dados: z.input<typeof esquemaNumero>): Promise<Resultado<SituacaoConexao>> {
  const p = esquemaNumero.safeParse(dados)
  if (!p.success) return invalido(p.error.issues[0]?.message ?? 'Conclua a autorização da Meta.')
  // Coexistência não usa PIN: não repassa nada além do necessário.
  const corpo = p.data.modo === 'coexistencia' ? { ...p.data, pin: undefined } : p.data
  const r = await chamarIntegracoes<SituacaoConexao>('/whatsapp/concluir', corpo)
  if (r.ok) revalidatePath(LISTA, 'layout')
  return r
}

/** Nova tentativa de registro de um número pendente (assistente ou painel). */
export async function registrarWhatsappAction(numero: string, pinInformado: string): Promise<Resultado<SituacaoConexao>> {
  if (!uuid.safeParse(numero).success) return invalido('Número inválido.')
  const p = pin.safeParse(pinInformado)
  if (!p.success) return invalido('O PIN tem 6 números.')
  const r = await chamarIntegracoes<SituacaoConexao>('/whatsapp/registrar', { numero, pin: p.data })
  if (r.ok) revalidatePath(LISTA, 'layout')
  return r
}

const ACOES_NUMERO = ['pausar', 'retomar', 'desconectar', 'revisar_cobranca'] as const
export async function acaoWhatsappAction(fd: FormData): Promise<void> {
  const numero = texto(fd, 'numero')
  const acao = texto(fd, 'acao') as (typeof ACOES_NUMERO)[number]
  if (!uuid.safeParse(numero).success || !ACOES_NUMERO.includes(acao)) voltar('erro', 'Ação inválida.')
  const r = await acaoWhatsapp(numero, acao)
  if (!r.ok) voltar('erro', r.mensagem)
  const msg = {
    pausar: 'Número pausado: não cria leads nem envia mensagens.',
    retomar: 'Número retomado.',
    desconectar: 'Número desconectado e credencial apagada. As conversas continuam no histórico.',
    revisar_cobranca: 'Aviso de cobrança revisado. O número continua em "Somente envios gratuitos".',
  }
  voltar('ok', msg[acao])
}

export type EstadoEnvio = { ok?: boolean; erro?: string; codigo?: string }

/** Resposta dentro da janela de 24 h (o banco decide; fora dela, nada vai para a Meta). */
export async function enviarWhatsappAction(_: EstadoEnvio, fd: FormData): Promise<EstadoEnvio> {
  const conversa = texto(fd, 'conversa')
  const msg = texto(fd, 'texto')
  if (!uuid.safeParse(conversa).success) return { erro: 'Conversa inválida.' }
  if (!msg) return { erro: 'Escreva a mensagem.' }
  if (msg.length > 4096) return { erro: 'Mensagem longa demais (até 4.096 caracteres).' }
  const r = await chamarIntegracoes('/whatsapp/enviar', { conversa, texto: msg })
  revalidatePath('/conversas')
  return r.ok ? { ok: true } : { erro: r.mensagem, codigo: r.codigo }
}

// ------------------------------------------------------------------ Meta Ads — Conversões do CRM
export async function configMetaAdsAction(): Promise<
  Resultado<{
    disponivel: boolean
    appId: string | null
    idExterno: string
    simulado?: boolean
    urlMbe?: string
    urlLogin?: string
    configIdLogin?: string | null
  }>
> {
  return chamarIntegracoes('/meta-ads/config')
}

export async function concluirMetaAdsAction(code: string): Promise<Resultado<{ datasetId: string; datasetNome: string | null }>> {
  if (!code || code.length > 2000) return invalido('Conclua a autorização na janela da Meta.')
  const r = await chamarIntegracoes<{ datasetId: string; datasetNome: string | null }>('/meta-ads/concluir', { code })
  if (r.ok) revalidatePath(LISTA, 'layout')
  return r
}

const ROTA_META_ADS = '/configuracoes/integracoes/meta-ads'
function voltarMetaAds(chave: 'ok' | 'erro', mensagem: string): never {
  revalidatePath(LISTA, 'layout')
  redirect(`${ROTA_META_ADS}?${chave}=${encodeURIComponent(mensagem)}`)
}

/** Funis monitorados + etapa → evento (campos evento:<etapa>, valor:<etapa>). O banco valida tudo de novo. */
export async function salvarMetaAdsAction(fd: FormData): Promise<void> {
  const funis = fd.getAll('funil').map(String).filter((v) => uuid.safeParse(v).success)
  const mapeamento: { etapa_id: string; evento: string; enviar_valor: boolean }[] = []
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith('evento:') || typeof v !== 'string' || !v.trim()) continue
    const etapa = k.slice('evento:'.length)
    const funil = texto(fd, `funil_da_etapa:${etapa}`)
    if (!uuid.safeParse(etapa).success || !funis.includes(funil)) continue
    const evento = v.trim().slice(0, 50)
    if (!/^[\p{L}\p{N} _-]{2,50}$/u.test(evento)) voltarMetaAds('erro', `Nome de evento inválido: "${evento}". Use letras, números, espaço, _ ou -.`)
    mapeamento.push({ etapa_id: etapa, evento, enviar_valor: fd.get(`valor:${etapa}`) === 'on' })
  }
  const r = await configurarMetaAds(funis, mapeamento, fd.get('enviar_contato_hash') === 'on')
  if (!r.ok) voltarMetaAds('erro', r.mensagem)
  voltarMetaAds('ok', `Configuração salva: ${funis.length} funil(is) monitorado(s), ${mapeamento.length} etapa(s) mapeada(s).`)
}

const ACOES_META_ADS = ['ativar', 'retomar', 'pausar', 'definir_codigo_teste', 'desconectar'] as const
export async function acaoMetaAdsAction(fd: FormData): Promise<void> {
  const acao = texto(fd, 'acao') as (typeof ACOES_META_ADS)[number]
  if (!ACOES_META_ADS.includes(acao)) voltarMetaAds('erro', 'Ação inválida.')
  const codigo = texto(fd, 'codigo_teste')
  if (acao === 'definir_codigo_teste' && codigo && !/^[A-Za-z0-9_-]{3,40}$/.test(codigo)) voltarMetaAds('erro', 'Código de teste inválido.')
  const r = await acaoMetaAds(acao, codigo || null)
  if (!r.ok) voltarMetaAds('erro', r.mensagem)
  const msg = {
    ativar: 'Envio de conversões ativado. Vale para as próximas mudanças de etapa.',
    retomar: 'Envio de conversões retomado.',
    pausar: 'Envio pausado: nenhum evento novo é gerado.',
    definir_codigo_teste: codigo ? 'Código de teste salvo: os eventos aparecem em "Eventos de teste" no Gerenciador de Eventos.' : 'Código de teste removido.',
    desconectar: 'Conta Meta Ads desconectada; a credencial foi apagada.',
  }
  voltarMetaAds('ok', msg[acao])
}

export async function reprocessarMetaAdsAction(fd: FormData): Promise<void> {
  const id = Number(texto(fd, 'evento'))
  if (!Number.isInteger(id) || id <= 0) voltarMetaAds('erro', 'Evento inválido.')
  const r = await reprocessarEventoMetaAds(id)
  voltarMetaAds(r.ok ? 'ok' : 'erro', r.ok ? 'Evento volta para a fila de envio.' : r.mensagem)
}

// ------------------------------------------------------------------ Meta Ads: Login para Empresas (multiempresa)
export type AtivosMetaAds = {
  negocioId: string
  datasets: { id: string; nome: string | null }[]
  paginas: { id: string; nome: string | null }[]
  contas: { id: string; nome: string | null; moeda: string | null; ativa: boolean }[]
}
export type ResultadoSelecaoMetaAds = {
  dataset: string | null
  paginas: { id: string; situacao: 'conectada' | 'erro'; mensagem?: string }[]
  contas: number | null
}
const idMeta = z.string().regex(/^[0-9]{5,30}$/)
const esquemaSelecaoAds = z.object({
  datasetId: idMeta.nullable(),
  paginas: z.array(z.object({ id: idMeta, funil: uuid, etapa: uuid, responsavel: uuid })).max(20),
  contas: z.array(idMeta).max(50),
})

/** code da janela do Login para Empresas → token do portfólio do cliente no cofre → ativos liberados. */
export async function concluirMetaAdsLoginAction(code: string): Promise<Resultado<AtivosMetaAds>> {
  if (!code || code.length > 2000) return invalido('Conclua a autorização na janela da Meta.')
  const r = await chamarIntegracoes<AtivosMetaAds>('/meta-ads/login/concluir', { code })
  if (r.ok) revalidatePath(`${LISTA}/meta-ads`)
  return r
}

/** Ativos que a empresa liberou para o AVANTE (lidos de novo na Meta). */
export async function ativosMetaAdsAction(): Promise<Resultado<AtivosMetaAds>> {
  return chamarIntegracoes<AtivosMetaAds>('/meta-ads/login/ativos')
}

/** Dataset (Conversões do CRM), Páginas (Lead Ads) e contas de anúncios (painel) escolhidos entre os liberados. */
export async function selecionarAtivosMetaAdsAction(dados: z.input<typeof esquemaSelecaoAds>): Promise<Resultado<ResultadoSelecaoMetaAds>> {
  const v = esquemaSelecaoAds.safeParse(dados)
  if (!v.success) return invalido('Escolha ativos válidos e, para cada Página, o funil, a etapa e o responsável.')
  const r = await chamarIntegracoes<ResultadoSelecaoMetaAds>('/meta-ads/login/selecionar', v.data)
  revalidatePath(`${LISTA}/meta-ads`)
  return r
}

export async function desconectarMetaAdsLoginAction(): Promise<void> {
  const { desconectarMetaAdsLogin } = await import('@/lib/dal/meta-ads')
  const r = await desconectarMetaAdsLogin()
  voltarMetaAds(r.ok ? 'ok' : 'erro', r.ok ? 'Meta Ads desconectado: a credencial foi apagada e as Páginas deixaram de receber leads. O histórico continua.' : r.mensagem)
}

// ------------------------------------------------------------------ Central (upgrade)
const INTEGRACOES_CENTRAL = ['formularios', 'google_sheets', 'whatsapp_oficial', 'meta_conversoes']

/** Pedido de upgrade: só registra o interesse (o Super Admin atende). Não libera nada sozinho. */
export async function solicitarIntegracaoAction(fd: FormData): Promise<void> {
  const integracao = texto(fd, 'integracao')
  if (!INTEGRACOES_CENTRAL.includes(integracao)) voltar('erro', 'Integração inválida.')
  const { solicitarIntegracao } = await import('@/lib/dal/central-integracoes')
  const r = await solicitarIntegracao(integracao)
  if (!r.ok) voltar('erro', r.mensagem)
  voltar('ok', r.novo ? 'Pedido enviado à Rio X7. Avisaremos quando a integração for liberada no seu plano.' : 'Esta integração já está liberada.')
}

