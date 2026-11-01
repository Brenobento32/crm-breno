import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { PageHeaderPremium } from '@/components/layout/page-header-premium'
import { Aviso } from '@/components/ui/aviso'
import { EstadoVazio } from '@/components/ui/estado-vazio'
import { botaoSecundarioClass } from '@/components/ui/estilos'
import { Secao } from '@/components/ui/secao'
import { Selo } from '@/components/ui/selo'
import { solicitarIntegracaoAction } from '@/lib/actions/integracoes-oficiais'
import { getUsuarioAtual } from '@/lib/dal/auth'
import { centralDaEmpresa } from '@/lib/dal/central-integracoes'
import { listarResponsaveis } from '@/lib/dal/clientes'
import { listarFontes, opcoesDeDestino, podeGerirFontes } from '@/lib/dal/fontes-leads'
import {
  consumoWhatsapp,
  integracoesHabilitadas,
  listarContasGoogle,
  listarIntegracoesOficiais,
  monitoramentoDasPlanilhas,
  podeAdministrarIntegracoes,
  sincronizacoesWhatsapp,
} from '@/lib/dal/integracoes-oficiais'
import { metaAdsDaEmpresa } from '@/lib/dal/meta-ads'
import { conexaoMetaAds, franquiaWhatsapp } from '@/lib/dal/meta-conversoes'
import { itemDoTipo, situacaoDaFonte } from '@/lib/integracoes/catalogo'
import {
  ROTULO_ESTADO,
  cartaoMetaAds,
  cartoesWhatsapp,
  estadoDoCartao,
  infoDoCartao,
  grupoDoCartao,
  linhasMetaAds,
  resumoMetaAds,
  textoDeUso,
  textoDoLimite,
  type CartaoCentral,
  type LinhaCentral,
  type ResumoMetaAds,
} from '@/lib/integracoes/central'
import { formatarDataHoraCompleta } from '@/lib/utils/formatacao'

import { CartaoIntegracao } from './_components/cartao-integracao'
import { PainelGoogleSheets, PainelMetaAds, PainelWhatsapp } from './_components/conexoes-oficiais'
import { LogoIntegracao } from './_components/logo-integracao'
import { NovaFonte } from './_components/nova-fonte'

export const metadata: Metadata = {
  title: 'Integrações',
}

const TOM_TEXTO: Record<string, string> = {
  ok: 'text-emerald-700 dark:text-emerald-300',
  espera: 'text-amber-700 dark:text-amber-300',
  parado: 'text-premium-mudo',
}

/**
 * Central de Integrações: cartões só para o que está lançado E liberado para
 * esta empresa (plano ou exceção do Super Admin — decidido no banco). O que o
 * plano não inclui aparece em "Disponível com upgrade", sem acesso à
 * configuração. O que ainda não foi lançado aparece só como "em breve".
 */
export default async function IntegracoesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const eu = await getUsuarioAtual()
  if (eu.role !== 'gerente') notFound()

  const [central, todasFontes, podeGerir, opcoes, responsaveis, params, oficiais, contas, consumo, podeConectar, franquia, metaAds, habilitadas, monitoramento, sincronizacoes, loginAds] =
    await Promise.all([
      centralDaEmpresa(),
      listarFontes(),
      podeGerirFontes(),
      opcoesDeDestino(),
      listarResponsaveis(),
      searchParams,
      listarIntegracoesOficiais(),
      listarContasGoogle(),
      consumoWhatsapp(30),
      podeAdministrarIntegracoes(),
      franquiaWhatsapp(),
      conexaoMetaAds(),
      integracoesHabilitadas(),
      monitoramentoDasPlanilhas(),
      sincronizacoesWhatsapp(),
      metaAdsDaEmpresa(),
    ])
  const erro = typeof params.erro === 'string' ? params.erro : null
  const ok = typeof params.ok === 'string' ? params.ok : null
  const idsOficiais = new Set(oficiais.map((o) => o.fonteId))
  const fontes = todasFontes.filter((f) => !idsOficiais.has(f.id) && f.tipo !== 'meta_lead_ads')
  const lista = responsaveis.map((r) => ({ id: r.id, nome: r.nome }))

  // WhatsApp oficial = uma integração (permissão e limite únicos), dois cartões: número novo e app existente.
  const numerosWhatsapp = oficiais
    .filter((o) => o.tipo === 'whatsapp_cloud')
    .map((o) => ({ modo: o.modo ?? ('cloud_api' as const), situacao: o.situacao, comErro: Boolean(o.bloqueadoPorCobranca || (o.ultimoErro && o.situacao !== 'conectado')) }))
  // Meta Ads: conta de anúncios, Páginas (formulários) e CAPI, cada uma com o próprio estado (registros reais da empresa).
  const resumoAds = resumoMetaAds(loginAds, metaAds)
  const cartoes = central.flatMap((l) =>
    l.integracao === 'whatsapp_oficial' ? cartoesWhatsapp(l, numerosWhatsapp) : l.integracao === 'meta_conversoes' ? [cartaoMetaAds(l, resumoAds)] : [l],
  )
  const liberadas = cartoes.filter((l) => grupoDoCartao(l) === 'liberada')
  const upgrade = cartoes.filter((l) => grupoDoCartao(l) === 'upgrade')
  const emBreve = cartoes.filter((l) => grupoDoCartao(l) === 'em_breve')
  const resumoPlano = central[0] ? textoDoLimite(central[0]) : null

  const painel: Record<CartaoCentral, React.ReactNode> = {
    formularios: (
      <div className="space-y-5">
        <Secao titulo="Fontes desta empresa" descricao={`${fontes.length} ${fontes.length === 1 ? 'fonte' : 'fontes'}`} semPadding>
          {fontes.length === 0 ? (
            <EstadoVazio compacto titulo="Nenhuma fonte cadastrada" descricao={podeGerir ? 'Crie uma fonte abaixo para receber leads direto no funil.' : 'Quando o administrador criar uma fonte, ela aparece aqui.'} />
          ) : (
            <ul className="divide-y divide-premium-borda-suave">
              {fontes.map((f) => {
                const s = situacaoDaFonte(f)
                return (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <Link href={`/configuracoes/integracoes/${f.id}`} className="font-medium text-premium-texto hover:underline">
                        {f.nome}
                      </Link>
                      <span className="ml-2 text-xs text-premium-mudo">{itemDoTipo(f.tipo).nome}</span>
                      <p className={`text-xs ${TOM_TEXTO[s.tom] ?? 'text-premium-mudo'}`}>
                        {s.rotulo}
                        {f.ultimoLeadEm ? ` · último lead ${formatarDataHoraCompleta(f.ultimoLeadEm)}` : ''}
                      </p>
                    </div>
                    {f.ultimoErro && f.status !== 'revogada' && <Selo tom="vermelho">Último erro registrado</Selo>}
                  </li>
                )
              })}
            </ul>
          )}
        </Secao>
        {podeGerir ? (
          <Secao id="nova-fonte" titulo="Nova fonte" descricao="Escolha o tipo e para onde os leads vão. Todas as respostas do formulário ficam guardadas no lead.">
            <NovaFonte opcoes={opcoes} responsaveis={lista} />
          </Secao>
        ) : (
          <Aviso tom="info">Somente o administrador da empresa cria e altera fontes.</Aviso>
        )}
      </div>
    ),
    google_sheets: (
      <PainelGoogleSheets
        integracoes={oficiais}
        contas={contas}
        opcoes={opcoes}
        responsaveis={lista}
        podeGerir={podeConectar}
        habilitada={habilitadas.googleSheets}
        monitoramento={monitoramento}
      />
    ),
    whatsapp_oficial: (
      <PainelWhatsapp
        integracoes={oficiais}
        consumo={consumo}
        opcoes={opcoes}
        responsaveis={lista}
        podeGerir={podeConectar}
        franquia={franquia}
        habilitada={habilitadas.whatsappOficial}
        sincronizacoes={sincronizacoes}
        modo="cloud_api"
      />
    ),
    whatsapp_app: (
      <PainelWhatsapp
        integracoes={oficiais}
        consumo={consumo}
        opcoes={opcoes}
        responsaveis={lista}
        podeGerir={podeConectar}
        franquia={franquia}
        habilitada={habilitadas.whatsappOficial}
        sincronizacoes={sincronizacoes}
        modo="coexistencia"
      />
    ),
    meta_conversoes: <PainelMetaAds metaAds={metaAds} habilitada={habilitadas.metaConversoes} />,
  }

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeaderPremium
        titulo="Central de Integrações"
        subtitulo="Conecte as fontes de leads e os canais da empresa. Cada integração entra no funil e na etapa que você escolher; reenvios não duplicam e nada é compartilhado com outras empresas."
        voltar={{ href: '/configuracoes', rotulo: 'Configurações' }}
      />
      {erro && <Aviso tom="erro">{erro}</Aviso>}
      {ok && <Aviso tom="sucesso">{ok}</Aviso>}
      {resumoPlano && <p className="text-sm text-premium-secundario">{resumoPlano}</p>}

      <section aria-labelledby="liberadas-titulo" className="space-y-3">
        <h2 id="liberadas-titulo" className="text-[15px] font-semibold tracking-tight text-premium-texto">
          Suas integrações
        </h2>
        {liberadas.length === 0 ? (
          <EstadoVazio compacto titulo="Nenhuma integração liberada no seu plano" descricao="Veja abaixo o que pode ser liberado com upgrade." />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {liberadas.map((l) => (
              <CartaoIntegracao
                key={l.cartao ?? l.integracao}
                chave={l.cartao ?? l.integracao}
                titulo={infoDoCartao(l).nome}
                cabecalho={<CabecalhoCartao l={l} metaAds={l.integracao === 'meta_conversoes' ? resumoAds : undefined} />}
              >
                {painel[l.cartao ?? l.integracao]}
              </CartaoIntegracao>
            ))}
          </div>
        )}
      </section>

      {upgrade.length > 0 && (
        <section aria-labelledby="upgrade-titulo" className="space-y-3">
          <div>
            <h2 id="upgrade-titulo" className="text-[15px] font-semibold tracking-tight text-premium-texto">
              Disponível com upgrade
            </h2>
            <p className="text-sm text-premium-secundario">Estas integrações não fazem parte do seu plano atual. A configuração fica liberada quando o plano incluir.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {upgrade.map((l) => (
              <CartaoUpgrade key={l.cartao ?? l.integracao} l={l} podePedir={podeConectar} />
            ))}
          </div>
        </section>
      )}

      {emBreve.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-premium-mudo">
          Em breve:
          {emBreve.map((l) => (
            <Selo key={l.cartao ?? l.integracao}>{infoDoCartao(l).nome}</Selo>
          ))}
        </p>
      )}
    </div>
  )
}

function CabecalhoCartao({ l, metaAds }: { l: LinhaCentral; metaAds?: ResumoMetaAds }) {
  const estado = ROTULO_ESTADO[estadoDoCartao(l)]
  const partes = metaAds ? linhasMetaAds(metaAds, formatarDataHoraCompleta) : null
  return (
    <span className="block space-y-2">
      <span className="flex items-start gap-3">
        <LogoIntegracao integracao={l.cartao ?? l.integracao} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-premium-texto">{infoDoCartao(l).nome}</span>
            <Selo tom={estado.tom}>{estado.texto}</Selo>
          </span>
          <span className="mt-1 block text-sm text-premium-secundario">{infoDoCartao(l).resumo}</span>
        </span>
      </span>
      {partes && (
        <span className="block space-y-1.5 rounded-lg border border-premium-borda-suave p-2.5">
          {partes.map((p) => (
            <span key={p.parte} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="min-w-0">
                <span className="font-medium text-premium-texto">{p.parte}</span>
                <span className="block text-premium-mudo">{p.texto}</span>
              </span>
              <Selo tom={p.estado.tom}>{p.estado.texto}</Selo>
            </span>
          ))}
        </span>
      )}
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-premium-mudo">
        {!partes && <span>{textoDeUso(l)}</span>}
        <span>Última atividade: {l.ultimaAtividade ? formatarDataHoraCompleta(l.ultimaAtividade) : '—'}</span>
        {l.regra === 'liberar' && <span>Liberada pela Rio X7</span>}
      </span>
    </span>
  )
}

function CartaoUpgrade({ l, podePedir }: { l: LinhaCentral; podePedir: boolean }) {
  const info = infoDoCartao(l)
  return (
    <div className="flex flex-col rounded-xl border border-dashed border-premium-borda bg-premium-card/60 p-4">
      <div className="flex items-start gap-3">
        <LogoIntegracao integracao={l.cartao ?? l.integracao} className="size-10 opacity-70" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-premium-texto">{info.nome}</p>
            <Selo tom="roxo">{l.regra === 'bloquear' ? 'Indisponível' : 'Upgrade'}</Selo>
          </div>
          <p className="mt-1 text-sm text-premium-secundario">{info.resumo}</p>
        </div>
      </div>
      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-premium-secundario">
        {info.beneficios.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Link href="/configuracoes/assinatura" className={botaoSecundarioClass}>
          Conhecer planos
        </Link>
        {podePedir && l.regra !== 'bloquear' && (
          l.solicitadaEm ? (
            <span className="text-xs text-premium-mudo">Pedido enviado em {formatarDataHoraCompleta(l.solicitadaEm)}</span>
          ) : (
            <form action={solicitarIntegracaoAction}>
              <input type="hidden" name="integracao" value={l.integracao} />
              <button type="submit" className={botaoSecundarioClass}>
                Solicitar liberação
              </button>
            </form>
          )
        )}
      </div>
    </div>
  )
}
