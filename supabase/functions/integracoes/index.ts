/**
 * Edge Function `integracoes` — Google Sheets e WhatsApp oficial por empresa.
 * A lógica fica em `_shared/integracoes-servico.ts` (testável no Node).
 *
 * Deploy com --no-verify-jwt: o callback do Google, o webhook da Meta e o
 * agendador não mandam JWT; as rotas de usuário conferem o JWT lá dentro.
 *
 * Secrets (definidos pelo dono no Supabase, nunca no Git):
 *   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_PICKER_API_KEY, GOOGLE_PICKER_APP_ID
 *   INTEGRACOES_STATE_SECRET (≥ 32), INTEGRACOES_CRON_SECRET (≥ 32), AVANTE_URL
 *   META_APP_ID, META_APP_SECRET, META_CONFIG_ID, META_VERIFY_TOKEN, META_GRAPH_VERSION (padrão v23.0)
 *   META_ADS_CONFIG_ID (opcional: Login do Facebook para Empresas do Meta Ads)
 */
import { createClient } from 'npm:@supabase/supabase-js@2'

import { tratarIntegracoes, type ClienteUsuario, type Dependencias } from '../_shared/integracoes-servico.ts'
import { HEADER_TENANT, slugDaRequisicao } from '../_shared/requisicao.ts'

const env = (k: string) => Deno.env.get(k) ?? ''
const url = env('SUPABASE_URL')
const anonKey = env('SUPABASE_ANON_KEY')
const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })

const googleOk = env('GOOGLE_OAUTH_CLIENT_ID') && env('GOOGLE_OAUTH_CLIENT_SECRET')
const metaOk = env('META_APP_ID') && env('META_APP_SECRET')

const deps: Dependencias = {
  admin,
  comoUsuario: (req: Request) => {
    const slug = slugDaRequisicao(req.headers)
    return createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '', ...(slug ? { [HEADER_TENANT]: slug } : {}) } },
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as ClienteUsuario
  },
  buscar: fetch,
  google: googleOk
    ? {
        clientId: env('GOOGLE_OAUTH_CLIENT_ID'),
        clientSecret: env('GOOGLE_OAUTH_CLIENT_SECRET'),
        redirectUri: `${url}/functions/v1/integracoes/google/callback`,
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        revokeUrl: 'https://oauth2.googleapis.com/revoke',
        sheetsUrl: 'https://sheets.googleapis.com/v4',
        driveUrl: 'https://www.googleapis.com/drive/v3',
        chaveApiPicker: env('GOOGLE_PICKER_API_KEY'),
        appIdPicker: env('GOOGLE_PICKER_APP_ID'),
      }
    : null,
  meta: metaOk
    ? {
        graphUrl: `https://graph.facebook.com/${env('META_GRAPH_VERSION') || 'v23.0'}`,
        appId: env('META_APP_ID'),
        appSecret: env('META_APP_SECRET'),
        configId: env('META_CONFIG_ID'),
        configIdAds: env('META_ADS_CONFIG_ID'),
        verifyToken: env('META_VERIFY_TOKEN'),
      }
    : null,
  segredoEstado: env('INTEGRACOES_STATE_SECRET'),
  segredoCron: env('INTEGRACOES_CRON_SECRET'),
  urlApp: env('AVANTE_URL') || 'https://avante.riox7comunicacao.com.br',
  // Avisos do Google Drive: responde rápido e lê a planilha depois da resposta.
  emSegundoPlano: tarefaEmSegundoPlano(),
  // Desligar os avisos do Drive sem deploy: secret GOOGLE_AVISOS_DRIVE=desligado (vale na próxima inicialização da função).
  avisosDrive: env('GOOGLE_AVISOS_DRIVE') !== 'desligado',
}

function tarefaEmSegundoPlano(): ((p: Promise<unknown>) => void) | undefined {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
  return rt?.waitUntil ? (p) => rt.waitUntil!(p) : undefined
}

Deno.serve((req) => tratarIntegracoes(req, deps))
