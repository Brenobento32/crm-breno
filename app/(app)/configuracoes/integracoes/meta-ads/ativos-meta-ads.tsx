'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

import { Aviso } from '@/components/ui/aviso'
import { ajudaClass, botaoPrimarioClass, botaoSecundarioClass, labelClass } from '@/components/ui/estilos'
import {
  ativosMetaAdsAction,
  concluirMetaAdsLoginAction,
  configMetaAdsAction,
  selecionarAtivosMetaAdsAction,
  type AtivosMetaAds,
  type ResultadoSelecaoMetaAds,
} from '@/lib/actions/integracoes-oficiais'
import { conectarMetaAdsLogin } from '@/lib/integracoes/janelas-provedores'

import { SeletorDestino, type Destino, type OpcoesDestino } from '../_components/seletor-destino'

type Props = {
  conectada: boolean
  opcoes: OpcoesDestino
  responsaveis: { id: string; nome: string }[]
  /** Já escolhidos (para marcar na lista). */
  atuais: { datasetId: string | null; paginas: { pageId: string; funilId: string; etapaId: string; responsavelId: string }[]; contas: string[] }
}

/**
 * Meta Ads pelo Login do Facebook para Empresas: a empresa autoriza, no PRÓPRIO
 * portfólio, as Páginas, contas de anúncios e datasets; aqui escolhe o que o AVANTE
 * usa. Só aparecem os ativos que a Meta liberou para esta autorização; o servidor
 * confere de novo antes de salvar. Nenhum token passa pela tela.
 */
export function AtivosMetaAds({ conectada, opcoes, responsaveis, atuais }: Props) {
  const router = useRouter()
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof configMetaAdsAction>> | null>(null)
  const [ativos, setAtivos] = useState<AtivosMetaAds | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [resultado, setResultado] = useState<ResultadoSelecaoMetaAds | null>(null)
  const [pendente, iniciar] = useTransition()

  const [dataset, setDataset] = useState<string | null>(atuais.datasetId)
  const [paginas, setPaginas] = useState<Map<string, Destino>>(
    () => new Map(atuais.paginas.map((p) => [p.pageId, { funilId: p.funilId, etapaId: p.etapaId, responsavelId: p.responsavelId }])),
  )
  const [contas, setContas] = useState<Set<string>>(() => new Set(atuais.contas))

  // Configuração carregada antes do clique: a janela da Meta precisa abrir no próprio clique.
  useEffect(() => {
    configMetaAdsAction().then(setCfg, () => setCfg({ ok: false, codigo: 'indisponivel', mensagem: 'O serviço de integrações não respondeu.' }))
  }, [])

  const conectar = () =>
    iniciar(async () => {
      setErro(null)
      setResultado(null)
      try {
        if (!cfg) return
        if (!cfg.ok) return setErro(cfg.mensagem)
        if (!cfg.configIdLogin) return setErro('O login do Meta Ads ainda não foi configurado na plataforma. Fale com o suporte da Rio X7.')
        const code = await conectarMetaAdsLogin({ appId: cfg.appId, configIdLogin: cfg.configIdLogin, simulado: cfg.simulado, urlLogin: cfg.urlLogin })
        if (!code) return setErro('Autorização na Meta cancelada. Nada foi conectado.')
        const r = await concluirMetaAdsLoginAction(code)
        if (!r.ok) return setErro(r.mensagem)
        setAtivos(r)
        router.refresh()
      } catch (e) {
        setErro(e instanceof Error ? e.message : 'Não foi possível abrir a janela da Meta.')
      }
    })

  const carregar = () =>
    iniciar(async () => {
      setErro(null)
      const r = await ativosMetaAdsAction()
      if (!r.ok) return setErro(r.mensagem)
      setAtivos(r)
    })

  const alternarPagina = (id: string, ligada: boolean) =>
    setPaginas((m) => {
      const n = new Map(m)
      if (ligada) n.set(id, n.get(id) ?? { funilId: '', etapaId: '', responsavelId: '' })
      else n.delete(id)
      return n
    })

  const paginasProntas = [...paginas.values()].every((d) => d.funilId && d.etapaId && d.responsavelId)

  const salvar = () =>
    iniciar(async () => {
      setErro(null)
      const r = await selecionarAtivosMetaAdsAction({
        datasetId: dataset,
        paginas: [...paginas.entries()].map(([id, d]) => ({ id, funil: d.funilId, etapa: d.etapaId, responsavel: d.responsavelId })),
        contas: [...contas],
      })
      if (!r.ok) return setErro(r.mensagem)
      setResultado(r)
      router.refresh()
    })

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={botaoPrimarioClass} disabled={pendente || !cfg} onClick={conectar}>
          {pendente && !ativos ? 'Aguardando a Meta…' : conectada ? 'Reautorizar na Meta' : 'Conectar com a Meta (Login para Empresas)'}
        </button>
        {conectada && !ativos && (
          <button type="button" className={botaoSecundarioClass} disabled={pendente} onClick={carregar}>
            Escolher Páginas, contas e dataset
          </button>
        )}
      </div>
      <p className={ajudaClass}>
        A autorização é feita no portfólio da sua empresa na Meta, mesmo que ele não seja da Rio X7. Nenhum ativo é transferido e você pode
        revogar quando quiser em Configurações do negócio › Integrações › Apps conectados.
      </p>
      {erro && <Aviso tom="erro">{erro}</Aviso>}

      {ativos && (
        <div className="space-y-5 rounded-xl border border-premium-borda p-4">
          <fieldset className="space-y-2">
            <legend className={labelClass}>Dataset para as Conversões do CRM</legend>
            {ativos.datasets.length === 0 ? (
              <p className={ajudaClass}>Nenhum dataset liberado nesta autorização.</p>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  <input type="radio" name="dataset" checked={dataset === null} onChange={() => setDataset(null)} /> Não enviar conversões agora
                </label>
                {ativos.datasets.map((d) => (
                  <label key={d.id} className="flex items-center gap-2">
                    <input type="radio" name="dataset" checked={dataset === d.id} onChange={() => setDataset(d.id)} />
                    {d.nome ?? 'Dataset'} <span className="text-premium-secundario">({d.id})</span>
                  </label>
                ))}
              </>
            )}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className={labelClass}>Páginas: leads dos formulários do Facebook e do Instagram</legend>
            {ativos.paginas.length === 0 && <p className={ajudaClass}>Nenhuma Página liberada nesta autorização.</p>}
            {ativos.paginas.map((p) => {
              const destino = paginas.get(p.id)
              return (
                <div key={p.id} className="space-y-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={Boolean(destino)} onChange={(e) => alternarPagina(p.id, e.target.checked)} />
                    {p.nome ?? 'Página'} <span className="text-premium-secundario">({p.id})</span>
                  </label>
                  {destino && (
                    <SeletorDestino
                      compacto
                      opcoes={opcoes}
                      responsaveis={responsaveis}
                      inicial={destino}
                      onChange={(d) => setPaginas((m) => new Map(m).set(p.id, d))}
                    />
                  )}
                </div>
              )
            })}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className={labelClass}>Contas de anúncios para o painel de campanhas</legend>
            {ativos.contas.length === 0 && <p className={ajudaClass}>Nenhuma conta de anúncios liberada nesta autorização.</p>}
            {ativos.contas.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={contas.has(c.id)}
                  onChange={(e) =>
                    setContas((s) => {
                      const n = new Set(s)
                      if (e.target.checked) n.add(c.id)
                      else n.delete(c.id)
                      return n
                    })
                  }
                />
                {c.nome ?? 'Conta'} <span className="text-premium-secundario">(act_{c.id}{c.moeda ? ` · ${c.moeda}` : ''}{c.ativa ? '' : ' · inativa'})</span>
              </label>
            ))}
            <p className={ajudaClass}>O AVANTE só lê investimento, impressões, cliques e leads. Nunca cria, edita ou pausa campanhas.</p>
          </fieldset>

          <button type="button" className={botaoPrimarioClass} disabled={pendente || !paginasProntas} onClick={salvar}>
            {pendente ? 'Salvando…' : 'Salvar escolhas'}
          </button>
          {!paginasProntas && <p className={ajudaClass}>Escolha funil, etapa e responsável de cada Página marcada.</p>}
        </div>
      )}

      {resultado && (
        <Aviso tom={resultado.paginas.some((p) => p.situacao === 'erro') ? 'alerta' : 'sucesso'} titulo="Escolhas salvas">
          <ul className="list-disc pl-5">
            <li>{resultado.dataset ? `Dataset ${resultado.dataset} ligado às Conversões do CRM (ative o envio abaixo).` : 'Conversões do CRM sem alteração.'}</li>
            {resultado.paginas.map((p) => (
              <li key={p.id}>
                Página {p.id}: {p.situacao === 'conectada' ? 'recebendo leads' : `não conectada — ${p.mensagem ?? 'erro'}`}
              </li>
            ))}
            {resultado.contas !== null && <li>{resultado.contas} conta(s) de anúncios no painel.</li>}
          </ul>
        </Aviso>
      )}
    </div>
  )
}
