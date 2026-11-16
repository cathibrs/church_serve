/**
 * Carga inicial: banco SQLite do programa antigo + aba BASE_TAREFAS da planilha -> Postgres.
 *
 * A planilha só é usada aqui. Depois da carga, o sistema não lê nem escreve mais nela.
 * A linha de comando fica em scripts/import.ts.
 */
import { cleanGender, cleanName, cleanTeam, normalize, type Query, type Sql } from "./db.ts";

type Row = Record<string, any>;

// ====================================================================== planilha

export interface SheetRow {
  name: string;
  gender: "Masculino" | "Feminino";
  team: string;
  category_counts: Record<string, number>;
  /** código da posição -> [categoria, quantidade] */
  position_counts: Record<string, [string, number]>;
}

function historyCategory(h: string): string | null {
  if (["total_faltas", "falta", "data_falta"].includes(h)) return null;
  if (h === "cozinha") return "Cozinha";
  if (h === "confete") return "Confete";
  if (h === "banheiro" || h === "banheiro (entrada)") return "Banheiro Entrada";
  if (h === "banheiro (saida)") return "Banheiro Saida";
  if (h.startsWith("pos_bm") || h.startsWith("pos_bf")) return "Banheiro";
  if (h.startsWith("pos_gm") || h.startsWith("pos_gf")) return "Galeria";
  if (h.startsWith("pos_bk") || h === "fixo bercario") return "Bercario";
  if (h.startsWith("pos_") || h.startsWith("corredor")) return "Corredor";
  if (h === "limpeza altar") return "Limpeza Altar";
  if (h === "limpeza conf" || h === "limpeza confete") return "Limpeza Conf";
  if (h === "recepcao") return "Recepcao";
  return null;
}

function historyCode(h: string): string | null {
  if (!h.startsWith("pos_")) return null;
  const code = h.slice(4).trim().toUpperCase();
  if (/^\d+$/.test(code)) return code.padStart(2, "0");
  return ["BM", "GM", "GF", "BK", "BF"].includes(code) ? code : null;
}

function asInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Lê as linhas da aba BASE_TAREFAS (primeira linha = títulos): nome, gênero, equipe
 * e contagens do histórico. Linhas sem nome ou sem gênero reconhecível são ignoradas.
 */
export function parseBaseSheet(data: unknown[][]): SheetRow[] {
  if (!data.length) return [];
  const header = new Map<string, number>();
  data[0].forEach((title, col) => {
    if (title !== null && title !== undefined && title !== "") header.set(normalize(title), col);
  });
  const col = (...names: string[]) => names.map((n) => header.get(n)).find((c) => c !== undefined);
  const cName = col("voluntarios", "voluntario", "nome");
  const cGender = col("genero");
  const cTeam = col("equipe");
  if (cName === undefined || cGender === undefined) {
    throw new Error("A aba da planilha não tem as colunas Voluntarios e Genero.");
  }
  const countCols = [...header].flatMap(([title, c]) => {
    const category = historyCategory(title);
    return category ? [{ c, category, code: historyCode(title) }] : [];
  });

  const rows: SheetRow[] = [];
  for (const line of data.slice(1)) {
    const name = cleanName(line[cName]);
    const gender = cleanGender(line[cGender]);
    if (!name || normalize(name) === "falta" || !gender) continue;
    const row: SheetRow = {
      name,
      gender,
      team: cleanTeam(cTeam === undefined ? null : line[cTeam]),
      category_counts: {},
      position_counts: {},
    };
    for (const { c, category, code } of countCols) {
      const n = asInt(line[c]);
      if (n <= 0) continue;
      row.category_counts[category] = (row.category_counts[category] ?? 0) + n;
      if (code) row.position_counts[code] = [category, (row.position_counts[code]?.[1] ?? 0) + n];
    }
    rows.push(row);
  }
  return rows;
}

// ====================================================================== plano da carga

/** Tabelas lidas do SQLite antigo (linhas como vieram, com 0/1 nos campos sim/não). */
export interface SourceData {
  volunteers: Row[];
  history_seed: Row[];
  history_position_seed: Row[];
  schedules: Row[];
  schedule_items: Row[];
  presence: Row[];
  app_meta: Row[];
}

export interface ImportPlan {
  volunteers: Row[];
  history_seed: Row[];
  history_position_seed: Row[];
  schedules: Row[];
  schedule_items: Row[];
  presence: Row[];
  app_meta: { key: string; value: string }[];
  notes: string[];
}

const bool = (v: unknown, fallback: boolean) => (v === null || v === undefined ? fallback : Boolean(Number(v)));

/** "AAAA-MM-DD HH:MM:SS" em UTC (formato do SQLite) -> ISO com fuso. */
function utcStamp(text: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(text ?? ""));
  return m ? `${m[1]}T${m[2]}Z` : new Date().toISOString();
}

function jsonOrNull(text: unknown): string | null {
  if (text === null || text === undefined || text === "") return null;
  try {
    return JSON.stringify(JSON.parse(String(text)));
  } catch {
    return null;
  }
}

/** Metas do programa antigo que não existem mais (marcação "Falta = Sim" da planilha). */
const DROPPED_META = new Set(["faltas_planilha"]);

/**
 * Monta o que será gravado. Regras (as mesmas da abertura do programa antigo):
 *  - o SQLite é a fonte principal e os ids são preservados;
 *  - quem já existe e aparece na planilha tem gênero e equipe atualizados por ela;
 *  - quem só existe na planilha é criado (ativo, berçário liberado para mulheres);
 *  - as contagens da planilha só viram histórico quando não há SQLite, porque a
 *    planilha atual já soma as escalas do banco e importar as duas contaria em dobro.
 */
export function buildImport(source: SourceData | null, sheet: SheetRow[]): ImportPlan {
  const notes: string[] = [];
  const volunteers: Row[] = (source?.volunteers ?? []).map((v) => ({
    id: Number(v.id),
    name: String(v.name),
    gender: v.gender,
    team: v.team ?? "",
    active: bool(v.active, true),
    observation: v.observation ?? null,
    can_bercario: bool(v.can_bercario, false),
    can_cozinha: bool(v.can_cozinha, true),
    can_recepcao: bool(v.can_recepcao, true),
    can_banheiro: bool(v.can_banheiro, true),
    can_limpar_altar: bool(v.can_limpar_altar, true),
  }));
  const ids = new Set(volunteers.map((v) => v.id));
  const byName = new Map(volunteers.map((v) => [v.name, v]));

  const history_seed: Row[] = (source?.history_seed ?? []).filter((r) => ids.has(Number(r.volunteer_id)));
  const history_position_seed: Row[] = (source?.history_position_seed ?? []).filter((r) =>
    ids.has(Number(r.volunteer_id)),
  );

  const withHistory = volunteers.length === 0;
  let nextId = Math.max(0, ...ids) + 1;
  let updated = 0;
  let created = 0;
  for (const row of sheet) {
    const existing = byName.get(row.name);
    if (existing) {
      if (existing.gender !== row.gender || existing.team !== row.team) updated++;
      existing.gender = row.gender;
      existing.team = row.team;
      continue;
    }
    const v = {
      id: nextId++,
      name: row.name,
      gender: row.gender,
      team: row.team,
      active: true,
      observation: null,
      can_bercario: row.gender === "Feminino",
      can_cozinha: true,
      can_recepcao: true,
      can_banheiro: true,
      can_limpar_altar: true,
    };
    volunteers.push(v);
    byName.set(v.name, v);
    ids.add(v.id);
    created++;
    if (!withHistory) continue;
    for (const [category, count] of Object.entries(row.category_counts)) {
      history_seed.push({ volunteer_id: v.id, category, count });
    }
    for (const [position_code, [category, count]] of Object.entries(row.position_counts)) {
      history_position_seed.push({ volunteer_id: v.id, position_code, category, count });
    }
  }
  if (sheet.length) {
    notes.push(`Planilha: ${sheet.length} linha(s) lida(s), ${created} voluntário(s) novo(s), ${updated} atualizado(s).`);
  }

  const schedules: Row[] = (source?.schedules ?? []).map((s) => ({
    id: Number(s.id),
    service_date: String(s.service_date).slice(0, 10),
    service_type: s.service_type,
    team: s.team ?? "",
    notes: s.notes ?? null,
    status: s.status ?? "finalizada",
    active_codes: jsonOrNull(s.active_codes),
    created_at: utcStamp(s.created_at),
  }));
  const scheduleIds = new Set(schedules.map((s) => s.id));
  const linked = (r: Row) => scheduleIds.has(Number(r.schedule_id)) && ids.has(Number(r.volunteer_id));

  const allItems = source?.schedule_items ?? [];
  const schedule_items = allItems.filter(linked);
  const allPresence = source?.presence ?? [];
  const presence = allPresence.filter(linked).map((p) => ({
    ...p,
    confirmed: bool(p.confirmed, false),
    absent: bool(p.absent, false),
    justification: p.justification ?? null,
  }));
  const orphans = allItems.length - schedule_items.length + (allPresence.length - presence.length);
  if (orphans) {
    notes.push(`${orphans} registro(s) de escala/presença ignorado(s) por apontarem para voluntário ou escala apagados.`);
  }

  const app_meta = (source?.app_meta ?? [])
    .filter((m) => !DROPPED_META.has(m.key) && jsonOrNull(m.value) !== null)
    .map((m) => ({ key: String(m.key), value: jsonOrNull(m.value)! }));

  return { volunteers, history_seed, history_position_seed, schedules, schedule_items, presence, app_meta, notes };
}

// ====================================================================== gravação

const TABLES = ["volunteers", "history_seed", "history_position_seed", "schedules", "schedule_items", "presence", "app_meta"] as const;

export type Counts = Record<(typeof TABLES)[number], number>;

/** Cria as tabelas que faltam (schema.sql, um comando por vez). */
export async function applySchema(sql: Sql, schemaText: string): Promise<void> {
  const statements = schemaText
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await sql.query(statement);
}

export async function countRows(sql: Sql): Promise<Counts> {
  const out = {} as Counts;
  for (const table of TABLES) out[table] = (await sql.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n;
  return out;
}

const column = (rows: Row[], key: string) => rows.map((r) => r[key] ?? null);

/**
 * Grava o plano em uma única transação (ou tudo entra, ou nada entra).
 * Recusa se o banco já tiver voluntários, a não ser com `force`, que apaga tudo antes.
 */
export async function applyImport(sql: Sql, plan: ImportPlan, opts: { force?: boolean } = {}): Promise<Counts> {
  const existing = (await sql`SELECT COUNT(*)::int AS n FROM volunteers`)[0].n;
  if (existing && !opts.force) {
    throw new Error(
      `O banco já tem ${existing} voluntário(s). A carga inicial só roda em banco vazio; ` +
        `para apagar tudo e importar de novo, use --force.`,
    );
  }
  const v = plan.volunteers;
  const s = plan.schedules;
  const i = plan.schedule_items;
  const p = plan.presence;
  const hs = plan.history_seed;
  const hp = plan.history_position_seed;
  const m = plan.app_meta;
  const queries: Query[] = [
    sql`TRUNCATE volunteers, history_seed, history_position_seed, schedules, schedule_items, presence, app_meta
        RESTART IDENTITY CASCADE`,
    sql`INSERT INTO volunteers (id, name, gender, team, active, observation, can_bercario, can_cozinha,
                                can_recepcao, can_banheiro, can_limpar_altar)
        SELECT * FROM unnest(
          ${column(v, "id")}::int[], ${column(v, "name")}::text[], ${column(v, "gender")}::text[],
          ${column(v, "team")}::text[], ${column(v, "active")}::boolean[], ${column(v, "observation")}::text[],
          ${column(v, "can_bercario")}::boolean[], ${column(v, "can_cozinha")}::boolean[],
          ${column(v, "can_recepcao")}::boolean[], ${column(v, "can_banheiro")}::boolean[],
          ${column(v, "can_limpar_altar")}::boolean[])`,
    sql`INSERT INTO history_seed (volunteer_id, category, count)
        SELECT * FROM unnest(${column(hs, "volunteer_id")}::int[], ${column(hs, "category")}::text[],
                             ${column(hs, "count")}::int[])`,
    sql`INSERT INTO history_position_seed (volunteer_id, position_code, category, count)
        SELECT * FROM unnest(${column(hp, "volunteer_id")}::int[], ${column(hp, "position_code")}::text[],
                             ${column(hp, "category")}::text[], ${column(hp, "count")}::int[])`,
    sql`INSERT INTO schedules (id, service_date, service_type, team, notes, status, active_codes, created_at)
        SELECT t.id, t.service_date, t.service_type, t.team, t.notes, t.status, t.active_codes::jsonb,
               t.created_at::timestamptz
        FROM unnest(
          ${column(s, "id")}::int[], ${column(s, "service_date")}::text[], ${column(s, "service_type")}::text[],
          ${column(s, "team")}::text[], ${column(s, "notes")}::text[], ${column(s, "status")}::text[],
          ${column(s, "active_codes")}::text[], ${column(s, "created_at")}::text[])
          AS t(id, service_date, service_type, team, notes, status, active_codes, created_at)`,
    sql`INSERT INTO schedule_items (id, schedule_id, position_code, position_name, category, volunteer_id,
                                    volunteer_name, item_order)
        SELECT * FROM unnest(
          ${column(i, "id")}::int[], ${column(i, "schedule_id")}::int[], ${column(i, "position_code")}::text[],
          ${column(i, "position_name")}::text[], ${column(i, "category")}::text[],
          ${column(i, "volunteer_id")}::int[], ${column(i, "volunteer_name")}::text[],
          ${column(i, "item_order")}::int[])`,
    sql`INSERT INTO presence (id, schedule_id, volunteer_id, confirmed, absent, justification)
        SELECT * FROM unnest(
          ${column(p, "id")}::int[], ${column(p, "schedule_id")}::int[], ${column(p, "volunteer_id")}::int[],
          ${column(p, "confirmed")}::boolean[], ${column(p, "absent")}::boolean[],
          ${column(p, "justification")}::text[])`,
    sql`INSERT INTO app_meta (key, value)
        SELECT t.key, t.value::jsonb FROM unnest(${column(m, "key")}::text[], ${column(m, "value")}::text[])
          AS t(key, value)`,
    // os próximos ids continuam depois do maior id importado
    ...["volunteers", "schedules", "schedule_items", "presence"].map((table) =>
      sql.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${table}`,
      ),
    ),
  ];
  await sql.transaction(queries);
  return countRows(sql);
}
