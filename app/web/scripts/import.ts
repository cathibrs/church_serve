/**
 * Carga inicial dos dados no Neon (roda uma vez, no seu computador).
 *
 *   npm run import -- --db ../../data/igreja_escala.db --xlsx "../../POSICIONAMENTO E TAREFAS.xlsx"
 *
 * Opções:
 *   --db <arquivo>     banco SQLite do programa antigo (voluntários, escalas, faltas)
 *   --xlsx <arquivo>   planilha POSICIONAMENTO E TAREFAS (aba BASE_TAREFAS)
 *   --dry-run          ensaia tudo em um Postgres embutido, sem tocar no Neon
 *   --force            apaga o que já existe no Neon antes de importar
 *
 * Precisa de pelo menos um entre --db e --xlsx. A conexão vem de DATABASE_URL
 * (arquivo .env.local ou .env desta pasta). Nenhum nome de voluntário é mostrado na tela.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Sql } from "../server/db.ts";
import { applyImport, applySchema, buildImport, parseBaseSheet, type SheetRow, type SourceData } from "../server/importer.ts";

const SOURCE_TABLES = ["volunteers", "history_seed", "history_position_seed", "schedules", "schedule_items", "presence", "app_meta"] as const;

async function readSqlite(path: string): Promise<SourceData> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const existing = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)),
    );
    const read = (table: string) => (existing.has(table) ? (db.prepare(`SELECT * FROM ${table}`).all() as Record<string, any>[]) : []);
    return Object.fromEntries(SOURCE_TABLES.map((t) => [t, read(t)])) as unknown as SourceData;
  } finally {
    db.close();
  }
}

async function readSheetRows(path: string): Promise<SheetRow[]> {
  const { default: readXlsxFile } = await import("read-excel-file/node");
  const sheets = await readXlsxFile(path);
  const base = sheets.find((s) => s.sheet === "BASE_TAREFAS") ?? sheets.find((s) => s.sheet === "TAREFAS");
  if (!base) throw new Error(`A planilha não tem a aba BASE_TAREFAS (abas: ${sheets.map((s) => s.sheet).join(", ")}).`);
  return parseBaseSheet(base.data);
}

async function connect(dryRun: boolean): Promise<Sql> {
  if (dryRun) {
    const { createTestDb } = await import("../server/testdb.ts");
    return (await createTestDb({ schema: false })).sql;
  }
  // .env.local é o arquivo que "neon env pull" / "neon deploy" gravam
  for (const file of [".env.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file);
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Falta DATABASE_URL (rode \"neon env pull\" nesta pasta ou use --dry-run para ensaiar).");
  }
  console.log(`Banco de destino: ${new URL(url).host}${process.env.NEON_BRANCH ? ` (branch ${process.env.NEON_BRANCH})` : ""}`);
  const { neon } = await import("@neondatabase/serverless");
  return neon(url) as unknown as Sql;
}

/**
 * Acha o arquivo a partir da pasta onde o comando foi digitado (INIT_CWD, que o npm informa)
 * ou desta pasta (app/web). Assim o comando funciona da raiz do projeto e de app/web.
 */
function locate(file: string): string {
  const bases = [process.env.INIT_CWD, process.cwd()].filter((b): b is string => Boolean(b));
  const found = bases.map((base) => resolve(base, file)).find((path) => existsSync(path));
  if (!found) throw new Error(`Arquivo não encontrado: ${file} (procurei em ${[...new Set(bases)].join(" e ")})`);
  return found;
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      xlsx: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.db && !values.xlsx) throw new Error("Informe --db e/ou --xlsx. Veja o início de scripts/import.ts.");
  values.db &&= locate(values.db);
  values.xlsx &&= locate(values.xlsx);

  const source = values.db ? await readSqlite(values.db) : null;
  const sheet = values.xlsx ? await readSheetRows(values.xlsx) : [];
  const plan = buildImport(source, sheet);

  const sql = await connect(values["dry-run"]);
  await applySchema(sql, readFileSync(new URL("../db/schema.sql", import.meta.url), "utf-8"));
  const counts = await applyImport(sql, plan, { force: values.force });

  console.log(values["dry-run"] ? "\nENSAIO (nada foi gravado no Neon)\n" : "\nImportação concluída.\n");
  console.log("tabela                   origem  gravado");
  let ok = true;
  for (const table of SOURCE_TABLES) {
    const from = source ? source[table].length : 0;
    const expected = plan[table].length;
    const stored = counts[table];
    if (stored !== expected) ok = false;
    console.log(`${table.padEnd(24)} ${String(from).padStart(6)}  ${String(stored).padStart(7)}${stored === expected ? "" : `  <- esperado ${expected}`}`);
  }
  for (const note of plan.notes) console.log(`\n${note}`);
  if (!ok) throw new Error("As contagens gravadas não batem com o esperado.");
}

main().catch((e) => {
  console.error(`\nFalhou: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
