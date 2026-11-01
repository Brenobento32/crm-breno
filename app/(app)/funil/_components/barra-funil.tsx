'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'

import { inputClass, botaoSecundarioClass, botaoPrimarioClass } from '@/components/ui/estilos'
import type { Funil } from '@/lib/dal/funis'
import { descreverFiltroEntrada, FILTROS_ENTRADA, ROTULO_FILTRO_ENTRADA, type FiltroEntrada } from '@/lib/utils/filtro-entrada'
import { ROTULO_TEMPERATURA, TEMPERATURAS } from '@/lib/validations/negociacao'

import { SeletorFunil } from './seletor-funil'

const selectClass = `${inputClass} w-auto py-2 pr-8`
const botaoClass = botaoSecundarioClass

/**
 * Toolbar do Kanban: funil selecionado, filtros de Responsável e
 * Temperatura (na URL — o servidor filtra os cards), configuração do funil e
 * nova entrada.
 */
export function BarraFunil({
  funis,
  funilId,
  responsaveis,
  podeConfigurar,
  filtroEntrada,
  totalVisiveis,
}: {
  funis: Pick<Funil, 'id' | 'nome' | 'ativo'>[]
  funilId: string
  responsaveis: string[]
  podeConfigurar: boolean
  /** Filtro de data de entrada já resolvido no servidor (null = todos). */
  filtroEntrada: FiltroEntrada | null
  /** Cards exibidos depois de todos os filtros. */
  totalVisiveis: number
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // "Intervalo personalizado" escolhido, mas ainda sem datas aplicadas.
  const [editandoIntervalo, setEditandoIntervalo] = useState(false)
  const [de, setDe] = useState(filtroEntrada?.chave === 'intervalo' && filtroEntrada.inicio !== '2000-01-01' ? filtroEntrada.inicio : '')
  const [ate, setAte] = useState(filtroEntrada?.chave === 'intervalo' && filtroEntrada.fim !== '2100-12-31' ? filtroEntrada.fim : '')

  function irPara(alterar: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString())
    alterar(params)
    router.push(`${pathname}?${params.toString()}`)
  }

  function atualizarParam(nome: string, valor: string) {
    irPara((params) => {
      if (valor) params.set(nome, valor)
      else params.delete(nome)
    })
  }

  function escolherEntrada(valor: string) {
    if (valor === 'intervalo') {
      setEditandoIntervalo(true)
      return
    }
    setEditandoIntervalo(false)
    irPara((params) => {
      params.delete('de')
      params.delete('ate')
      if (valor) params.set('entrada', valor)
      else params.delete('entrada')
    })
  }

  function aplicarIntervalo() {
    if (!de && !ate) return
    setEditandoIntervalo(false)
    irPara((params) => {
      params.set('entrada', 'intervalo')
      if (de) params.set('de', de)
      else params.delete('de')
      if (ate) params.set('ate', ate)
      else params.delete('ate')
    })
  }

  function limparEntrada() {
    setEditandoIntervalo(false)
    setDe('')
    setAte('')
    irPara((params) => {
      params.delete('entrada')
      params.delete('de')
      params.delete('ate')
    })
  }

  const responsavelAtual = searchParams.get('responsavel') ?? ''
  const temperaturaAtual = searchParams.get('temperatura') ?? ''
  const entradaAtual = editandoIntervalo ? 'intervalo' : (filtroEntrada?.chave ?? '')
  const mostrarIntervalo = editandoIntervalo || filtroEntrada?.chave === 'intervalo'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <SeletorFunil funis={funis} funilId={funilId} variant="premium" />

        <div>
          <label className="mb-1 block text-xs text-premium-mudo" htmlFor="filtro-responsavel">
            Responsável
          </label>
          <select
            id="filtro-responsavel"
            value={responsavelAtual}
            onChange={(e) => atualizarParam('responsavel', e.target.value)}
            className={selectClass}
          >
            <option value="">Todos os responsáveis</option>
            {responsaveis.map((nome) => (
              <option key={nome} value={nome}>
                {nome}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs text-premium-mudo" htmlFor="filtro-temperatura">
            Temperatura
          </label>
          <select
            id="filtro-temperatura"
            value={temperaturaAtual}
            onChange={(e) => atualizarParam('temperatura', e.target.value)}
            className={selectClass}
          >
            <option value="">Todas as temperaturas</option>
            {TEMPERATURAS.map((t) => (
              <option key={t} value={t}>
                {ROTULO_TEMPERATURA[t]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs text-premium-mudo" htmlFor="filtro-entrada">
            Entrada do lead
          </label>
          <select id="filtro-entrada" value={entradaAtual} onChange={(e) => escolherEntrada(e.target.value)} className={selectClass}>
            <option value="">{ROTULO_FILTRO_ENTRADA.todos}</option>
            {FILTROS_ENTRADA.map((f) => (
              <option key={f} value={f}>
                {ROTULO_FILTRO_ENTRADA[f]}
              </option>
            ))}
          </select>
        </div>

        {mostrarIntervalo && (
          <>
            <div>
              <label className="mb-1 block text-xs text-premium-mudo" htmlFor="filtro-entrada-de">
                De
              </label>
              <input id="filtro-entrada-de" type="date" value={de} max={ate || undefined} onChange={(e) => setDe(e.target.value)} className={selectClass} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-premium-mudo" htmlFor="filtro-entrada-ate">
                Até
              </label>
              <input id="filtro-entrada-ate" type="date" value={ate} min={de || undefined} onChange={(e) => setAte(e.target.value)} className={selectClass} />
            </div>
            <button type="button" onClick={aplicarIntervalo} disabled={!de && !ate} className={`${botaoClass} disabled:opacity-50`}>
              Aplicar
            </button>
          </>
        )}

        <span className="flex-1" />

        {podeConfigurar && (
          <Link href={`/configuracoes/funis/${funilId}`} className={botaoClass}>
            Configurar funil
          </Link>
        )}
        <Link
          href={`/funil/nova?funil=${funilId}`}
          className={botaoPrimarioClass}
        >
          + Nova entrada
        </Link>
      </div>
      {filtroEntrada && (
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-premium-secundario">
          <span className="rounded-md border border-premium-borda bg-premium-card px-2 py-1">
            Entrada do lead: <strong className="font-medium text-premium-texto">{descreverFiltroEntrada(filtroEntrada)}</strong> ·{' '}
            {totalVisiveis === 1 ? '1 negociação' : `${totalVisiveis} negociações`}
          </span>
          <button type="button" onClick={limparEntrada} className="text-premium-acento underline-offset-2 hover:underline">
            Limpar filtro
          </button>
        </p>
      )}
    </div>
  )
}
