/**
 * Acesso ao Postgres (Neon).
 *
 * Cada função faz o filtro e a soma no próprio banco e devolve só o que a rota vai usar:
 * nada de trazer a tabela inteira para filtrar aqui. Consultas independentes saem juntas
 * (Promise.all), porque cada uma é uma ida ao banco pela rede.
 */
import { neon } from "@neondatabase/serverless";
import { POSITIONS, TEAM_OPTIONS } from "./config.ts";
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

// ---------------------------------------------------------------- filtro por equipe

/** Equipes de uma consulta: null = todas (admin sem filtro). */
export type Teams = string[] | null;

/**
 * Equipe comparada no banco sem diferença de maiúsculas e tratando espaço, hífen e
 * sublinhado como iguais ("Domingo Manha A" = "Domingo_Manha_A").
 */
const teamKeySql = (column: string) => `translate(lower(btrim(${column})), '- ', '__')`;
const teamKeys = (teams: Teams) => (teams ?? []).map((t) => t.trim().toLowerCase().replace(/[- ]/g, "_"));

/** Condição "voluntário v dentro do pedido"; os parâmetros $1..$3 vêm de volunteerScope(). */
const VOLUNTEER_SCOPE = `(v.active OR NOT $1::boolean) AND ($2::boolean OR ${teamKeySql("v.team")} = ANY($3::text[]))`;
const volunteerScope = (activeOnly: boolean, teams: Teams) => [activeOnly, teams === null, teamKeys(teams)];

// ---------------------------------------------------------------- meta

/** Valores guardados em app_meta para essas chaves (só as que existem). */
export async function getMetaMany(sql: Sql, keys: string[]): Promise<Map<string, unknown>> {
  const rows = await sql`SELECT key, value FROM app_meta WHERE key = ANY(${keys}::text[])`;
  return new Map(rows.filter((r) => r.value !== null && r.value !== undefined).map((r) => [r.key as string, r.value]));
}

export async function setMeta(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql`
    INSERT INTO app_meta (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
}

// ---------------------------------------------------------------- posições (fixas, vêm do código)

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

const sortByName = <T extends { name: string }>(list: T[]) => list.sort((a, b) => byName(a.name, b.name));

export async function getVolunteers(sql: Sql, opts: { activeOnly?: boolean; teams?: Teams } = {}): Promise<Volunteer[]> {
  const rows = await sql.query(
    `SELECT v.* FROM volunteers v WHERE ${VOLUNTEER_SCOPE}`,
    volunteerScope(opts.activeOnly ?? true, opts.teams ?? null),
  );
  return sortByName(rows.map(volunteerFromRow));
}

const FALTAS = "(SELECT COUNT(*)::int FROM presence p WHERE p.volunteer_id = v.id AND p.absent) AS faltas";

/** Voluntário com o total de faltas, que a tela da escala mostra ao lado do nome. */
export interface RosterVolunteer extends Volunteer {
  faltas: number;
}

/** Equipe de um culto: todos (ativos e inativos) da equipe, com as faltas de cada um. */
export async function getRoster(sql: Sql, team: string): Promise<RosterVolunteer[]> {
  const rows = await sql.query(`SELECT v.*, ${FALTAS} FROM volunteers v WHERE ${VOLUNTEER_SCOPE}`, volunteerScope(false, [team]));
  return sortByName(rows.map((r) => ({ ...volunteerFromRow(r), faltas: r.faltas })));
}

/** Voluntário com os números que o cadastro mostra. */
export interface VolunteerStats extends RosterVolunteer {
  vezes: number;
  ultima_vez: string | null;
}

/** Voluntários (ativos e inativos) com faltas, vezes que serviu e a última vez, em uma consulta. */
export async function getVolunteersWithStats(sql: Sql, teams: Teams = null): Promise<VolunteerStats[]> {
  const rows = await sql.query(
    `SELECT v.*, ${FALTAS},
       (SELECT COUNT(DISTINCT si.schedule_id)::int FROM schedule_items si WHERE si.volunteer_id = v.id) AS vezes,
       (SELECT MAX(s.service_date) FROM schedule_items si JOIN schedules s ON s.id = si.schedule_id
         WHERE si.volunteer_id = v.id) AS ultima_vez
     FROM volunteers v WHERE ${VOLUNTEER_SCOPE}`,
    volunteerScope(false, teams),
  );
  return sortByName(
    rows.map((r) => ({ ...volunteerFromRow(r), faltas: r.faltas, vezes: r.vezes, ultima_vez: r.ultima_vez ?? null })),
  );
}

export async function getAvailableTeams(sql: Sql): Promise<string[]> {
  const rows = await sql`SELECT DISTINCT team FROM volunteers WHERE active AND team <> ''`;
  return [...new Set([...rows.map((r) => r.team as string), ...TEAM_OPTIONS])].sort();
}

/** Equipe atual de um voluntário (null se o id não existe). */
export async function getVolunteerTeam(sql: Sql, id: number): Promise<string | null> {
  const rows = await sql`SELECT team FROM volunteers WHERE id = ${id}`;
  return rows.length ? (rows[0].team as string) : null;
}

export interface VolunteerInput {
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

const given = (value: unknown) => value !== undefined && value !== null;

/** Nome repetido (índice único) vira uma mensagem clara. */
function duplicateName(e: unknown, name: string | null): never {
  if ((e as { code?: string }).code === "23505") throw new UserError(`Já existe um voluntário chamado ${name}.`);
  throw e;
}

export async function createVolunteer(sql: Sql, input: VolunteerInput): Promise<Volunteer> {
  const name = cleanName(input.name);
  if (!name) throw new UserError("Informe o nome do voluntário.");
  const flag = (value: unknown, fallback: boolean) => (given(value) ? Boolean(value) : fallback);
  try {
    const rows = await sql`
      INSERT INTO volunteers (name, gender, team, active, can_bercario, can_cozinha, can_recepcao,
                              can_banheiro, can_limpar_altar, observation)
      VALUES (${name}, ${cleanGender(input.gender) ?? "Masculino"}, ${cleanTeam(input.team)}, ${flag(input.active, true)},
              ${Boolean(input.can_bercario)}, ${flag(input.can_cozinha, true)}, ${flag(input.can_recepcao, true)},
              ${flag(input.can_banheiro, true)}, ${flag(input.can_limpar_altar, true)}, ${cleanText(input.observation)})
      RETURNING *`;
    return volunteerFromRow(rows[0]);
  } catch (e) {
    duplicateName(e, name);
  }
}

/** Altera só os campos enviados; os outros ficam como estão. Devolve null se o id não existe. */
export async function updateVolunteer(sql: Sql, id: number, input: VolunteerInput): Promise<Volunteer | null> {
  const name = given(input.name) ? cleanName(input.name) : null;
  if (name === "") throw new UserError("Informe o nome do voluntário.");
  const flag = (value: unknown) => (given(value) ? Boolean(value) : null);
  const team = given(input.team) ? cleanTeam(input.team) : null;
  const observation = given(input.observation) ? cleanText(input.observation) : null;
  try {
    const rows = await sql`
      UPDATE volunteers SET
        name = COALESCE(${name}::text, name),
        gender = COALESCE(${cleanGender(input.gender)}::text, gender),
        team = COALESCE(${team}::text, team),
        active = COALESCE(${flag(input.active)}::boolean, active),
        can_bercario = COALESCE(${flag(input.can_bercario)}::boolean, can_bercario),
        can_cozinha = COALESCE(${flag(input.can_cozinha)}::boolean, can_cozinha),
        can_recepcao = COALESCE(${flag(input.can_recepcao)}::boolean, can_recepcao),
        can_banheiro = COALESCE(${flag(input.can_banheiro)}::boolean, can_banheiro),
        can_limpar_altar = COALESCE(${flag(input.can_limpar_altar)}::boolean, can_limpar_altar),
        observation = COALESCE(${observation}::text, observation)
      WHERE id = ${id} RETURNING *`;
    return rows.length ? volunteerFromRow(rows[0]) : null;
  } catch (e) {
    duplicateName(e, name);
  }
}

// ---------------------------------------------------------------- rotatividade (usada ao gerar)

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

/**
 * Escala mais recente salva para a data e a equipe (ou null). As três consultas saem juntas:
 * as de itens e de faltas localizam a escala por conta própria, sem esperar a primeira.
 */
export async function findSchedule(sql: Sql, serviceDate: string, team: string): Promise<SavedSchedule | null> {
  const [found, items, absent] = await Promise.all([
    sql`SELECT id, created_at, active_codes FROM schedules
        WHERE service_date = ${serviceDate} AND team = ${team} ORDER BY id DESC LIMIT 1`,
    sql`SELECT position_code, position_name, category, volunteer_id, volunteer_name, item_order
        FROM schedule_items
        WHERE schedule_id = (SELECT id FROM schedules WHERE service_date = ${serviceDate} AND team = ${team}
                             ORDER BY id DESC LIMIT 1)
        ORDER BY item_order`,
    sql`SELECT volunteer_id, justification FROM presence
        WHERE absent AND schedule_id = (SELECT id FROM schedules WHERE service_date = ${serviceDate} AND team = ${team}
                                        ORDER BY id DESC LIMIT 1)`,
  ]);
  if (!found.length) return null;
  const s = found[0];
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
  itens: number;
  faltas: number;
}

/** Escalas salvas, da mais recente para a mais antiga, já filtradas por equipe. */
export async function listSchedules(sql: Sql, teams: Teams = null, limit = 200): Promise<ScheduleRow[]> {
  const rows = await sql.query(
    `SELECT s.id, s.service_date, s.service_type, s.team,
       (SELECT COUNT(*)::int FROM schedule_items i WHERE i.schedule_id = s.id) AS itens,
       (SELECT COUNT(*)::int FROM presence p WHERE p.schedule_id = s.id AND p.absent) AS faltas
     FROM schedules s
     WHERE $1::boolean OR ${teamKeySql("s.team")} = ANY($2::text[])
     ORDER BY s.service_date DESC, s.id DESC LIMIT $3`,
    [teams === null, teamKeys(teams), limit],
  );
  return rows as unknown as ScheduleRow[];
}

/** Equipe da última escala salva nesse dia da semana (ou null). `teams` limita a busca a essas equipes. */
export async function lastTeamFor(sql: Sql, serviceType: string, teams: Teams = null): Promise<string | null> {
  const rows = await sql`
    SELECT team FROM schedules
    WHERE service_type = ${serviceType} AND team <> ''
      AND (${teams === null}::boolean OR team = ANY(${teams ?? []}::text[]))
    ORDER BY service_date DESC, id DESC LIMIT 1`;
  return rows[0]?.team ?? null;
}

// ---------------------------------------------------------------- histórico

export interface AbsenceItem {
  date: string;
  team: string;
  reason: string;
}

/** Linha do histórico: só os números diferentes de zero, por coluna. */
export interface HistoryRow {
  id: number;
  name: string;
  gender: string;
  team: string;
  faltas: number;
  /** coluna (ex.: "Cozinha", "POS_07") -> quantas vezes serviu */
  counts: Record<string, number>;
  /** faltas mais recentes (até RECENT_ABSENCES), com data e motivo */
  absences: AbsenceItem[];
}

export const RECENT_ABSENCES = 8;

const CATEGORY_COLUMN: Record<string, string> = {
  Cozinha: "Cozinha",
  Confete: "Confete",
  "Banheiro Entrada": "Banheiro (Entrada)",
  "Banheiro Saida": "Banheiro (Saída)",
  "Limpeza Altar": "Limpeza Altar",
  "Limpeza Conf": "Limpeza Confete",
  Recepcao: "Recepção",
};

function historyColumn(category: string, rawCode: string | null): string | null {
  const code = (rawCode ?? "").trim().toUpperCase();
  if (["Corredor", "Galeria", "Banheiro", "Bercario"].includes(category)) {
    if (["BM", "GM", "GF", "BK", "BF"].includes(code)) return `POS_${code}`;
    if (/^\d+$/.test(code)) return `POS_${code.padStart(2, "0")}`;
    return null;
  }
  return CATEGORY_COLUMN[category] ?? null;
}

/**
 * Histórico dos voluntários ativos: quantas vezes cada um serviu em cada função e as
 * faltas. O banco soma a carga inicial da planilha com as escalas salvas.
 */
export async function getHistory(sql: Sql, teams: Teams = null): Promise<HistoryRow[]> {
  const scope = volunteerScope(true, teams);
  const [vols, counts, absences] = await Promise.all([
    sql.query(`SELECT v.id, v.name, v.gender, v.team FROM volunteers v WHERE ${VOLUNTEER_SCOPE}`, scope),
    sql.query(
      `SELECT t.volunteer_id, t.category, t.position_code, SUM(t.n)::int AS n FROM (
         SELECT volunteer_id, category, NULL::text AS position_code, count AS n FROM history_seed
         UNION ALL
         SELECT volunteer_id, 'Corredor', position_code, count FROM history_position_seed
         UNION ALL
         SELECT volunteer_id, category, position_code, 1 FROM schedule_items
       ) t JOIN volunteers v ON v.id = t.volunteer_id
       WHERE ${VOLUNTEER_SCOPE}
       GROUP BY t.volunteer_id, t.category, t.position_code`,
      scope,
    ),
    sql.query(
      `SELECT volunteer_id, service_date, team, justification, total FROM (
         SELECT p.volunteer_id, s.service_date, s.team, p.justification,
                (COUNT(*) OVER (PARTITION BY p.volunteer_id))::int AS total,
                row_number() OVER (PARTITION BY p.volunteer_id ORDER BY s.service_date DESC, s.id DESC) AS rn
         FROM presence p
         JOIN schedules s ON s.id = p.schedule_id
         JOIN volunteers v ON v.id = p.volunteer_id
         WHERE p.absent AND ${VOLUNTEER_SCOPE}
       ) t WHERE rn <= ${RECENT_ABSENCES} ORDER BY volunteer_id, rn`,
      scope,
    ),
  ]);
  const rows = new Map<number, HistoryRow>(
    vols.map((v) => [v.id, { id: v.id, name: v.name, gender: v.gender, team: v.team, faltas: 0, counts: {}, absences: [] }]),
  );
  for (const r of counts) {
    const row = rows.get(r.volunteer_id);
    const column = historyColumn(r.category, r.position_code);
    if (row && column) row.counts[column] = (row.counts[column] ?? 0) + r.n;
  }
  for (const r of absences) {
    const row = rows.get(r.volunteer_id);
    if (!row) continue;
    row.faltas = r.total;
    row.absences.push({ date: r.service_date, team: r.team, reason: r.justification ?? "" });
  }
  return sortByName([...rows.values()]);
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

/** Acessos com a situação da conta de cada e-mail no login. `email`: só o acesso desse e-mail. */
export async function listAppUsers(sql: Sql, email: string | null = null): Promise<AppUser[]> {
  const rows = await sql`
    SELECT a.email, a.role, a.teams, a.created_at, a.created_by, u.name,
           (u.email IS NOT NULL) AS has_account, COALESCE(u."emailVerified", false) AS verified
    FROM app_users a
    LEFT JOIN neon_auth."user" u ON lower(u.email) = a.email
    WHERE ${email}::text IS NULL OR a.email = ${email}
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
