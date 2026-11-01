import { describe, expect, it } from 'vitest'

import { dentroDoFiltroEntrada, descreverFiltroEntrada, resolverFiltroEntrada } from './filtro-entrada'

const HOJE = '2026-11-01'

describe('filtro "Entrada do lead" do Kanban', () => {
  it('sem filtro (ou valor desconhecido) = todos', () => {
    expect(resolverFiltroEntrada(undefined, undefined, undefined, HOJE)).toBeNull()
    expect(resolverFiltroEntrada('ontem', undefined, undefined, HOJE)).toBeNull()
    expect(dentroDoFiltroEntrada('2020-01-01T00:00:00Z', null)).toBe(true)
  })

  it('hoje, últimos 7 dias e este mês no calendário de São Paulo', () => {
    expect(resolverFiltroEntrada('hoje', null, null, HOJE)).toEqual({ chave: 'hoje', inicio: HOJE, fim: HOJE })
    expect(resolverFiltroEntrada('7d', null, null, HOJE)).toEqual({ chave: '7d', inicio: '2026-10-26', fim: HOJE })
    expect(resolverFiltroEntrada('mes', null, null, HOJE)).toEqual({ chave: 'mes', inicio: '2026-11-01', fim: HOJE })
  })

  it('usa o dia de São Paulo, não o de UTC', () => {
    const hoje = resolverFiltroEntrada('hoje', null, null, HOJE)
    // 01/11 01:30 UTC = 31/10 22:30 em São Paulo
    expect(dentroDoFiltroEntrada('2026-11-01T01:30:00Z', hoje)).toBe(false)
    expect(dentroDoFiltroEntrada('2026-11-01T03:00:00Z', hoje)).toBe(true)
    expect(dentroDoFiltroEntrada('2026-11-02T02:59:00Z', hoje)).toBe(true)
  })

  it('intervalo: inclusivo, invertido é trocado, uma ponta só vale, datas inválidas = todos', () => {
    const f = resolverFiltroEntrada('intervalo', '2026-10-10', '2026-10-20', HOJE)
    expect(f).toEqual({ chave: 'intervalo', inicio: '2026-10-10', fim: '2026-10-20' })
    expect(dentroDoFiltroEntrada('2026-10-10T03:00:00Z', f)).toBe(true)
    expect(dentroDoFiltroEntrada('2026-10-21T02:59:59Z', f)).toBe(true)
    expect(dentroDoFiltroEntrada('2026-10-21T03:00:00Z', f)).toBe(false)
    expect(resolverFiltroEntrada('intervalo', '2026-10-20', '2026-10-10', HOJE)).toEqual(f)
    expect(resolverFiltroEntrada('intervalo', '2026-10-10', '', HOJE)?.fim).toBe('2100-12-31')
    expect(resolverFiltroEntrada('intervalo', 'x', '2026-02-31', HOJE)).toBeNull()
  })

  it('descreve o filtro ativo', () => {
    expect(descreverFiltroEntrada(resolverFiltroEntrada('hoje', null, null, HOJE)!)).toBe('Hoje (01/11/2026)')
    expect(descreverFiltroEntrada(resolverFiltroEntrada('7d', null, null, HOJE)!)).toBe('Últimos 7 dias (26/10/2026 a 01/11/2026)')
    expect(descreverFiltroEntrada(resolverFiltroEntrada('intervalo', '2026-10-10', '2026-10-20', HOJE)!)).toBe('10/10/2026 a 20/10/2026')
    expect(descreverFiltroEntrada(resolverFiltroEntrada('intervalo', '2026-10-10', null, HOJE)!)).toBe('A partir de 10/10/2026')
  })
})
