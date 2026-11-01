# AVANTE CRM — continuar o trabalho no Windows ou no Mac

Guia para trabalhar no mesmo projeto em qualquer computador sem perder código, contexto nem
segurança. Atualizado em 01/11/2026 (Pacote 8). **Este é o guia válido para máquina nova.** O
`docs/SCORPION-SETUP.md` é anterior à migração para a Rio X7 e cita outro projeto Supabase e a
Vercel: não siga as seções 6 a 8 dele.

## 1. Onde está cada coisa

| Item | Onde | Observação |
| --- | --- | --- |
| Código | GitHub `Brenobento32/CRM-RX7`, branch `main` | fonte única da verdade; nada de deploy automático a partir do push (não há `.github/`) |
| Banco, Auth, Storage, Edge Functions | Supabase, projeto `ybgzlxgeoiggmfdxarqx` | **único** projeto autorizado. Nunca usar `lonyiyopurzxnczwrysm` (projeto antigo da Scorpion) |
| Site | Hostinger, app Node.js de `avante.riox7comunicacao.com.br` | publicação **manual** por ZIP no hPanel |
| Integrações | Google Cloud (OAuth do Sheets), app Meta "AVANTE CRM" | ver `docs/INTEGRACOES-OFICIAIS.md` e `docs/META-ADS-MULTIEMPRESA.md` |
| Segredos | Supabase (Vault e secrets das funções), `.env.local` de cada máquina, gerenciador de senhas | **nunca** no GitHub |

## 2. Arquitetura e dependências

- **Next.js 16.3.6** (App Router), **React 19.2**, TypeScript 5, Tailwind. Build de produção:
  `npm run build` (= `next build --webpack`). Leia `AGENTS.md`: esta versão do Next difere do que
  ferramentas e modelos costumam supor (`proxy.ts`, `await` em `params`/`searchParams`).
- **Node 22** (`.nvmrc` = 22; a Hostinger compila com Node 22.x). Use 22 também no Mac.
- **Supabase**: Postgres com RLS (a segurança real), Vault, Edge Functions em Deno (`supabase/functions`).
  CLI sempre por `npx supabase ...` (não precisa instalar). Checagem das funções:
  `npx -y deno@2.5.6 check --no-config supabase/functions/integracoes/index.ts`.
- **Testes**: Vitest (`npm run test`, lógica pura em `lib/**`), `npm run typecheck`, `npm run lint`.
  Os testes SQL de `supabase/tests/` rodam só em cópia local descartável do banco, nunca em produção.
- **`whatsapp-service/`**: projeto Node separado (Baileys). **Desligado e assim deve ficar**: o WhatsApp
  do produto é a Cloud API oficial.
- Regras completas: `CLAUDE.md`, `docs/ARQUITETURA.md`, `docs/SCORPION-MASTER.md`.

## 3. Preparar o Mac (uma vez)

```bash
# ferramentas
xcode-select --install                 # git
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install nvm gh                    # ou fnm/volta no lugar do nvm
nvm install 22 && nvm use 22

# código
gh auth login                          # conta com acesso ao repositório
git clone https://github.com/Brenobento32/CRM-RX7.git
cd CRM-RX7
npm ci

# ambiente (valores do painel do Supabase: Project Settings → API; nunca copiados pelo GitHub)
cp .env.example .env.local             # preencher NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SITE_URL
npm run setup                          # confere Node, dependências e quais variáveis faltam (não mostra valores);
                                       # a sugestão de instalar a Vercel CLI que ele imprime é antiga: ignore

# Supabase CLI (só para quem publica)
npx supabase login
npx supabase link --project-ref ybgzlxgeoiggmfdxarqx   # conferir o ref ANTES de qualquer comando --linked

# conferência
npm run test && npm run typecheck && npm run lint
npm run dev                            # http://localhost:3000
```

O `.env.local` só tem as três variáveis públicas do `.env.example`. A chave `service_role` e os segredos
das integrações (Meta, Google, WhatsApp) ficam no Supabase e **não** vão para o Mac nem para o GitHub.

## 4. Claude Code no Mac

- A sessão do Claude usada até agora é **local**: roda no app Claude do Windows, com o histórico salvo
  só nesse computador (`%USERPROFILE%\.claude\projects\...`). **Histórico de sessões e a memória
  automática não sincronizam** entre computadores.
- No Mac: instalar o app Claude, entrar com a mesma conta, abrir a aba **Code** e escolher a pasta do
  clone (`CRM-RX7`). O Claude lê sozinho `CLAUDE.md`, `AGENTS.md` e os subagentes de `.claude/agents/`
  (versionados no repositório).
- Primeira mensagem sugerida numa sessão nova: "Leia `CLAUDE.md`, `docs/CONTINUIDADE-WINDOWS-MAC.md` e
  `docs/SCORPION-MASTER.md` antes de começar. Comunicação em português brasileiro."
- Subagentes disponíveis (todos somente leitura): `avante-revisor`, `avante-testador`,
  `avante-auditor-seguranca`, `avante-integracoes`.
- Arquivos locais do Claude que **não** vão para o GitHub: `.claude/launch.json` (aponta para
  ferramentas `C:\Tools` do Windows) e `.claude/settings.local.json`, se existir. No Mac, crie os seus.

## 5. Estado em 01/11/2026 (Pacote 8)

- `main` = `42f8bdd`; última migration aplicada `20261108090000_funil_deduplicacao_leads`; Edge
  Functions `integracoes` v18, `meta-webhooks` v3; Hostinger com `avante-8-funil-42f8bdd-app.zip`.
- Funil: Lead Novo ordenado pela data real do envio; filtro "Entrada do lead"; qualificação recolhida no
  painel lateral; deduplicação por ID do lead da Meta, telefone e e-mail.
- Google Sheets: operacional, liberado só para Rio X7 Agência Digital e Empresa Teste A. Consentimento
  OAuth ainda em "Teste" (token de 7 dias; ver `docs/GOOGLE-OAUTH-PUBLICACAO.md` quando versionado).
- Meta Ads: só a conta de anúncios da Rio X7 (BM Bento) conectada, leitura de métricas. Nenhuma Página,
  dataset, Conversions API ou número de WhatsApp conectado. Chaves globais desligadas. App Meta não
  publicado.
- Próximas etapas registradas (cada uma com autorização): `docs/META-ADS-MULTIEMPRESA.md`.

## 6. Como desenvolver e publicar (mesmo processo nas duas máquinas)

Ordem fixa: investigar → implementar → testar → revisar (`typecheck`, `lint`, `build`, diff) → commit →
push → deploy. Migration e deploy em produção só com autorização explícita do proprietário para aquele
pacote.

1. Branch própria; staging explícito arquivo por arquivo (nunca `git add .`); conferir
   `git status --short` e `git diff --cached`.
2. Push para `main` em avanço direto (sem `--force`).
3. **Backup** antes de mudar o banco: `pg_dump` do schema `public` (formato custom) mais os dados de
   `auth.users`, `auth.identities` e `storage.buckets`, com a senha digitada pelo proprietário na hora e
   pasta nova fora do repositório. Só vale depois de restaurado numa base local e conferido pelas
   contagens. No Windows isso é o `backup.ps1` local; no Mac, refazer o mesmo com `pg_dump` do
   PostgreSQL 17 (`brew install postgresql@17`).
4. `npx supabase db push --linked --dry-run` → deve listar só a migration do pacote; depois sem `--dry-run`.
5. `npx supabase functions deploy <função> --no-verify-jwt --project-ref ybgzlxgeoiggmfdxarqx`.
6. ZIP do site, reproduzível, a partir do commit:
   ```bash
   git archive --format=zip -o avante-N-nome-$(git rev-parse --short HEAD)-app.zip HEAD -- . \
     ':(exclude)scripts' ':(exclude)apps-script' ':(exclude)whatsapp-service' \
     ':(exclude)supabase/propostas' ':(exclude).env.example' ':(exclude,glob)**/*.sh'
   ```
   hPanel → Implantações → Configurações e reimplantação → "Carregar novos arquivos" → "Salvar e
   reimplantar" (as variáveis do site já ficam na Hostinger; o log mostra "variables loaded from .env").
7. Conferir em produção (só leitura) e registrar versão e reversão.

## 7. Cuidados

- Só este projeto. Não abrir nem alterar o RIO X7 AI Agency OS nem outros projetos, sites ou DNS.
- Nunca versionar `.env*` (exceto `.env.example`), tokens, chaves, backups, dumps, sessões do WhatsApp
  (`whatsapp-service/auth_info_baileys*`), dados de clientes nem `supabase/.temp/`.
- `supabase/propostas/` são propostas do proprietário: nunca aplicadas sem autorização própria.
- Baileys e WhatsApp Web não oficial continuam desligados.
- Ao alternar de máquina: `git pull` antes de começar e push ao terminar; nunca deixar a mesma alteração
  pela metade em dois computadores.

## 8. O que existe só no Windows (fora do GitHub)

| Item | Para que serve | No Mac |
| --- | --- | --- |
| Alterações locais não versionadas: `next.config.ts` (posição do indicador de desenvolvimento), `docs/GOOGLE-OAUTH-PUBLICACAO.md`, `docs/meta-app/avante-icone-app-1024.jpg`, `supabase/functions/_shared/meta-conversoes-mensagens.ts` e teste (Click-to-WhatsApp, em proposta), `supabase/propostas/*` | trabalho em andamento | versionar o que for aprovado, depois de auditoria; até lá, só existe no Windows |
| Branch local `pacote-5-inscricao-waba` | 1 commit substituído (nunca publicado) | não precisa |
| `C:\Tools\avante-local` (servidor local, emulador de Google/Meta, testes de tela, seeds) | testes locais com dados fictícios | copiar a pasta **sem** `segredos.json` (senhas de teste: recriar); trocar caminhos `C:/Tools/...`, `psql.exe` e do Chrome |
| `C:\Tools\crm-rx7` (scripts `.ps1`/`.sh`, consultas SQL de conferência, registros de publicação, `wt-pub`, pastas `pubN`) | publicação controlada | levar só as consultas `.sql` e os registros `.md`; **não** levar `segredos\`, `pubN\supabase\.temp`, ZIPs nem `wt-pub` (refazer com `git worktree`) |
| `C:\Tools\pg17` e bases locais `crm_rx7_*` (porta 5543) | PostgreSQL local para testes | `brew install postgresql@17`; recriar as bases a partir das migrations. As bases `crm_rx7_bkp_*` contêm **dados reais**: não copiar |
| `C:\Backups\crm-rx7` | backups reais do banco (com hashes de senha) | **não copiar**; fazer backups novos quando publicar pelo Mac |
| `.env.local`, login do Supabase CLI, `gh`, sessões do Chrome (hPanel, Meta, Google Cloud) | acesso | refazer no Mac (seção 3); senhas só no gerenciador de senhas |
| Memória e histórico do Claude | contexto das sessões | não sincronizam; este documento e `docs/` são o contexto oficial |

Se precisar mesmo levar algum arquivo local que não vai para o GitHub, use mídia criptografada ou o
gerenciador de senhas (para segredos), nunca e-mail, chat nem repositório.
