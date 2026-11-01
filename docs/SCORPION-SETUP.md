# Scorpion CRM — Setup em outra máquina

> **DESATUALIZADO (01/11/2026).** Para máquina nova, Windows ou Mac, siga
> [`docs/CONTINUIDADE-WINDOWS-MAC.md`](CONTINUIDADE-WINDOWS-MAC.md). Este guia é anterior à migração
> para a Rio X7: o projeto Supabase citado na seção 8 (`lonyiyopurzxnczwrysm`) é o antigo da Scorpion
> e **não deve ser usado**; o projeto do AVANTE é `ybgzlxgeoiggmfdxarqx`. O site não usa mais a Vercel
> (publicação manual na Hostinger). O restante fica só como histórico.

Guia para configurar o projeto do zero numa máquina nova, a partir só do que
está no GitHub. Para arquitetura, modelo de dados e convenções de código, veja
[`docs/ARQUITETURA.md`](ARQUITETURA.md) — este documento cobre só o "como
rodar", não o "como o sistema funciona por dentro".

O repositório tem **dois projetos Node separados**, cada um com seu próprio
`package.json`:

- raiz (`/`): o CRM em si — Next.js 16.
- `whatsapp-service/`: serviço separado (conexão Baileys + gravação de
  mensagens no Supabase com a chave `service_role`). Roda independente do CRM.

Este guia cobre os dois, mas o CRM (raiz) é o essencial; o `whatsapp-service`
só é necessário se você for trabalhar na integração de WhatsApp.

## 1. Pré-requisitos

- **Node.js 20.9+** (o projeto não define `engines` no `package.json`; este é
  o mínimo que o README já assume).
- **npm** (vem com o Node).
- **Git**.
- Acesso autorizado ao repositório no GitHub, ao projeto no Supabase e,
  se for mexer em deploy, ao projeto na Vercel.
- Opcional, mas recomendado:
  - [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`) — só para
    recuperar variáveis de ambiente de produção sem digitá-las à mão.
  - Supabase CLI — não precisa instalar: todo comando deste projeto já roda
    via `npx supabase ...` (confirmado em `scripts/gerar-tipos.mts` e nos
    comandos deste guia), o `npx` baixa a versão certa na primeira execução.

## 2. Clonar o repositório

```bash
git clone https://github.com/Brenobento32/CRM-RX7.git
cd CRM-RX7
```

## 3. Instalar dependências

```bash
npm install
```

(No `whatsapp-service/`, só se for trabalhar nele: `cd whatsapp-service && npm install`.)

## 4. Configurar o ambiente local

```bash
cp .env.example .env.local
```

Preencha `.env.local` com os valores reais (seção 9 tem a lista completa de
variáveis). **Nunca** commite `.env.local` — o `.gitignore` já bloqueia
qualquer `.env*` (com exceção explícita de `.env.example`).

Você pode rodar `npm run setup` (`scripts/setup.mts`) a qualquer momento: ele
confere a versão do Node, instala dependências se faltarem, cria um
`.env.local` vazio a partir do template se ainda não existir, e diz **pelo
nome** quais variáveis obrigatórias ainda estão sem valor — nunca imprime
valor de nenhuma variável. Ele não executa `vercel env pull`, não faz
`supabase link`, não faz deploy nem migration; só detecta o que está instalado
e explica o próximo comando manual.

## 5. Autenticar no GitHub

Se ainda não tiver uma credencial configurada nesta máquina:

```bash
gh auth login
```

(ou configure uma chave SSH / token de acesso pessoal, pelo método que
preferir — o `gh auth login` é só o caminho mais simples.)

## 6. Autenticar na Vercel

```bash
npm i -g vercel   # se ainda não tiver a CLI
vercel login
```

## 7. Recuperar variáveis de ambiente da Vercel (quando possível)

Com a CLI autenticada e o projeto vinculado:

```bash
vercel link
vercel env pull .env.local
```

Isso **sobrescreve** `.env.local` com os valores de produção/preview
configurados na Vercel. Se você já tinha um `.env.local` com valores próprios
(ex.: apontando pra um projeto Supabase de teste), faça backup antes.

Se você não tiver acesso à Vercel do projeto, preencha `.env.local`
manualmente com os valores do Supabase (seção 8) — as variáveis do CRM nunca
dependem exclusivamente da Vercel, só é mais rápido buscá-las lá quando dá.

## 8. Vincular ao projeto Supabase

O projeto Supabase usado pelo CRM tem o ref `lonyiyopurzxnczwrysm` (não é um
segredo — é o identificador público que já aparece na própria URL
`https://lonyiyopurzxnczwrysm.supabase.co`; sozinho ele não dá acesso a nada).

```bash
npx supabase login
npx supabase link --project-ref lonyiyopurzxnczwrysm
```

O `login` abre o browser para autenticação na sua conta Supabase — só quem já
tem acesso ao projeto consegue de fato vincular.

## 9. Variáveis de ambiente

| Variável | Obrigatória | Onde é usada | Origem | É segredo? |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | sim | browser e servidor | Supabase → Project Settings → API | não — é pública por natureza (prefixo `NEXT_PUBLIC_`, vai pro bundle do browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | sim | browser e servidor | Supabase → Project Settings → API | não — é a chave pública (`anon`); sem acesso a nada que a RLS não libere pro usuário logado |
| `NEXT_PUBLIC_SITE_URL` | não (padrão `http://localhost:3000`) | servidor (redirects de auth, links de e-mail) | você define | não — é uma URL pública. Em produção: `https://scorpion-crm.vercel.app` |
| `SUPABASE_SERVICE_ROLE_KEY` | **só no `whatsapp-service/`, nunca no CRM** | servidor (processo separado) | Supabase → Project Settings → API | **sim, é segredo** — ignora RLS por completo |
| `SUPABASE_URL` (`whatsapp-service/.env`) | sim, nesse serviço | servidor | mesma do item acima, mesmo projeto | não |

O `whatsapp-service` tem seu **próprio** `.env` (não `.env.local`) — copie
`whatsapp-service/.env.example` para `whatsapp-service/.env` do mesmo jeito.
A `SUPABASE_SERVICE_ROLE_KEY` só existe ali, nunca no `.env.local` do CRM —
ver o aviso em `.env.example` e a regra em `CLAUDE.md`.

## 10. Gerar os tipos do banco

```bash
npm run db:types
```

Regera `lib/types/database.ts` a partir do schema **real** do projeto já
vinculado (`--linked`). Só funciona depois do passo 8. Para gerar a partir de
um Supabase local (`supabase start`), use `npm run db:types:local`.

## 11. Executar os testes

```bash
npm run test
```

Testes de lógica pura (`lib/utils/**`, `lib/validations/**`, scripts de
importação) — não tocam no banco.

## 12. Typecheck

```bash
npm run typecheck
```

## 13. Lint

```bash
npm run lint
```

## 14. Build

```bash
npm run build
```

O build **falha de propósito** se `NEXT_PUBLIC_SUPABASE_URL`/
`NEXT_PUBLIC_SUPABASE_ANON_KEY` estiverem ausentes (`lib/env/public.ts` lança
um erro explícito) — qualquer valor sintaticamente presente já é suficiente
pra passar do build, mesmo que não seja um projeto Supabase real; só pra
rodar a aplicação de verdade (`npm run dev`/`npm run start` contra dados
reais) que os valores precisam ser os do projeto certo.

## 15. Iniciar o ambiente local

```bash
npm run dev
```

Sobe em `http://localhost:3000`.

## 16. Verificar produção

- App: `https://scorpion-crm.vercel.app`.
- Deploys: painel da Vercel do projeto (`vercel ls`, ou direto no
  dashboard).
- Banco, só leitura, sem aplicar nada:

  ```bash
  npx supabase db query --linked "select 1;"
  ```

  Qualquer consulta de leitura (contagens, `pg_policies`, `pg_trigger` etc.)
  pode ser feita assim, sempre contra o projeto já vinculado no passo 8.

## 17. Como trabalhar com migrations

- Toda migration nova vai em `supabase/migrations/<timestamp>_<nome>.sql`,
  seguindo o padrão de timestamp já usado nos arquivos existentes.
- Escreva também o dry-run correspondente em `supabase/tests/<nome>_dry_run.sql`
  — um bloco `begin; ... rollback;` autocontido, que nunca deixa nada
  gravado (ver qualquer arquivo em `supabase/tests/` como exemplo).
- Valide **sempre** antes de aplicar:

  ```bash
  npx supabase db push --dry-run --linked
  ```

- **Nunca** rode `npx supabase db push --linked` (sem `--dry-run`) a não ser
  que isso tenha sido pedido e autorizado explicitamente — é uma alteração
  real em produção. O fluxo de trabalho deste projeto é
  investigar → implementar → testar → revisar → aplicar só com autorização
  explícita (ver `CLAUDE.md`).

## 18. Como NÃO expor segredos

- Nunca commitar `.env`, `.env.local`, `.env.production` ou qualquer
  variante — o `.gitignore` já bloqueia `.env*` (com a exceção explícita de
  `.env.example`).
- Nunca colocar `SUPABASE_SERVICE_ROLE_KEY` no CRM (raiz) — ela só existe no
  `whatsapp-service`, um processo separado, nunca em código importado por
  página/action do Next.js. Ela ignora a RLS por completo.
- Nunca imprimir valor de variável de ambiente em log, script ou mensagem de
  commit — `scripts/setup.mts` só imprime **nomes** de variáveis faltando,
  nunca valores.
- Nunca usar `git add .` às cegas — sempre revisar `git status --short` e
  fazer staging explícito do que é intencional.
- Antes de qualquer commit, procurar por `service_role`, `BEGIN PRIVATE KEY`,
  tokens e senhas reais no que será commitado.

## 19. Sessão do WhatsApp (separado do Git)

A sessão do WhatsApp (pasta `auth_info_baileys/` e qualquer backup tipo
`auth_info_baileys_backup_*`/`auth_info_baileys_old_*` dentro de
`whatsapp-service/`) **nunca faz parte do Git** — está no `.gitignore` do
`whatsapp-service` (`auth_info_baileys/` e `auth_info_baileys_*/`).

Isso significa que uma máquina nova **não herda** a sessão conectada. Duas
opções, nessa ordem de preferência:

1. **Reconectar do zero** (mais simples e mais seguro): rode o
   `whatsapp-service` na máquina nova e escaneie o QR Code de novo com o
   WhatsApp da empresa. Não depende de copiar nenhum arquivo.
2. **Transferir a sessão existente**, só se reconectar não for viável: copie a
   pasta `auth_info_baileys/` manualmente, por um canal seguro (nunca por
   e-mail, chat ou qualquer lugar que vire histórico permanente, e nunca pelo
   Git). Esses arquivos (`creds.json`, `pre-key-*.json`,
   `app-state-sync-key-*.json`) equivalem a uma sessão logada — quem tiver
   acesso a eles acessa o WhatsApp da empresa sem precisar escanear nada.

Nenhum script deste projeto copia, lê ou publica esses arquivos
automaticamente — isso é deliberado.
