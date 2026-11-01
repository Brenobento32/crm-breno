# Meta Ads multiempresa (local, não publicado)

Cada empresa cliente conecta, no **próprio portfólio da Meta** (mesmo fora da BM da Rio X7),
as Páginas, contas de anúncios e datasets que quiser liberar. Nada é transferido para a BM da
Rio X7, ninguém digita ou entrega token, e o cliente revoga quando quiser em Configurações do
negócio › Integrações › Apps conectados.

## Configuração no app AVANTE CRM (feita em 31/10/2026, app ainda "Não publicado")

Mesmo app do WhatsApp oficial (App ID 1849102593109058). Nada do WhatsApp foi alterado: o caso
de uso, a configuração do Cadastro Incorporado `AVANTE WhatsApp ES v4` (2263375681228010) e o
webhook continuam iguais.

**Casos de uso adicionados** (só os de leitura):
- "Mensurar dados de desempenho do anúncio com a API de Marketing"
- "Capturar e gerenciar leads de anúncios com a API de Marketing"

"Criar e gerenciar anúncios" **não** foi adicionado: o AVANTE não cria campanhas, e a
`ads_management` já vem no caso de uso de mensuração, caso um dia seja necessária.

**Configuração do Login do Facebook para Empresas: `AVANTE Meta Ads v1`**
- Identificação (`META_ADS_CONFIG_ID`, valor público, não é segredo): **1650064946908971**.
  Ainda **não** cadastrado no Supabase.
- Variação: Geral. Token: **usuário do sistema** (BISU, do portfólio do cliente), **nunca expira**
  (o cliente revoga quando quiser; token revogado → erro 190 → "reconectar" no AVANTE).
- Ativos que o cliente escolhe na janela (nenhum obrigatório): **Páginas**, **contas de anúncios**
  (tarefa **ANALYZE** apenas: relatórios, sem criar ou editar anúncios) e **Pixels** (datasets).
  Catálogos e Instagram ficaram de fora.
- Permissões (7): `ads_read`, `business_management`, `leads_retrieval`, `pages_manage_ads`,
  `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`. Sem `ads_management` e sem
  as do WhatsApp. `pages_manage_metadata` entrou em 31/10/2026 pela edição da mesma configuração
  (o ID não mudou; a tarefa ANALYZE e o token que nunca expira foram mantidos).

O modelo pronto "Integração de parceiros da API de Conversões" só libera datasets; a configuração
própria acima cobre os três recursos num único login.

## Permissões: o que já dá para testar e o que falta

Situação no painel em 31/10/2026 (acesso padrão = só pessoas com função no app):

| Permissão / recurso | Situação | Para quê |
|---|---|---|
| `ads_read` | Pronto para teste | métricas do painel e envio de eventos (CAPI) |
| `business_management` | Pronto para teste | datasets do portfólio (`owned_pixels`/`client_pixels`) |
| `leads_retrieval` | Pronto para teste | ler o lead do formulário |
| `pages_show_list`, `pages_read_engagement` | Pronto para teste | listar a Página e obter o token dela |
| `pages_manage_ads` | Pronto para teste | leads de formulários de anúncios da Página |
| `ads_management` | Pronto para teste (fora da configuração) | ver CAPI abaixo |
| `pages_manage_metadata` | Pronto para teste (adicionada ao rascunho em 31/10/2026) | inscrever a Página no webhook `leadgen` |
| **Marketing API Access Tier** | **Acesso limitado** | volume e contas de clientes externos |

Rascunho da Análise do app: "Não enviado". "Adicionar à análise do app" só põe a permissão na
lista do rascunho e a libera para teste; não envia nada nem cria obrigação. O envio é outro passo
("Avançar" na página Análise do app) e **não** foi feito.

### Permissões da Conversions API (fontes oficiais, divergentes)

- Modelo "Conversions API partner integration": recomenda `ads_read` + `business_management`;
  requisito listado: "`ads_management` **ou** `business_management`, e `pages_read_engagement` e
  `ads_read`" → a configuração atual atende.
- Guia "Conversions API para CRM como plataforma": `ads_read` "envia eventos em nome dos
  anunciantes", mas lista também `ads_management` (e o Access Tier) como pré-requisitos.
- Decisão: **validar com evento de teste** (código de teste do Gerenciador de Eventos) na Teste A.
  Se a Meta recusar sem `ads_management`, incluí-la na mesma configuração (ID não muda; a tarefa
  ANALYZE continua impedindo criar ou editar anúncios) e no App Review.

## Webhook Lead Ads (Page › leadgen)

- URL: `https://ybgzlxgeoiggmfdxarqx.supabase.co/functions/v1/meta-webhooks` (deploy com
  `--no-verify-jwt`; a Meta não manda JWT). Objeto **Page**, campo **leadgen**, assinado no app
  (Casos de uso › Capturar leads › Webhooks) depois do primeiro deploy da função.
- Verificação (GET): `hub.verify_token` = `META_VERIFY_TOKEN` (o mesmo segredo já usado no
  webhook do WhatsApp); só devolve o `hub.challenge` com o token certo.
- Eventos (POST): só com `X-Hub-Signature-256` válido (HMAC-SHA256 do corpo cru com
  `META_APP_SECRET`, comparação em tempo constante); corpo até 256 KB.
- Inscrição de cada Página: feita pelo AVANTE ao salvar as escolhas, com o token da própria
  Página (`POST /{page}/subscribed_apps?subscribed_fields=leadgen`, exige `pages_manage_metadata`).
- Empresa: nunca vem do corpo. `page_id` → fonte ativa e validada (`fonte_por_provedor`, só com
  Meta Ads liberado para a empresa); uma Página ativa pertence a uma só empresa (índice único).
- Duplicatas: reenvio do mesmo `leadgen_id` atualiza o mesmo lead (idempotente por fonte), nunca
  cria outro. Falha ao ler o lead → 500 para a Meta reenviar.
- Leitura do lead com o token da Página e `appsecret_proof`, na mesma versão da Graph da função
  `integracoes` (corrigido em 31/10/2026; antes ia sem prova e em v21.0).

## Validação local (31/10/2026)

Emulador local (`C:\Tools\avante-local`, nada sai da máquina) com o Login para Empresas, a Graph
e o evento `leadgen` assinado simulados; o evento passa pelos mesmos passos da `meta-webhooks`.
`node meta-ads-ui.mjs` (Chrome headless): **30/30 ok**, incluindo:
- janela do login mostra só os ativos liberados (Página e conta não liberadas não aparecem nem são gravadas);
- Página exige funil, etapa e responsável; inscrita em `leadgen`; token só no cofre;
- lead do formulário entra na etapa e com o responsável escolhidos, com campanha e plataforma;
  reenvio não duplica; assinatura inválida recusada; Página não autorizada ignorada;
- painel: investimento, campanhas, CPL (CRM), ROAS (CRM) e ROAS (Meta) separados;
- outra empresa não vê nada; Closer da própria empresa não vê o painel.

Para clientes **externos** (portfólios sem ninguém com função no app) todas as permissões acima
precisam de **acesso avançado** (App Review), e o app precisa estar **Live**.

## Marketing API Access Tier (requisito corrigido)

Conferido no painel do app em 31/10/2026: requisitos = verificação da empresa (já concluída),
Análise do app, **pelo menos 500 chamadas à Marketing API com taxa de erro abaixo de 15%** e as
perguntas sobre tratamento de dados. (A Meta reduziu de 1.500 para 500 em 04/05/2026; a janela é
de 15 dias, com o erro medido nas últimas 500 chamadas.) Contador atual: 0.

As chamadas vêm só do uso real (leitura horária de métricas das contas conectadas no teste);
**nunca** gerar chamadas artificiais.

## O que o código faz

| Recurso | Antes | Agora (local) |
|---|---|---|
| Lead Ads | fonte com token de Página colado à mão; `meta-webhooks` nunca publicada; fora da Central | Página autorizada na janela oficial → fonte `meta_lead_ads` com token da Página no cofre, inscrita em `leadgen`; destino no funil por Página; atribuição com campanha, conjunto, anúncio, formulário e plataforma (FB/IG); respostas extras na ficha; segue permissão "Meta Ads" da Central e cota de fontes |
| Conversões do CRM (CAPI) | pronto (fila, mapeamento por etapa, envio), conexão só por MBE | o dataset escolhido no login vai para a mesma `capi_salvar_conexao`; leads de Lead Ads já levam `leadgen_id` → viram eventos |
| Painel de campanhas | não existia | contas de anúncios autorizadas; leitura horária (Marketing API, só leitura); painel com dois blocos separados (abaixo) |

### Painel: CRM × atribuição da Meta

Os dois nunca se misturam (colunas próprias no banco, indicadores próprios na tela):

- **Resultado no CRM**: leads que entraram no funil, vendas (fechamentos não anulados),
  faturamento registrado, CPL (CRM) = investimento ÷ leads no CRM e **ROAS (CRM)** = faturamento
  ÷ investimento. Liga o lead à campanha pela atribuição do Lead Ads.
- **Atribuição informada pela Meta**: leads, compras atribuídas e valor atribuído que a própria
  Meta informa (`actions`/`action_values`, maior entre os tipos de compra, nunca somados), pelo
  modelo e pela janela de atribuição configurados na conta, e **ROAS (Meta)** = valor atribuído
  ÷ investimento. Só para comparar; não é conferido pelo CRM.

Isolamento: portfólio, conta de anúncios, Página e dataset ativos pertencem a uma só empresa
(índices únicos no banco); tokens só no Vault e só para o servidor; painel e estado só da empresa
da sessão (Administrador/gerente); qualquer ID fora do que a Meta liberou para o token é recusado
pelo servidor; desconectar apaga tokens e revoga as Páginas do login (histórico fica).
O AVANTE **nunca** cria, edita, pausa campanhas nem gera gasto.

## Arquivos

- `supabase/migrations/20261107090000_meta_ads_multiempresa.sql` (+ `supabase/tests/meta_ads_multiempresa_test.sql`, 31)
- `supabase/functions/_shared/meta-ads.ts` (Graph: ativos, token da Página, inscrição `leadgen`, insights)
- `supabase/functions/_shared/integracoes-servico.ts`: `/meta-ads/login/concluir`, `/ativos`, `/selecionar`; métricas no `/cron`
- `supabase/functions/meta-webhooks/index.ts`: campos do lead e respostas extras
- Site: `meta-ads/ativos-meta-ads.tsx`, `meta-ads/painel/page.tsx`, `lib/dal/meta-ads.ts`,
  `lib/integracoes/meta-ads-painel.ts`, ações e janela `conectarMetaAdsLogin`
- Testes unitários: `lib/integracoes/meta-ads.test.ts` (17)

## Ativação (cada passo com autorização)

1. ~~`pages_manage_metadata` no rascunho e na configuração~~ (feito em 31/10/2026).
2. Cadastrar o segredo `META_ADS_CONFIG_ID` = 1650064946908971 no Supabase (Edge Functions).
3. Publicar: migration `20261107090000` → funções `integracoes` e `meta-webhooks` (primeiro deploy
   desta) → site. Assinar no app o objeto **Page › leadgen** → `.../functions/v1/meta-webhooks`.
4. Liberar Meta Ads só para a Teste A (lista de homologação), conectar a BM da Rio X7 e testar:
   lead de formulário de teste (Ferramenta de teste de anúncios de cadastro), métricas e evento
   CAPI com código de teste.
5. Acumular as 500 chamadas pelo uso real, gravar os vídeos e enviar o App Review; app em Live.

## Situação em 01/11/2026

- Passos 2 e 3 concluídos (Pacote 6 publicado; `META_ADS_CONFIG_ID` cadastrado). A homologação saiu
  da Teste A e foi para a **Rio X7 Agência Digital** (`rio-x7`, interna): conta de anúncios **Rio X7**
  (`act_1109230466869089`) da **BM Bento** (938379700973334) conectada só para leitura; métricas
  chegando. Sem Página, sem dataset, sem CAPI. Webhook Page › leadgen ainda não registrado.
- Correção local, ainda não publicada: o cartão da Central passa a mostrar conta de anúncios,
  formulários e conversões (CAPI) separadamente (`lib/integracoes/central.ts`, página da Central).
  Entra no próximo pacote controlado.

## Próximas etapas registradas (NÃO executar sem nova autorização)

1. **Formulários do Facebook e do Instagram direto no funil** (Lead Ads oficial): conectar a Página
   "Rio X7 Agência Digital" (272993359821382, do portfólio "riox7", compartilhada com a BM Bento),
   registrar o webhook Page › leadgen, conferir o "Acesso a leads" do portfólio dono da Página e
   publicar o app (leads reais só chegam com o app em Live + App Review).
2. **Leads de anúncios para WhatsApp** (Click-to-WhatsApp) pela Cloud API oficial, com a origem do
   anúncio guardada no lead (liberação do WhatsApp oficial por empresa).
3. **Campanha de origem e devolutivas** (qualificação/venda) pela Conversions API, com dataset
   autorizado pela BM Bento e mapeamento das etapas do funil; validar antes com código de teste se a
   Meta exige `ads_management`.
