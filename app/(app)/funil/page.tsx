import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'

import { PageHeaderPremium } from '@/components/layout/page-header-premium'
import { getUsuarioAtual } from '@/lib/dal/auth'
import { listarEtapas } from '@/lib/dal/etapas'
import { DIAS_VISIVEIS_ENCERRADOS, listarCardsFunil } from '@/lib/dal/funil'
import { listarFunis, resolverFunilSelecionado } from '@/lib/dal/funis'
import { obterPermissoesFunil } from '@/lib/dal/permissoes'
import { listarServicosAtivos } from '@/lib/dal/servicos'
import { dentroDoFiltroEntrada, resolverFiltroEntrada } from '@/lib/utils/filtro-entrada'
import { COOKIE_FUNIL } from '@/lib/utils/preferencia-funil'
import { CARGOS_POR_AREA } from '@/lib/validations/usuario'

import { BarraFunil } from './_components/barra-funil'
import { Kanban } from './_components/kanban'

export const metadata: Metadata = {
  title: 'Funil',
}

/** Kanban operacional. As métricas ficam em /funil/metricas. */
export default async function FunilPage({ searchParams }: PageProps<'/funil'>) {
  const [usuario, cookieStore] = await Promise.all([getUsuarioAtual(), cookies()])
  const { funil: funilParam, responsavel, temperatura, entrada, de, ate } = await searchParams
  // "Entrada do lead": só filtra a exibição (data real de entrada, calendário de São Paulo).
  const filtroEntrada = resolverFiltroEntrada(entrada, de, ate)

  const funilSelecionado = await resolverFunilSelecionado(funilParam, cookieStore.get(COOKIE_FUNIL)?.value)
  const funis = await listarFunis()

  if (!funilSelecionado) {
    return (
      <div className="@container w-full space-y-6">
        <PageHeaderPremium titulo="Funil" usuario={usuario} />
        <p className="rounded-lg border border-dashed border-premium-borda p-6 text-center text-sm text-premium-mudo">
          Você ainda não tem acesso a nenhum funil. Peça ao administrador para configurar suas permissões.
        </p>
      </div>
    )
  }

  const [cards, etapas, servicos] = await Promise.all([
    listarCardsFunil(funilSelecionado.id),
    listarEtapas(funilSelecionado.id),
    listarServicosAtivos(),
  ])
  const permissoes = await obterPermissoesFunil(
    funilSelecionado.id,
    etapas.map((e) => e.id),
  )

  const responsaveis = [...new Set(cards.flatMap((c) => (c.responsavel ? [c.responsavel] : [])))].sort(
    (a, b) => a.localeCompare(b, 'pt-BR'),
  )
  const cardsFiltrados = cards.filter(
    (c) =>
      (typeof responsavel !== 'string' || responsavel === '' || c.responsavel === responsavel) &&
      (typeof temperatura !== 'string' || temperatura === '' || c.temperatura === temperatura) &&
      dentroDoFiltroEntrada(c.dataChegada, filtroEntrada),
  )

  // Coluna aparece se o gerente vê tudo OU se há permissão de ver
  // configurada para aquela etapa — owner_id não entra aqui. Nenhum card
  // chega em `cardsFiltrados` fora de uma etapa visível: a RLS de
  // `negociacoes` já filtra pela mesma regra (`pode_ver_etapa`).
  const etapasVisiveis =
    usuario.role === 'gerente' ? new Set(etapas.map((e) => e.id)) : permissoes.etapasVisiveis
  const etapasExibidas = etapas.filter((e) => etapasVisiveis.has(e.id))

  return (
    <div className="@container w-full space-y-5 text-premium-texto">
      <PageHeaderPremium
        titulo={funilSelecionado.nome}
        subtitulo={`${
          usuario.role === 'gerente' ? 'Negociações de toda a equipe.' : 'Negociações das etapas liberadas pelo administrador.'
        } Fechadas e perdidas aparecem por ${DIAS_VISIVEIS_ENCERRADOS} dias.`}
        acoes={
          (CARGOS_POR_AREA.relatorios as readonly string[]).includes(usuario.role) ? (
            <Link
              href={`/funil/metricas?funil=${funilSelecionado.id}`}
              className="rounded-lg border border-premium-borda px-3 py-2 text-sm text-premium-secundario transition hover:border-premium-mudo/50 hover:text-premium-texto"
            >
              Ver métricas
            </Link>
          ) : undefined
        }
        usuario={usuario}
      />

      <BarraFunil
        funis={funis}
        funilId={funilSelecionado.id}
        responsaveis={responsaveis}
        podeConfigurar={usuario.role === 'gerente'}
        filtroEntrada={filtroEntrada}
        totalVisiveis={cardsFiltrados.length}
      />

      <Kanban
        cards={cardsFiltrados}
        etapas={etapasExibidas.map(({ id, nome, cor, tipo, etapaInicial, ordem, chave, atendentePodeMover }) => ({
          id,
          nome,
          cor,
          tipo,
          etapaInicial,
          ordem,
          chave,
          atendentePodeMover,
        }))}
        papel={usuario.role}
        etapasMovimentaveis={usuario.role === 'gerente' ? null : [...permissoes.etapasMovimentaveis]}
        servicos={servicos}
        whatsappHabilitado={funilSelecionado.whatsappHabilitado}
        meuId={usuario.id}
      />
    </div>
  )
}
