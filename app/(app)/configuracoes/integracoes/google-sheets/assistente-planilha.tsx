'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'

import { Aviso } from '@/components/ui/aviso'
import { ajudaClass, botaoPrimarioClass, inputClass, labelClass } from '@/components/ui/estilos'
import { Secao } from '@/components/ui/secao'
import {
  acessoSeletorAction,
  conectarPlanilhaAction,
  iniciarGoogleAction,
  lerColunasAction,
  lerPlanilhaAction,
  type Aba,
  type ResumoSincronizacao,
} from '@/lib/actions/integracoes-oficiais'
import { escolherPlanilhaNoGoogle } from '@/lib/integracoes/janelas-provedores'
import { colunaNaoEIdDoLead } from '@/supabase/functions/_shared/planilha-colunas'

import { SeletorDestino, type Destino, type OpcoesDestino } from '../_components/seletor-destino'

type Campo = 'nome' | 'telefone' | 'email' | 'empresa' | 'meta_lead_id'
const CAMPOS: { campo: Campo; rotulo: string }[] = [
  { campo: 'nome', rotulo: 'Nome' },
  { campo: 'telefone', rotulo: 'Telefone / WhatsApp' },
  { campo: 'email', rotulo: 'E-mail' },
  { campo: 'empresa', rotulo: 'Empresa' },
  { campo: 'meta_lead_id', rotulo: 'ID do lead Meta (Lead Ads) — opcional' },
]

type Planilha = { planilhaId: string; titulo: string; abas: Aba[] }
type Colunas = { cabecalho: string[]; amostra: string[][] }

/** Link guardado só nesta aba enquanto o Google autoriza a conta (volta e continua sozinho). */
const LINK_PENDENTE = 'avante:sheets-link'

/**
 * COLAR LINK → CONECTAR → AUTORIZAR GOOGLE → PRONTO.
 * O AVANTE detecta aba, cabeçalho e colunas sozinho e usa o destino padrão
 * (a última planilha conectada, ou o funil principal); ajustes ficam em
 * "Opções avançadas". Se o Google exigir, a planilha é liberada no seletor
 * oficial (só aquele arquivo). Nenhum token fica no navegador.
 */
export function AssistentePlanilha({
  contas,
  contaInicial,
  reconectar,
  opcoes,
  responsaveis,
  destinoPadrao,
}: {
  contas: { id: string; email: string; comErro: boolean }[]
  contaInicial: string | null
  reconectar: boolean
  opcoes: OpcoesDestino
  responsaveis: { id: string; nome: string }[]
  destinoPadrao: Destino
}) {
  const [conta, setConta] = useState(contaInicial && contas.some((c) => c.id === contaInicial) ? contaInicial : (contas[0]?.id ?? ''))
  const [link, setLink] = useState('')
  const [planilha, setPlanilha] = useState<Planilha | null>(null)
  const [precisaAutorizar, setPrecisaAutorizar] = useState<string | null>(null)
  const [abaId, setAbaId] = useState<number | null>(null)
  const [linhaCabecalho, setLinhaCabecalho] = useState(1)
  const [colunas, setColunas] = useState<Colunas | null>(null)
  const [mapa, setMapa] = useState<Partial<Record<Campo, string>>>({})
  const [chave, setChave] = useState<string>('')
  const [importar, setImportar] = useState(true)
  const [nome, setNome] = useState('')
  const [destino, setDestino] = useState<Destino>(destinoPadrao)
  const [erro, setErro] = useState<string | null>(null)
  const [feito, setFeito] = useState<ResumoSincronizacao | null>(null)
  const [pendente, iniciar] = useTransition()
  const retomou = useRef(false)

  const aba = planilha?.abas.find((a) => a.id === abaId) ?? null
  const passo = (fn: () => Promise<void>) =>
    iniciar(async () => {
      setErro(null)
      try {
        await fn()
      } catch (e) {
        setErro(e instanceof Error ? e.message : 'Algo deu errado. Tente de novo.')
      }
    })

  /** Colunas da aba (cabeçalho, amostra e sugestão de mapeamento) — chamada logo depois de achar a planilha. */
  async function carregarColunas(p: Planilha, abaEscolhida: Aba | null, linha: number) {
    if (!abaEscolhida) return
    const r = await lerColunasAction(conta, p.planilhaId, abaEscolhida.titulo, linha)
    if (!r.ok) return setErro(r.mensagem)
    setColunas({ cabecalho: r.cabecalho, amostra: r.amostra })
    setMapa(r.mapeamento as Partial<Record<Campo, string>>)
    setChave(r.chave ?? '')
  }

  async function abrirPlanilha(alvo: string) {
    setPlanilha(null)
    setColunas(null)
    const r = await lerPlanilhaAction(conta, alvo)
    if (!r.ok) {
      if (r.codigo === 'autorizar_arquivo') return setPrecisaAutorizar(r.planilhaId ?? null)
      return setErro(r.mensagem)
    }
    setPrecisaAutorizar(null)
    const p = { planilhaId: r.planilhaId, titulo: r.titulo, abas: r.abas }
    const sugerida = r.abaSugerida !== null && r.abas.some((a) => a.id === r.abaSugerida) ? r.abaSugerida : (r.abas[0]?.id ?? null)
    setPlanilha(p)
    setAbaId(sugerida)
    setNome((n) => n || r.titulo.slice(0, 80))
    await carregarColunas(p, r.abas.find((a) => a.id === sugerida) ?? null, linhaCabecalho)
  }

  const conectarConta = () =>
    passo(async () => {
      try {
        if (link.trim()) sessionStorage.setItem(LINK_PENDENTE, link.trim())
      } catch {}
      const r = await iniciarGoogleAction()
      if (!r.ok) return setErro(r.mensagem)
      window.location.assign(r.url)
    })

  // Voltou da autorização do Google com um link colado antes: continua sozinho.
  useEffect(() => {
    if (retomou.current || !conta) return
    retomou.current = true
    let guardado: string | null = null
    try {
      guardado = sessionStorage.getItem(LINK_PENDENTE)
      sessionStorage.removeItem(LINK_PENDENTE)
    } catch {}
    if (guardado) {
      const alvo = guardado
      passo(async () => {
        setLink(alvo)
        await abrirPlanilha(alvo)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conta])

  const conectarLink = () => (conta ? passo(() => abrirPlanilha(link)) : conectarConta())

  const autorizarNoGoogle = () =>
    passo(async () => {
      const acesso = await acessoSeletorAction(conta)
      if (!acesso.ok) return setErro(acesso.mensagem)
      const escolhida = await escolherPlanilhaNoGoogle(acesso, precisaAutorizar)
      if (!escolhida) return setErro('Nenhuma planilha escolhida no Google.')
      setLink(`https://docs.google.com/spreadsheets/d/${escolhida}/edit`)
      await abrirPlanilha(escolhida)
    })

  const conectar = () =>
    passo(async () => {
      if (!planilha || !aba) return
      const r = await conectarPlanilhaAction({
        contaId: conta,
        planilhaId: planilha.planilhaId,
        planilhaNome: planilha.titulo,
        abaId: aba.id,
        abaNome: aba.titulo,
        linhaCabecalho,
        mapeamento: mapa,
        colunaChave: chave || null,
        importarExistentes: importar,
        nome,
        funilId: destino.funilId,
        etapaId: destino.etapaId,
        responsavelId: destino.responsavelId,
      })
      if (!r.ok) return setErro(r.mensagem)
      setFeito(r.resumo ?? { ok: true, emAndamento: true })
    })

  if (feito) {
    return (
      <Secao titulo="Pronto: planilha conectada">
        <div className="space-y-3 pb-5 text-sm">
          {feito.ok ? (
            <Aviso tom="sucesso">
              Primeira sincronização concluída: {feito.importadas ?? 0} oportunidade(s) criada(s)
              {feito.novas_oportunidades ? ` (${feito.novas_oportunidades} para clientes que já existiam)` : ''}, {feito.existentes ?? 0} com negociação aberta
              reaproveitada
              {feito.ignoradas_inicio ? `, ${feito.ignoradas_inicio} linha(s) antigas ignoradas (só entram as novas)` : ''}
              {feito.invalidas ? `, ${feito.invalidas} sem telefone/e-mail válido` : ''}.
            </Aviso>
          ) : (
            <Aviso tom="alerta">A conexão foi salva, mas a primeira leitura falhou: {feito.erro}. O AVANTE tenta de novo automaticamente.</Aviso>
          )}
          <p className="text-premium-secundario">
            A partir de agora, linhas novas entram quando o Google avisar a alteração da planilha (normalmente em segundos ou poucos minutos) e, por garantia, a
            planilha também é conferida periodicamente. Todas as outras colunas ficam guardadas como perguntas e respostas no lead.
          </p>
          <Link href="/configuracoes/integracoes?abrir=google_sheets" className={botaoPrimarioClass}>
            Ver na Central de Integrações
          </Link>
        </div>
      </Secao>
    )
  }

  const telefoneOuEmail = Boolean(mapa.telefone || mapa.email)
  const pronto = Boolean(planilha && aba && colunas && telefoneOuEmail && destino.funilId && destino.etapaId && destino.responsavelId && nome.trim().length >= 2)
  const usadas = new Set(Object.values(mapa).filter(Boolean))
  const outras = colunas ? colunas.cabecalho.filter((h, i) => !(h && usadas.has(h) && colunas.cabecalho.indexOf(h) === i)).length : 0
  const funil = opcoes.funis.find((f) => f.id === destino.funilId)
  const etapa = funil?.etapas.find((e) => e.id === destino.etapaId)
  const responsavel = responsaveis.find((r) => r.id === destino.responsavelId)

  return (
    <div className="space-y-5">
      {erro && <Aviso tom="erro">{erro}</Aviso>}
      {reconectar && <Aviso tom="alerta">Para reconectar, entre de novo com a mesma conta Google: as planilhas dela voltam a sincronizar.</Aviso>}

      <Secao titulo="1. Cole o link da planilha" descricao="Pode ser a planilha de respostas de um Google Forms. O AVANTE só lê: nunca escreve na planilha.">
        <div className="space-y-3 pb-5">
          <label className="block text-sm">
            <span className="sr-only">Link da planilha</span>
            <input
              className={inputClass}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…/edit"
              inputMode="url"
              aria-label="Link da planilha"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={botaoPrimarioClass} disabled={pendente || !link.trim()} onClick={conectarLink}>
              {pendente ? 'Conectando…' : conta ? 'Conectar' : 'Conectar com o Google'}
            </button>
            {conta && contas.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-premium-mudo">
                Conta:
                <select className={`${inputClass} w-auto py-1 text-xs`} value={conta} onChange={(e) => setConta(e.target.value)} aria-label="Conta Google">
                  {contas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.email}
                      {c.comErro ? ' (reconectar)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {conta && (
              <button type="button" className="text-xs text-premium-acento hover:underline" disabled={pendente} onClick={conectarConta}>
                Usar outra conta Google
              </button>
            )}
          </div>
          {!conta && (
            <p className={ajudaClass}>
              O Google vai pedir só o seu e-mail e o acesso aos arquivos que você escolher. O AVANTE não vê o resto do seu Google Drive.
            </p>
          )}
        </div>
      </Secao>

      {precisaAutorizar && (
        <Secao titulo="2. Autorize esta planilha no Google" descricao="Por segurança, o Google só libera para o AVANTE o arquivo que você escolher. É uma vez só.">
          <div className="space-y-3 pb-5 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-premium-secundario">
              <li>Clique em &quot;Autorizar no Google&quot;: abre a janela oficial do Google Drive.</li>
              <li>Selecione a mesma planilha do link (ela já aparece em destaque quando o Google permite).</li>
              <li>Confirme: o AVANTE continua sozinho.</li>
            </ol>
            <button type="button" className={botaoPrimarioClass} disabled={pendente} onClick={autorizarNoGoogle}>
              {pendente ? 'Aguardando o Google…' : 'Autorizar no Google'}
            </button>
          </div>
        </Secao>
      )}

      {planilha && colunas && (
        <Secao titulo={`${precisaAutorizar ? '3' : '2'}. Confira e conecte`} descricao={`${planilha.titulo}${aba ? ` · aba ${aba.titulo}` : ''}`}>
          <div className="space-y-4 pb-5 text-sm">
            <ul className="space-y-1">
              {CAMPOS.slice(0, 3).map(({ campo, rotulo }) => (
                <li key={campo} className={mapa[campo] ? 'text-premium-texto' : 'text-premium-mudo'}>
                  {mapa[campo] ? '✓' : '•'} {rotulo}: {mapa[campo] ? <strong>{mapa[campo]}</strong> : 'não encontrado'}
                </li>
              ))}
              <li className="text-premium-texto">✓ {outras} outra(s) coluna(s) guardada(s) como perguntas e respostas no lead</li>
              <li className="text-premium-texto">
                ✓ Destino: <strong>{funil?.nome ?? '—'}</strong> › {etapa?.nome ?? '—'} · responsável {responsavel?.nome ?? <em>escolha em Opções avançadas</em>}
              </li>
            </ul>
            {!telefoneOuEmail && <Aviso tom="alerta">Não encontramos a coluna de telefone nem de e-mail. Escolha uma delas em Opções avançadas.</Aviso>}

            <details className="rounded-lg border border-premium-borda-suave p-3" open={!telefoneOuEmail || !destino.responsavelId}>
              <summary className="cursor-pointer font-medium text-premium-acento">Opções avançadas</summary>
              <div className="mt-3 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={labelClass}>Aba</span>
                    <select
                      className={inputClass}
                      value={abaId ?? ''}
                      onChange={(e) => {
                        const id = Number(e.target.value)
                        setAbaId(id)
                        passo(() => carregarColunas(planilha, planilha.abas.find((a) => a.id === id) ?? null, linhaCabecalho))
                      }}
                    >
                      {planilha.abas.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.titulo}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className={labelClass}>Linha do cabeçalho</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      className={inputClass}
                      value={linhaCabecalho}
                      onChange={(e) => {
                        const n = Math.min(50, Math.max(1, Number(e.target.value) || 1))
                        setLinhaCabecalho(n)
                        passo(() => carregarColunas(planilha, aba, n))
                      }}
                    />
                  </label>
                  {CAMPOS.map(({ campo, rotulo }) => (
                    <label key={campo} className="block">
                      <span className={labelClass}>{rotulo}</span>
                      <select className={inputClass} value={mapa[campo] ?? ''} onChange={(e) => setMapa((m) => ({ ...m, [campo]: e.target.value || undefined }))}>
                        <option value="">— não usar —</option>
                        {colunas.cabecalho.filter(Boolean).map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label className="block sm:col-span-2">
                    <span className={labelClass}>Coluna identificadora (recomendada)</span>
                    <select className={inputClass} value={chave} onChange={(e) => setChave(e.target.value)}>
                      <option value="">— nenhuma: usar o próprio contato —</option>
                      {colunas.cabecalho.filter(Boolean).map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    <span className={ajudaClass}>
                      Um ID ou o carimbo de data/hora do formulário: garante que cada linha seja reconhecida mesmo depois de reordenar, inserir ou apagar linhas. Sem
                      ela, linhas com o mesmo contato contam como uma só (o cliente e a negociação aberta são reaproveitados, sem duplicar).
                    </span>
                  </label>
                </div>
                {colunaNaoEIdDoLead(mapa.meta_lead_id) ? (
                  <Aviso tom="erro">
                    A coluna &quot;{mapa.meta_lead_id}&quot; é o ID do anúncio, do conjunto, da campanha ou do formulário, não do lead. No export dos Lead Ads, o ID do
                    lead é a coluna &quot;id&quot;.
                  </Aviso>
                ) : mapa.meta_lead_id && (
                  <p className={ajudaClass}>
                    Use o ID do lead só se a planilha for alimentada pelos formulários nativos da Meta (Lead Ads): ele permite devolver as etapas do funil para a Meta.
                    Valores que não forem um ID válido são ignorados.
                  </p>
                )}
                <label className="block">
                  <span className={labelClass}>Nome da conexão</span>
                  <input className={inputClass} value={nome} maxLength={80} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Formulário do site" />
                </label>
                <SeletorDestino opcoes={opcoes} responsaveis={responsaveis} inicial={destino} onChange={setDestino} />
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={importar} onChange={(e) => setImportar(e.target.checked)} />
                  <span>
                    Importar também as linhas que já estão na planilha
                    <span className={`block ${ajudaClass}`}>Desmarcado: só as linhas novas, a partir de agora. Contatos que já são clientes não são duplicados.</span>
                  </span>
                </label>
                {colunas.amostra.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border border-premium-borda">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-premium-bg text-premium-mudo">
                        <tr>
                          {colunas.cabecalho.map((h, i) => (
                            <th key={i} className="px-2 py-1.5 font-medium whitespace-nowrap">
                              {h || `(coluna ${i + 1})`}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {colunas.amostra.map((l, i) => (
                          <tr key={i} className="border-t border-premium-borda-suave">
                            {colunas.cabecalho.map((_, j) => (
                              <td key={j} className="px-2 py-1.5 whitespace-nowrap">
                                {l[j] ?? ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </details>

            <button type="button" className={botaoPrimarioClass} disabled={pendente || !pronto} onClick={conectar}>
              {pendente ? 'Conectando…' : 'Pronto — conectar e sincronizar'}
            </button>
          </div>
        </Secao>
      )}
    </div>
  )
}
