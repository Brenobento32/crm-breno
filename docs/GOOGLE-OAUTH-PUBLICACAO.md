# Google OAuth do AVANTE — uso contínuo pelos clientes

> **Atualização em 01/11/2026.** O Google Sheets está liberado para a **Rio X7 Agência Digital** e a
> **Empresa Teste A**; a Rio X7 tem 1 planilha conectada e sincronizando. O app OAuth **continua em
> "Teste"**, então os dois refresh tokens valem 7 dias: o da Teste A vence por volta de **04/11** e
> o da Rio X7 (conectado em 01/11) por volta de **08/11**. Passar para "Em produção" (opção A abaixo,
> sem verificação, porque os escopos não são sensíveis) só pode ser feito pela conta dona do projeto
> no Google Cloud; nenhuma alteração no Client ID, nos escopos nem nos redirecionamentos é
> necessária para isso. Depois de publicar, reconectar as duas contas uma vez. A seção
> "Pendências do Google Sheets" abaixo é o registro de 28/10.

Estado em 28/10/2026: o app OAuth **"AVANTE CRM"** (projeto Google Cloud `avante-crm-513014`)
está em **Teste**, tipo **Externo**, com 1 usuário de teste (a conta da Rio X7). Os escopos são
só `openid`, `userinfo.email` e `drive.file`, todos **não sensíveis**. O Google Sheets está
liberado só para a Empresa Teste A.

## Por que não dá para ficar em "Teste"

- Em "Teste", só os usuários de teste cadastrados (até 100) conseguem autorizar.
- O Google emite o refresh token com **validade de 7 dias** para app externo em "Teste". A conta
  conectada em 28/10 às 13:16 deixa de funcionar por volta de **04/11**. A partir daí o painel
  pede "Reconectar", os avisos do Drive param e a planilha não é lida até reconectar.
- Fonte: [OAuth 2.0 — expiração do refresh token](https://developers.google.com/identity/protocols/oauth2#expiration).

## O que o Google exige (documentação oficial)

- **Verificação do app**: obrigatória só para escopos *sensíveis* ou *restritos*. Com só escopos
  não sensíveis (o nosso caso), "não é obrigatória".
  ([Verificação de apps OAuth](https://support.google.com/cloud/answer/13463073))
- **Verificação da marca** (*brand verification*): necessária para o consentimento mostrar o
  **nome e o logo** do app. Sem ela, o usuário vê só o domínio do app. Hoje aparece
  `ybgzlxgeoiggmfdxarqx.supabase.co`. Para a marca ser verificada:
  ([Branding](https://support.google.com/cloud/answer/15549049))
  - página inicial num domínio **verificado e nosso**, descrevendo o app e com link para a
    política de privacidade;
  - política de privacidade no **mesmo domínio**, explicando o uso dos dados do Google;
  - termos de uso;
  - **todos os domínios do projeto como domínios autorizados**, inclusive os do redirecionamento
    e da origem do cliente OAuth;
  - logo JPG, PNG ou BMP, até 1 MB, de preferência 120×120.

## O ponto que muda o caminho

O endereço de retorno do OAuth hoje é
`https://ybgzlxgeoiggmfdxarqx.supabase.co/functions/v1/integracoes/google/callback`, e
**`supabase.co` não é um domínio nosso**. Por isso, a verificação da marca não pode ser feita
como está. São duas opções:

| Opção | O que muda | Custo/esforço |
|---|---|---|
| **A. Publicar sem verificar a marca** | Passa para "Em produção". Acaba o limite de 7 dias e o de 100 usuários. O consentimento continua mostrando `…supabase.co`, sem o nome AVANTE | Nenhuma mudança de código; o Google pode pedir revisão se o uso crescer |
| **B. Retorno pelo domínio do AVANTE** (recomendada) | Callback em `https://avante.riox7comunicacao.com.br/...`, que repassa para a função. Com isso, `riox7comunicacao.com.br` fica como único domínio autorizado, e a marca pode ser verificada | Pequena mudança de código, migration nenhuma, deploy controlado. Alternativa: domínio próprio no Supabase, um complemento pago |

## Procedimento recomendado (cada passo com autorização)

1. **Páginas públicas** em `avante.riox7comunicacao.com.br`:
   - página inicial do produto, que não pode ser só o login;
   - `/privacidade`, explicando que o app lê só a planilha escolhida pelo usuário (`drive.file`),
     não grava nada na planilha e guarda o token cifrado;
   - `/termos`.
2. **Google Search Console**: verificar a propriedade de `riox7comunicacao.com.br`, com a mesma
   conta Google que administra o projeto.
3. **Opção B no código**: rota de retorno no site do AVANTE, que repassa `code` e `state` para a
   função `integracoes`. A função continua conferindo o state assinado e o nonce de uso único.
   Depois, trocar no cliente OAuth o URI de redirecionamento e as origens.
4. Na **tela de consentimento → Branding**: preencher o nome "AVANTE CRM", o logo, a página
   inicial, a privacidade, os termos e o domínio autorizado `riox7comunicacao.com.br`. Enviar para
   verificação da marca (a análise inicial costuma levar minutos; casos indeterminados vão para
   revisão).
5. Em **Público → Publicar app**: passar de "Teste" para "Em produção". Como os escopos não são
   sensíveis, não há avaliação de segurança.
6. **Reconectar a conta Google da Teste A** uma vez, para obter um refresh token sem o limite de 7
   dias. Os avisos do Drive voltam sozinhos na rodada seguinte do agendador.
7. Só depois **liberar outras empresas**, uma por vez, pela lista de liberação.

Até lá: reconectar a conta da Teste A antes de ~04/11, se a homologação precisar continuar.

## Pendências do Google Sheets (registradas)

- **Renovação do canal do Drive**: o canal atual vence em **29/10 às 17:15:04**. A partir de
  ~29/10 15:15, o agendador cria um canal novo e encerra o antigo. Conferir só por leitura,
  depois desse horário, sem forçar renovação:
  - um canal `ativo` novo, com vencimento por volta de 30/10;
  - o anterior `encerrado`, com motivo "encerrado pelo agendador";
  - a planilha continua com 5 importados e 0 falhas.
- **Funil atualizado sozinho** (melhoria futura): quando um lead chega pelo aviso do Google, o card
  só aparece ao recarregar a página. A ideia é mostrar um aviso discreto ("1 lead novo — mostrar")
  ou atualizar a coluna sem tirar o usuário do que está fazendo (sem recarregar e sem perder
  arrasto ou modal aberto). Fica registrada **aqui**, no planejamento do AVANTE.
  (`SCORPION-ROADMAP.md` é o roadmap histórico do Scorpion e não recebe itens do AVANTE.)
