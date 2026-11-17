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
  shared/catalog.ts        posições, equipes e regras fixas (usado pelo site e pela API)
  db/schema.sql            tabelas do Postgres
  scripts/import.ts        carga inicial (SQLite antigo + planilha)
```

## Publicar pela primeira vez

Precisa de Node 24, uma conta no [Neon](https://neon.com) e uma no [Netlify](https://netlify.com).
Os comandos `npm` rodam nesta pasta (`app/web`); os comandos `netlify` rodam na raiz do projeto,
onde está o `netlify.toml`.

### 1. Banco e login no Neon

O projeto do Neon é descrito em `neon.ts` (Postgres + Auth) e administrado pela CLI:

```bash
npm i -g neon          # uma vez
neon login             # abre o navegador
neon link              # vincula esta pasta a um projeto (grava .neon)
neon deploy            # cria o que neon.ts declara e grava as variáveis em .env.local
```

- Use a região **AWS US East (Ohio), `aws-us-east-2`**: é onde as funções do Netlify rodam por
  padrão, e banco e funções na mesma região deixam o sistema mais rápido.
- `neon deploy` e `neon env pull` gravam `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
  `NEON_AUTH_BASE_URL` e `NEON_AUTH_JWKS_URL` em `.env.local` (modelo em `.env.example`).
- O site exige e-mail confirmado por código mesmo que a opção *Verify email at signup* do Neon
  esteja desligada (é o padrão): quem entra sem confirmar cai na tela do código.

### 2. Carga inicial dos dados

```bash
npm install

# ensaio: confere os arquivos em um banco temporário, sem tocar no Neon
npm run import -- --db ../../data/igreja_escala.db --xlsx "../../POSICIONAMENTO E TAREFAS.xlsx" --dry-run

# carga de verdade
npm run import -- --db ../../data/igreja_escala.db --xlsx "../../POSICIONAMENTO E TAREFAS.xlsx"
```

Da raiz do projeto o mesmo comando funciona, com os caminhos a partir dela:
`npm run import -- --db data/igreja_escala.db --xlsx "POSICIONAMENTO E TAREFAS.xlsx"`.

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
2. Em **Project configuration > Environment variables**, cadastre `DATABASE_URL` e
   `NEON_AUTH_BASE_URL` (os valores estão no seu `.env.local`). Só a API usa essas variáveis: nenhuma
   é embutida no site durante o build. A página pede o endereço do login à API (`/api/config`) quando
   abre. `NEON_AUTH_JWKS_URL` é opcional: sem ela, a API usa `NEON_AUTH_BASE_URL` + `/.well-known/jwks.json`.
3. Libere o endereço do site no login do Neon; sem isso o login responde `invalid domain`:
   `neon neon-auth domain add https://seu-site.netlify.app`
4. Publique de novo depois de mudar variáveis: elas só valem a partir da publicação seguinte.
   O navegador guarda o endereço do login por até uma hora; se você trocar `NEON_AUTH_BASE_URL`,
   quem abriu o site há pouco pode levar esse tempo para receber o novo.

### 4. Primeiro acesso e administradores

Quem pode entrar fica na tabela `app_users` do banco, com um papel:

- **Coordenador**: tem uma ou mais equipes e só vê e altera a escala, os voluntários e o histórico
  dessas equipes. A API recusa qualquer pedido sobre outra equipe.
- **Administrador**: vê todas as equipes e libera e remove e-mails na tela **Acessos**.

O primeiro administrador é criado pelo terminal (o mesmo comando serve para recuperar o acesso se
ninguém mais conseguir entrar na tela Acessos). Se o e-mail ainda não tiver conta de login, o
comando cria uma e mostra a senha:

```bash
npm run admin -- pessoa@exemplo.com
```

Daí em diante é tudo pelo site, na tela Acessos:

- **Liberar um e-mail** (para coordenador, escolhendo as equipes dele) cria a conta de login da
  pessoa com uma **senha aleatória**, mostrada uma única vez ao administrador, que a repassa. A
  conta já nasce com o e-mail confirmado: a pessoa entra direto, sem cadastro e sem código. O
  sistema não guarda a senha.
- **A pessoa troca a senha se quiser**, em "Alterar senha" no menu. Não é obrigatório.
- **Gerar nova senha** (ícone de chave na linha) serve para quando a senha se perde: a anterior
  deixa de valer, a pessoa é desconectada e a nova aparece para o administrador.
- **Remover** um e-mail bloqueia a pessoa na hora; não é preciso publicar o site de novo.

A tela de login não tem "criar conta". O serviço de login do Neon ainda aceita cadastros feitos
direto no endereço dele, mas uma conta assim não entra no sistema: a API só atende e-mails
liberados na tela Acessos.

Como a conta é criada ([`server/accounts.ts`](server/accounts.ts)): a API chama o cadastro do Neon
Auth com a senha sorteada, marca o e-mail como confirmado e apaga a sessão aberta pelo cadastro.
"Gerar nova senha" apaga a conta de login e a recria; papel e equipes ficam como estavam.

O site só baixa e mostra o sistema depois que a API valida a sessão e o acesso: quem não está
logado, ou não foi liberado, recebe apenas a tela de login.

"Esqueci a senha" manda um código por e-mail, pelo remetente compartilhado do Neon
(`auth@mail.myneon.app`), e pode cair no spam. Para uso contínuo, o Neon recomenda configurar um
SMTP próprio (<https://neon.com/docs/auth/production-checklist>).

## Desenvolver

```bash
npm install -g netlify-cli   # uma vez
npm run dev                  # site + API em http://localhost:8888 (usa o app/web/.env.local)
npm test                     # regras da escala, API e importação
npm run typecheck
npm run build
```

- `npm test` não precisa de internet nem do Neon: a API é testada sobre um Postgres embutido.
- `server/parity.test.ts` garante que o motor em TypeScript gera a mesma escala do motor antigo em
  Python. Os casos ficam em `server/fixtures/parity.json` e são refeitos com
  `py -3 scripts/gen_parity.py` (precisa da pasta `app/escala`).

## API

A API é REST: cada endereço é um recurso e o verbo diz o que fazer com ele. Tudo exige o token do
login (`Authorization: Bearer ...`), menos `/api/config`. As respostas são JSON; erros vêm como
`{ "error": "mensagem", "code": "..." }` com o status correspondente (400 entrada inválida, 401 sem
acesso, 404 não existe).

| Verbo e endereço | O que faz |
| --- | --- |
| `GET /api/config` | Endereço do login (público). |
| `GET /api/me` | Quem está logado, o papel, as equipes e a data de hoje. |
| `GET /api/volunteers[?team=]` | Voluntários, com faltas, vezes que serviram e a última vez. |
| `POST /api/volunteers` | Cadastra um voluntário (201). |
| `PATCH /api/volunteers/:id` | Altera só os campos enviados. |
| `GET /api/schedules[?team=]` | Escalas salvas (data, equipe, posições e faltas). |
| `GET /api/schedules/:data[/:equipe]` | Folha do culto: equipe, posições padrão, escala salva e regras quebradas. Sem equipe, usa a sugerida para o dia. |
| `PUT /api/schedules/:data/:equipe` | Grava a escala do culto (substitui a anterior) e devolve as regras quebradas. |
| `POST /api/schedules/:data/:equipe/suggestion` | Gera uma sugestão de escala. Não grava. |
| `PUT /api/teams/:equipe/positions` | Guarda as posições ligadas por padrão para a equipe. |
| `GET /api/history[?team=]` | Quantas vezes cada voluntário ativo serviu em cada função, e as faltas. |
| `GET /api/users` | Acessos liberados (só administrador). |
| `PUT /api/users/:email` | Libera um e-mail (201, com a senha criada) ou muda papel e equipes (200). |
| `DELETE /api/users/:email` | Remove o acesso (204). |
| `POST /api/users/:email/password` | Gera uma senha nova (201). |

Como o sistema fica leve:

- **Cada tela pede só o que mostra.** Abrir um culto é um pedido; salvar é um pedido (a resposta
  já traz as regras quebradas, sem um segundo pedido para conferir). Depois de alterar um
  voluntário ou um acesso, a tela usa o item que a API devolveu, sem baixar a lista de novo.
- **O que é fixo não trafega.** Posições, equipes e regras estão em `shared/catalog.ts` e vão
  dentro do próprio site.
- **O banco filtra e soma.** As consultas já saem por equipe e com os totais prontos; o histórico
  manda só as colunas em que a pessoa serviu, e só de quem está ativo.
- **Os dados nunca ficam em cache no navegador** (`Cache-Control: no-store`); só o endereço do
  login fica, por uma hora.

`server/client.test.ts` roda o cliente do site (`src/lib/api.ts`) contra as rotas de verdade: se um
endereço ou verbo mudar de um lado só, o teste falha.

## O que mudou em relação ao programa de Windows

- Não existe mais `EscalaIgreja.exe`, nem banco em arquivo, nem pasta `exports`.
- O sistema não gera mais a planilha `.xlsx` de cada culto. Continuam: mapa em PNG, ficha em PNG e impressão.
- A marcação "Falta = Sim" feita na planilha deixou de existir; as faltas são marcadas na tela de presença.
- Os horários ("Salvo às...") usam o fuso de São Paulo.
- As posições do mapa e da ficha ficam em `shared/catalog.ts`, não no banco.

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
