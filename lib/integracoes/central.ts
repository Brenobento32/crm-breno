/**
 * Central de Integrações: o que cada cartão mostra, a partir do que o banco
 * devolve (`central_integracoes_empresa`). Regra de ouro: integração não
 * lançada nunca aparece como operacional, e a liberação real é sempre do
 * banco (plano + exceção do Super Admin) — aqui só se decide a apresentação.
 */

export const INTEGRACOES = ['formularios', 'google_sheets', 'whatsapp_oficial', 'meta_conversoes'] as const
export type ChaveIntegracao = (typeof INTEGRACOES)[number]
/**
 * Cartões da tela. O WhatsApp oficial aparece em DOIS cartões (número novo pela
 * Cloud API e app existente por coexistência), mas é UMA integração no banco:
 * mesma permissão, mesmo limite de números, mesma infraestrutura segura.
 */
export type CartaoCentral = ChaveIntegracao | 'whatsapp_app'

export type LinhaCentral = {
  integracao: ChaveIntegracao
  /** Cartão da tela (padrão: a própria integração). */
  cartao?: CartaoCentral
  lancada: boolean
  noPlano: boolean
  regra: 'liberar' | 'bloquear' | null
  permitida: boolean
  emUso: number
  comErro: number
  pendentes: number
  ultimaAtividade: string | null
  solicitadaEm: string | null
  planoNome: string | null
  /**
   * Fontes de captação (formulários, Respondi, webhook, Google Sheets): limite efetivo (exceção da empresa ou plano).
   * `null` com `...Definido` = sem limite (empresa interna). Números de WhatsApp NÃO entram aqui.
   */
  limiteFontes: number | null
  usoFontes: number
  limiteFontesDefinido: boolean
  /** Números de WhatsApp: API oficial e app existente contam juntos. */
  limiteNumeros: number | null
  limiteNumerosDefinido: boolean
  usoNumeros: number
}

export type EstadoCartao = 'nao_conectado' | 'conectado' | 'ativo' | 'erro' | 'limite_atingido' | 'limite_a_definir'
export type GrupoCartao = 'liberada' | 'upgrade' | 'em_breve'

export type InfoIntegracao = {
  nome: string
  resumo: string
  unidade: [singular: string, plural: string]
  beneficios: string[]
}

export const INFO: Record<CartaoCentral, InfoIntegracao> = {
  formularios: {
    nome: 'Formulários e webhooks',
    resumo: 'Formulário AVANTE, Respondi e webhook: cada envio vira lead no funil, com todas as respostas guardadas.',
    unidade: ['fonte ativa', 'fontes ativas'],
    beneficios: ['Formulário próprio com link para divulgar', 'Respondi e sistemas da empresa por webhook', 'Perguntas e respostas no lead'],
  },
  google_sheets: {
    nome: 'Google Sheets',
    resumo: 'Cole o link da planilha (de um Google Forms, por exemplo), autorize o Google e as linhas novas entram no funil.',
    unidade: ['planilha', 'planilhas'],
    beneficios: ['Linhas novas em segundos ou poucos minutos', 'Sem duplicar leads ao reordenar ou editar a planilha', 'Todas as colunas guardadas no lead'],
  },
  whatsapp_oficial: {
    nome: 'WhatsApp Business — API Oficial',
    resumo: 'Número novo pela Cloud API da Meta: quem escreve vira lead no funil e a equipe responde pelo AVANTE, com controle de custos.',
    unidade: ['número', 'números'],
    beneficios: ['Conexão oficial da Meta (Cloud API)', 'Conversas ligadas ao cliente e ao funil', 'Bloqueio preventivo de envios cobrados'],
  },
  whatsapp_app: {
    nome: 'WhatsApp Business — Conectar aplicativo existente',
    resumo: 'Coexistência oficial da Meta: o número continua no app WhatsApp Business do celular e as conversas também chegam ao AVANTE.',
    unidade: ['número', 'números'],
    beneficios: ['O app do celular continua funcionando', 'Histórico e contatos quando a Meta enviar e você autorizar', 'Mesmo limite de números do plano'],
  },
  meta_conversoes: {
    nome: 'Meta Ads — campanhas, formulários e conversões',
    resumo:
      'Painel das campanhas da conta de anúncios, leads dos formulários do Facebook e do Instagram no funil e devolutiva de conversões (CAPI) à Meta.',
    // No banco, o uso desta integração conta só as conexões de conversões (CAPI); contas e Páginas vêm do resumo do Meta Ads.
    unidade: ['conexão de conversões (CAPI)', 'conexões de conversões (CAPI)'],
    beneficios: ['Investimento, campanhas e CPL da conta de anúncios', 'Leads dos formulários direto no funil', 'Conversões do funil devolvidas à Meta'],
  },
}

export function grupoDoCartao(l: LinhaCentral): GrupoCartao {
  if (!l.lancada) return 'em_breve'
  return l.permitida ? 'liberada' : 'upgrade'
}

const ehWhatsapp = (i: ChaveIntegracao) => i === 'whatsapp_oficial'

/** Limite que vale para conexões NOVAS deste cartão: números (WhatsApp) ou fontes de captação (demais). */
export function limiteDoCartao(l: LinhaCentral): { definido: boolean; limite: number | null; uso: number } {
  return ehWhatsapp(l.integracao)
    ? { definido: l.limiteNumerosDefinido, limite: l.limiteNumeros, uso: l.usoNumeros }
    : { definido: l.limiteFontesDefinido, limite: l.limiteFontes, uso: l.usoFontes }
}

/** Ausência de limite cadastrado NÃO é ilimitado: novas conexões ficam bloqueadas até ser definido. */
export function limiteAtingido(l: LinhaCentral): boolean {
  const x = limiteDoCartao(l)
  return x.definido && x.limite !== null && x.uso >= x.limite
}

export function estadoDoCartao(l: LinhaCentral): EstadoCartao {
  if (l.comErro > 0) return 'erro'
  if (l.emUso === 0) return !limiteDoCartao(l).definido ? 'limite_a_definir' : limiteAtingido(l) ? 'limite_atingido' : 'nao_conectado'
  if (l.pendentes >= l.emUso || !l.ultimaAtividade) return 'conectado'
  return 'ativo'
}

export const ROTULO_ESTADO: Record<EstadoCartao, { texto: string; tom: 'verde' | 'azul' | 'ambar' | 'vermelho' | 'neutro' }> = {
  nao_conectado: { texto: 'Não conectado', tom: 'neutro' },
  conectado: { texto: 'Conectado', tom: 'azul' },
  ativo: { texto: 'Ativo', tom: 'verde' },
  erro: { texto: 'Com erro', tom: 'vermelho' },
  limite_atingido: { texto: 'Limite do plano atingido', tom: 'ambar' },
  limite_a_definir: { texto: 'Limite a definir', tom: 'ambar' },
}

/** Os dois cartões do WhatsApp a partir da linha única do banco, com o uso de cada modo de conexão. */
export function cartoesWhatsapp(
  l: LinhaCentral,
  numeros: { modo: 'cloud_api' | 'coexistencia'; situacao: string; comErro: boolean }[],
): [LinhaCentral, LinhaCentral] {
  const ativos = numeros.filter((n) => n.situacao !== 'desconectado' && n.situacao !== 'revogada')
  const deModo = (m: 'cloud_api' | 'coexistencia') => ativos.filter((n) => n.modo === m)
  const linha = (cartao: CartaoCentral, lista: typeof ativos): LinhaCentral => ({
    ...l,
    cartao,
    emUso: lista.length,
    comErro: lista.filter((n) => n.comErro).length,
    pendentes: lista.filter((n) => n.situacao === 'pendente_registro').length,
    ultimaAtividade: lista.length ? l.ultimaAtividade : null,
  })
  return [linha('whatsapp_oficial', deModo('cloud_api')), linha('whatsapp_app', deModo('coexistencia'))]
}

// ------------------------------------------------------------------ Meta Ads: três partes, três estados
/**
 * O cartão do Meta Ads junta três coisas independentes, cada uma com o próprio estado:
 * conta de anúncios (leitura de campanhas), formulários (Páginas, Lead Ads) e conversões (CAPI).
 * O uso que o banco devolve para `meta_conversoes` conta só a CAPI; aqui entram os registros
 * reais da empresa da sessão (conexão do Login para Empresas, contas, Páginas e dataset).
 */
export type ResumoMetaAds = {
  anuncios: { contas: number; situacao: 'nao_conectado' | 'conectado' | 'ativo' | 'erro'; ultimaLeitura: string | null; erro: string | null }
  formularios: { paginas: number; pausadas: number; ultimoLead: string | null }
  conversoes: { situacao: 'nao_configurado' | 'configurando' | 'ativo' | 'pausado' | 'erro'; dataset: string | null; ultimoEnvio: string | null }
}

type LoginMetaAds = {
  conexao: { situacao: string; ultimaSincronizacaoEm: string | null; ultimoErro: string | null } | null
  contas: unknown[]
  paginas: { status: string; ultimoLeadEm: string | null }[]
} | null
type CapiMetaAds = { conexaoId: string | null; situacao: string | null; datasetId: string | null; datasetNome: string | null; ultimoEnvioEm: string | null } | null

const maisRecente = (...datas: (string | null)[]) =>
  datas.filter((d): d is string => Boolean(d)).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null

export function resumoMetaAds(login: LoginMetaAds, capi: CapiMetaAds): ResumoMetaAds {
  const c = login?.conexao ?? null
  const contas = c ? (login?.contas.length ?? 0) : 0
  const anuncios: ResumoMetaAds['anuncios'] = {
    contas,
    situacao: !c || contas === 0 ? 'nao_conectado' : c.situacao === 'erro_autorizacao' || c.ultimoErro ? 'erro' : c.ultimaSincronizacaoEm ? 'ativo' : 'conectado',
    ultimaLeitura: c?.ultimaSincronizacaoEm ?? null,
    erro: c?.ultimoErro ?? (c?.situacao === 'erro_autorizacao' ? 'Autorização da Meta expirou ou foi revogada.' : null),
  }
  const paginas = c ? (login?.paginas ?? []) : []
  const formularios: ResumoMetaAds['formularios'] = {
    paginas: paginas.filter((p) => p.status === 'ativa').length,
    pausadas: paginas.filter((p) => p.status === 'pausada').length,
    ultimoLead: maisRecente(...paginas.map((p) => p.ultimoLeadEm)),
  }
  const conversoes: ResumoMetaAds['conversoes'] = {
    situacao: !capi?.conexaoId || !capi.situacao
      ? 'nao_configurado'
      : capi.situacao === 'ativa' ? 'ativo' : capi.situacao === 'pausada' ? 'pausado' : capi.situacao === 'erro_autorizacao' ? 'erro' : 'configurando',
    dataset: capi?.conexaoId ? (capi.datasetNome ?? capi.datasetId) : null,
    ultimoEnvio: capi?.ultimoEnvioEm ?? null,
  }
  return { anuncios, formularios, conversoes }
}

/** Linha do cartão do Meta Ads recalculada pelas três partes (estado geral, uso e última atividade). */
export function cartaoMetaAds(l: LinhaCentral, r: ResumoMetaAds): LinhaCentral {
  const capiLigada = r.conversoes.situacao !== 'nao_configurado'
  return {
    ...l,
    emUso: r.anuncios.contas + r.formularios.paginas + (capiLigada ? 1 : 0),
    comErro: (r.anuncios.situacao === 'erro' ? 1 : 0) + (r.conversoes.situacao === 'erro' ? 1 : 0),
    pendentes: (r.anuncios.situacao === 'conectado' ? 1 : 0) + (r.conversoes.situacao === 'configurando' ? 1 : 0),
    ultimaAtividade: maisRecente(r.anuncios.ultimaLeitura, r.formularios.ultimoLead, r.conversoes.ultimoEnvio, l.ultimaAtividade),
  }
}

export type LinhaResumoMetaAds = { parte: string; texto: string; estado: { texto: string; tom: 'verde' | 'azul' | 'ambar' | 'vermelho' | 'neutro' } }

/** As três linhas do cartão: o que está conectado em cada parte, sem confundir anúncios com CAPI. */
export function linhasMetaAds(r: ResumoMetaAds, formatarData: (iso: string) => string): LinhaResumoMetaAds[] {
  const a = r.anuncios
  const f = r.formularios
  const v = r.conversoes
  const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`
  return [
    {
      parte: 'Conta de anúncios e campanhas',
      texto:
        a.contas === 0
          ? 'Nenhuma conta de anúncios conectada'
          : `${plural(a.contas, 'conta conectada', 'contas conectadas')} · ${a.situacao === 'erro' ? `última leitura falhou${a.erro ? `: ${a.erro}` : ''}` : a.ultimaLeitura ? `métricas lidas em ${formatarData(a.ultimaLeitura)}` : 'aguardando a primeira leitura (até 1 hora)'}`,
      estado:
        a.situacao === 'nao_conectado'
          ? { texto: 'Não conectado', tom: 'neutro' }
          : a.situacao === 'erro'
            ? { texto: 'Com erro', tom: 'vermelho' }
            : a.situacao === 'ativo'
              ? { texto: 'Métricas funcionando', tom: 'verde' }
              : { texto: 'Conectado', tom: 'azul' },
    },
    {
      parte: 'Formulários do Facebook e do Instagram',
      texto:
        f.paginas === 0
          ? `Nenhuma Página conectada${f.pausadas ? ` (${plural(f.pausadas, 'pausada', 'pausadas')})` : ''}`
          : `${plural(f.paginas, 'Página conectada', 'Páginas conectadas')}${f.ultimoLead ? ` · último lead em ${formatarData(f.ultimoLead)}` : ' · nenhum lead ainda'}`,
      estado: f.paginas === 0 ? { texto: 'Não conectado', tom: 'neutro' } : f.ultimoLead ? { texto: 'Recebendo leads', tom: 'verde' } : { texto: 'Conectado', tom: 'azul' },
    },
    {
      parte: 'Conversões (CAPI)',
      texto:
        v.situacao === 'nao_configurado'
          ? 'Nenhum dataset conectado'
          : `Dataset ${v.dataset ?? ''}${v.ultimoEnvio ? ` · último envio em ${formatarData(v.ultimoEnvio)}` : ''}`.trim(),
      estado:
        v.situacao === 'nao_configurado'
          ? { texto: 'Não configurado', tom: 'neutro' }
          : v.situacao === 'ativo'
            ? { texto: 'Enviando', tom: 'verde' }
            : v.situacao === 'pausado'
              ? { texto: 'Pausado', tom: 'ambar' }
              : v.situacao === 'erro'
                ? { texto: 'Com erro', tom: 'vermelho' }
                : { texto: 'Falta ativar', tom: 'ambar' },
    },
  ]
}

export const infoDoCartao = (l: LinhaCentral) => INFO[l.cartao ?? l.integracao]

export function textoDeUso(l: LinhaCentral): string {
  const [um, varios] = infoDoCartao(l).unidade
  return `${l.emUso} ${l.emUso === 1 ? um : varios}`
}

function parteDoLimite(uso: number, limite: number | null, definido: boolean, nome: string): string {
  if (!definido) return `${uso} ${nome} em uso (limite a definir pela Rio X7: novas conexões bloqueadas)`
  if (limite === null) return `${uso} ${nome} em uso (sem limite de plano)`
  if (uso > limite) return `${uso} de ${limite} ${nome} (acima do limite: o que já existe continua; novas conexões bloqueadas)`
  return `${uso} de ${limite} ${nome}`
}

/** Cota de uma empresa no painel do Super Admin (mesmo formato de `LimiteEmpresa` do DAL). */
export type CotaEmpresa = {
  recurso: 'fontes' | 'numeros_whatsapp' | 'funis'
  padrao: number | null
  padraoDefinido: boolean
  excecao: number | null
  motivo: string | null
  efetivo: number | null
  efetivoDefinido: boolean
  uso: number
}

export const NOME_COTA: Record<CotaEmpresa['recurso'], string> = {
  fontes: 'Fontes de captação desta empresa (formulários, Respondi, webhook, planilhas)',
  numeros_whatsapp: 'Números de WhatsApp desta empresa (API oficial + app existente)',
  funis: 'Funis desta empresa',
}

/**
 * Resumo e aviso de uma cota. Limite abaixo do uso (reduzido pelo Super Admin)
 * nunca apaga nada: o aviso deixa claro que só as criações novas ficam barradas.
 */
export function textoDaCota(c: CotaEmpresa): { resumo: string; aviso: string | null } {
  const padrao = c.padraoDefinido && c.padrao !== null ? `Padrão do plano: ${c.padrao}` : 'Padrão do plano: a definir'
  const regra = c.excecao !== null ? `exceção desta empresa: ${c.excecao}${c.motivo ? ` (${c.motivo})` : ''}` : 'segue o plano'
  const vale = !c.efetivoDefinido ? 'a definir' : c.efetivo === null ? 'sem limite' : String(c.efetivo)
  const resumo = `${padrao} · ${regra} · vale: ${vale} · em uso: ${c.uso}`
  if (!c.efetivoDefinido) return { resumo, aviso: 'Sem limite definido: nenhuma criação nova até a Rio X7 definir (o que já existe continua).' }
  if (c.efetivo === null) return { resumo, aviso: null }
  if (c.uso > c.efetivo) {
    return { resumo, aviso: `Uso atual (${c.uso}) acima do limite (${c.efetivo}): nada foi excluído; novas criações ficam bloqueadas até o uso voltar ao limite ou o limite subir.` }
  }
  if (c.uso === c.efetivo) return { resumo, aviso: 'Limite atingido: novas criações ficam bloqueadas.' }
  return { resumo, aviso: null }
}

export function textoDoLimite(
  l: Pick<LinhaCentral, 'planoNome' | 'limiteFontes' | 'usoFontes' | 'limiteFontesDefinido' | 'limiteNumeros' | 'limiteNumerosDefinido' | 'usoNumeros'>,
): string {
  const plano = l.planoNome ? `Plano ${l.planoNome}` : 'Sem plano vinculado'
  return `${plano}: ${parteDoLimite(l.usoFontes, l.limiteFontes, l.limiteFontesDefinido, 'fonte(s) de captação')}; ${parteDoLimite(l.usoNumeros, l.limiteNumeros, l.limiteNumerosDefinido, 'número(s) de WhatsApp')}.`
}

/** Linha do banco (snake_case) → tipo da tela; ignora integração desconhecida. */
export function lerLinhasCentral(dados: unknown): LinhaCentral[] {
  if (!Array.isArray(dados)) return []
  return dados.flatMap((d) => {
    const r = d as Record<string, unknown>
    const chave = r.integracao as ChaveIntegracao
    if (!INTEGRACOES.includes(chave)) return []
    const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
    return [
      {
        integracao: chave,
        lancada: r.lancada === true,
        noPlano: r.no_plano === true,
        regra: r.regra === 'liberar' || r.regra === 'bloquear' ? r.regra : null,
        permitida: r.permitida === true,
        emUso: n(r.em_uso),
        comErro: n(r.com_erro),
        pendentes: n(r.pendentes),
        ultimaAtividade: typeof r.ultima_atividade === 'string' ? r.ultima_atividade : null,
        solicitadaEm: typeof r.solicitada_em === 'string' ? r.solicitada_em : null,
        planoNome: typeof r.plano_nome === 'string' ? r.plano_nome : null,
        limiteFontes: r.limite_fontes === null || r.limite_fontes === undefined ? null : n(r.limite_fontes),
        usoFontes: n(r.uso_fontes),
        limiteFontesDefinido: r.limite_fontes_definido === true,
        limiteNumeros: r.limite_numeros === null || r.limite_numeros === undefined ? null : n(r.limite_numeros),
        limiteNumerosDefinido: r.limite_numeros_definido === true,
        usoNumeros: n(r.uso_numeros),
      },
    ]
  })
}
