/**
 * Cria ou promove um administrador direto no banco.
 *
 *   npm run admin -- pessoa@exemplo.com
 *
 * Use para o primeiro acesso (antes de existir algum admin) e para recuperar o acesso
 * se ninguém mais conseguir entrar na tela Acessos. A conexão vem de DATABASE_URL
 * (arquivo .env.local ou .env desta pasta). Também cria a tabela de acessos, se faltar.
 */
import { existsSync, readFileSync } from "node:fs";
import { cleanEmail, countAdmins, upsertAppUser, type Sql } from "../server/db.ts";
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
  await upsertAppUser(sql, email, "admin", "npm run admin");
  console.log(`${email} agora é administrador (${await countAdmins(sql)} administrador(es) no total).`);
}

main().catch((e) => {
  console.error(`\nFalhou: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
