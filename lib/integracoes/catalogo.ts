import type { Database } from '@/lib/types/database'

/**
 * Catálogo das fontes de leads mostrado na tela de integrações.
 *
 * `situacao` diz o que o CÓDIGO já faz — nunca que a conexão com o provedor
 * foi testada: Meta e WhatsApp só recebem depois da validação real com o
 * token da empresa (`validada_em`).
 */

export type TipoFonte = Database['public']['Enums']['fonte_lead_tipo']
export type StatusFonte = Database['public']['Enums']['fonte_lead_status']

export type ItemCatalogo = {
  tipo: TipoFonte | 'manual'
  nome: string
  descricao: string
  situacao: 'nativo' | 'pronto' | 'requer_configuracao'
  rotuloSituacao: string
  usaToken: boolean
  exigeValidacao: boolean
}

export const CATALOGO: ItemCatalogo[] = [
  {
    tipo: 'formulario_rx7',
    nome: 'Formulário AVANTE',
    descricao: 'Página pública de captação hospedada pelo próprio CRM. Basta divulgar o link.',
    situacao: 'pronto',
    rotuloSituacao: 'Disponível',
    usaToken: false,
    exigeValidacao: false,
  },
  {
    tipo: 'webhook',
    nome: 'Webhook (API)',
    descricao: 'Qualquer sistema da empresa envia o lead por POST com o token da fonte no header.',
    situacao: 'pronto',
    rotuloSituacao: 'Disponível',
    usaToken: true,
    exigeValidacao: false,
  },
  {
    tipo: 'google_sheets',
    nome: 'Google Sheets',
    descricao: 'Conecte a conta Google da empresa, escolha a planilha e a aba: as linhas novas entram no funil escolhido. Sem Apps Script.',
    situacao: 'requer_configuracao',
    rotuloSituacao: 'Conexão oficial do Google (OAuth)',
    usaToken: true,
    exigeValidacao: false,
  },
  {
    tipo: 'respondi',
    nome: 'Respondi da empresa',
    descricao: 'Webhook do Respondi da própria empresa. Ainda não testado com o Respondi real.',
    situacao: 'pronto',
    rotuloSituacao: 'Disponível — confirmar no primeiro envio',
    usaToken: true,
    exigeValidacao: false,
  },
  {
    tipo: 'meta_lead_ads',
    nome: 'Meta Lead Ads',
    descricao: 'Formulários nativos de anúncios do Facebook/Instagram: a empresa autoriza as próprias Páginas na janela oficial da Meta (Meta Ads › Ativos da empresa). Nenhum token é digitado.',
    situacao: 'requer_configuracao',
    rotuloSituacao: 'Conexão oficial da Meta (Login para Empresas)',
    usaToken: false,
    exigeValidacao: true,
  },
  {
    tipo: 'whatsapp_cloud',
    nome: 'WhatsApp oficial (Cloud API)',
    descricao: 'Conecte o número oficial pelo cadastro da Meta: quem escreve vira lead e a equipe responde pelo AVANTE, só dentro da janela gratuita de 24 h.',
    situacao: 'requer_configuracao',
    rotuloSituacao: 'Conexão oficial da Meta (Embedded Signup)',
    usaToken: false,
    exigeValidacao: true,
  },
  {
    tipo: 'manual',
    nome: 'Cadastro manual',
    descricao: 'Clientes e negociações criados pela equipe na tela de Clientes.',
    situacao: 'nativo',
    rotuloSituacao: 'Nativo',
    usaToken: false,
    exigeValidacao: false,
  },
]

export const TIPOS_FONTE: TipoFonte[] = ['formulario_rx7', 'webhook', 'google_sheets', 'respondi', 'meta_lead_ads', 'whatsapp_cloud']

/**
 * Tipos criados pelo formulário de token/configuração manual. Google Sheets,
 * WhatsApp oficial e Meta Lead Ads têm conexão própria (OAuth do Google / janelas
 * oficiais da Meta), com credenciais guardadas só no servidor — não entram aqui:
 * a empresa nunca digita nem entrega token.
 */
export const TIPOS_FONTE_MANUAIS: TipoFonte[] = ['formulario_rx7', 'webhook', 'respondi']

/** Tipos com conexão oficial (telas próprias em Integrações). */
export const TIPOS_CONEXAO_OFICIAL: TipoFonte[] = ['google_sheets', 'whatsapp_cloud']

export function itemDoTipo(tipo: TipoFonte): ItemCatalogo {
  return CATALOGO.find((i) => i.tipo === tipo)!
}

/** Situação visível de uma fonte cadastrada (nunca "funcionando" sem prova). */
export function situacaoDaFonte(f: {
  tipo: TipoFonte
  status: StatusFonte
  validadaEm: string | null
  ultimoLeadEm: string | null
}): { rotulo: string; tom: 'ok' | 'espera' | 'parado' } {
  if (f.status === 'revogada') return { rotulo: 'Revogada', tom: 'parado' }
  if (f.status === 'pausada') return { rotulo: 'Pausada', tom: 'parado' }
  if (itemDoTipo(f.tipo).exigeValidacao && !f.validadaEm) return { rotulo: 'Aguardando validação com o provedor', tom: 'espera' }
  if (!f.ultimoLeadEm) return { rotulo: 'Ativa — aguardando o primeiro lead', tom: 'espera' }
  return { rotulo: 'Recebendo leads', tom: 'ok' }
}
