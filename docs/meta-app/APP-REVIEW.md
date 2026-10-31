# App Review da Meta — app "AVANTE CRM" (preparação, nada enviado)

App ID 1849102593109058 · portfólio Rio X7 (2430586127289598) · configuração do
Embedded Signup **"AVANTE WhatsApp ES v4"**, ID **2263375681228010**.
Conferido na documentação da Meta em 31/10/2026
([App Review para Tech Providers](https://developers.facebook.com/docs/whatsapp/solution-providers/app-review),
[versões do Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions/)).

## 1. Situação dos requisitos

| Requisito | Situação |
|---|---|
| Verificação da empresa (Rio X7) | feita |
| Plataforma do WhatsApp ativada + Independent Tech Provider | feitos (aceites do proprietário, 31/10) |
| Política de privacidade, termos, exclusão de dados, categoria, domínio do app | feitos (`avante.riox7comunicacao.com.br`) |
| Ícone 1024×1024 | **preparado** em `docs/meta-app/avante-icone-app-1024.png` (variante escura ao lado); falta enviar no painel (Configurações do app › Básico) |
| Login para Empresas: domínio do SDK JS `https://avante.riox7comunicacao.com.br/`, URI de retorno `https://avante.riox7comunicacao.com.br/configuracoes/integracoes/whatsapp` (única página que abre a janela da Meta), OAuth cliente/web/HTTPS/modo estrito/navegador incorporado/SDK JS = Sim | feito (31/10) |
| Configuração ES v4 (Cloud API, token de usuário do sistema que nunca expira, Contas do WhatsApp "Gerenciar") | feita |
| Parâmetros da janela conferidos no verificador da Meta | feito: os dois modos → v4, cloud_api, sessão 3; coexistência "Ativado" só no cartão B |
| Protótipo funcionando (exigência para gravar) | depende da publicação dos pacotes e do primeiro teste oficial (Teste A) |
| Pedido de acesso avançado (2 permissões, descrição + vídeo cada) | rascunho criado pela Meta, **não enviado** |

Permissões a pedir: **só** `whatsapp_business_messaging` e `whatsapp_business_management`.
Não pedir `whatsapp_business_manage_events` (só com Marketing Messages API) nem nada além:
permissão desnecessária é causa comum de recusa. O rascunho atual também lista
`public_profile`, que é padrão e não precisa de vídeo.

Regras da Meta para os vídeos: um vídeo **por permissão** (nunca as duas juntas), gravação de
tela (captura estática é recusada) e descrição escrita obrigatória. O rascunho não é analisado,
e a resposta leva em média ~24 h depois do envio.

Antes do acesso avançado, o app tem acesso padrão: o Embedded Signup funciona para quem tem
papel no app (administrador ou desenvolvedor). É assim que o primeiro teste oficial e as
gravações são feitos.

## 2. Descrições (colar em inglês no formulário)

**whatsapp_business_management**

> AVANTE CRM is a sales CRM used by small businesses. A business owner connects their own
> WhatsApp Business account through Embedded Signup (Cloud API, or the WhatsApp Business app
> through coexistence). We use whatsapp_business_management only on the accounts each client
> shares with us, to: read the shared WhatsApp Business account and its phone numbers so the
> client can confirm the right number; subscribe our app to that account's webhooks; register
> the Cloud API number with the client's 6-digit PIN; request the initial app state and
> history sync for coexistence numbers; and read pricing analytics so the CRM can warn the
> client before free service conversations run out. We never create or send templates on the
> client's behalf, and each client pays Meta directly with their own payment method.

**whatsapp_business_messaging**

> AVANTE CRM lets each onboarded business answer the people who message it on WhatsApp. When
> a customer writes to the business number, the message appears in the CRM's Conversations
> screen and a lead is created in the client's sales pipeline. A salesperson then replies from
> the CRM, only inside the 24-hour customer service window; free-form replies outside the
> window, templates and bulk sending are blocked in the product. Delivery, read and failure
> statuses are shown next to each reply.

## 3. Roteiro do vídeo 1 — `whatsapp_business_messaging` (≈ 2 min)

Pré-requisito: primeiro teste oficial concluído na Empresa Teste A, com número conectado e
liberação só para a Teste A. Nenhuma mensagem para quem não escreveu antes.

1. **Abertura (5 s)**: navegador em `https://avante.riox7comunicacao.com.br` com a barra de
   endereço visível; legenda "AVANTE CRM — replying to a customer on WhatsApp".
2. **Contexto (10 s)**: Configurações › Integrações › WhatsApp mostrando o número conectado
   (legenda: "Business number connected through Embedded Signup").
3. **Cliente escreve (20 s)**: tela dividida, ou corte para o celular de teste do
   proprietário, mandando "Olá, quero saber dos planos" para o número da empresa.
4. **Chegada no CRM (20 s)**: Conversas mostrando a mensagem recebida, e o funil com o lead
   criado (legenda: "Incoming message creates a lead").
5. **Resposta (25 s)**: digitar a resposta no CRM e enviar; mostrar os status
   enviado → entregue (legenda: "Reply sent with the Cloud API").
6. **Recebimento (20 s)**: o mesmo celular (WhatsApp móvel ou Web) exibindo a resposta. É o
   ponto que a Meta exige ver.
7. **Bloqueios (15 s, opcional)**: aviso do CRM de que fora da janela de 24 h não há resposta
   livre e que modelos não são enviados.

Plano B, só se o vídeo 1 tiver de sair antes do teste oficial: a Meta aceita gerar o cURL no
painel API Setup do app e gravar a mensagem chegando num número de destinatário de teste.
Deixar claro na descrição que o produto final responde pelo CRM.

## 4. Roteiro do vídeo 2 — `whatsapp_business_management` (≈ 2 min 30 s)

A Meta pede para gravar o app, ou o WhatsApp Manager, **criando um modelo de mensagem**. O
AVANTE não cria modelos, então o vídeo mostra o uso real do produto e depois a criação no
WhatsApp Manager, que a Meta aceita explicitamente.

1. **Abertura (5 s)**: `avante.riox7comunicacao.com.br`, Configurações › Integrações ›
   WhatsApp, Empresa Teste A.
2. **Onboarding (60 s)**: cartão "API Oficial" → escolher funil, etapa e responsável → PIN →
   **Conectar WhatsApp** → janela oficial da Meta (login, escolha do portfólio e da conta do
   WhatsApp, número) → concluir. Legenda: "Client shares its own WhatsApp Business account
   via Embedded Signup".
3. **Uso da permissão (30 s)**: tela "Número conectado" com as etapas: conta lida, número
   conferido (nome verificado), webhook assinado e número registrado. Legenda: "We read the
   shared account and phone number, subscribe webhooks and register the number".
4. **Modelo no WhatsApp Manager (45 s)**: abrir o WhatsApp Manager da conta de teste ›
   Modelos de mensagem › Criar modelo (categoria Utilidade, nome `teste_app_review`, texto
   curto) › Enviar para análise. Legenda: "Message template created in WhatsApp Manager".
   Só criar o modelo. Ele nunca é enviado pelo AVANTE.
5. **Fecho (10 s)**: voltar ao AVANTE mostrando o número conectado.

## 5. Cuidados de gravação (os dois vídeos)

- Só Empresa Teste A e o celular de teste do proprietário; nenhum dado de cliente real.
- Nunca mostrar token, App Secret, PIN digitado (borrar), cURL com token ou tela de secrets.
- Resolução 1080p, legendas em inglês, sem cortes no momento em que a Meta precisa ver
  (mensagem chegando no celular; modelo criado).
- Gravar só depois das autorizações da fase: publicação dos pacotes, secrets `META_*`,
  webhook de produção e liberação da Teste A.
