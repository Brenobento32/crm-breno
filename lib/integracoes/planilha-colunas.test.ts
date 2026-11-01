import { describe, expect, it } from 'vitest'

import { CHAVES_DATA_ENVIO, colunaNaoEIdDoLead, dataDoEnvio } from '../../supabase/functions/_shared/planilha-colunas'

const AGORA = Date.parse('2026-11-01T15:00:00Z')

describe('data real do envio do formulário', () => {
  it('Lead Ads da Meta (ISO com fuso, com ou sem dois-pontos)', () => {
    expect(dataDoEnvio('2026-10-30T10:00:00-03:00', AGORA)).toBe('2026-10-30T13:00:00.000Z')
    expect(dataDoEnvio('2026-10-30T10:00:00-0300', AGORA)).toBe('2026-10-30T13:00:00.000Z')
    expect(dataDoEnvio('2026-10-30T13:00:00+0000', AGORA)).toBe('2026-10-30T13:00:00.000Z')
    expect(dataDoEnvio('2026-10-30T13:00:00Z', AGORA)).toBe('2026-10-30T13:00:00.000Z')
  })

  it('sem fuso e Google Forms em português: hora de São Paulo', () => {
    expect(dataDoEnvio('2026-10-30 10:00:00', AGORA)).toBe('2026-10-30T13:00:00.000Z')
    expect(dataDoEnvio('30/10/2026 10:00:00', AGORA)).toBe('2026-10-30T13:00:00.000Z')
    expect(dataDoEnvio('1/9/2026 8:05', AGORA)).toBe('2026-09-01T11:05:00.000Z')
    expect(dataDoEnvio('30/10/2026', AGORA)).toBe('2026-10-30T03:00:00.000Z')
  })

  it('nunca inventa: vazio, texto, dia inexistente, ano absurdo ou futuro → null', () => {
    for (const t of ['', null, undefined, 'ontem', '31/02/2026 10:00', '2026-13-01', '1999-01-01T00:00:00Z', '2026-11-05T00:00:00Z', 'l:123456789012345']) {
      expect(dataDoEnvio(t as string, AGORA)).toBeNull()
    }
  })

  it('chaves das respostas guardadas batem com a normalização do banco', () => {
    expect(CHAVES_DATA_ENVIO).toContain('created_time')
    expect(CHAVES_DATA_ENVIO).toContain('carimbo_de_data_hora')
  })
})

describe('coluna do ID do lead da Meta', () => {
  it('ad_id, adset_id, campaign_id, form_id e page_id não são o ID do lead', () => {
    for (const c of ['ad_id', 'adset_id', 'campaign_id', 'form_id', 'page_id', 'Ad ID']) expect(colunaNaoEIdDoLead(c)).toBe(true)
    for (const c of ['id', 'lead_id', 'ID do lead', '', null, undefined]) expect(colunaNaoEIdDoLead(c)).toBe(false)
  })
})
