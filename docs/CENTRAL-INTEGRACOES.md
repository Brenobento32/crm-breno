# Central de Integrações

Migration `20261104090000_central_integracoes.sql` (depende de `20261103090000`)
+ telas da Central, Super Admin, Sheets, WhatsApp e funil. Não publicada.

## Regras

- **Lançada** (chave global ou lista de homologação, como antes) **e permitida**
  (plano ou exceção do Super Admin). Não lançada nunca funciona nem aparece como
  operacional ("em breve").
- Plano: recursos cadastrados. `ingestao_leads` = captação completa (formulários
  + Google Sheets); **`formularios`** (novo) = só formulários (Formulário AVANTE,
  Respondi, webhook, credenciais de ingestão), sem Google Sheets; `whatsapp`;
  `meta_conversoes`. Para vender formulários no Starter sem abrir planilhas:
  marcar "Captação só por formulário" no plano e definir a quantidade de fontes.
- Exceção por empresa (`empresa_integracoes_regras`): liberar ou bloquear, com
  motivo, auditada em `admin_auditoria`. "Seguir o plano" remove a exceção.
- O bloqueio vale no banco: `integracao_habilitada()` exige permissão, e ela é
  chamada na conexão, na entrada de mensagens e no envio.
- Meta Ads: plano Business por padrão; outro plano só com liberação.
- Pedido de upgrade (`integracoes_solicitacoes`): registra o interesse; liberar
  pelo Super Admin atende o pedido. Nada é liberado sozinho.

## Limites (ausência de limite NÃO é ilimitado)

Três cotas independentes (uma não consome a outra):

| Cota | Coluna do plano | Conta | Vazio |
|---|---|---|---|
| Fontes de captação | `limite_integracoes` (já existia) | `uso_fontes()`: Formulário AVANTE, Respondi, webhook, Google Sheets, credenciais de ingestão | a definir: nenhuma fonte nova |
| Números de WhatsApp | `limite_numeros_whatsapp` (novo) | `uso_numeros_whatsapp()`: API oficial + app existente | a definir: nenhum número novo |
| Funis | `limite_funis` (novo) | funis ativos | a definir: só o 1º funil |
| Usuários | `limite_usuarios` | inalterado | inalterado |

- **Número de WhatsApp não gasta a cota de fontes** (a fonte `whatsapp_cloud` fica
  fora de `uso_fontes`); a Agenda Google também não (só o recurso do plano).
  `uso_integracoes()` (nome antigo, telas de assinatura) passa a ser a conta de fontes.
- Credencial de ingestão (Respondi via Apps Script) segue a permissão de
  formulários e a cota de fontes; vazio também é "a definir".
- Exceção por empresa: `empresa_limites` com recurso `fontes`, `numeros_whatsapp`
  ou `funis` (0 a 1000, com motivo, auditada). Prevalece sobre o padrão enquanto
  existir; vazio volta ao padrão do plano.
- Limite abaixo do uso (reduzido pelo Super Admin): nada é excluído nem
  desconectado; criações novas ficam barradas e o painel mostra o aviso.

### Padrões aprovados pelo proprietário (29/10/2026)

Gravados pela própria migration `20261104090000` (seção 5c), com registro
`planos_padroes_aprovados` na auditoria:

| Plano | Usuários | Fontes | Funis | Números WhatsApp | Meta Ads |
|---|---|---|---|---|---|
| Starter | 1 | 1 | 1 | 1 | não disponível (nem por exceção) |
| Pro | 3 | 3 | 3 | 3 | só com liberação individual do Super Admin |
| Business | 10 | 10 | 10 | 10 | incluído no plano |

- Starter recebe `formularios` (captação básica, sem Google Sheets) e `whatsapp`;
  Pro e Business recebem `whatsapp`; Business recebe `meta_conversoes`.
- Cota disponível não liga nada: WhatsApp e Meta Ads continuam dependendo da
  chave global (hoje desligada) e da homologação.
- Produção hoje (29/10): Teste A (Pro) com 5 usuários e Teste B (Starter) com 2
  já estão acima do limite de usuários (mesmo de antes): continuam, só não entram novos.
- O que já está em uso continua (só conexões/funis NOVOS são barrados).
- Empresa interna (Rio X7): sem limite de plano, como antes.
- Os dois cartões de WhatsApp contam no MESMO limite de números; o mesmo número
  (`phone_number_id`) nunca fica em duas empresas.

## Formulários e planilhas

Todas as colunas além de nome/telefone/e-mail/empresa/ID do lead ficam em
`negociacao_respostas` (por envio; pergunta repetida vira `_2`; vazia é
ignorada; reprocessar o mesmo envio atualiza sem duplicar; novo envio do mesmo
contato fica guardado à parte). Formulários por token (Respondi/webhook) passam
a guardar também as respostas sem pergunta cadastrada. Resumo (2 respostas) no
cartão do funil; lista completa na ficha do lead.

## WhatsApp — dois cartões, uma integração oficial

- **A — API Oficial:** número novo pela Cloud API (registro com PIN).
- **B — Conectar aplicativo existente:** coexistência oficial (Embedded Signup v4
  com `featureType: whatsapp_business_app_onboarding`). Os dois cartões mandam
  `setup: {}`, `version: 'v4'` e `sessionInfoVersion: '3'`, conferidos no verificador da Meta.
  O número continua no app do celular; a confirmação é feita no app, pelo
  código ou QR Code que a janela oficial da Meta mostrar. App 2.24.17+.
- Mesma permissão (`whatsapp_oficial`), mesmo limite, mesmos webhooks, custos e
  isolamento. Depois da coexistência, o servidor pede `smb_app_data`
  (`smb_app_state_sync` e `history`, 24 h, uma vez por tipo).
- Webhooks: `smb_message_echoes` (enviadas pelo app), `history` (até 180 dias,
  só se a empresa aceitar; recusa 2593109 registrada) e `smb_app_state_sync`.
  Histórico entra nas conversas, sem criar negociação.
- **`account_update`** (pacote 4, migration `20261105090000`):
  - `ACCOUNT_OFFBOARDED` (troca de aparelho ou novo registro no app) é temporário:
    o número em coexistência fica **pausado** (token mantido, "Retomar" barrado) e
    `ACCOUNT_RECONNECTED` retoma só o que o AVANTE pausou.
  - `PARTNER_REMOVED`, `PARTNER_APP_UNINSTALLED` (só do app AVANTE) e `ACCOUNT_DELETED`:
    o servidor confere na Meta, com o token de cada número, se o acesso acabou.
    Só então desconecta e apaga o token; conversas e leads ficam. Acesso mantido:
    só registra (e avisa no painel quando a Meta informou desconexão do app).
  - Conta pelo `waba_id` do banco; `PARTNER_*` usa `waba_info.waba_id`, nunca o `entry.id`.
  - Avisos registrados em `whatsapp_eventos_conta` (só servidor).
- **Sem WhatsApp Web, Baileys ou QR não oficial.** A demonstração local de
  espelhamento foi retirada do produto (servidor, telas e migration); o desenho
  ficou só como registro em `supabase/propostas/referencia_demo_whatsapp_qr_local.sql`
  (fora dos pacotes). `whatsapp-service/` (Baileys, sessão única, sem empresa)
  continua desligado e fora dos pacotes.
- Depende de teste real: elegibilidade do número, confirmação no app, assinatura
  dos campos de webhook no app da Meta, histórico real e cobrança.

## Testes locais

- SQL: `central_integracoes_test.sql` (96: L7–L10 cotas separadas, L11–L14 padrões,
  Meta por plano, exceções e limite abaixo do uso) +
  registro 50, Sheets 75, franquia/CAPI 86, monitoramento 48.
- Unitários: `lib/integracoes/central.test.ts`, `central-edge.test.ts`.
- Ponta a ponta (emulador): `C:\Tools\avante-local\integracoes-e2e.mjs` (176).
- Tela: `central-ui.mjs` (29), `integracoes-ui.mjs`, `paginas-publicas-ui.mjs`.
- Ensaio na cópia do backup de produção de 29/10: `20261103` → `20261104` sem
  recusa da trava; empresas, usuários, funis, fontes e planilha idênticos.
- Testes antigos `fontes_leads`, `superadmin_assinaturas` e `integracoes_multiempresa`
  param em "clientes legados" com ou sem a Central (falha anterior, sem relação).

## Publicação (cada passo com autorização)

1. Pacote 1 — páginas (`paginas-publicas` 99befc6): migration `20261102120000`
   + ZIP `avante-1-paginas-publicas-99befc6`.
2. Pacote 2 — WhatsApp + páginas (merge 34e0c76): migration `20261103090000`,
   deploy da Edge Function `integracoes`, ZIP `avante-2-whatsapp-com-paginas-34e0c76`.
3. Pacote 3 — Central (sobre o pacote 2): a migration `20261104090000` já grava
   os padrões aprovados dos planos (tabela acima) (recusa se alguma empresa com
   integração em uso perderia a permissão); deploy da `integracoes`; ZIP 3.
4. Pacote 4 — `account_update` + parâmetros v4 dos dois cartões: migration `20261105090000`, deploy da `integracoes`, ZIP 4.
5. Meta: assinar os campos de webhook (`messages`, `smb_message_echoes`, `history`,
   `smb_app_state_sync`, `account_update`) e homologar.
