import 'server-only'

import { banco, exigirAdministrador, falhaDoBanco, podeAdministrarIntegracoes, type Resultado } from '@/lib/dal/integracoes-oficiais'
import { linhaDoPainel, type LinhaPainelAds } from '@/lib/integracoes/meta-ads-painel'

export type { LinhaPainelAds }

/**
 * Meta Ads multiempresa (Login do Facebook para Empresas): estado da conexão da
 * empresa da sessão e painel por campanha. O banco decide empresa e cargo; nenhum
 * token chega aqui.
 */

export type ConexaoMetaAdsLogin = {
  conexao: {
    situacao: 'ativa' | 'erro_autorizacao'
    negocioId: string
    conectadoEm: string
    ultimaSincronizacaoEm: string | null
    ultimoErro: string | null
  } | null
  contas: { contaId: string; nome: string | null; moeda: string | null }[]
  paginas: { fonteId: string; pageId: string; nome: string; status: string; funilId: string; etapaId: string; responsavelId: string; ultimoLeadEm: string | null }[]
}

export async function metaAdsDaEmpresa(): Promise<ConexaoMetaAdsLogin | null> {
  if (!(await podeAdministrarIntegracoes())) return null
  const { rpc } = await banco()
  const { data, error } = await rpc('meta_ads_da_empresa')
  if (error) return null
  type C = { situacao: 'ativa' | 'erro_autorizacao'; negocio_id: string; conectado_em: string; ultima_sincronizacao_em: string | null; ultimo_erro: string | null }
  type Bruto = {
    conexao: C | null
    contas: { conta_id: string; nome: string | null; moeda: string | null }[]
    paginas: { fonte_id: string; page_id: string; nome: string; status: string; funil_id: string; etapa_id: string; responsavel_id: string; ultimo_lead_em: string | null }[]
  }
  const d = data as Bruto
  return {
    conexao: d.conexao
      ? {
          situacao: d.conexao.situacao,
          negocioId: d.conexao.negocio_id,
          conectadoEm: d.conexao.conectado_em,
          ultimaSincronizacaoEm: d.conexao.ultima_sincronizacao_em,
          ultimoErro: d.conexao.ultimo_erro,
        }
      : null,
    contas: (d.contas ?? []).map((c) => ({ contaId: c.conta_id, nome: c.nome, moeda: c.moeda })),
    paginas: (d.paginas ?? []).map((p) => ({
      fonteId: p.fonte_id,
      pageId: p.page_id,
      nome: p.nome,
      status: p.status,
      funilId: p.funil_id,
      etapaId: p.etapa_id,
      responsavelId: p.responsavel_id,
      ultimoLeadEm: p.ultimo_lead_em,
    })),
  }
}

/** Painel por campanha da empresa da sessão, no período [inicio, fim] (datas AAAA-MM-DD). */
export async function painelMetaAds(inicio: string, fim: string): Promise<LinhaPainelAds[]> {
  if (!(await podeAdministrarIntegracoes())) return []
  const { rpc } = await banco()
  const { data, error } = await rpc('meta_ads_painel', { p_inicio: inicio, p_fim: fim })
  if (error) throw new Error('Não foi possível carregar o painel do Meta Ads.', { cause: error })
  return ((data as Parameters<typeof linhaDoPainel>[0][] | null) ?? []).map((l) => linhaDoPainel(l))
}

export async function desconectarMetaAdsLogin(): Promise<Resultado> {
  const recusa = await exigirAdministrador()
  if (recusa) return recusa
  const { rpc } = await banco()
  const { error } = await rpc('meta_ads_desconectar')
  return error ? falhaDoBanco(error, 'Não foi possível desconectar o Meta Ads.') : { ok: true }
}
