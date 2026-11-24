/**
 * Banco de teste: Postgres embutido (PGlite) com a mesma interface `Sql` do driver do Neon.
 * Só é usado pelos testes; nada daqui vai para o site.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { applySchema, type Query, type Sql } from "./db.ts";

type Row = Record<string, any>;

interface LazyQuery extends PromiseLike<Row[]> {
  text: string;
  params: unknown[];
}

export const SCHEMA = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf-8");

export async function createTestDb(opts: { schema?: boolean } = {}): Promise<{ sql: Sql; pg: PGlite }> {
  const pg = new PGlite();
  const lazy = (text: string, params: unknown[]): LazyQuery => ({
    text,
    params,
    then: (resolve, reject) => pg.query<Row>(text, params).then((r) => r.rows).then(resolve, reject),
  });
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    lazy(
      strings.reduce((text, part, i) => `${text}$${i}${part}`),
      params,
    )) as unknown as Sql;
  sql.query = (text: string, params: unknown[] = []) => lazy(text, params);
  sql.transaction = (queries: Query[]) =>
    pg.transaction(async (tx) => {
      const out: Row[][] = [];
      for (const q of queries as LazyQuery[]) out.push((await tx.query<Row>(q.text, q.params)).rows);
      return out;
    });
  // Nos testes não há Neon Auth: uma tabela vazia no mesmo formato basta para as consultas.
  await pg.exec(`CREATE SCHEMA neon_auth;
    CREATE TABLE neon_auth."user" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, email text,
                                   "emailVerified" boolean NOT NULL DEFAULT false)`);
  if (opts.schema ?? true) await applySchema(sql, SCHEMA);
  return { sql, pg };
}
