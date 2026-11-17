/** Acesso ao Postgres (Neon). Mesmas consultas do banco SQLite antigo (app/escala/db.py). */
import { neon } from "@neondatabase/serverless";
import { DEFAULT_POSITIONS, TEAM_OPTIONS } from "./config.ts";
import type { Assignment, HistoryStats, Position, Volunteer } from "./models.ts";

type Row = Record<string, any>;

/** Consulta ainda não enviada: é executada ao dar await ou dentro de transaction(). */
export type Query = PromiseLike<Row[]>;

/**
 * O que o sistema usa do driver do Neon: consultas por template (valores viram
 * parâmetros $1, $2...) e transação com várias consultas em uma ida ao banco.
 * Os testes usam a mesma interface sobre um Postgres embutido (server/testdb.ts).
 */
export interface Sql {
  (strings: TemplateStringsArray, ...params: any[]): Query;
  /** SQL em texto com parâmetros $1, $2... (só para texto fixo do próprio código). */
  query(text: string, params?: any[]): Query;
  transaction(queries: Query[]): Promise<Row[][]>;
}

/** Erro que pode ser mostrado ao usuário como está. */
export class UserError extends Error {}

/** Falta configuração no servidor (variável de ambiente). A mensagem diz qual, sem expor valores. */
export class ConfigError extends Error {}

let cached: Sql | null = null;

export function connect(): Sql {
  if (cached) return cached;
  const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new ConfigError("Servidor sem banco configurado: falta a variável DATABASE_URL.");
  cached = neon(url) as unknown as Sql;
  return cached;
}

// ---------------------------------------------------------------- texto

const collator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });
export const byName = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export function normalize(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export const normalizeTeam = (value: unknown) => normalize(value).replaceAll("-", "_").replaceAll(" ", "_");

export const cleanName = (value: unknown) =>
  value === null || value === undefined ? "" : String(value).trim().split(/\s+/).filter(Boolean).join(" ");

/** Texto livre (observação, motivo): sem espaços sobrando e com tamanho limitado. */
export const cleanText = (value: unknown, limit = 500) =>
  value === null || value === undefined ? "" : String(value).trim().slice(0, limit);

export function cleanGender(value: unknown): "Masculino" | "Feminino" | null {
  const n = normalize(value);
  if (n.startsWith("masc")) return "Masculino";
  if (n.startsWith("fem")) return "Feminino";
  return null;
}

export function cleanTeam(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value).trim();
  if (!raw) return TEAM_OPTIONS[0];
  const n = normalizeTeam(raw);
  return TEAM_OPTIONS.find((option) => normalizeTeam(option) === n) ?? raw;
}

// ---------------------------------------------------------------- meta

export async function getMeta<T>(sql: Sql, key: string, fallback: T): Promise<T> {
  const rows = await sql`SELECT value FROM app_meta WHERE key = ${key}`;
  const value = rows[0]?.value;
  return value === null || value === undefined ? fallback : (value as T);
}

export async function setMeta(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql`
    INSERT INTO app_meta (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
}

// ---------------------------------------------------------------- posições (fixas)

const POSITIONS = [...DEFAULT_POSITIONS].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

export function getPositions(): Position[] {
  return POSITIONS;
}

// ---------------------------------------------------------------- voluntários

function volunteerFromRow(r: Row): Volunteer {
  return {
    id: r.id,
    name: r.name,
    gender: r.gender,
    team: r.team,
    active: r.active,
    can_bercario: r.can_bercario,
    can_cozinha: r.can_cozinha,
    can_recepcao: r.can_recepcao,
    can_banheiro: r.can_banheiro,
    can_limpar_altar: r.can_limpar_altar,
    observation: r.observation ?? "",
  };
}

export async function getVolunteers(sql: Sql, opts: { activeOnly?: boolean; team?: string | null } = {}): Promise<Volunteer[]> {
  const activeOnly = opts.activeOnly ?? true;
  const rows = await sql`SELECT * FROM volunteers WHERE (NOT ${activeOnly}::boolean OR active)`;
  let vols = rows.map(volunteerFromRow).sort((a, b) => byName(a.name, b.name));
  if (opts.team) {
    const t = normalizeTeam(opts.team);
    vols = vols.filter((v) => normalizeTeam(v.team) === t);
  }
  return vols;
}

export async function getAvailableTeams(sql: Sql): Promise<string[]> {
  const rows = await sql`SELECT DISTINCT team FROM volunteers WHERE active AND team <> ''`;
  return [...new Set([...rows.map((r) => r.team as string), ...TEAM_OPTIONS])].sort();
}

export interface VolunteerInput {
  id?: number | null;
  name?: unknown;
  gender?: unknown;
  team?: unknown;
  active?: unknown;
  can_bercario?: unknown;
  can_cozinha?: unknown;
  can_recepcao?: unknown;
  can_banheiro?: unknown;
  can_limpar_altar?: unknown;
  observation?: unknown;
}

export async function upsertVolunteer(sql: Sql, input: VolunteerInput): Promise<number> {
  const name = cleanName(input.name);
  if (!name) throw new UserError("Informe o nome do voluntário.");
  const gender = cleanGender(input.gender) ?? "Masculino";
  const flag = (value: unknown, fallback: boolean) => (value === undefined || value === null ? fallback : Boolean(value));
  const v = {
    team: cleanTeam(input.team),
    active: flag(input.active, true),
    can_bercario: Boolean(input.can_bercario),
    can_cozinha: flag(input.can_cozinha, true),
    can_recepcao: flag(input.can_recepcao, true),
    can_banheiro: flag(input.can_banheiro, true),
    can_limpar_altar: flag(input.can_limpar_altar, true),
    observation: cleanText(input.observation),
  };
  try {
    if (input.id) {
      const id = Number(input.id);
      const rows = await sql`
        UPDATE volunteers SET name = ${name}, gender = ${gender}, team = ${v.team}, active = ${v.active},
          can_bercario = ${v.can_bercario}, can_cozinha = ${v.can_cozinha}, can_recepcao = ${v.can_recepcao},
          can_banheiro = ${v.can_banheiro}, can_limpar_altar = ${v.can_limpar_altar}, observation = ${v.observation}
        WHERE id = ${id} RETURNING id`;
      if (!rows.length) throw new UserError("Voluntário não encontrado.");
      return id;
    }
    const rows = await sql`
      INSERT INTO volunteers (name, gender, team, active, can_bercario, can_cozinha, can_recepcao,
                              can_banheiro, can_limpar_altar, observation)
      VALUES (${name}, ${gender}, ${v.team}, ${v.active}, ${v.can_bercario}, ${v.can_cozinha}, ${v.can_recepcao},
              ${v.can_banheiro}, ${v.can_limpar_altar}, ${v.observation})
      RETURNING id`;
    return rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new UserError(`Já existe um voluntário chamado ${name}.`);
    throw e;
  }
}

// ---------------------------------------------------------------- histórico

export async function getHistoryStats(sql: Sql, volunteerIds: number[]): Promise<Map<number, HistoryStats>> {
  const stats = new Map<number, HistoryStats>(
    volunteerIds.map((id) => [id, { counts: {}, position_counts: {}, total: 0 }]),
  );
  if (!volunteerIds.length) return stats;
  const [seeds, positionSeeds, items] = await Promise.all([
    sql`SELECT volunteer_id, category, count FROM history_seed WHERE volunteer_id = ANY(${volunteerIds}::int[])`,
    sql`SELECT volunteer_id, position_code, count FROM history_position_seed
        WHERE volunteer_id = ANY(${volunteerIds}::int[])`,
    sql`SELECT volunteer_id, category, position_code, COUNT(*)::int AS n FROM schedule_items
        WHERE volunteer_id = ANY(${volunteerIds}::int[]) GROUP BY volunteer_id, category, position_code`,
  ]);
  const add = (target: Record<string, number>, key: string, n: number) => (target[key] = (target[key] ?? 0) + n);
  for (const r of seeds) {
    const item = stats.get(r.volunteer_id)!;
    add(item.counts, r.category, r.count);
    item.total += r.count;
  }
  for (const r of positionSeeds) add(stats.get(r.volunteer_id)!.position_counts, r.position_code, r.count);
  for (const r of items) {
    const item = stats.get(r.volunteer_id)!;
    add(item.counts, r.category, r.n);
    add(item.position_counts, r.position_code, r.n);
    item.total += r.n;
  }
  return stats;
}

export async function getLastAltarGender(sql: Sql): Promise<string | null> {
  const rows = await sql`
    SELECT v.gender FROM schedule_items si
    JOIN schedules s ON s.id = si.schedule_id
    JOIN volunteers v ON v.id = si.volunteer_id
    WHERE si.category = 'Limpeza Altar'
    ORDER BY s.service_date DESC, s.id DESC, si.item_order ASC
    LIMIT 1`;
  return rows[0]?.gender ?? null;
}

/** Voluntários que estavam nessas categorias no último culto em que alguma delas foi usada. */
export async function lastAssignmentIds(sql: Sql, volunteerIds: number[], categories: string[]): Promise<Set<number>> {
  if (!volunteerIds.length || !categories.length) return new Set();
  const rows = await sql`
    WITH last AS (
      SELECT s.id FROM schedule_items si JOIN schedules s ON s.id = si.schedule_id
      WHERE si.category = ANY(${categories}::text[]) AND si.volunteer_id = ANY(${volunteerIds}::int[])
      ORDER BY s.service_date DESC, s.id DESC LIMIT 1
    )
    SELECT DISTINCT si.volunteer_id FROM schedule_items si JOIN last ON last.id = si.schedule_id
    WHERE si.category = ANY(${categories}::text[]) AND si.volunteer_id = ANY(${volunteerIds}::int[])`;
  return new Set(rows.map((r) => r.volunteer_id as number));
}

/** Posições (códigos) que cada voluntário ocupou no seu último culto. */
export async function lastPositionByVolunteer(sql: Sql, volunteerIds: number[]): Promise<Map<number, Set<string>>> {
  const result = new Map<number, Set<string>>();
  if (!volunteerIds.length) return result;
  const rows = await sql`
    SELECT si.volunteer_id, si.position_code FROM schedule_items si
    JOIN (
      SELECT DISTINCT ON (si2.volunteer_id) si2.volunteer_id, s2.id AS schedule_id
      FROM schedule_items si2 JOIN schedules s2 ON s2.id = si2.schedule_id
      WHERE si2.volunteer_id = ANY(${volunteerIds}::int[])
      ORDER BY si2.volunteer_id, s2.service_date DESC, s2.id DESC
    ) last ON last.volunteer_id = si.volunteer_id AND last.schedule_id = si.schedule_id`;
  for (const r of rows) {
    if (!result.has(r.volunteer_id)) result.set(r.volunteer_id, new Set());
    result.get(r.volunteer_id)!.add(r.position_code);
  }
  return result;
}

// ---------------------------------------------------------------- escalas

export interface SaveScheduleInput {
  serviceDate: string;
  serviceType: string;
  team: string;
  assignments: Assignment[];
  presentIds: Set<number>;
  allVolunteerIds: number[];
  activeCodes: string[] | null;
  absentReasons: Map<number, string>;
}

/**
 * Salva a escala em uma transação. Se já existir escala para a mesma data e equipe,
 * ela é substituída. O motivo da falta fica em presence.justification.
 */
export async function saveSchedule(sql: Sql, input: SaveScheduleInput): Promise<number> {
  const a = input.assignments;
  const people = [...new Set([...input.allVolunteerIds, ...input.presentIds])].sort((x, y) => x - y);
  const present = people.map((id) => input.presentIds.has(id));
  const reasons = people.map((id, i) => (present[i] ? null : cleanText(input.absentReasons.get(id)) || null));
  const codes = input.activeCodes === null ? null : JSON.stringify([...input.activeCodes].sort());
  const [, inserted] = await sql.transaction([
    sql`DELETE FROM schedules WHERE service_date = ${input.serviceDate} AND team = ${input.team}`,
    sql`
      WITH s AS (
        INSERT INTO schedules (service_date, service_type, notes, status, team, active_codes)
        VALUES (${input.serviceDate}, ${input.serviceType}, '', 'finalizada', ${input.team}, ${codes}::jsonb)
        RETURNING id
      ), items AS (
        INSERT INTO schedule_items (schedule_id, position_code, position_name, category, volunteer_id,
                                    volunteer_name, item_order)
        SELECT s.id, t.* FROM s, unnest(
          ${a.map((x) => x.position_code)}::text[], ${a.map((x) => x.position_name)}::text[],
          ${a.map((x) => x.category)}::text[], ${a.map((x) => x.volunteer_id)}::int[],
          ${a.map((x) => x.volunteer_name)}::text[], ${a.map((x) => x.order)}::int[]) AS t
      ), people AS (
        INSERT INTO presence (schedule_id, volunteer_id, confirmed, absent, justification)
        SELECT s.id, t.* FROM s, unnest(
          ${people}::int[], ${present}::boolean[], ${present.map((p) => !p)}::boolean[], ${reasons}::text[]) AS t
      )
      SELECT id FROM s`,
  ]);
  return inserted[0].id;
}

export interface SavedSchedule {
  id: number;
  created_at: Date;
  active_codes: string[] | null;
  assignments: Assignment[];
  /** id de quem faltou -> motivo */
  absent: Map<number, string>;
}

/** Escala mais recente salva para a data e a equipe (ou null). */
export async function findSchedule(sql: Sql, serviceDate: string, team: string): Promise<SavedSchedule | null> {
  const found = await sql`
    SELECT id, created_at, active_codes FROM schedules
    WHERE service_date = ${serviceDate} AND team = ${team} ORDER BY id DESC LIMIT 1`;
  if (!found.length) return null;
  const s = found[0];
  const [items, absent] = await Promise.all([
    sql`SELECT * FROM schedule_items WHERE schedule_id = ${s.id} ORDER BY item_order`,
    sql`SELECT volunteer_id, justification FROM presence WHERE schedule_id = ${s.id} AND absent`,
  ]);
  return {
    id: s.id,
    created_at: s.created_at,
    active_codes: s.active_codes ?? null,
    assignments: items.map((r) => ({
      position_code: r.position_code,
      position_name: r.position_name,
      category: r.category,
      volunteer_id: r.volunteer_id,
      volunteer_name: r.volunteer_name,
      order: r.item_order,
    })),
    absent: new Map(absent.map((r) => [r.volunteer_id as number, (r.justification as string) ?? ""])),
  };
}

export interface ScheduleRow {
  id: number;
  service_date: string;
  service_type: string;
  team: string;
  created_at: Date;
  itens: number;
  faltas: number;
}

export async function listSchedules(sql: Sql, limit = 30): Promise<ScheduleRow[]> {
  const rows = await sql`
    SELECT s.id, s.service_date, s.service_type, s.team, s.created_at,
      (SELECT COUNT(*)::int FROM schedule_items i WHERE i.schedule_id = s.id) AS itens,
      (SELECT COUNT(*)::int FROM presence p WHERE p.schedule_id = s.id AND p.absent) AS faltas
    FROM schedules s ORDER BY s.service_date DESC, s.id DESC LIMIT ${limit}`;
  return rows as unknown as ScheduleRow[];
}

/** Equipe da última escala salva nesse dia da semana (ou null). `teams` limita a busca a essas equipes. */
export async function lastTeamFor(sql: Sql, serviceType: string, teams: string[] | null = null): Promise<string | null> {
  const rows = await sql`
    SELECT team FROM schedules
    WHERE service_type = ${serviceType} AND team <> ''
      AND (${teams === null}::boolean OR team = ANY(${teams ?? []}::text[]))
    ORDER BY service_date DESC, id DESC LIMIT 1`;
  return rows[0]?.team ?? null;
}

/** Quantas vezes cada voluntário serviu e a data da última vez. */
export async function serviceInfo(sql: Sql): Promise<Map<number, { vezes: number; ultima: string | null }>> {
  const rows = await sql`
    SELECT si.volunteer_id, COUNT(DISTINCT s.id)::int AS vezes, MAX(s.service_date) AS ultima
    FROM schedule_items si JOIN schedules s ON s.id = si.schedule_id GROUP BY si.volunteer_id`;
  return new Map(rows.map((r) => [r.volunteer_id as number, { vezes: r.vezes, ultima: r.ultima }]));
}

/** Total de faltas e data da última falta por voluntário. */
export async function absenceInfo(sql: Sql): Promise<Map<number, { total: number; ultima: string | null }>> {
  const rows = await sql`
    SELECT p.volunteer_id, COUNT(*)::int AS total, MAX(s.service_date) AS ultima
    FROM presence p JOIN schedules s ON s.id = p.schedule_id WHERE p.absent GROUP BY p.volunteer_id`;
  return new Map(rows.map((r) => [r.volunteer_id as number, { total: r.total, ultima: r.ultima }]));
}

export interface AbsenceItem {
  date: string;
  team: string;
  reason: string;
}

/** Cada falta registrada (mais recente primeiro): data, equipe e motivo. */
export async function absenceDetails(sql: Sql): Promise<Map<number, AbsenceItem[]>> {
  const rows = await sql`
    SELECT p.volunteer_id, s.service_date, s.team, p.justification FROM presence p
    JOIN schedules s ON s.id = p.schedule_id WHERE p.absent
    ORDER BY s.service_date DESC, s.id DESC`;
  const out = new Map<number, AbsenceItem[]>();
  for (const r of rows) {
    if (!out.has(r.volunteer_id)) out.set(r.volunteer_id, []);
    out.get(r.volunteer_id)!.push({ date: r.service_date, team: r.team, reason: r.justification ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------- matriz do histórico

export const HISTORY_HEADERS = [
  "Voluntarios", "Genero", "Equipe", "Total_Faltas", "Ultima_Falta",
  "Cozinha", "Confete", "Banheiro (Entrada)", "Banheiro (Saída)",
  "Limpeza Altar", "Limpeza Confete", "Recepção",
  "POS_BM", "POS_GM", "POS_GF", "POS_BK", "POS_BF",
  ...Array.from({ length: 22 }, (_, i) => `POS_${String(i + 1).padStart(2, "0")}`),
];

const CATEGORY_COLUMN: Record<string, string> = {
  Cozinha: "Cozinha",
  Confete: "Confete",
  "Banheiro Entrada": "Banheiro (Entrada)",
  "Banheiro Saida": "Banheiro (Saída)",
  "Limpeza Altar": "Limpeza Altar",
  "Limpeza Conf": "Limpeza Confete",
  Recepcao: "Recepção",
};

function matrixColumn(category: string, rawCode: string): string | null {
  const code = (rawCode ?? "").trim().toUpperCase();
  if (["Corredor", "Galeria", "Banheiro", "Bercario"].includes(category)) {
    if (["BM", "GM", "GF", "BK", "BF"].includes(code)) return `POS_${code}`;
    if (/^\d+$/.test(code)) return `POS_${code.padStart(2, "0")}`;
    return null;
  }
  return CATEGORY_COLUMN[category] ?? null;
}

export type HistoryRow = Record<string, string | number | boolean>;

export async function getHistoryMatrix(sql: Sql, team: string | null = null): Promise<HistoryRow[]> {
  const [vols, seeds, positionSeeds, items, absences] = await Promise.all([
    getVolunteers(sql, { activeOnly: false, team }),
    sql`SELECT volunteer_id, category, count FROM history_seed`,
    sql`SELECT volunteer_id, position_code, count FROM history_position_seed`,
    sql`SELECT volunteer_id, category, position_code, COUNT(*)::int AS n FROM schedule_items
        GROUP BY volunteer_id, category, position_code`,
    absenceInfo(sql),
  ]);
  const rows = new Map<number, HistoryRow>();
  for (const v of vols) {
    const row: HistoryRow = Object.fromEntries(HISTORY_HEADERS.map((h) => [h, 0]));
    Object.assign(row, { id: v.id, Voluntarios: v.name, Genero: v.gender, Equipe: v.team, Ultima_Falta: "", Ativo: v.active });
    rows.set(v.id, row);
  }
  const add = (id: number, col: string | null | undefined, n: number) => {
    const row = rows.get(id);
    if (row && col) row[col] = (row[col] as number) + n;
  };
  for (const r of seeds) add(r.volunteer_id, CATEGORY_COLUMN[r.category], r.count);
  for (const r of positionSeeds) add(r.volunteer_id, matrixColumn("Corredor", r.position_code), r.count);
  for (const r of items) add(r.volunteer_id, matrixColumn(r.category, r.position_code), r.n);
  for (const [id, info] of absences) {
    const row = rows.get(id);
    if (row) Object.assign(row, { Total_Faltas: info.total, Ultima_Falta: info.ultima ?? "" });
  }
  return [...rows.values()]; // já na ordem de getVolunteers (por nome)
}

// ---------------------------------------------------------------- acessos (app_users)

export type Role = "admin" | "coordinator";

/** Acesso de uma pessoa: o papel e, para coordenador, as equipes que ela coordena. */
export interface Access {
  role: Role;
  teams: string[];
}

export interface AppUser extends Access {
  email: string;
  created_at: Date;
  created_by: string | null;
  /** nome informado ao criar a conta no login (null se ainda não criou) */
  name: string | null;
  has_account: boolean;
  verified: boolean;
}

/** E-mail em minúsculas e sem espaços; erro se não parecer um e-mail. */
export function cleanEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new UserError("E-mail inválido.");
  return email;
}

export function cleanRole(value: unknown): Role {
  if (value === "admin" || value === "coordinator") return value;
  throw new UserError("Papel inválido.");
}

/** Equipes de um coordenador: precisam existir (`valid`) e não podem repetir. */
export function cleanTeams(value: unknown, valid: string[]): string[] {
  if (!Array.isArray(value)) throw new UserError("Informe as equipes do coordenador.");
  const byKey = new Map(valid.map((t) => [normalizeTeam(t), t]));
  const teams = new Set<string>();
  for (const item of value) {
    const team = byKey.get(normalizeTeam(item));
    if (!team) throw new UserError(`Equipe desconhecida: ${String(item)}.`);
    teams.add(team);
  }
  return [...teams].sort();
}

/** Acesso de quem está liberado, ou null se o e-mail não está na lista. */
export async function getAccess(sql: Sql, email: string): Promise<Access | null> {
  const rows = await sql`SELECT role, teams FROM app_users WHERE email = ${email.trim().toLowerCase()}`;
  return rows.length ? { role: rows[0].role as Role, teams: (rows[0].teams as string[]) ?? [] } : null;
}

/** Lista de acessos, com a situação da conta de cada e-mail no login. */
export async function listAppUsers(sql: Sql): Promise<AppUser[]> {
  const rows = await sql`
    SELECT a.email, a.role, a.teams, a.created_at, a.created_by, u.name,
           (u.email IS NOT NULL) AS has_account, COALESCE(u."emailVerified", false) AS verified
    FROM app_users a
    LEFT JOIN neon_auth."user" u ON lower(u.email) = a.email
    ORDER BY (a.role = 'admin') DESC, a.email`;
  return rows as unknown as AppUser[];
}

/** Libera um e-mail ou muda o papel e as equipes de quem já está liberado. */
export async function upsertAppUser(sql: Sql, email: string, access: Access, by: string | null): Promise<void> {
  const teams = access.role === "admin" ? [] : access.teams;
  await sql`
    INSERT INTO app_users (email, role, teams, created_by)
    VALUES (${email}, ${access.role}, ${teams}::text[], ${by})
    ON CONFLICT (email) DO UPDATE SET role = excluded.role, teams = excluded.teams`;
}

/** Nome da conta de login desse e-mail; null se a pessoa ainda não tem conta. */
export async function getAccountName(sql: Sql, email: string): Promise<{ name: string } | null> {
  const rows = await sql`SELECT name FROM neon_auth."user" WHERE lower(email) = ${email} LIMIT 1`;
  return rows.length ? { name: (rows[0].name as string) ?? "" } : null;
}

export async function removeAppUser(sql: Sql, email: string): Promise<void> {
  await sql`DELETE FROM app_users WHERE email = ${email}`;
}

export async function countAdmins(sql: Sql): Promise<number> {
  return (await sql`SELECT COUNT(*)::int AS n FROM app_users WHERE role = 'admin'`)[0].n;
}

/** Equipe atual de um voluntário (null se o id não existe). */
export async function getVolunteerTeam(sql: Sql, id: number): Promise<string | null> {
  const rows = await sql`SELECT team FROM volunteers WHERE id = ${id}`;
  return rows.length ? (rows[0].team as string) : null;
}
