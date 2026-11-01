import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeaderPremium } from '@/components/layout/page-header-premium'
import { Aviso, AvisoDaUrl } from '@/components/ui/aviso'
import { BotaoConfirmar } from '@/components/ui/botao-confirmar'
import { EstadoVazio } from '@/components/ui/estado-vazio'
import { ajudaClass, botaoCompactoClass, botaoPerigoClass, botaoPrimarioClass, botaoSecundarioClass, inputClass } from '@/components/ui/estilos'
import { Secao } from '@/components/ui/secao'
import { Selo, type TomSelo } from '@/components/ui/selo'
import { acaoMetaAdsAction, desconectarMetaAdsLoginAction, reprocessarMetaAdsAction, salvarMetaAdsAction } from '@/lib/actions/integracoes-oficiais'
import { getUsuarioAtual } from '@/lib/dal/auth'
import { listarResponsaveis } from '@/lib/dal/clientes'
import { opcoesDeDestino } from '@/lib/dal/fontes-leads'
import { integracoesHabilitadas, podeAdministrarIntegracoes } from '@/lib/dal/integracoes-oficiais'
import { metaAdsDaEmpresa } from '@/lib/dal/meta-ads'
import { conexaoMetaAds, eventosMetaAds, funisComEtapas } from '@/lib/dal/meta-conversoes'
import { formatarDataHoraCompleta } from '@/lib/utils/formatacao'

import { AtivosMetaAds } from './ativos-meta-ads'
import { ConectarMetaAds } from './conectar-meta-ads'

export const metadata: Metadata = { title: 'Meta Ads — Conversões do CRM' }

const SITUACAO: Record<string, { rotulo: string; tom: TomSelo }> = {
  configurando: { rotulo: 'Conectada — falta ativar', tom: 'ambar' },
  ativa: { rotulo: 'Enviando conversões', tom: 'verde' },
  pausada: { rotulo: 'Pausada', tom: 'neutro' },
  erro_autorizacao: { rotulo: 'Reconectar na Meta', tom: 'vermelho' },
}
const EVENTO: Record<string, { rotulo: string; tom: TomSelo }> = {
  pendente: { rotulo: 'Na fila', tom: 'ambar' },
  enviando: { rotulo: 'Enviando', tom: 'ambar' },
  enviado: { rotulo: 'Aceito pela Meta', tom: 'verde' },
  rejeitado: { rotulo: 'Rejeitado', tom: 'vermelho' },
  sem_correspondencia: { rotulo: 'Não enviado: sem ID de lead da Meta', tom: 'neutro' },
  expirado: { rotulo: 'Expirado (mais de 7 dias)', tom: 'neutro' },
}
/** Sugestão de nome por posição da etapa (o Administrador ajusta; a Meta aceita o nome da etapa do CRM). */
const sugestao = (nome: string, tipo: string) => (tipo === 'perdida' ? '' : nome)

export default async function MetaAdsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const eu = await getUsuarioAtual()
  if (eu.role !== 'gerente') notFound()
  const [podeGerir, conexao, funis, eventos, params, habilitadas, login, opcoes, responsaveis] = await Promise.all([
    podeAdministrarIntegracoes(),
    conexaoMetaAds(),
    funisComEtapas(),
    eventosMetaAds(50),
    searchParams,
    integracoesHabilitadas(),
    metaAdsDaEmpresa(),
    opcoesDeDestino(),
    listarResponsaveis(),
  ])
  const elegivel = Boolean(conexao?.elegivel)
  const conectada = Boolean(conexao?.conexaoId)
  const mapa = new Map((conexao?.mapeamento ?? []).map((m) => [m.etapaId, m]))
  const monitorados = new Set(conexao?.funis ?? [])
  const s = conexao?.situacao ? SITUACAO[conexao.situacao] : null

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeaderPremium
        titulo="Meta Ads — Conversões do CRM"
        subtitulo="Devolve para a Meta o andamento dos leads que vieram dos formulários nativos de anúncio (Lead Ads): recebido, qualificado, reunião, fechado. Ajuda a medir e otimizar as campanhas pela qualidade do lead. Não é o WhatsApp."
        voltar={{ href: '/configuracoes/integracoes?abrir=meta_conversoes', rotulo: 'Integrações' }}
      />
      <AvisoDaUrl ok={params.ok} erro={params.erro} />

      {!habilitadas.metaConversoes ? (
        <Aviso tom="info" titulo="Em homologação">O Meta Ads — Conversões do CRM ainda não foi liberado na plataforma. Nenhuma conexão é aberta enquanto isso.</Aviso>
      ) : !podeGerir ? (
        <Aviso tom="info">Somente o Administrador da empresa configura as conversões do Meta Ads.</Aviso>
      ) : !elegivel ? (
        <Aviso tom="info" titulo="Disponível no plano Business">
          As Conversões do CRM fazem parte do plano Business; outros planos só com liberação da Rio X7 (peça na Central de Integrações). Nada é enviado à Meta enquanto o recurso não estiver liberado.
        </Aviso>
      ) : (
        <>
          <Secao
            titulo="Ativos da empresa na Meta"
            descricao="Conecte, pelo Login do Facebook para Empresas, as Páginas (leads dos formulários do Facebook e do Instagram), as contas de anúncios (painel de campanhas) e o dataset (Conversões do CRM) do portfólio da SUA empresa, mesmo fora da Rio X7."
          >
            <div className="space-y-3 pb-5 text-sm">
              {login?.conexao && (
                <div className="space-y-1 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">Portfólio {login.conexao.negocioId}</span>
                    <Selo tom={login.conexao.situacao === 'ativa' ? 'verde' : 'vermelho'}>
                      {login.conexao.situacao === 'ativa' ? 'Conectado' : 'Reautorizar na Meta'}
                    </Selo>
                  </div>
                  <p className="text-premium-mudo">
                    {login.paginas.filter((p) => p.status === 'ativa').length} Página(s) recebendo leads · {login.contas.length} conta(s) de anúncios
                    {login.conexao.ultimaSincronizacaoEm ? ` · métricas atualizadas em ${formatarDataHoraCompleta(login.conexao.ultimaSincronizacaoEm)}` : ''}
                  </p>
                  {login.conexao.ultimoErro && <p className="text-red-700 dark:text-red-300">Último erro: {login.conexao.ultimoErro}</p>}
                </div>
              )}
              <AtivosMetaAds
                conectada={Boolean(login?.conexao)}
                opcoes={opcoes}
                responsaveis={responsaveis.map((r) => ({ id: r.id, nome: r.nome }))}
                atuais={{
                  datasetId: conexao?.datasetId ?? null,
                  paginas: (login?.paginas ?? []).filter((p) => p.status === 'ativa').map((p) => ({ pageId: p.pageId, funilId: p.funilId, etapaId: p.etapaId, responsavelId: p.responsavelId })),
                  contas: (login?.contas ?? []).map((c) => c.contaId),
                }}
              />
              {login?.conexao && (
                <div className="flex flex-wrap gap-2">
                  {login.contas.length > 0 && (
                    <Link href="/configuracoes/integracoes/meta-ads/painel" className={botaoSecundarioClass}>
                      Ver painel de campanhas
                    </Link>
                  )}
                  <form action={desconectarMetaAdsLoginAction}>
                    <BotaoConfirmar
                      pergunta="Desconectar o Meta Ads da empresa? A credencial é apagada, as Páginas deixam de receber leads e as métricas param de atualizar. Leads e histórico continuam."
                      className={botaoPerigoClass}
                    >
                      Desconectar Páginas e contas
                    </BotaoConfirmar>
                  </form>
                </div>
              )}
            </div>
          </Secao>
          <Secao titulo="1. Conta Meta" descricao="Você autoriza na janela oficial da Meta e escolhe o conjunto de dados (dataset) de CRM da empresa. Nenhum token é digitado aqui; a credencial fica guardada só no servidor.">
            <div className="space-y-3 pb-5 text-sm">
              {!conectada ? (
                <ConectarMetaAds />
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{conexao?.datasetNome ?? 'Conjunto de dados'}</span>
                    <span className="text-xs text-premium-mudo">dataset {conexao?.datasetId}</span>
                    {s && <Selo tom={s.tom}>{s.rotulo}</Selo>}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-premium-mudo">Aceitos pela Meta</dt>
                      <dd className="font-medium tabular-nums">{conexao?.enviados ?? 0}</dd>
                    </div>
                    <div>
                      <dt className="text-premium-mudo">Na fila</dt>
                      <dd className="font-medium tabular-nums">{conexao?.pendentes ?? 0}</dd>
                    </div>
                    <div>
                      <dt className="text-premium-mudo">Rejeitados</dt>
                      <dd className="font-medium tabular-nums">{conexao?.rejeitados ?? 0}</dd>
                    </div>
                    <div>
                      <dt className="text-premium-mudo">Sem ID de lead da Meta</dt>
                      <dd className="font-medium tabular-nums">{conexao?.semCorrespondencia ?? 0}</dd>
                    </div>
                  </dl>
                  {conexao?.ultimoErro && <p className="text-xs text-red-700 dark:text-red-300">Último erro: {conexao.ultimoErro}</p>}
                  <div className="flex flex-wrap gap-2">
                    {conexao?.situacao === 'configurando' && (
                      <form action={acaoMetaAdsAction}>
                        <input type="hidden" name="acao" value="ativar" />
                        <button type="submit" className={botaoPrimarioClass}>
                          Ativar envio
                        </button>
                      </form>
                    )}
                    {conexao?.situacao === 'ativa' && (
                      <form action={acaoMetaAdsAction}>
                        <input type="hidden" name="acao" value="pausar" />
                        <button type="submit" className={botaoSecundarioClass}>
                          Pausar
                        </button>
                      </form>
                    )}
                    {conexao?.situacao === 'pausada' && (
                      <form action={acaoMetaAdsAction}>
                        <input type="hidden" name="acao" value="retomar" />
                        <button type="submit" className={botaoPrimarioClass}>
                          Retomar
                        </button>
                      </form>
                    )}
                    {conexao?.situacao === 'erro_autorizacao' && <ConectarMetaAds rotulo="Reconectar na Meta" />}
                    <form action={acaoMetaAdsAction}>
                      <input type="hidden" name="acao" value="desconectar" />
                      <BotaoConfirmar pergunta="Desconectar a conta Meta Ads? A credencial é apagada e os eventos na fila não serão enviados." className={botaoPerigoClass}>
                        Desconectar
                      </BotaoConfirmar>
                    </form>
                  </div>
                  <details className="text-sm">
                    <summary className="cursor-pointer text-premium-acento hover:underline">Homologação: código de teste do Gerenciador de Eventos</summary>
                    <form action={acaoMetaAdsAction} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="acao" value="definir_codigo_teste" />
                      <label className="block text-sm">
                        <span className="mb-1 block text-xs text-premium-mudo">Código (ex.: TEST12345). Vazio = envio normal.</span>
                        <input name="codigo_teste" defaultValue={conexao?.codigoTeste ?? ''} maxLength={40} className={inputClass} />
                      </label>
                      <button type="submit" className={botaoCompactoClass}>
                        Salvar
                      </button>
                    </form>
                  </details>
                </>
              )}
            </div>
          </Secao>

          {conectada && (
            <Secao titulo="2. Funis e eventos" descricao="Escolha os funis monitorados e o nome do evento de cada etapa. A Meta recomenda enviar todas as etapas, na ordem, inclusive a de lead recebido. Etapa sem nome não é enviada.">
              <form action={salvarMetaAdsAction} className="space-y-5 pb-5">
                {funis.map((f) => (
                  <fieldset key={f.id} className="space-y-2 rounded-lg border border-premium-borda p-3">
                    <legend className="px-1 text-sm">
                      <label className="flex items-center gap-2 font-medium">
                        <input type="checkbox" name="funil" value={f.id} defaultChecked={monitorados.has(f.id)} />
                        Monitorar o funil {f.nome}
                      </label>
                    </legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {f.etapas.map((e) => {
                        const atual = mapa.get(e.id)
                        return (
                          <div key={e.id} className="text-sm">
                            <input type="hidden" name={`funil_da_etapa:${e.id}`} value={f.id} />
                            <label className="block">
                              <span className="mb-1 block text-xs text-premium-mudo">
                                Etapa “{e.nome}”{e.tipo === 'ganha' ? ' (fechamento)' : e.tipo === 'perdida' ? ' (perda)' : ''} → evento
                              </span>
                              <input
                                name={`evento:${e.id}`}
                                defaultValue={atual?.evento ?? (monitorados.has(f.id) ? '' : sugestao(e.nome, e.tipo))}
                                maxLength={50}
                                placeholder="não enviar"
                                className={inputClass}
                              />
                            </label>
                            {e.tipo === 'ganha' && (
                              <label className="mt-1 flex items-center gap-2 text-xs">
                                <input type="checkbox" name={`valor:${e.id}`} defaultChecked={atual?.enviarValor ?? true} />
                                Enviar o valor da venda (R$)
                              </label>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </fieldset>
                ))}
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="enviar_contato_hash" className="mt-1" defaultChecked={conexao?.enviarContatoHash ?? false} />
                  <span>
                    Enviar também e-mail e telefone do lead, criptografados (hash SHA-256), para melhorar a correspondência
                    <span className={`block ${ajudaClass}`}>
                      Desligado por padrão: só o ID do lead da Meta é enviado. Ligue apenas se a política de privacidade da empresa cobre esse uso (LGPD).
                    </span>
                  </span>
                </label>
                <button type="submit" className={botaoPrimarioClass}>
                  Salvar funis e eventos
                </button>
              </form>
            </Secao>
          )}

          <Aviso tom="info" titulo="O que é enviado (e o que não é)">
            Só leads que chegaram por formulário nativo de anúncio da Meta (Lead Ads) — direto, ou por uma planilha com a coluna &quot;ID do lead&quot; — têm o
            identificador que a Meta exige. Os demais (WhatsApp, site, cadastro manual) ficam registrados como &quot;sem ID de lead da Meta&quot; e não são
            enviados: o AVANTE não presume que vieram de anúncio. Leads de anúncio Click-to-WhatsApp guardam a origem do clique, mas o envio desse tipo usa outra
            integração da Meta, ainda não ativada. Eventos com mais de 7 dias não são aceitos pela Meta.
          </Aviso>

          <Secao titulo="Histórico de transmissão" descricao="Últimos 50 eventos gerados pelo funil." semPadding>
            {eventos.length === 0 ? (
              <EstadoVazio compacto titulo="Nenhum evento ainda" descricao="Os eventos aparecem quando um lead de funil monitorado muda para uma etapa mapeada." />
            ) : (
              <ul className="divide-y divide-premium-borda-suave text-sm">
                {eventos.map((e) => {
                  const st = EVENTO[e.situacao] ?? { rotulo: e.situacao, tom: 'neutro' as TomSelo }
                  return (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {e.evento} <span className="text-xs font-normal text-premium-mudo">· {e.funilNome}</span>
                        </p>
                        <p className="text-xs text-premium-mudo">
                          <Link href={`/negociacoes/${e.negociacaoId}/editar`} className="hover:underline">
                            {e.clienteNome ?? 'Negociação'}
                          </Link>{' '}
                          · {formatarDataHoraCompleta(e.eventTime)}
                          {e.tentativas > 1 ? ` · ${e.tentativas} tentativas` : ''}
                          {e.ultimoErro ? ` · ${e.ultimoErro}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Selo tom={st.tom} className="whitespace-normal">{st.rotulo}</Selo>
                        {e.situacao === 'rejeitado' && (
                          <form action={reprocessarMetaAdsAction}>
                            <input type="hidden" name="evento" value={e.id} />
                            <button type="submit" className={botaoCompactoClass}>
                              Tentar de novo
                            </button>
                          </form>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Secao>
        </>
      )}
    </div>
  )
}
