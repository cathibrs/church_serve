/** Rotas da API (/api/*). Mesmo contrato do servidor local antigo (app/escala/server.py). */
import { authenticate, HttpError, type AuthOptions } from "./auth.ts";
import {
  isLastSunday,
  isoDate,
  localNow,
  MAP_CATEGORIES,
  RECEPTION_CATEGORY,
  teamForDate,
  weekdayName,
} from "./config.ts";
import * as db from "./db.ts";
import { activePositions, buildSchedule, validate } from "./engine.ts";
import type { Assignment, GenerationResult, Issue } from "./models.ts";

type Body = Record<string, any>;
type Query = Record<string, string>;
type Sql = db.Sql;

const UserError = db.UserError;

// ====================================================================== auxiliares

function dateOf(value: unknown): string {
  if (!value) return localNow().date;
  try {
    return isoDate(String(value).slice(0, 10));
  } catch {
    throw new UserError("Data inválida.");
  }
}

function idSet(value: unknown): Set<number> {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value)) throw new UserError("Lista de presentes inválida.");
  const ids = value.map(Number);
  if (ids.some((i) => !Number.isInteger(i))) throw new UserError("Lista de presentes inválida.");
  return new Set(ids);
}

function codeList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new UserError("Lista de posições inválida.");
  return value.map(String);
}

/** Texto "AAAA-MM-DD HH:MM:SS" no horário de São Paulo. */
function localStamp(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  const { date, time } = localNow(d);
  return `${date} ${time}`;
}

/** Equipe da última escala salva no mesmo dia da semana; senão, a padrão. */
async function suggestTeam(sql: Sql, date: string): Promise<string> {
  return (await db.lastTeamFor(sql, weekdayName(date))) ?? teamForDate(date);
}

async function defaultActive(sql: Sql): Promise<string[]> {
  const positions = db.getPositions();
  const saved = await db.getMeta<string[] | null>(sql, "posicoes_padrao", null);
  if (saved?.length) {
    const codes = new Set(positions.map((p) => p.code));
    return saved.filter((c) => codes.has(c));
  }
  return positions.filter((p) => p.normal_active && !p.event_only).map((p) => p.code);
}

function assignmentsOf(body: Body): Assignment[] {
  const positions = new Map(db.getPositions().map((p) => [p.code, p]));
  const list = body.assignments ?? [];
  if (!Array.isArray(list)) throw new UserError("Escala inválida.");
  const out: Assignment[] = [];
  list.forEach((a: Body, i: number) => {
    const p = positions.get(String(a?.position_code));
    const volunteerId = Number(a?.volunteer_id);
    if (!p || !a?.volunteer_id || !Number.isInteger(volunteerId)) return;
    out.push({
      position_code: p.code,
      position_name: p.name,
      category: p.category,
      volunteer_id: volunteerId,
      volunteer_name: String(a.volunteer_name ?? ""),
      order: i + 1,
    });
  });
  return out;
}

async function validateFor(
  sql: Sql,
  assignments: Assignment[],
  team: string | null,
  date: string,
  present: Set<number>,
): Promise<Issue[]> {
  const vols = new Map((await db.getVolunteers(sql, { activeOnly: false, team })).map((v) => [v.id, v]));
  const positions = new Map(db.getPositions().map((p) => [p.code, p]));
  const absent = present.size ? new Set([...vols.keys()].filter((id) => !present.has(id))) : new Set<number>();
  const mustPlace = new Set([...present].filter((id) => vols.get(id)?.active));
  return validate(assignments, vols, positions, isLastSunday(date), absent, mustPlace);
}

async function generate(
  sql: Sql,
  present: Set<number>,
  activeCodes: Set<string> | null,
  team: string | null,
  date: string,
): Promise<GenerationResult> {
  const volunteers = (await db.getVolunteers(sql, { team })).filter((v) => present.has(v.id));
  const ids = volunteers.map((v) => v.id);
  const [stats, lastReception, lastMap, lastPositions, lastAltarGender] = await Promise.all([
    db.getHistoryStats(sql, ids),
    db.lastAssignmentIds(sql, ids, [RECEPTION_CATEGORY]),
    db.lastAssignmentIds(sql, ids, [...MAP_CATEGORIES]),
    db.lastPositionByVolunteer(sql, ids),
    db.getLastAltarGender(sql),
  ]);
  const all = db.getPositions();
  const result = buildSchedule(
    volunteers,
    activePositions(all, activeCodes),
    {
      stats,
      last_reception_ids: lastReception,
      last_map_ids: lastMap,
      last_positions: lastPositions,
      last_altar_gender: lastAltarGender,
    },
    isLastSunday(date),
    all.filter((p) => p.category === RECEPTION_CATEGORY),
  );
  if ([...present].some((id) => !ids.includes(id))) {
    result.warnings.push("Alguns marcados como presentes não pertencem à equipe ou estão inativos.");
  }
  return result;
}

// ====================================================================== API

async function apiInit(sql: Sql) {
  const today = localNow().date;
  const [teams, team, active] = await Promise.all([
    db.getAvailableTeams(sql),
    suggestTeam(sql, today),
    defaultActive(sql),
  ]);
  return { today, teams, team, positions: db.getPositions(), default_active: active };
}

async function apiDay(sql: Sql, q: Query) {
  const date = dateOf(q.date);
  const suggested = await suggestTeam(sql, date);
  const team = q.team || suggested;
  const [vols, absences, schedule, active] = await Promise.all([
    db.getVolunteers(sql, { activeOnly: false, team }),
    db.absenceInfo(sql),
    db.findSchedule(sql, date, team),
    defaultActive(sql),
  ]);
  const saved = schedule && {
    id: schedule.id,
    created_at: localStamp(schedule.created_at),
    assignments: schedule.assignments,
    absent_ids: [...schedule.absent.keys()].sort((a, b) => a - b),
    absent_reasons: Object.fromEntries([...schedule.absent].filter(([, reason]) => reason).map(([id, r]) => [String(id), r])),
    active_codes: schedule.active_codes,
  };
  return {
    date,
    weekday: weekdayName(date),
    last_sunday: isLastSunday(date),
    team,
    suggested_team: suggested,
    volunteers: vols.map((v) => ({ ...v, faltas: absences.get(v.id)?.total ?? 0 })),
    default_active: active,
    saved,
  };
}

async function apiGenerate(sql: Sql, body: Body) {
  const date = dateOf(body.date);
  const team = body.team ? String(body.team) : null;
  const present = idSet(body.present_ids);
  const codes = codeList(body.active_codes);
  const res = await generate(sql, present, codes && new Set(codes), team, date);
  return {
    assignments: res.assignments,
    warnings: res.warnings,
    issues: await validateFor(sql, res.assignments, team, date, present),
  };
}

async function apiValidate(sql: Sql, body: Body) {
  const date = dateOf(body.date);
  const team = body.team ? String(body.team) : null;
  return { issues: await validateFor(sql, assignmentsOf(body), team, date, idSet(body.present_ids)) };
}

async function apiSave(sql: Sql, body: Body) {
  const date = dateOf(body.date);
  const team = body.team ? String(body.team) : await suggestTeam(sql, date);
  const present = idSet(body.present_ids);
  const reasons = new Map<number, string>();
  for (const [id, reason] of Object.entries(body.absent_reasons ?? {})) {
    if (reason) reasons.set(Number(id), String(reason));
  }
  const teamVols = await db.getVolunteers(sql, { team });
  const scheduleId = await db.saveSchedule(sql, {
    serviceDate: date,
    serviceType: weekdayName(date),
    team,
    assignments: assignmentsOf(body),
    presentIds: present,
    allVolunteerIds: teamVols.map((v) => v.id),
    activeCodes: codeList(body.active_codes),
    absentReasons: reasons,
  });
  return { schedule_id: scheduleId, warnings: [] as string[], saved_at: localNow().time };
}

async function apiVolunteer(sql: Sql, body: Body) {
  return { id: await db.upsertVolunteer(sql, { ...body, id: body.id || null }) };
}

async function apiVolunteers(sql: Sql, q: Query) {
  const [vols, absences, served, teams] = await Promise.all([
    db.getVolunteers(sql, { activeOnly: false, team: q.team || null }),
    db.absenceInfo(sql),
    db.serviceInfo(sql),
    db.getAvailableTeams(sql),
  ]);
  return {
    volunteers: vols.map((v) => ({
      ...v,
      faltas: absences.get(v.id)?.total ?? 0,
      vezes: served.get(v.id)?.vezes ?? 0,
      ultima_vez: served.get(v.id)?.ultima ?? null,
    })),
    teams,
  };
}

async function apiPositionsDefault(sql: Sql, body: Body) {
  const codes = [...new Set(codeList(body.codes) ?? [])].sort();
  await db.setMeta(sql, "posicoes_padrao", codes);
  return { default_active: codes };
}

async function apiHistory(sql: Sql, q: Query) {
  const team = q.team || null;
  const [all, rows, details] = await Promise.all([
    db.listSchedules(sql, 200),
    db.getHistoryMatrix(sql, team),
    db.absenceDetails(sql),
  ]);
  const schedules = (team ? all.filter((s) => s.team === team) : all).map((s) => ({
    ...s,
    created_at: localStamp(s.created_at),
  }));
  const active = rows.filter((r) => r.Ativo);
  const totalAbsences = schedules.reduce((sum, s) => sum + s.faltas, 0);
  const ids = new Set(rows.map((r) => r.id as number));
  return {
    headers: db.HISTORY_HEADERS,
    rows,
    schedules,
    kpis: {
      escalas: schedules.length,
      faltas: totalAbsences,
      media_faltas: schedules.length ? Math.round((totalAbsences / schedules.length) * 10) / 10 : 0,
      ativos: active.length,
      com_faltas: active.filter((r) => r.Total_Faltas).length,
    },
    absences: Object.fromEntries([...details].filter(([id]) => ids.has(id)).map(([id, list]) => [String(id), list])),
  };
}

const GET_ROUTES: Record<string, (sql: Sql, q: Query) => Promise<unknown>> = {
  "/api/init": apiInit,
  "/api/day": apiDay,
  "/api/volunteers": apiVolunteers,
  "/api/history": apiHistory,
};

const POST_ROUTES: Record<string, (sql: Sql, body: Body) => Promise<unknown>> = {
  "/api/positions/default": apiPositionsDefault,
  "/api/generate": apiGenerate,
  "/api/validate": apiValidate,
  "/api/save": apiSave,
  "/api/volunteer": apiVolunteer,
};

// ====================================================================== HTTP

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export interface HandleOptions extends AuthOptions {
  sql?: Sql;
}

export async function handle(request: Request, opts: HandleOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    const get = request.method === "GET" ? GET_ROUTES[path] : undefined;
    const post = request.method === "POST" ? POST_ROUTES[path] : undefined;
    // Pública: o navegador precisa do endereço do login antes de existir sessão.
    if (request.method === "GET" && path === "/api/config") {
      return json({ auth_url: process.env.NEON_AUTH_BASE_URL || null });
    }
    if (!get && !post) return json({ error: "rota inválida" }, 404);

    const sql = opts.sql ?? db.connect();
    await authenticate(request, sql, opts);

    if (get) return json(await get(sql, Object.fromEntries(url.searchParams)));
    let body: unknown;
    try {
      body = JSON.parse((await request.text()) || "{}");
    } catch {
      return json({ error: "JSON inválido" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "JSON inválido" }, 400);
    return json(await post!(sql, body as Body));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    if (e instanceof UserError) return json({ error: e.message }, 400);
    if (e instanceof db.ConfigError) return json({ error: e.message }, 500);
    console.error(e);
    return json({ error: "Erro interno. Tente de novo em instantes." }, 500);
  }
}
