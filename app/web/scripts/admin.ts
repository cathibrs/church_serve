/**
 * Cria ou promove um administrador direto no banco.
 *
 *   npm run admin -- pessoa@exemplo.com
 *
 * Use para o primeiro acesso (antes de existir algum admin) e para recuperar o acesso
 * se ninguém mais conseguir entrar na tela Acessos. Se o e-mail ainda não tiver conta de
 * login, cria uma e mostra a senha aleatória. A conexão vem de DATABASE_URL
 * (arquivo .env.local ou .env desta pasta). Também cria a tabela de acessos, se faltar.
 */
import { existsSync, readFileSync } from "node:fs";
import { generatePassword, neonAccounts } from "../server/accounts.ts";
import { cleanEmail, countAdmins, getAccountName, upsertAppUser, type Sql } from "../server/db.ts";
import { applySchema } from "../server/importer.ts";

async function main() {
  const email = cleanEmail(process.argv[2]);
  for (const file of [".env.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file);
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL (rode "neon env pull" nesta pasta).');
  console.log(`Banco de destino: ${new URL(url).host}${process.env.NEON_BRANCH ? ` (branch ${process.env.NEON_BRANCH})` : ""}`);

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url) as unknown as Sql;
  await applySchema(sql, readFileSync(new URL("../db/schema.sql", import.meta.url), "utf-8"));
  await upsertAppUser(sql, email, { role: "admin", teams: [] }, "npm run admin");
  console.log(`${email} agora é administrador (${await countAdmins(sql)} administrador(es) no total).`);

  // Sem conta de login ainda: cria uma, com senha aleatória mostrada só agora.
  if (!(await getAccountName(sql, email))) {
    const password = generatePassword();
    // localhost é uma origem que o Neon Auth aceita por padrão
    if (await neonAccounts.create(sql, { email, name: email.split("@")[0], password }, "http://localhost:8888")) {
      console.log(`\nConta de login criada. Senha (anote, ela não aparece de novo): ${password}`);
      console.log('A pessoa pode trocar depois em "Alterar senha".');
    }
  } else {
    console.log("A conta de login desse e-mail já existia; a senha não foi alterada.");
  }
}

main().catch((e) => {
  console.error(`\nFalhou: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
