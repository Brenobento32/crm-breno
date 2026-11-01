import { diaEmSaoPaulo, diaValido, formatarDia, hojeSaoPaulo, somarDias } from '@/lib/utils/formatacao'

/**
 * Filtro "Entrada do lead" do Kanban: só muda o que aparece na tela, nunca
 * os dados. Datas no calendário de São Paulo, inclusivas. Na URL:
 * `?entrada=hoje|7d|mes|intervalo` e, no intervalo, `&de=AAAA-MM-DD&ate=AAAA-MM-DD`.
 * Sem `entrada` (ou valor desconhecido) = todos.
 */
export const FILTROS_ENTRADA = ['hoje', '7d', 'mes', 'intervalo'] as const
export type ChaveFiltroEntrada = (typeof FILTROS_ENTRADA)[number]

export const ROTULO_FILTRO_ENTRADA: Record<ChaveFiltroEntrada | 'todos', string> = {
  todos: 'Todos',
  hoje: 'Hoje',
  '7d': 'Últimos 7 dias',
  mes: 'Este mês',
  intervalo: 'Intervalo personalizado',
}

export type FiltroEntrada = { chave: ChaveFiltroEntrada; inicio: string; fim: string }

export function resolverFiltroEntrada(
  entrada: unknown,
  de: unknown,
  ate: unknown,
  hoje: string = hojeSaoPaulo(),
): FiltroEntrada | null {
  switch (entrada) {
    case 'hoje':
      return { chave: 'hoje', inicio: hoje, fim: hoje }
    case '7d':
      return { chave: '7d', inicio: somarDias(hoje, -6), fim: hoje }
    case 'mes':
      return { chave: 'mes', inicio: `${hoje.slice(0, 7)}-01`, fim: hoje }
    case 'intervalo': {
      const i = diaValido(de) ? de : null
      const f = diaValido(ate) ? ate : null
      if (!i && !f) return null
      // Só uma ponta: intervalo aberto do outro lado. Invertido: troca.
      const inicio = i ?? '2000-01-01'
      const fim = f ?? '2100-12-31'
      return inicio <= fim ? { chave: 'intervalo', inicio, fim } : { chave: 'intervalo', inicio: fim, fim: inicio }
    }
    default:
      return null
  }
}

/** O lead (pela data real de entrada, ISO) cai no filtro? Sem filtro, sempre. */
export function dentroDoFiltroEntrada(dataEntradaIso: string, filtro: FiltroEntrada | null): boolean {
  if (!filtro) return true
  const dia = diaEmSaoPaulo(dataEntradaIso)
  return dia >= filtro.inicio && dia <= filtro.fim
}

/** "Últimos 7 dias (26/10/2026 a 01/11/2026)", "Hoje (01/11/2026)", "A partir de 10/10/2026". */
export function descreverFiltroEntrada(filtro: FiltroEntrada): string {
  if (filtro.chave === 'intervalo') {
    if (filtro.inicio === '2000-01-01') return `Até ${formatarDia(filtro.fim)}`
    if (filtro.fim === '2100-12-31') return `A partir de ${formatarDia(filtro.inicio)}`
    return `${formatarDia(filtro.inicio)} a ${formatarDia(filtro.fim)}`
  }
  const rotulo = ROTULO_FILTRO_ENTRADA[filtro.chave]
  return filtro.inicio === filtro.fim
    ? `${rotulo} (${formatarDia(filtro.inicio)})`
    : `${rotulo} (${formatarDia(filtro.inicio)} a ${formatarDia(filtro.fim)})`
}
