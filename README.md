# Escala de Voluntários

Sistema web que monta a escala de voluntários de cada culto: quem fica em cada posição do mapa,
na recepção e nas tarefas de entrada e saída, com rodízio entre os cultos e controle de faltas.

O site roda no Netlify, guarda os dados em Postgres no Neon e exige login individual.

## O que ele faz

- **Gera a escala** a partir de quem está presente, respeitando gênero por posição, permissões de
  cada voluntário e rodízio (ninguém repete a posição do último culto; quem estava na recepção vai
  para o mapa).
- **Permite ajustar à mão**: trocar pessoas, ligar e desligar posições. Se uma troca quebra alguma
  regra, a posição fica marcada com a explicação.
- **Registra presença e faltas**, com motivo opcional, e mostra o histórico por voluntário.
- **Exporta** o mapa e a ficha em PNG, ou imprime.
- **Cadastro de voluntários** com equipe, permissões e observações.

As regras completas da escala estão em [`LEIA-ME.txt`](LEIA-ME.txt).

## Como é feito

| Parte | Tecnologia | Onde fica |
| --- | --- | --- |
| Telas | React, TypeScript, Tailwind | [`app/web/src`](app/web/src) |
| API (`/api/*`) | Netlify Functions | [`app/web/netlify/functions`](app/web/netlify/functions) |
| Regras da escala, banco e rotas | TypeScript | [`app/web/server`](app/web/server) |
| Banco de dados | Postgres (Neon) | [`app/web/db/schema.sql`](app/web/db/schema.sql) |
| Login | Neon Auth | [`app/web/server/auth.ts`](app/web/server/auth.ts) |
| Carga inicial dos dados | script Node | [`app/web/scripts/import.ts`](app/web/scripts/import.ts) |

Só acessa a escala quem tem conta com e-mail confirmado **e** foi liberado por um administrador
(tela Acessos), como administrador ou como coordenador de uma ou mais equipes. O coordenador só vê
e altera o que é das equipes dele. Criar uma conta com outro e-mail não dá acesso a nenhum dado, e o site só baixa e
mostra o sistema depois que a API valida a sessão.

## Rodar no seu computador

Precisa de Node 24.

O site fica em `app/web`. Os comandos abaixo funcionam na raiz do projeto (ela só repassa para
`app/web`) e também dentro de `app/web`.

```bash
npm run setup     # instala as dependências de app/web
npm test          # regras da escala, API e importação (não precisa de internet)
npm run build
```

Para abrir o site localmente com a API, é preciso um projeto no Neon e o arquivo
`app/web/.env.local`, que `neon env pull` grava (modelo em [`app/web/.env.example`](app/web/.env.example)). Depois:

```bash
npm install -g netlify-cli
netlify dev       # na raiz do projeto; abre em http://localhost:8888
```

## Publicar

O passo a passo completo (criar o banco e o login no Neon, carregar os dados e publicar no
Netlify) está em [`app/web/README.md`](app/web/README.md).

## Dados e privacidade

Este repositório tem só o código. Banco de dados, planilhas, exportações e o arquivo `.env`
ficam fora dele (veja o [`.gitignore`](.gitignore)): nomes de voluntários e registros de falta
não devem ser enviados para cá.

## Versão anterior

A pasta [`app/escala`](app/escala) guarda o programa antigo, em Python, que rodava no Windows com
banco em arquivo e uma planilha do Excel. Ele fica como referência: o motor da escala em TypeScript
foi portado dele, e um teste garante que os dois geram a mesma escala.
