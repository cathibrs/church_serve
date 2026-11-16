# Escala de Voluntários (versão web)

Site em React publicado no Netlify. A API (`/api/*`) roda em Netlify Functions, os dados ficam em
Postgres no Neon e o acesso é por login individual (Neon Auth). A planilha
`POSICIONAMENTO E TAREFAS.xlsx` só é usada uma vez, na carga inicial.

```
netlify.toml (na raiz)     configuração da publicação
app/web/
  src/                     telas (React + Tailwind)
  netlify/functions/api.ts entrada da API
  server/                  regras da escala, banco, login e rotas
  db/schema.sql            tabelas do Postgres
  scripts/import.ts        carga inicial (SQLite antigo + planilha)
```

## Publicar pela primeira vez

Precisa de Node 24, uma conta no [Neon](https://neon.com) e uma no [Netlify](https://netlify.com).
Os comandos `npm` rodam nesta pasta (`app/web`); os comandos `netlify` rodam na raiz do projeto,
onde está o `netlify.toml`.

### 1. Banco e login no Neon

1. Crie um projeto no Neon na região **AWS US East (Ohio), `aws-us-east-2`**. É a região onde as
   funções do Netlify rodam por padrão; banco e funções na mesma região deixam o sistema mais rápido.
2. No projeto, abra **Auth** e ative. Em *Configuration*, ligue **Verify email at signup**
   (confirmação do e-mail por código).
3. Copie `.env.example` para `.env` e preencha com os valores do Console do Neon:
   `DATABASE_URL` (conexão *pooled*), `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` e `VITE_NEON_AUTH_URL`.
4. Em `ALLOWED_EMAILS`, liste os e-mails de quem pode usar a escala.

### 2. Carga inicial dos dados

```bash
npm install

# ensaio: confere os arquivos em um banco temporário, sem tocar no Neon
npm run import -- --db ../../data/igreja_escala.db --xlsx "../../POSICIONAMENTO E TAREFAS.xlsx" --dry-run

# carga de verdade
npm run import -- --db ../../data/igreja_escala.db --xlsx "../../POSICIONAMENTO E TAREFAS.xlsx"
```

O comando mostra quantas linhas leu e quantas gravou em cada tabela. O que ele faz:

- copia do banco antigo os voluntários (com inativos, permissões e observações), as escalas, os
  itens e as presenças/faltas, mantendo os mesmos números de identificação;
- lê a aba `BASE_TAREFAS` da planilha: atualiza gênero e equipe de quem já existe e cria quem só
  está na planilha;
- só transforma as contagens da planilha em histórico quando não há banco antigo (`--xlsx` sozinho),
  porque a planilha atual já soma as escalas do banco;
- recusa rodar se o Neon já tiver voluntários. Para apagar tudo e importar de novo, use `--force`.

### 3. Site no Netlify

1. Crie o site apontando para este repositório (ou use `netlify deploy --build --prod` na raiz).
   O `netlify.toml` já informa a pasta, o comando de build e as funções.
2. Em **Site configuration > Environment variables**, cadastre as cinco variáveis do `.env`.
3. No Neon, em **Auth > Domains**, adicione o endereço do site (ex.: `https://escala-lagoinha.netlify.app`).
   Sem isso o login responde `invalid domain`.
4. Publique de novo depois de mudar variáveis: elas só valem a partir da publicação seguinte.

### 4. Primeiro acesso

Cada líder abre o site, clica em **Criar conta**, informa o e-mail que está em `ALLOWED_EMAILS` e
confirma com o código recebido por e-mail. Quem criar conta com outro e-mail entra na tela
"Sem acesso" e não vê nenhum dado.

Para liberar ou remover alguém: edite `ALLOWED_EMAILS` no Netlify e publique de novo.

Os e-mails de código saem pelo remetente compartilhado do Neon (`auth@mail.myneon.app`) e podem
cair no spam. Para uso contínuo, o Neon recomenda configurar um SMTP próprio
(<https://neon.com/docs/auth/production-checklist>).

## Desenvolver

```bash
npm install -g netlify-cli   # uma vez
npm run dev                  # site + API em http://localhost:8888 (usa o app/web/.env)
npm test                     # regras da escala, API e importação
npm run typecheck
npm run build
```

- `npm test` não precisa de internet nem do Neon: a API é testada sobre um Postgres embutido.
- `server/parity.test.ts` garante que o motor em TypeScript gera a mesma escala do motor antigo em
  Python. Os casos ficam em `server/fixtures/parity.json` e são refeitos com
  `py -3 scripts/gen_parity.py` (precisa da pasta `app/escala`).

## O que mudou em relação ao programa de Windows

- Não existe mais `EscalaIgreja.exe`, nem banco em arquivo, nem pasta `exports`.
- O sistema não gera mais a planilha `.xlsx` de cada culto. Continuam: mapa em PNG, ficha em PNG e impressão.
- A marcação "Falta = Sim" feita na planilha deixou de existir; as faltas são marcadas na tela de presença.
- Os horários ("Salvo às...") usam o fuso de São Paulo.
- As posições do mapa e da ficha ficam em `server/config.ts`, não no banco.

O código Python (`app/escala`), a interface antiga já compilada (`app/static`), os executáveis,
`data/` e `exports/` continuam na pasta como cópia de segurança e não fazem parte do site.
O `app/build.bat`, que gerava o executável, não é mais mantido.

O `.gitignore` da raiz deixa banco, planilhas, exportações, executáveis e `node_modules` fora do
repositório. Ele só vale para arquivos que ainda não foram adicionados: se você rodou `git add`
antes de o `.gitignore` existir, refaça a seleção antes do primeiro commit:

```bash
git rm -r --cached -q .   # tira tudo da seleção (não apaga nenhum arquivo)
git add .                 # seleciona de novo, agora respeitando o .gitignore
git status --short | grep -E "data/|exports/|xlsx|\.exe|\.db"   # não deve listar nada
```
