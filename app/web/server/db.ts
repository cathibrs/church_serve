/**
 * Acesso ao Postgres (Neon).
 *
 * Cada função faz o filtro e a soma no próprio banco e devolve só o que a rota vai usar:
 * nada de trazer a tabela inteira para filtrar aqui. Consultas independentes saem juntas
 * (Promise.all), porque cada uma é uma ida ao banco pela rede.
 */
import { neon } from "@neondatabase/serverless";
import { EVENT_TEAM, POSITIONS, TEAM_OPTIONS } from "./config.ts";
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

/** Cria as tabelas que faltam (db/schema.sql, um comando por vez). */
export async function applySchema(sql: Sql, schemaText: string): Promise<void> {
  const statements = schemaText
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await sql.query(statement);
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

/** Equipe de um culto: todos (ativos e inativos) dessas equipes, com as faltas de cada um. null = todos (evento). */
export async function getRoster(sql: Sql, teams: Teams): Promise<RosterVolunteer[]> {
  const rows = await sql.query(`SELECT v.*, ${FALTAS} FROM volunteers v WHERE ${VOLUNTEER_SCOPE}`, volunteerScope(false, teams));
  return sortByName(rows.map((r) => ({ ...volunteerFromRow(r), faltas: r.faltas })));
}

/** Voluntário com os números que o cadastro mostra. */
export interface VolunteerStats extends RosterVolunteer {
  vezes: number;
  ultima_vez: string | null;
  /** quantas observações datadas a pessoa tem e o texto da mais recente */
  notas: number;
  ultima_nota: string | null;
}

/** Voluntários (ativos e inativos) com faltas, vezes que serviu, a última vez e as observações, em uma consulta. */
export async function getVolunteersWithStats(sql: Sql, teams: Teams = null): Promise<VolunteerStats[]> {
  const rows = await sql.query(
    `SELECT v.*, ${FALTAS},
       (SELECT COUNT(DISTINCT si.schedule_id)::int FROM schedule_items si WHERE si.volunteer_id = v.id) AS vezes,
       (SELECT MAX(s.service_date) FROM schedule_items si JOIN schedules s ON s.id = si.schedule_id
         WHERE si.volunteer_id = v.id) AS ultima_vez,
       (SELECT COUNT(*)::int FROM volunteer_notes n WHERE n.volunteer_id = v.id) AS notas,
       (SELECT n.body FROM volunteer_notes n WHERE n.volunteer_id = v.id
         ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS ultima_nota
     FROM volunteers v WHERE ${VOLUNTEER_SCOPE}`,
    volunteerScope(false, teams),
  );
  return sortByName(
    rows.map((r) => ({
      ...volunteerFromRow(r),
      faltas: r.faltas,
      vezes: r.vezes,
      ultima_vez: r.ultima_vez ?? null,
      notas: r.notas,
      ultima_nota: r.ultima_nota ?? null,
    })),
  );
}

/** Equipes que existem: as dos voluntários e as fixas, e por último a dos eventos (que junta todos). */
export async function getAvailableTeams(sql: Sql): Promise<string[]> {
  const rows = await sql`SELECT DISTINCT team FROM volunteers WHERE active AND team <> ''`;
  const teams = [...new Set([...rows.map((r) => r.team as string), ...TEAM_OPTIONS])].filter((t) => t !== EVENT_TEAM);
  return [...teams.sort(), EVENT_TEAM];
}

/** Cadastro de um voluntário (null se o id não existe). */
export async function getVolunteer(sql: Sql, id: number): Promise<Volunteer | null> {
  const rows = await sql`SELECT * FROM volunteers WHERE id = ${id}`;
  return rows.length ? volunteerFromRow(rows[0]) : null;
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
  const items = await sql`
    SELECT volunteer_id, category, position_code, COUNT(*)::int AS n FROM schedule_items
    WHERE volunteer_id = ANY(${volunteerIds}::int[]) GROUP BY volunteer_id, category, position_code`;
  const add = (target: Record<string, number>, key: string, n: number) => (target[key] = (target[key] ?? 0) + n);
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
  /** quem estava presente (no evento, quem foi escolhido para servir) */
  present: number[];
}

/**
 * Escala mais recente salva para a data e a equipe (ou null). As três consultas saem juntas:
 * as de itens e de faltas localizam a escala por conta própria, sem esperar a primeira.
 */
export async function findSchedule(sql: Sql, serviceDate: string, team: string): Promise<SavedSchedule | null> {
  const [found, items, people] = await Promise.all([
    sql`SELECT id, created_at, active_codes FROM schedules
        WHERE service_date = ${serviceDate} AND team = ${team} ORDER BY id DESC LIMIT 1`,
    sql`SELECT position_code, position_name, category, volunteer_id, volunteer_name, item_order
        FROM schedule_items
        WHERE schedule_id = (SELECT id FROM schedules WHERE service_date = ${serviceDate} AND team = ${team}
                             ORDER BY id DESC LIMIT 1)
        ORDER BY item_order`,
    sql`SELECT volunteer_id, absent, justification FROM presence
        WHERE schedule_id = (SELECT id FROM schedules WHERE service_date = ${serviceDate} AND team = ${team}
                             ORDER BY id DESC LIMIT 1)
        ORDER BY volunteer_id`,
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
    absent: new Map(people.filter((r) => r.absent).map((r) => [r.volunteer_id as number, (r.justification as string) ?? ""])),
    present: people.filter((r) => !r.absent).map((r) => r.volunteer_id as number),
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

/**
 * Equipe da última escala salva nesse dia da semana (ou null). `teams` limita a busca a essas
 * equipes. Eventos não entram: um evento num domingo não faz o domingo seguinte virar evento.
 */
export async function lastTeamFor(sql: Sql, serviceType: string, teams: Teams = null): Promise<string | null> {
  const rows = await sql`
    SELECT team FROM schedules
    WHERE service_type = ${serviceType} AND team <> '' AND team <> ${EVENT_TEAM}
      AND (${teams === null}::boolean OR team = ANY(${teams ?? []}::text[]))
    ORDER BY service_date DESC, id DESC LIMIT 1`;
  return rows[0]?.team ?? null;
}

/** Quem serviu no último evento antes dessa data (para repetir as mesmas pessoas), ou null. */
export async function lastEventPeople(sql: Sql, beforeDate: string): Promise<{ date: string; ids: number[] } | null> {
  const rows = await sql`
    WITH last AS (
      SELECT id, service_date FROM schedules
      WHERE team = ${EVENT_TEAM} AND service_date < ${beforeDate}
      ORDER BY service_date DESC, id DESC LIMIT 1
    )
    SELECT last.service_date, p.volunteer_id FROM last
    LEFT JOIN presence p ON p.schedule_id = last.id AND NOT p.absent
    ORDER BY p.volunteer_id`;
  if (!rows.length) return null;
  return { date: rows[0].service_date, ids: rows.filter((r) => r.volunteer_id !== null).map((r) => r.volunteer_id as number) };
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
 * faltas, contados nas escalas salvas.
 */
export async function getHistory(sql: Sql, teams: Teams = null): Promise<HistoryRow[]> {
  const scope = volunteerScope(true, teams);
  const [vols, counts, absences] = await Promise.all([
    sql.query(`SELECT v.id, v.name, v.gender, v.team FROM volunteers v WHERE ${VOLUNTEER_SCOPE}`, scope),
    sql.query(
      `SELECT t.volunteer_id, t.category, t.position_code, COUNT(*)::int AS n FROM schedule_items t
       JOIN volunteers v ON v.id = t.volunteer_id
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

/** Acesso como está gravado: o papel, as equipes e se está suspenso. */
export interface StoredAccess extends Access {
  suspended: boolean;
}

export interface AppUser extends StoredAccess {
  email: string;
  created_at: Date;
  created_by: string | null;
  /** nome informado ao criar a conta no login (null se ainda não criou) */
  name: string | null;
  has_account: boolean;
  verified: boolean;
  /** último pedido feito ao sistema (com precisão de alguns minutos); null se nunca entrou */
  last_seen_at: Date | null;
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

const accessFromRow = (r: Row): StoredAccess => ({
  role: r.role as Role,
  teams: (r.teams as string[]) ?? [],
  suspended: r.suspended === true,
});

/** Acesso de quem está liberado, ou null se o e-mail não está na lista. */
export async function getAccess(sql: Sql, email: string): Promise<StoredAccess | null> {
  const rows = await sql`SELECT role, teams, suspended FROM app_users WHERE email = ${email.trim().toLowerCase()}`;
  return rows.length ? accessFromRow(rows[0]) : null;
}

/** Intervalo mínimo entre duas anotações de "último acesso": não grava a cada pedido. */
const SEEN_EVERY = "5 minutes";

/**
 * Acesso de quem está fazendo o pedido, anotando o último acesso. É uma ida só ao banco: a
 * leitura vê a linha como estava antes da anotação, o que não muda o papel nem as equipes.
 */
export async function touchAccess(sql: Sql, email: string): Promise<StoredAccess | null> {
  const key = email.trim().toLowerCase();
  const rows = await sql.query(
    `WITH seen AS (
       UPDATE app_users SET last_seen_at = now()
       WHERE email = $1 AND NOT suspended
         AND (last_seen_at IS NULL OR last_seen_at < now() - interval '${SEEN_EVERY}')
     )
     SELECT role, teams, suspended FROM app_users WHERE email = $1`,
    [key],
  );
  return rows.length ? accessFromRow(rows[0]) : null;
}

/** Acessos com a situação da conta de cada e-mail no login. `email`: só o acesso desse e-mail. */
export async function listAppUsers(sql: Sql, email: string | null = null): Promise<AppUser[]> {
  const rows = await sql`
    SELECT a.email, a.role, a.teams, a.suspended, a.last_seen_at, a.created_at, a.created_by, u.name,
           (u.email IS NOT NULL) AS has_account, COALESCE(u."emailVerified", false) AS verified
    FROM app_users a
    LEFT JOIN neon_auth."user" u ON lower(u.email) = a.email
    WHERE ${email}::text IS NULL OR a.email = ${email}
    ORDER BY (a.role = 'admin') DESC, a.email`;
  return rows as unknown as AppUser[];
}

export async function setSuspended(sql: Sql, email: string, suspended: boolean): Promise<void> {
  await sql`UPDATE app_users SET suspended = ${suspended} WHERE email = ${email}`;
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

/** Administradores que conseguem entrar (suspensos não contam). */
export async function countAdmins(sql: Sql): Promise<number> {
  return (await sql`SELECT COUNT(*)::int AS n FROM app_users WHERE role = 'admin' AND NOT suspended`)[0].n;
}

// ---------------------------------------------------------------- observações dos voluntários

export interface VolunteerNote {
  id: number;
  volunteer_id: number;
  body: string;
  /** e-mail de quem escreveu */
  author: string;
  /** nome da conta de quem escreveu (null se a conta não existe mais) */
  author_name: string | null;
  created_at: Date;
}

export const NOTE_LIMIT = 1000;

const NOTE_COLUMNS = `n.id, n.volunteer_id, n.body, n.author, n.created_at,
  (SELECT u.name FROM neon_auth."user" u WHERE lower(u.email) = n.author LIMIT 1) AS author_name`;

/** Observações de um voluntário, da mais recente para a mais antiga. */
export async function listNotes(sql: Sql, volunteerId: number): Promise<VolunteerNote[]> {
  const rows = await sql.query(
    `SELECT ${NOTE_COLUMNS} FROM volunteer_notes n WHERE n.volunteer_id = $1 ORDER BY n.created_at DESC, n.id DESC`,
    [volunteerId],
  );
  return rows as unknown as VolunteerNote[];
}

export async function addNote(sql: Sql, volunteerId: number, body: unknown, author: string): Promise<VolunteerNote> {
  const text = cleanText(body, NOTE_LIMIT);
  if (!text) throw new UserError("Escreva a observação.");
  const rows = await sql.query(
    `WITH n AS (
       INSERT INTO volunteer_notes (volunteer_id, body, author) VALUES ($1, $2, $3) RETURNING *
     )
     SELECT ${NOTE_COLUMNS} FROM n`,
    [volunteerId, text, author],
  );
  return rows[0] as VolunteerNote;
}

/** Uma observação (null se não existe ou é de outro voluntário). */
export async function getNote(sql: Sql, volunteerId: number, id: number): Promise<VolunteerNote | null> {
  const rows = await sql.query(`SELECT ${NOTE_COLUMNS} FROM volunteer_notes n WHERE n.id = $1 AND n.volunteer_id = $2`, [
    id,
    volunteerId,
  ]);
  return (rows[0] as VolunteerNote | undefined) ?? null;
}

export async function removeNote(sql: Sql, id: number): Promise<void> {
  await sql`DELETE FROM volunteer_notes WHERE id = ${id}`;
}

// ---------------------------------------------------------------- registro de atividades

export interface ActivityInput {
  actor: string;
  /** "grupo.ação": volunteer.create, note.add, schedule.save, user.suspend... */
  action: string;
  /** o que foi mexido; com `merge`, junta gravações seguidas da mesma coisa */
  target?: string | null;
  team?: string | null;
  summary: string;
  details?: unknown;
}

export interface ActivityRow {
  id: number;
  at: Date;
  actor: string;
  actor_name: string | null;
  action: string;
  target: string | null;
  team: string | null;
  summary: string;
  details: unknown;
  repeats: number;
}

/**
 * Anota uma atividade. Com `merge`, se a mesma pessoa mexeu na mesma coisa há menos que esse
 * tempo, a linha anterior é atualizada em vez de criar outra: a escala salva sozinha a cada
 * troca, e o registro mostraria dezenas de linhas iguais.
 */
export async function logActivity(sql: Sql, entry: ActivityInput, merge?: "30 minutes"): Promise<void> {
  const details = entry.details === undefined ? null : JSON.stringify(entry.details);
  const values = [entry.actor, entry.action, entry.target ?? null, entry.team ?? null, entry.summary, details];
  if (!merge || !entry.target) {
    await sql.query(
      `INSERT INTO activity_log (actor, action, target, team, summary, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      values,
    );
    return;
  }
  await sql.query(
    `WITH last AS (
       SELECT id FROM activity_log
       WHERE actor = $1 AND action = $2 AND target = $3 AND at > now() - interval '${merge}'
       ORDER BY id DESC LIMIT 1
     ), bumped AS (
       UPDATE activity_log a SET at = now(), summary = $5, details = $6::jsonb, repeats = a.repeats + 1
       FROM last WHERE a.id = last.id RETURNING a.id
     )
     INSERT INTO activity_log (actor, action, target, team, summary, details)
     SELECT $1, $2, $3, $4, $5, $6::jsonb WHERE NOT EXISTS (SELECT 1 FROM bumped)`,
    values,
  );
}

export interface ActivityFilter {
  actor?: string | null;
  /** grupo de ações ("volunteer", "schedule"...) */
  group?: string | null;
  team?: string | null;
  /** só linhas com id menor que este (próxima página) */
  before?: number | null;
  limit?: number;
}

/** Atividades da mais recente para a mais antiga, com o nome de quem fez. */
export async function listActivity(sql: Sql, f: ActivityFilter = {}): Promise<ActivityRow[]> {
  const rows = await sql.query(
    `SELECT a.id::int AS id, a.at, a.actor, a.action, a.target, a.team, a.summary, a.details, a.repeats,
       (SELECT u.name FROM neon_auth."user" u WHERE lower(u.email) = a.actor LIMIT 1) AS actor_name
     FROM activity_log a
     WHERE ($1::text IS NULL OR a.actor = $1)
       AND ($2::text IS NULL OR a.action LIKE $2 || '.%')
       AND ($3::text IS NULL OR ${teamKeySql("a.team")} = $3)
       AND ($4::bigint IS NULL OR a.id < $4)
     ORDER BY a.id DESC LIMIT $5`,
    [f.actor ?? null, f.group ?? null, f.team ? teamKeys([f.team])[0] : null, f.before ?? null, f.limit ?? 50],
  );
  return rows as unknown as ActivityRow[];
}

/** Quem aparece no registro (para o filtro da tela). */
export async function activityActors(sql: Sql): Promise<string[]> {
  const rows = await sql`SELECT DISTINCT actor FROM activity_log ORDER BY actor`;
  return rows.map((r) => r.actor as string);
}

// ---------------------------------------------------------------- regras para coordenadores

/** O que o administrador libera ou trava para os coordenadores. */
export interface Rules {
  /** coordenador cadastra e altera voluntários das equipes dele */
  coordinators_edit_volunteers: boolean;
  /** coordenador não altera escalas de cultos que já passaram */
  lock_past_schedules: boolean;
}

export const DEFAULT_RULES: Rules = { coordinators_edit_volunteers: true, lock_past_schedules: false };
const RULES_KEY = "regras_coordenadores";

export async function getRules(sql: Sql): Promise<Rules> {
  const saved = (await getMetaMany(sql, [RULES_KEY])).get(RULES_KEY) as Partial<Rules> | undefined;
  return { ...DEFAULT_RULES, ...(saved && typeof saved === "object" ? saved : {}) };
}

/** Grava só as regras conhecidas que vierem no pedido; as outras ficam como estão. */
export async function setRules(sql: Sql, input: Record<string, unknown>): Promise<Rules> {
  const current = await getRules(sql);
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_RULES) as (keyof Rules)[]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new UserError("Regra inválida.");
    next[key] = input[key];
  }
  await setMeta(sql, RULES_KEY, next);
  return next;
}
