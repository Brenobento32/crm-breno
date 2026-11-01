'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import { PontoEtapa } from '@/components/ui/ponto-etapa'
import { obterDetalhesLeadAction, obterHistoricoNegociacaoAction, obterRespostasLeadAction } from '@/lib/actions/funil'
import type { AtribuicaoCampanha, CardFunil } from '@/lib/dal/funil'
import type { DetalhesLeadNegociacao, RespostaLead } from '@/lib/dal/negociacoes'
import { formatarTelefone } from '@/lib/utils/documentos'
import type { EtapaKanban } from '@/lib/utils/etapas'
import { formatarMoeda } from '@/lib/utils/formatacao'
import { formatarDuracaoHistorico, montarHistorico, type LinhaHistoricoBruta } from '@/lib/utils/historico'
import { rotuloDaOrigem } from '@/lib/validations/funil'
import { ROTULO_TEMPERATURA } from '@/lib/validations/negociacao'
import { botaoCompactoClass } from '@/components/ui/estilos'

type Props = {
  card: CardFunil
  etapas: EtapaKanban[]
  whatsappHabilitado: boolean
  onFechar: () => void
  onEditar: (card: CardFunil) => void
  onMover: (id: string, etapaId: string) => void
  onAbrirConversa: (card: CardFunil) => void
  onAbrirFicha: (card: CardFunil) => void
  onDesqualificar: (card: CardFunil) => void
}

/**
 * Painel lateral do card — abre sem sair de `/funil` (mesmo padrão de
 * `Modal`: `<dialog>` nativo, foco preso, Esc fecha). "Tempo parado na
 * etapa" vem de `historico_etapas` (via `montarHistorico`, a mesma lógica já
 * usada na tela de edição da negociação), buscado ao abrir — não existe
 * ainda no `CardFunil` que o Kanban já tem em mãos. Qualificação
 * (`respostas_lead`) e os poucos campos do lead que `CardFunil` não traz
 * (e-mail/Instagram do cliente, valor da proposta) vêm das mesmas chamadas,
 * em paralelo.
 */
export function DrawerNegociacao({
  card,
  etapas,
  whatsappHabilitado,
  onFechar,
  onEditar,
  onMover,
  onAbrirConversa,
  onAbrirFicha,
  onDesqualificar,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [historico, setHistorico] = useState<LinhaHistoricoBruta[] | null>(null)
  const [respostas, setRespostas] = useState<RespostaLead[] | null>(null)
  const [detalhes, setDetalhes] = useState<DetalhesLeadNegociacao | null>(null)
  // Qualificação começa recolhida (formulários longos empurravam a negociação e as ações para baixo).
  const [qualificacaoAberta, setQualificacaoAberta] = useState(false)
  const [carregando, startTransition] = useTransition()

  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    // O drawer desmonta e remonta a cada card (troca via `{drawer && <DrawerNegociacao .../>}`
    // no Kanban), então os estados já nascem `null` — sem precisar resetar aqui.
    startTransition(async () => {
      const [h, r, d] = await Promise.all([
        obterHistoricoNegociacaoAction(card.id),
        obterRespostasLeadAction(card.id),
        obterDetalhesLeadAction(card.id),
      ])
      setHistorico(h)
      setRespostas(r)
      setDetalhes(d)
    })
  }, [card.id])

  const etapa = etapas.find((e) => e.id === card.etapaId)
  // A etapa atual é sempre a última entrada (saida === null); tempo parado é a duração dela até agora.
  const etapaAtualHistorico = historico ? montarHistorico(historico).at(-1) : undefined

  return (
    <dialog
      ref={ref}
      aria-labelledby="drawer-titulo"
      onCancel={(e) => {
        e.preventDefault()
        onFechar()
      }}
      className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-sm border-l border-premium-borda bg-premium-card p-0 text-premium-texto shadow-premium-alta backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-premium-borda p-4">
          <div className="min-w-0">
            {card.clienteEmpresa && (
              <p className="truncate text-base font-semibold" title={card.clienteEmpresa}>
                {card.clienteEmpresa}
              </p>
            )}
            <p
              id="drawer-titulo"
              className={`truncate ${card.clienteEmpresa ? 'text-sm text-zinc-500' : 'text-base font-semibold'}`}
              title={card.clienteNome}
            >
              {card.clienteNome}
            </p>
          </div>
          <button
            type="button"
            onClick={onFechar}
            aria-label="Fechar painel"
            className="shrink-0 rounded-md p-1.5 text-premium-mudo transition hover:bg-premium-bg hover:text-premium-texto"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
              <path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6Z" />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {/* LEAD — nome/empresa já estão no header acima, sem repetir aqui (item 3: não duplicar). */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-premium-mudo">Lead</h3>
            <dl className="space-y-3 text-sm">
              {detalhes?.clienteInstagram && <Campo rotulo="Instagram" valor={detalhes.clienteInstagram} />}
              {card.clienteTelefone && <Campo rotulo="WhatsApp" valor={formatarTelefone(card.clienteTelefone)} />}
              {detalhes?.clienteEmail && <Campo rotulo="E-mail" valor={detalhes.clienteEmail} />}
              <Campo rotulo="Nicho" valor={card.nichoNome ?? 'Outros'} />
              <Campo rotulo="Origem" valor={rotuloDaOrigem(card.origem, card.atribuicao)} />
              <Campo rotulo="Responsável" valor={card.responsavel ?? '—'} />
            </dl>
          </section>

          <SecaoCampanha atribuicao={card.atribuicao} />

          {respostas !== null && respostas.length > 0 && (
            <section className="space-y-3 border-t border-premium-borda pt-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-premium-mudo">
                  Qualificação <span className="font-normal normal-case tracking-normal">({respostas.length === 1 ? '1 resposta' : `${respostas.length} respostas`})</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setQualificacaoAberta((v) => !v)}
                  aria-expanded={qualificacaoAberta}
                  aria-controls="drawer-qualificacao"
                  className={botaoCompactoClass}
                >
                  {qualificacaoAberta ? 'Recolher qualificação' : 'Expandir qualificação'}
                </button>
              </div>
              {/* Recolher só esconde: as respostas continuam carregadas (nada é perdido nem refeito). */}
              <dl id="drawer-qualificacao" hidden={!qualificacaoAberta} className="space-y-3 text-sm">
                {respostas.map((r, i) => (
                  <div key={`${r.pergunta}-${i}`}>
                    {r.envio && r.envio !== respostas[i - 1]?.envio && (
                      <p className="mb-1.5 border-b border-premium-borda-suave pb-1 text-xs font-medium text-premium-secundario">{r.envio}</p>
                    )}
                    <dt className="text-premium-mudo">{r.pergunta}</dt>
                    <dd className="mt-0.5 font-medium text-premium-texto">{r.resposta}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section className="space-y-3 border-t border-premium-borda pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-premium-mudo">Negociação</h3>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-premium-mudo">Etapa atual</dt>
                <dd className="mt-1 flex items-center gap-2 font-medium">
                  {etapa && <PontoEtapa cor={etapa.cor} />}
                  {etapa?.nome ?? '—'}
                </dd>
              </div>

              <div>
                <dt className="text-premium-mudo">Tempo parado</dt>
                <dd className="mt-1">
                  {carregando
                    ? '…'
                    : etapaAtualHistorico
                      ? formatarDuracaoHistorico(etapaAtualHistorico.duracaoMs)
                      : '—'}
                </dd>
              </div>

              {detalhes && detalhes.valorProposta !== null && (
                <Campo rotulo="Valor da proposta" valor={formatarMoeda(detalhes.valorProposta)} />
              )}

              {card.temperatura && <Campo rotulo="Temperatura" valor={ROTULO_TEMPERATURA[card.temperatura]} />}

              <Campo rotulo="Responsável" valor={card.responsavel ?? '—'} />
            </dl>
          </section>

          <section className="space-y-2 border-t border-premium-borda pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-premium-mudo">Ações rápidas</h3>

            <button
              type="button"
              onClick={() => {
                onFechar()
                onEditar(card)
              }}
              className="w-full rounded-md border border-premium-borda px-3 py-2 text-left text-sm transition hover:bg-premium-bg"
            >
              Editar negociação
            </button>

            <button
              type="button"
              onClick={() => onAbrirFicha(card)}
              className="block w-full rounded-md border border-premium-borda px-3 py-2 text-left text-sm transition hover:bg-premium-bg"
            >
              Ver ficha do cliente
            </button>

            <button
              type="button"
              // Não fecha o drawer: ModalDesqualificar abre por cima (mesma
              // pilha nativa do PainelConversa) — fechar/concluir o modal
              // revela o drawer de novo sozinho.
              onClick={() => onDesqualificar(card)}
              className="block w-full rounded-md border border-red-300 px-3 py-2 text-left text-sm text-red-700 transition hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              Desqualificar lead
            </button>

            {etapas.length > 1 && (
              <div className="pt-1">
                <p className="mb-1.5 text-xs text-premium-mudo">Mover para</p>
                <div className="flex flex-wrap gap-1.5">
                  {etapas
                    .filter((e) => e.id !== card.etapaId)
                    .map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => {
                          onMover(card.id, e.id)
                          onFechar()
                        }}
                        className={botaoCompactoClass}
                      >
                        <PontoEtapa cor={e.cor} />
                        {e.nome}
                      </button>
                    ))}
                </div>
              </div>
            )}
          </section>

          {whatsappHabilitado && (
            <section className="space-y-2 border-t border-premium-borda pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-premium-mudo">WhatsApp</h3>

              <button
                type="button"
                // Não fecha o drawer: o PainelConversa abre por cima (outro
                // <dialog> modal, pilha nativa do navegador) e, ao ser
                // fechado, revela este de volta sozinho, com o mesmo
                // estado/contexto — sem recriar nada.
                onClick={() => onAbrirConversa(card)}
                className="w-full rounded-md border border-premium-borda px-3 py-2 text-left text-sm transition hover:bg-premium-bg"
              >
                Abrir conversa
              </button>
            </section>
          )}
        </div>
      </div>
    </dialog>
  )
}

/** Par rótulo/valor padrão do painel — rótulo discreto, valor com destaque de leitura. */
function Campo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-premium-mudo">{rotulo}</dt>
      <dd className="mt-0.5 font-medium text-premium-texto">{valor}</dd>
    </div>
  )
}

/**
 * Campanha/atribuição (Meta Ads/UTM/Respondi) — só os campos preenchidos,
 * nunca "undefined"/"null"/vazio. IDs técnicos (respondent/form/gclid/fbclid)
 * em aparência secundária, com botão de copiar; nunca o `formulario_id`
 * (UUID interno do CRM, sem utilidade comercial). Não confunde utm_source
 * (origem do tráfego) com utm_campaign (campanha) nem com respondent_id
 * (identificador do respondente) — ver `ingestao-lead/index.ts`.
 */
function SecaoCampanha({ atribuicao }: { atribuicao: AtribuicaoCampanha | null }) {
  if (!atribuicao) return null

  const campos: { rotulo: string; valor: string | null | undefined }[] = [
    { rotulo: 'Campanha', valor: atribuicao.utm_campaign },
    { rotulo: 'Origem / Source', valor: atribuicao.utm_source },
    { rotulo: 'Medium', valor: atribuicao.utm_medium },
    { rotulo: 'Term', valor: atribuicao.utm_term },
    { rotulo: 'Content', valor: atribuicao.utm_content },
  ]
  const camposPreenchidos = campos.filter(
    (c): c is { rotulo: string; valor: string } => Boolean(c.valor),
  )

  const idsCopiaveis: { rotulo: string; valor: string | null | undefined }[] = [
    { rotulo: 'GCLID', valor: atribuicao.gclid },
    { rotulo: 'FBCLID', valor: atribuicao.fbclid },
    { rotulo: 'Respondent ID', valor: atribuicao.respondent_id },
    { rotulo: 'Form ID', valor: atribuicao.form_id },
  ]
  const idsPreenchidos = idsCopiaveis.filter(
    (c): c is { rotulo: string; valor: string } => Boolean(c.valor),
  )

  const formName = atribuicao.form_name

  if (camposPreenchidos.length === 0 && idsPreenchidos.length === 0 && !formName) return null

  return (
    <section className="space-y-3 border-t border-premium-borda pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-premium-mudo">Campanha / Atribuição</h3>

      {camposPreenchidos.length > 0 && (
        <dl className="space-y-3 text-sm">
          {camposPreenchidos.map((c) => (
            <Campo key={c.rotulo} rotulo={c.rotulo} valor={c.valor} />
          ))}
        </dl>
      )}

      {(idsPreenchidos.length > 0 || formName) && (
        <dl className="space-y-2 border-t border-zinc-100 pt-3 dark:border-premium-acento">
          {formName && (
            <div>
              <dt className="text-xs text-premium-mudo">Form Name</dt>
              <dd className="mt-0.5 truncate text-xs text-premium-mudo" title={formName}>
                {formName}
              </dd>
            </div>
          )}
          {idsPreenchidos.map((c) => (
            <div key={c.rotulo}>
              <dt className="text-xs text-premium-mudo">{c.rotulo}</dt>
              <dd className="mt-0.5 flex items-center gap-1 font-mono text-xs text-premium-mudo">
                <span className="min-w-0 truncate" title={c.valor}>
                  {c.valor}
                </span>
                <BotaoCopiar valor={c.valor} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

/** Copia um ID técnico pro clipboard; feedback visual breve, sem alterar mais nada na tela. */
function BotaoCopiar({ valor }: { valor: string }) {
  const [copiado, setCopiado] = useState(false)

  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(valor)
          setCopiado(true)
          setTimeout(() => setCopiado(false), 1500)
        } catch {
          // Clipboard indisponível (contexto não seguro, permissão negada) — sem copiar, sem crash.
        }
      }}
      aria-label="Copiar"
      title={copiado ? 'Copiado!' : 'Copiar'}
      className="shrink-0 rounded p-0.5 text-premium-mudo transition hover:bg-premium-bg hover:text-premium-texto"
    >
      {copiado ? (
        <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
          <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
          <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m0 16H8V7h11z" />
        </svg>
      )}
    </button>
  )
}
