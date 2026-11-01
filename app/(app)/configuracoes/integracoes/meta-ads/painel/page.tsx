import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeaderPremium } from '@/components/layout/page-header-premium'
import { Aviso } from '@/components/ui/aviso'
import { EstadoVazio } from '@/components/ui/estado-vazio'
import { ajudaClass, botaoCompactoClass } from '@/components/ui/estilos'
import { getUsuarioAtual } from '@/lib/dal/auth'
import { integracoesHabilitadas, podeAdministrarIntegracoes } from '@/lib/dal/integracoes-oficiais'
import { metaAdsDaEmpresa, painelMetaAds, type LinhaPainelAds } from '@/lib/dal/meta-ads'
import { formatarDataHoraCompleta } from '@/lib/utils/formatacao'

export const metadata: Metadata = { title: 'Meta Ads — Painel de campanhas' }

const PERIODOS = [7, 30, 90] as const
const dia = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)
const moeda = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const inteiro = (v: number) => v.toLocaleString('pt-BR')

const vezes = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}x`)

/** Soma das linhas (CPL e os dois ROAS recalculados do total, nunca média de médias). */
function total(linhas: LinhaPainelAds[]) {
  const t = linhas.reduce(
    (a, l) => ({
      investimento: a.investimento + l.investimento,
      impressoes: a.impressoes + l.impressoes,
      cliques: a.cliques + l.cliques,
      leadsCrm: a.leadsCrm + l.leadsCrm,
      vendas: a.vendas + l.vendas,
      faturamento: a.faturamento + l.faturamento,
      leadsMeta: a.leadsMeta + l.leadsMeta,
      conversoesMeta: a.conversoesMeta + l.conversoesMeta,
      valorConversoesMeta: a.valorConversoesMeta + l.valorConversoesMeta,
    }),
    { investimento: 0, impressoes: 0, cliques: 0, leadsCrm: 0, vendas: 0, faturamento: 0, leadsMeta: 0, conversoesMeta: 0, valorConversoesMeta: 0 },
  )
  const razao = (a: number, b: number) => (b > 0 ? a / b : null)
  return { ...t, cpl: razao(t.investimento, t.leadsCrm), roasCrm: razao(t.faturamento, t.investimento), roasMeta: razao(t.valorConversoesMeta, t.investimento) }
}

function Indicadores({ titulo, descricao, itens }: { titulo: string; descricao: string; itens: [string, string][] }) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold">{titulo}</h2>
        <p className={ajudaClass}>{descricao}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
        {itens.map(([r, v]) => (
          <div key={r} className="rounded-xl border border-premium-borda p-3">
            <dt className="text-xs text-premium-mudo">{r}</dt>
            <dd className="font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export default async function PainelMetaAdsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const eu = await getUsuarioAtual()
  if (eu.role !== 'gerente') notFound()
  const params = await searchParams
  const dias = PERIODOS.find((p) => String(p) === params.dias) ?? 30
  const agora = new Date()
  const fim = dia(agora)
  const inicio = dia(new Date(agora.getTime() - (dias - 1) * 86400000))
  const [podeGerir, habilitadas, login] = await Promise.all([podeAdministrarIntegracoes(), integracoesHabilitadas(), metaAdsDaEmpresa()])
  const linhas = podeGerir && habilitadas.metaConversoes && login?.contas.length ? await painelMetaAds(inicio, fim) : []
  const t = total(linhas)

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeaderPremium
        titulo="Meta Ads — Painel de campanhas"
        subtitulo="Investimento e leads da Meta, cruzados com o que aconteceu no CRM: leads que entraram no funil, vendas e faturamento por campanha. Só as contas de anúncios que a sua empresa autorizou."
        voltar={{ href: '/configuracoes/integracoes/meta-ads', rotulo: 'Meta Ads' }}
      />
      {!habilitadas.metaConversoes ? (
        <Aviso tom="info" titulo="Em homologação">O Meta Ads ainda não foi liberado na plataforma.</Aviso>
      ) : !podeGerir ? (
        <Aviso tom="info">Somente o Administrador da empresa vê o painel do Meta Ads.</Aviso>
      ) : !login?.contas.length ? (
        <EstadoVazio titulo="Nenhuma conta de anúncios conectada" descricao="Conecte o Meta Ads e escolha as contas de anúncios da sua empresa." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {PERIODOS.map((p) => (
              <Link key={p} href={`?dias=${p}`} className={botaoCompactoClass} aria-current={p === dias ? 'page' : undefined}>
                {p === dias ? <strong>Últimos {p} dias</strong> : `Últimos ${p} dias`}
              </Link>
            ))}
            {login.conexao?.ultimaSincronizacaoEm && (
              <span className={ajudaClass}>Atualizado em {formatarDataHoraCompleta(login.conexao.ultimaSincronizacaoEm)}</span>
            )}
          </div>
          {login.conexao?.ultimoErro && <Aviso tom="alerta">Última leitura da Meta falhou: {login.conexao.ultimoErro}</Aviso>}

          <Indicadores
            titulo="Resultado no CRM"
            descricao="Medido no funil da sua empresa: leads que entraram, vendas fechadas e faturamento registrado, por campanha de origem."
            itens={[
              ['Investimento', moeda(t.investimento)],
              ['Leads no CRM', inteiro(t.leadsCrm)],
              ['CPL (CRM)', t.cpl === null ? '—' : moeda(t.cpl)],
              ['Vendas (CRM)', inteiro(t.vendas)],
              ['Faturamento (CRM)', moeda(t.faturamento)],
              ['ROAS (CRM)', vezes(t.roasCrm)],
            ]}
          />
          <Indicadores
            titulo="Atribuição informada pela Meta"
            descricao="Números que a própria Meta atribui aos anúncios, pelo modelo e pela janela de atribuição configurados na conta. Servem para comparar; podem diferir do CRM."
            itens={[
              ['Leads (Meta)', inteiro(t.leadsMeta)],
              ['Compras atribuídas', inteiro(t.conversoesMeta)],
              ['Valor atribuído', moeda(t.valorConversoesMeta)],
              ['ROAS (Meta)', vezes(t.roasMeta)],
            ]}
          />

          {linhas.length === 0 ? (
            <EstadoVazio titulo="Sem dados no período" descricao="A primeira leitura da Meta acontece em até uma hora depois de conectar as contas." />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-premium-borda">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-premium-mudo">
                  <tr>
                    {[
                      'Campanha',
                      'Investimento',
                      'Impressões',
                      'Cliques',
                      'Leads no CRM',
                      'CPL (CRM)',
                      'Vendas (CRM)',
                      'Faturamento (CRM)',
                      'ROAS (CRM)',
                      'Leads (Meta)',
                      'Valor atribuído (Meta)',
                      'ROAS (Meta)',
                    ].map((c) => (
                      <th key={c} className="px-3 py-2 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => (
                    <tr key={`${l.contaId}-${l.campanhaId}`} className="border-t border-premium-borda tabular-nums">
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.campanhaNome ?? 'Campanha'}</div>
                        <div className="text-xs text-premium-mudo">
                          act_{l.contaId} · {l.campanhaId}
                        </div>
                      </td>
                      <td className="px-3 py-2">{moeda(l.investimento)}</td>
                      <td className="px-3 py-2">{inteiro(l.impressoes)}</td>
                      <td className="px-3 py-2">{inteiro(l.cliques)}</td>
                      <td className="px-3 py-2">{inteiro(l.leadsCrm)}</td>
                      <td className="px-3 py-2">{l.cpl === null ? '—' : moeda(l.cpl)}</td>
                      <td className="px-3 py-2">{inteiro(l.vendas)}</td>
                      <td className="px-3 py-2">{moeda(l.faturamento)}</td>
                      <td className="px-3 py-2 font-medium">{vezes(l.roasCrm)}</td>
                      <td className="px-3 py-2 text-premium-mudo">{inteiro(l.leadsMeta)}</td>
                      <td className="px-3 py-2 text-premium-mudo">{moeda(l.valorConversoesMeta)}</td>
                      <td className="px-3 py-2 text-premium-mudo">{vezes(l.roasMeta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={ajudaClass}>
            ROAS (CRM) = faturamento registrado no CRM ÷ investimento; conta só os leads que chegaram pelos formulários nativos (Lead Ads) com a
            campanha identificada. ROAS (Meta) = valor de compras que a Meta atribui ao anúncio ÷ investimento, pela atribuição da Meta; não é conferido
            pelo CRM. Faturamento em reais, como está no CRM; investimento e valor atribuído vêm na moeda da conta de anúncios. O AVANTE só lê métricas:
            nunca cria, edita ou pausa campanhas.
          </p>
        </>
      )}
    </div>
  )
}
