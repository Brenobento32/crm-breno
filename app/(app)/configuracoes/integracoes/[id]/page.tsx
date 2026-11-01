import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { PageHeaderPremium } from '@/components/layout/page-header-premium'
import { Aviso, AvisoDaUrl } from '@/components/ui/aviso'
import { BotaoConfirmar } from '@/components/ui/botao-confirmar'
import { EstadoVazio } from '@/components/ui/estado-vazio'
import {
  botaoPerigoClass,
  botaoPrimarioClass,
  botaoSecundarioClass,
  cartaoClass,
  inputClass,
  labelClass,
  legendaClass,
  linhaClass,
  tabelaCaixaClass,
  tabelaClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/ui/estilos'
import { Selo } from '@/components/ui/selo'
import {
  revogarFonteAction,
  salvarFonteAction,
  segredoFonteAction,
  statusFonteAction,
  validarFonteAction,
} from '@/lib/actions/fontes-leads'
import { getUsuarioAtual } from '@/lib/dal/auth'
import { listarResponsaveis } from '@/lib/dal/clientes'
import { listarIntegracoesOficiais } from '@/lib/dal/integracoes-oficiais'
import { enderecosIntegracao, listarEventos, obterFonte, opcoesDeDestino, podeGerirFontes, type Fonte } from '@/lib/dal/fontes-leads'
import { serverEnv } from '@/lib/env/server'
import { itemDoTipo, situacaoDaFonte } from '@/lib/integracoes/catalogo'
import { formatarDataHoraCompleta } from '@/lib/utils/formatacao'

import { CamposFonte } from '../_components/campos-fonte'
import { GirarToken } from '../_components/token-uma-vez'

export const metadata: Metadata = {
  title: 'Fonte de leads',
}

type Props = {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function FontePage({ params, searchParams }: Props) {
  const eu = await getUsuarioAtual()
  if (eu.role !== 'gerente') notFound()
  const [{ id }, busca] = await Promise.all([params, searchParams])
  if (!UUID.test(id)) notFound()

  const fonte = await obterFonte(id)
  if (!fonte) notFound()
  // Conexão oficial (Google/Meta): gerenciada no painel próprio, nunca pelo formulário de token.
  if ((await listarIntegracoesOficiais()).some((o) => o.fonteId === fonte.id)) {
    redirect(fonte.tipo === 'whatsapp_cloud' ? '/configuracoes/integracoes?abrir=whatsapp_oficial' : '/configuracoes/integracoes?abrir=google_sheets')
  }
  const [eventos, podeGerir, opcoes, responsaveis] = await Promise.all([
    listarEventos(id),
    podeGerirFontes(),
    opcoesDeDestino(),
    listarResponsaveis(fonte.responsavelId),
  ])
  const item = itemDoTipo(fonte.tipo)
  const situacao = situacaoDaFonte(fonte)
  const ativa = fonte.status !== 'revogada'
  const secao = `${cartaoClass} space-y-3 p-5`

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeaderPremium
        titulo={fonte.nome}
        subtitulo={`${item.nome}${fonte.ultimoLeadEm ? ` · último lead ${formatarDataHoraCompleta(fonte.ultimoLeadEm)}` : ''}`}
        voltar={{ href: '/configuracoes/integracoes', rotulo: 'Integrações' }}
        acoes={<Selo tom={situacao.tom === 'ok' ? 'verde' : situacao.tom === 'espera' ? 'ambar' : 'neutro'}>{situacao.rotulo}</Selo>}
      />
      <AvisoDaUrl ok={busca.ok} erro={busca.erro} />
      {fonte.ultimoErro && ativa && (
        <Aviso tom="erro" titulo={`Último erro${fonte.ultimoErroEm ? ` (${formatarDataHoraCompleta(fonte.ultimoErroEm)})` : ''}`}>
          {fonte.ultimoErro}
        </Aviso>
      )}

      {ativa && <Instrucoes fonte={fonte} />}

      {ativa && podeGerir && (
        <>
          {item.usaToken && (
            <section className={secao}>
              <h2 className={legendaClass}>Token</h2>
              <p className="text-sm text-premium-secundario">
                Atual: <code>{fonte.tokenPrefixo}…</code> (o restante nunca é mostrado de novo).
              </p>
              <GirarToken id={fonte.id} />
            </section>
          )}

          {fonte.tipo === 'meta_lead_ads' && (
            <section className={secao}>
              <h2 className={legendaClass}>Conexão com a Meta</h2>
              <p className="text-sm text-premium-secundario">
                Página autorizada pela empresa na janela oficial da Meta (Login para Empresas); o token fica só no servidor e nunca é digitado aqui.
                {fonte.validadaEm ? ` Validada em ${formatarDataHoraCompleta(fonte.validadaEm)}.` : ' Ainda não validada: nenhum lead é aceito.'}
              </p>
              <Link href="/configuracoes/integracoes/meta-ads" className={botaoSecundarioClass}>
                Gerenciar em Meta Ads
              </Link>
            </section>
          )}

          {item.exigeValidacao && fonte.tipo !== 'meta_lead_ads' && (
            <section className={secao}>
              <h2 className={legendaClass}>Conexão com a Meta</h2>
              <p className="text-sm text-premium-secundario">
                {fonte.validadaEm
                  ? `Validada em ${formatarDataHoraCompleta(fonte.validadaEm)}.`
                  : 'Ainda não validada: nenhum evento é aceito até a validação com o token da empresa.'}
              </p>
              <form action={segredoFonteAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={fonte.id} />
                <label className="block min-w-60 flex-1">
                  <span className={labelClass}>
                    Token de acesso do WhatsApp Cloud API
                  </span>
                  <input name="segredo" type="password" autoComplete="off" required minLength={20} className={inputClass} />
                </label>
                <button type="submit" className={botaoSecundarioClass}>
                  Guardar no cofre
                </button>
              </form>
              <form action={validarFonteAction}>
                <input type="hidden" name="id" value={fonte.id} />
                <button type="submit" className={botaoPrimarioClass}>
                  Validar com a Meta
                </button>
              </form>
            </section>
          )}

          <section className={secao}>
            <h2 className={legendaClass}>Destino e configuração</h2>
            <form action={salvarFonteAction} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="id" value={fonte.id} />
              <input type="hidden" name="tipo" value={fonte.tipo} />
              <CamposFonte
                tipo={fonte.tipo}
                opcoes={opcoes}
                responsaveis={responsaveis.map((r) => ({
                  id: r.id,
                  nome: r.nome,
                }))}
                valores={{
                  nome: fonte.nome,
                  destino: `${fonte.funilId}|${fonte.etapaId}`,
                  responsavelId: fonte.responsavelId,
                  configuracao: fonte.configuracao,
                }}
              />
              <div className="sm:col-span-2">
                <button type="submit" className={botaoPrimarioClass}>
                  Salvar
                </button>
              </div>
            </form>
          </section>

          <section className="flex flex-wrap gap-3">
            <form action={statusFonteAction}>
              <input type="hidden" name="id" value={fonte.id} />
              <input type="hidden" name="status" value={fonte.status === 'ativa' ? 'pausada' : 'ativa'} />
              <button type="submit" className={botaoSecundarioClass}>
                {fonte.status === 'ativa' ? 'Pausar' : 'Ativar'}
              </button>
            </form>
            <form action={revogarFonteAction}>
              <input type="hidden" name="id" value={fonte.id} />
              <BotaoConfirmar
                pergunta={`Revogar a fonte "${fonte.nome}"? Ela para de aceitar leads e não pode ser reativada.`}
                className={botaoPerigoClass}
              >
                Revogar (definitivo)
              </BotaoConfirmar>
            </form>
          </section>
        </>
      )}

      <section aria-labelledby="recebimentos-titulo" className="space-y-3">
        <h2 id="recebimentos-titulo" className={legendaClass}>
          Últimos recebimentos
        </h2>
        {eventos.length === 0 ? (
          <EstadoVazio
            titulo="Nada recebido ainda"
            descricao="Assim que esta fonte enviar o primeiro lead, o recebimento aparece aqui com o resultado."
          />
        ) : (
          <div className={tabelaCaixaClass}>
            <table className={tabelaClass}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>Quando</th>
                  <th className={thClass}>Resultado</th>
                  <th className={thClass}>Identificador</th>
                  <th className={thClass}>Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {eventos.map((e) => (
                  <tr key={e.id} className={linhaClass}>
                    <td className={`${tdClass} whitespace-nowrap`}>{formatarDataHoraCompleta(e.recebidoEm)}</td>
                    <td className={tdClass}>{e.resultado}</td>
                    <td className={`${tdClass} font-mono text-xs`}>{e.externalId ?? '—'}</td>
                    <td className={`${tdClass} text-xs text-premium-secundario`}>
                      {e.erroMensagem ?? e.erroCodigo ?? (e.negociacaoId ? 'negociação criada/atualizada' : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/** Como conectar, por tipo. Nunca mostra segredo: só endereços e o formato. */
function Instrucoes({ fonte }: { fonte: Fonte }) {
  const end = enderecosIntegracao()
  const caixa = `${cartaoClass} space-y-2 p-5 text-sm`
  const codigo =
    'block overflow-x-auto whitespace-pre rounded-lg border border-premium-borda-suave bg-premium-bg p-3 font-mono text-xs text-premium-texto'

  if (fonte.tipo === 'formulario_rx7') {
    return (
      <section className={caixa}>
        <h2 className={legendaClass}>Link do formulário</h2>
        <code className={codigo}>{`${serverEnv.siteUrl.replace(/\/+$/, '')}/f/${fonte.id}`}</code>
        <p className="text-premium-secundario">Divulgue este link (site, bio, anúncios). Ele não contém nenhum segredo.</p>
      </section>
    )
  }
  if (fonte.tipo === 'webhook' || fonte.tipo === 'google_sheets' || fonte.tipo === 'respondi') {
    return (
      <section className={caixa}>
        <h2 className={legendaClass}>Como conectar</h2>
        <code className={codigo}>{`POST ${end.webhook}\nAuthorization: Bearer <token da fonte>`}</code>
        {fonte.tipo === 'webhook' && (
          <code
            className={codigo}
          >{`{ "external_id": "id-do-lead-no-seu-sistema",\n  "dados": { "nome": "…", "telefone": "…", "email": "…" },\n  "atribuicao": { "utm_source": "…" } }`}</code>
        )}
        {fonte.tipo === 'respondi' && (
          <p className="text-premium-secundario">
            No Respondi da empresa, configure o webhook para este endereço com o header acima. Se o Respondi não aceitar header, use{' '}
            <code>?token=&lt;token da fonte&gt;</code> no fim da URL. O primeiro envio confirma a conexão.
          </p>
        )}
        {fonte.tipo === 'google_sheets' && (
          <>
            <p className="text-premium-secundario">
              Na planilha: Extensões → Apps Script. Guarde o token em Propriedades do script (<code>AVANTE_TOKEN</code>) e crie um acionador
              &quot;Ao enviar formulário&quot; ou &quot;Ao editar&quot; para esta função:
            </p>
            <code className={codigo}>{`function enviarLeadAvante(e) {
  const linha = e.range.getRow();
  const aba = e.range.getSheet();
  const [nome, telefone, email] = aba.getRange(linha, 1, 1, 3).getValues()[0];
  UrlFetchApp.fetch('${end.webhook}', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + PropertiesService.getScriptProperties().getProperty('AVANTE_TOKEN') },
    payload: JSON.stringify({
      external_id: aba.getSheetId() + ':' + linha,
      dados: { nome: nome, telefone: String(telefone), email: email }
    })
  });
}`}</code>
          </>
        )}
      </section>
    )
  }
  return (
    <section className={caixa}>
      <h2 className={legendaClass}>Como conectar</h2>
      <p className="text-premium-secundario">
        O app da Meta da Rio X7 recebe os eventos em <code>{end.meta}</code>. A empresa informa{' '}
        {fonte.tipo === 'meta_lead_ads' ? 'a página pela janela oficial da Meta (sem digitar token)' : 'o número (Phone Number ID) e o token dela'}, e o CRM valida
        com a Meta antes de aceitar qualquer lead.
      </p>
    </section>
  )
}
