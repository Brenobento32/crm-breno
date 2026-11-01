/**
 * Regras puras sobre colunas de planilha, sem dependências: usadas pela
 * leitura da planilha (Edge Function `integracoes`) e pelo Next.js (tela de
 * conexão e funil), com a mesma regra nos dois lados.
 */

/** Mesma normalização do cabeçalho em google-sheets.ts (minúsculas, sem acento, separadores viram espaço). */
export function normalizarColuna(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Export dos Lead Ads da Meta: `id` é o ID do lead ("l:" + dígitos). Estas
 * outras são do anúncio, conjunto, campanha, formulário ou página — nunca do lead.
 */
const COLUNAS_ID_META_NAO_LEAD = new Set(['ad id', 'adset id', 'ad set id', 'campaign id', 'form id', 'page id'])
export function colunaNaoEIdDoLead(coluna: string | null | undefined): boolean {
  return Boolean(coluna) && COLUNAS_ID_META_NAO_LEAD.has(normalizarColuna(coluna as string))
}

/**
 * Data REAL do envio de um formulário (a coluna da planilha, não a hora da
 * importação). Sem dependências: usada pela leitura da planilha (Edge
 * Function) e pelo funil (Next.js), com a mesma regra.
 *
 * Aceita:
 *  - ISO com fuso: `2026-10-30T10:00:00-03:00`, `...-0300`, `...+0000`, `...Z` (Lead Ads da Meta);
 *  - ISO sem fuso ou `AAAA-MM-DD HH:MM[:SS]`: hora de São Paulo;
 *  - `DD/MM/AAAA[ HH:MM[:SS]]` (Google Forms em português): hora de São Paulo.
 * Devolve ISO em UTC (`...Z`) ou null. Nunca inventa: texto fora desses
 * formatos, ano fora de 2000–2100 ou data a mais de 1 dia no futuro → null.
 */

/** Colunas de data do envio, já normalizadas (minúsculas, sem acento, separadores viram espaço). */
export const COLUNAS_DATA_ENVIO = new Set([
  'created time',
  'carimbo de data hora',
  'timestamp',
  'data hora do envio',
  'data e hora do envio',
  'data do envio',
  'data de envio',
  'submitted at',
  'submission date',
])

/** Chaves das respostas guardadas (`negociacao_respostas.chave`) que trazem a data do envio. */
export const CHAVES_DATA_ENVIO = [...COLUNAS_DATA_ENVIO].map((c) => c.replace(/ /g, '_'))

// Brasil sem horário de verão desde 2019: São Paulo é sempre UTC-3.
const FUSO_SP = '-03:00'

export function dataDoEnvio(texto: string | null | undefined, agora = Date.now()): string | null {
  const t = (texto ?? '').trim()
  if (!t) return null
  let iso: string | null = null
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  if (br) {
    const [, d, m, a, h = '0', min = '00', s = '00'] = br
    iso = `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min}:${s}${FUSO_SP}`
  } else {
    const x = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(t)
    if (!x) return null
    const [, a, m, d, h = '00', min = '00', s = '00', fuso] = x
    const f = !fuso ? FUSO_SP : fuso.toUpperCase() === 'Z' ? 'Z' : `${fuso.slice(0, 3)}:${fuso.slice(-2)}`
    iso = `${a}-${m}-${d}T${h}:${min}:${s}${f}`
  }
  const [ano, mes, dia] = iso.slice(0, 10).split('-').map(Number)
  if (ano < 2000 || ano > 2100 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms) || ms > agora + 86_400_000) return null
  // Dia inexistente (31/02) o Date "rola" para o mês seguinte: recusado.
  const local = new Date(ms - 3 * 3_600_000)
  if (iso.endsWith(FUSO_SP) && local.getUTCDate() !== dia) return null
  return new Date(ms).toISOString()
}
