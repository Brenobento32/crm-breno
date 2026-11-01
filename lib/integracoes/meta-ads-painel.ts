/**
 * Linha do painel de campanhas do Meta Ads: números do banco → valores e indicadores.
 *
 * Duas leituras que NUNCA se misturam:
 * - CRM: leads que entraram no funil, vendas fechadas e faturamento, ligados à campanha pela
 *   atribuição do lead (Lead Ads). ROAS do CRM = faturamento ÷ investimento.
 * - Meta: leads e compras que a própria Meta atribui ao anúncio, pelo modelo e pela janela de
 *   atribuição dela. ROAS da Meta = valor atribuído ÷ investimento. Serve para comparar.
 */
export type LinhaPainelAds = {
  contaId: string
  campanhaId: string
  campanhaNome: string | null
  investimento: number
  impressoes: number
  cliques: number
  leadsCrm: number
  vendas: number
  faturamento: number
  /** Custo por lead do CRM (investimento ÷ leads que entraram no funil); null sem lead. */
  cpl: number | null
  /** ROAS medido no CRM (faturamento ÷ investimento); null sem investimento. */
  roasCrm: number | null
  /** Atribuição da Meta (informado pela Meta, não conferido pelo CRM). */
  leadsMeta: number
  conversoesMeta: number
  valorConversoesMeta: number
  /** ROAS informado pela Meta (valor atribuído ÷ investimento); null sem investimento. */
  roasMeta: number | null
}

type N = number | string

export function linhaDoPainel(l: {
  conta_id: string; campanha_id: string; campanha_nome: string | null; investimento: N; impressoes: N
  cliques: N; leads_meta: N; leads_crm: N; vendas: N; faturamento: N; conversoes_meta?: N | null; valor_conversoes_meta?: N | null
}): LinhaPainelAds {
  const n = (v: N | null | undefined) => {
    const x = Number(v ?? 0)
    return Number.isFinite(x) ? x : 0
  }
  const razao = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) / 100 : null)
  const investimento = n(l.investimento)
  const leadsCrm = n(l.leads_crm)
  const faturamento = n(l.faturamento)
  const valorConversoesMeta = n(l.valor_conversoes_meta)
  return {
    contaId: l.conta_id,
    campanhaId: l.campanha_id,
    campanhaNome: l.campanha_nome,
    investimento,
    impressoes: n(l.impressoes),
    cliques: n(l.cliques),
    leadsCrm,
    vendas: n(l.vendas),
    faturamento,
    cpl: razao(investimento, leadsCrm),
    roasCrm: razao(faturamento, investimento),
    leadsMeta: n(l.leads_meta),
    conversoesMeta: n(l.conversoes_meta),
    valorConversoesMeta,
    roasMeta: razao(valorConversoesMeta, investimento),
  }
}
