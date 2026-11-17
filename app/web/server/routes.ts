/**
 * API REST (/api/*). Cada endereço é um recurso e o verbo diz o que fazer com ele:
 *
 *   GET    /api/config                             público: endereço do login
 *   GET    /api/me                                 quem está logado, papel, equipes e a data de hoje
 *
 *   GET    /api/volunteers[?team=]                 voluntários, com faltas e vezes que serviram
 *   POST   /api/volunteers                         cadastra (201)
 *   PATCH  /api/volunteers/:id                     altera só os campos enviados
 *
 *   GET    /api/schedules[?team=]                  escalas salvas (lista resumida)
 *   GET    /api/schedules/:date[/:team]            folha do culto: equipe, presença e a escala salva
 *   PUT    /api/schedules/:date/:team              grava a escala do culto (substitui a anterior)
 *   POST   /api/schedules/:date/:team/suggestion   gera uma sugestão de escala (não grava)
 *
 *   PUT    /api/teams/:team/positions              posições ligadas por padrão para a equipe
 *   GET    /api/history[?team=]                    quantas vezes cada um serviu em cada função
 *
 *   GET    /api/users                              acessos liberados (só admin)
 *   PUT    /api/users/:email                       libera um e-mail ou muda papel e equipes (201 ou 200)
 *   DELETE /api/users/:email                       remove o acesso (204)
 *   POST   /api/users/:email/password              gera uma senha nova (201)
 *
 * Erros respondem { error, code? } com o status HTTP correspondente. O que é fixo (posições,
 * regras) não passa por aqui: está em shared/catalog.ts e já vai dentro do site.
 */
import { generatePassword, neonAccounts, type Accounts } from "./accounts.ts";
import { authenticate, denied, HttpError, type AuthOptions, type AuthUser } from "./auth.ts";
import {
  FACTORY_ACTIVE,
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
import type { Assignment, Issue, Volunteer } from "./models.ts";

type Body = Record<string, any>;
type Sql = db.Sql;

/** Tudo o que uma rota recebe. */
interface Ctx {
  sql: Sql;
  user: AuthUser;
  /** trechos variáveis do endereço (:id, :date, :team, :email) */
  params: Record<string, string>;
  query: Record<string, string>;
  body: Body;
  /** endereço do site e contas de login, usados pelas rotas de acessos */
  origin: string;
  accounts: Accounts;
}

/** Resposta com status diferente de 200 (201 criado, 204 sem conteúdo). */
class Reply {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data?: unknown) {
    this.status = status;
    this.data = data;
  }
}

const UserError = db.UserError;
const notFound = (message: string) => new HttpError(404, message);

// ====================================================================== entradas

function dateOf(value: string): string {
  try {
    return isoDate(value);
  } catch {
    throw new UserError("Data inválida.");
  }
}

function idOf(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw notFound("Voluntário não encontrado.");
  return id;
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

const POSITION_BY_CODE = new Map(db.getPositions().map((p) => [p.code, p]));

/** Escala enviada pelo site: só posições que existem; nome e categoria vêm do catálogo. */
function assignmentsOf(list: unknown): Assignment[] {
  if (!Array.isArray(list)) throw new UserError("Escala inválida.");
  const out: Assignment[] = [];
  list.forEach((a: Body, i: number) => {
    const p = POSITION_BY_CODE.get(String(a?.position_code));
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

/** Texto "AAAA-MM-DD HH:MM:SS" no horário de São Paulo. */
function localStamp(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  const { date, time } = localNow(d);
  return `${date} ${time}`;
}

// ====================================================================== equipes de quem está logado

/** Equipes que a pessoa pode usar: null = todas (admin); coordenador = só as dele. */
const ownTeams = (user: AuthUser): db.Teams => (user.role === "admin" ? null : user.teams);

function canUseTeam(user: AuthUser, team: string): boolean {
  const mine = ownTeams(user);
  return mine === null || mine.some((t) => db.normalizeTeam(t) === db.normalizeTeam(team));
}

/** Recusa a equipe que não é da pessoa. A API é quem garante isso, não a tela. */
function checkTeam(user: AuthUser, team: string): string {
  if (!canUseTeam(user, team)) throw denied("forbidden", `Você não coordena a equipe ${team.replaceAll("_", " ")}.`);
  return team;
}

/** Equipes de uma listagem: a do filtro (conferida) ou, sem filtro, todas as da pessoa. */
const scopeOf = (user: AuthUser, team: string | undefined): db.Teams => (team ? [checkTeam(user, team)] : ownTeams(user));

/** Equipe da última escala salva no mesmo dia da semana; senão, a padrão. Sempre uma equipe da pessoa. */
async function suggestTeam(sql: Sql, date: string, user: AuthUser): Promise<string> {
  const mine = ownTeams(user);
  const weekday = weekdayName(date);
  const last = await db.lastTeamFor(sql, weekday, mine);
  if (last) return last;
  const fallback = teamForDate(date);
  if (mine === null || canUseTeam(user, fallback)) return fallback;
  return mine.find((t) => t.startsWith(weekday)) ?? mine[0];
}

const DEFAULT_POSITIONS_KEY = "posicoes_padrao";

/** Posições ligadas por padrão: as da equipe, se ela guardou as suas; senão as gerais; senão as de fábrica. */
async function defaultActive(sql: Sql, team: string): Promise<string[]> {
  const keys = [`${DEFAULT_POSITIONS_KEY}:${team}`, DEFAULT_POSITIONS_KEY];
  const saved = await db.getMetaMany(sql, keys);
  for (const key of keys) {
    const codes = saved.get(key);
    if (Array.isArray(codes) && codes.length) return codes.filter((c) => POSITION_BY_CODE.has(c));
  }
  return FACTORY_ACTIVE;
}

// ====================================================================== regras da escala

/** Regras quebradas na escala. `roster`: todos da equipe (ativos e inativos), já carregados. */
function issuesOf(roster: Volunteer[], assignments: Assignment[], date: string, present: Set<number>): Issue[] {
  const vols = new Map(roster.map((v) => [v.id, v]));
  const absent = present.size ? new Set([...vols.keys()].filter((id) => !present.has(id))) : new Set<number>();
  const mustPlace = new Set([...present].filter((id) => vols.get(id)?.active));
  return validate(assignments, vols, POSITION_BY_CODE, isLastSunday(date), absent, mustPlace);
}

// ====================================================================== sessão

async function getMe({ sql, user }: Ctx) {
  return {
    email: user.email,
    role: user.role,
    teams: ownTeams(user) ?? (await db.getAvailableTeams(sql)),
    today: localNow().date,
  };
}

// ====================================================================== voluntários

async function listVolunteers({ sql, user, query }: Ctx) {
  return db.getVolunteersWithStats(sql, scopeOf(user, query.team));
}

async function createVolunteer({ sql, user, body }: Ctx) {
  // coordenador só cadastra em equipe dele
  if (ownTeams(user) !== null) checkTeam(user, db.cleanTeam(body.team));
  return new Reply(201, await db.createVolunteer(sql, body));
}

async function updateVolunteer({ sql, user, params, body }: Ctx) {
  const id = idOf(params.id);
  if (ownTeams(user) !== null) {
    // coordenador só altera quem já é de uma equipe dele, e não manda ninguém para outra
    if (body.team !== undefined && body.team !== null) checkTeam(user, db.cleanTeam(body.team));
    const current = await db.getVolunteerTeam(sql, id);
    if (current === null) throw notFound("Voluntário não encontrado.");
    checkTeam(user, current);
  }
  const saved = await db.updateVolunteer(sql, id, body);
  if (!saved) throw notFound("Voluntário não encontrado.");
  return saved;
}

// ====================================================================== escalas

async function listSchedules({ sql, user, query }: Ctx) {
  return db.listSchedules(sql, scopeOf(user, query.team));
}

/**
 * Folha do culto: tudo o que a tela da escala precisa em um pedido só. Sem equipe no
 * endereço, vale a sugerida para o dia.
 */
async function getSheet({ sql, user, params }: Ctx) {
  const date = dateOf(params.date);
  const team = params.team ? checkTeam(user, params.team) : await suggestTeam(sql, date, user);
  const [volunteers, schedule, active] = await Promise.all([
    db.getRoster(sql, team),
    db.findSchedule(sql, date, team),
    defaultActive(sql, team),
  ]);
  let saved = null;
  let issues: Issue[] = [];
  if (schedule) {
    saved = {
      id: schedule.id,
      created_at: localStamp(schedule.created_at),
      assignments: schedule.assignments,
      absent_ids: [...schedule.absent.keys()].sort((a, b) => a - b),
      absent_reasons: Object.fromEntries([...schedule.absent].filter(([, reason]) => reason).map(([id, r]) => [String(id), r])),
      active_codes: schedule.active_codes,
    };
    // confere a escala salva com o cadastro de hoje (alguém pode ter mudado de permissão ou saído)
    const names = new Map(volunteers.map((v) => [v.id, v.name]));
    const byCode = new Map(schedule.assignments.map((a) => [a.position_code, a]));
    const current = assignmentsOf(
      [...byCode.values()].map((a) => ({ ...a, volunteer_name: names.get(a.volunteer_id) ?? a.volunteer_name })),
    );
    const present = new Set(volunteers.filter((v) => v.active && !schedule.absent.has(v.id)).map((v) => v.id));
    issues = issuesOf(volunteers, current, date, present);
  }
  return {
    date,
    weekday: weekdayName(date),
    last_sunday: isLastSunday(date),
    team,
    volunteers,
    default_active: active,
    saved,
    issues,
  };
}

/** Grava a escala do culto e devolve as regras quebradas: um pedido só em vez de validar e salvar. */
async function putSchedule({ sql, user, params, body }: Ctx) {
  const date = dateOf(params.date);
  const team = checkTeam(user, params.team);
  const present = idSet(body.present_ids);
  const assignments = assignmentsOf(body.assignments ?? []);
  const reasons = new Map<number, string>();
  for (const [id, reason] of Object.entries(body.absent_reasons ?? {})) {
    if (reason) reasons.set(Number(id), String(reason));
  }
  const roster = await db.getVolunteers(sql, { activeOnly: false, teams: [team] });
  if (ownTeams(user) !== null) {
    // coordenador só escala e marca presença de gente da equipe dele
    const everyone = new Set(roster.map((v) => v.id));
    const outsiders = [...present, ...assignments.map((a) => a.volunteer_id)].filter((id) => !everyone.has(id));
    if (outsiders.length) throw new UserError("A escala tem pessoas que não são desta equipe.");
  }
  const id = await db.saveSchedule(sql, {
    serviceDate: date,
    serviceType: weekdayName(date),
    team,
    assignments,
    presentIds: present,
    allVolunteerIds: roster.filter((v) => v.active).map((v) => v.id),
    activeCodes: codeList(body.active_codes),
    absentReasons: reasons,
  });
  return { id, saved_at: localNow().time, issues: issuesOf(roster, assignments, date, present) };
}

/** Sugestão de escala para os presentes. Não grava nada: o site grava com PUT quando aceita. */
async function suggestSchedule({ sql, user, params, body }: Ctx) {
  const date = dateOf(params.date);
  const team = checkTeam(user, params.team);
  const present = idSet(body.present_ids);
  const codes = codeList(body.active_codes);
  const roster = await db.getVolunteers(sql, { activeOnly: false, teams: [team] });
  const volunteers = roster.filter((v) => v.active && present.has(v.id));
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
    activePositions(all, codes && new Set(codes)),
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
  return {
    assignments: result.assignments,
    warnings: result.warnings,
    issues: issuesOf(roster, result.assignments, date, present),
  };
}

// ====================================================================== equipes e histórico

async function putTeamPositions({ sql, user, params, body }: Ctx) {
  const team = checkTeam(user, params.team);
  const codes = [...new Set(codeList(body.codes) ?? [])].filter((c) => POSITION_BY_CODE.has(c)).sort();
  await db.setMeta(sql, `${DEFAULT_POSITIONS_KEY}:${team}`, codes);
  return { codes };
}

async function getHistory({ sql, user, query }: Ctx) {
  return db.getHistory(sql, scopeOf(user, query.team));
}

// ====================================================================== acessos (só admin)

function requireAdmin(user: AuthUser): void {
  if (user.role !== "admin") throw denied("forbidden", "Só administradores podem gerenciar os acessos.");
}

const toUser = (u: db.AppUser) => ({ ...u, created_at: localStamp(u.created_at) });

/** Nome para a conta de login: o informado ou, na falta, o começo do e-mail. */
const accountName = (value: unknown, email: string) => db.cleanName(value).slice(0, 80) || email.split("@")[0];

async function listUsers({ sql, user }: Ctx) {
  requireAdmin(user);
  return (await db.listAppUsers(sql)).map(toUser);
}

/** Recusa mudanças que deixariam o sistema sem admin ou tirariam o acesso de quem está pedindo. */
async function guardAdminChange(sql: Sql, user: AuthUser, email: string, current: db.Access | null, next: db.Role | null) {
  if (current?.role !== "admin" || next === "admin") return;
  if (email === user.email) {
    throw new UserError("Você não pode tirar o seu próprio acesso de administrador. Peça a outro administrador.");
  }
  if ((await db.countAdmins(sql)) <= 1) throw new UserError("O sistema precisa de pelo menos um administrador.");
}

/**
 * Libera um e-mail ou muda o papel e as equipes de quem já está liberado. Quem ainda não tem
 * conta de login ganha uma, com senha aleatória que volta aqui uma única vez (não é guardada).
 */
async function putUser({ sql, user, params, body, origin, accounts }: Ctx) {
  requireAdmin(user);
  const email = db.cleanEmail(params.email);
  const role = db.cleanRole(body.role ?? "coordinator");
  const [valid, current, account] = await Promise.all([
    role === "admin" ? [] : db.getAvailableTeams(sql),
    db.getAccess(sql, email),
    db.getAccountName(sql, email),
  ]);
  // coordenador sempre tem pelo menos uma equipe; admin não tem equipe (vê todas)
  const teams = role === "admin" ? [] : db.cleanTeams(body.teams, valid);
  if (role === "coordinator" && !teams.length) throw new UserError("Escolha pelo menos uma equipe para o coordenador.");
  await guardAdminChange(sql, user, email, current, role);
  let password: string | null = null;
  if (!account) {
    const candidate = generatePassword();
    if (await accounts.create(sql, { email, name: accountName(body.name, email), password: candidate }, origin)) {
      password = candidate;
    }
  }
  await db.upsertAppUser(sql, email, { role, teams }, user.email);
  const [saved] = await db.listAppUsers(sql, email);
  return new Reply(current ? 200 : 201, { user: toUser(saved), password });
}

async function deleteUser({ sql, user, params }: Ctx) {
  requireAdmin(user);
  const email = db.cleanEmail(params.email);
  if (email === user.email) throw new UserError("Você não pode remover o seu próprio acesso.");
  await guardAdminChange(sql, user, email, await db.getAccess(sql, email), null);
  await db.removeAppUser(sql, email);
  return new Reply(204);
}

/** Gera uma senha nova para alguém já liberado: a conta de login é recriada com ela. */
async function resetPassword({ sql, user, params, origin, accounts }: Ctx) {
  requireAdmin(user);
  const email = db.cleanEmail(params.email);
  if (email === user.email) throw new UserError('Para trocar a sua própria senha, use "Alterar senha" no menu.');
  const [access, account] = await Promise.all([db.getAccess(sql, email), db.getAccountName(sql, email)]);
  if (!access) throw notFound("Esse e-mail não está liberado.");
  const password = generatePassword();
  await accounts.remove(sql, email);
  const created = await accounts.create(sql, { email, name: accountName(account?.name, email), password }, origin);
  if (!created) throw new HttpError(502, "Não foi possível recriar a conta de login. Tente de novo.");
  const [saved] = await db.listAppUsers(sql, email);
  return new Reply(201, { user: toUser(saved), password });
}

// ====================================================================== rotas

type Handler = (ctx: Ctx) => Promise<unknown>;

const ROUTES: { method: string; parts: string[]; handler: Handler }[] = (
  [
    ["GET", "/api/me", getMe],
    ["GET", "/api/volunteers", listVolunteers],
    ["POST", "/api/volunteers", createVolunteer],
    ["PATCH", "/api/volunteers/:id", updateVolunteer],
    ["GET", "/api/schedules", listSchedules],
    ["GET", "/api/schedules/:date", getSheet],
    ["GET", "/api/schedules/:date/:team", getSheet],
    ["PUT", "/api/schedules/:date/:team", putSchedule],
    ["POST", "/api/schedules/:date/:team/suggestion", suggestSchedule],
    ["PUT", "/api/teams/:team/positions", putTeamPositions],
    ["GET", "/api/history", getHistory],
    ["GET", "/api/users", listUsers],
    ["PUT", "/api/users/:email", putUser],
    ["DELETE", "/api/users/:email", deleteUser],
    ["POST", "/api/users/:email/password", resetPassword],
  ] as [string, string, Handler][]
).map(([method, path, handler]) => ({ method, parts: path.split("/").filter(Boolean), handler }));

/** Acha a rota do pedido e separa os trechos variáveis do endereço. */
function match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  const parts = path.split("/").filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method || route.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const fits = route.parts.every((expected, i) => {
      if (!expected.startsWith(":")) return expected === parts[i];
      try {
        params[expected.slice(1)] = decodeURIComponent(parts[i]);
        return true;
      } catch {
        return false; // %xx malformado
      }
    });
    if (fits) return { handler: route.handler, params };
  }
  return null;
}

// ====================================================================== HTTP

function respond(data: unknown, status = 200, cache = "no-store"): Response {
  if (status === 204) return new Response(null, { status, headers: { "Cache-Control": cache } });
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

const failure = (status: number, error: string, code?: string) => respond({ error, code }, status);

async function bodyOf(request: Request): Promise<Body> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  let body: unknown;
  try {
    body = JSON.parse((await request.text()) || "{}");
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "JSON inválido");
  return body as Body;
}

export interface HandleOptions extends AuthOptions {
  sql?: Sql;
  /** Só para testes: troca a criação de contas no Neon Auth. */
  accounts?: Accounts;
}

export async function handle(request: Request, opts: HandleOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    // Pública: o navegador precisa do endereço do login antes de existir sessão. Como só muda
    // quando o site é publicado de novo, o navegador pode guardar por uma hora e abrir mais rápido.
    if (request.method === "GET" && path === "/api/config") {
      const authUrl = process.env.NEON_AUTH_BASE_URL || null;
      return respond({ auth_url: authUrl }, 200, authUrl ? "public, max-age=3600" : "no-store");
    }
    const route = match(request.method, path);
    if (!route) return failure(404, "rota inválida");

    const sql = opts.sql ?? db.connect();
    const user = await authenticate(request, sql, opts);
    const result = await route.handler({
      sql,
      user,
      params: route.params,
      query: Object.fromEntries(url.searchParams),
      body: await bodyOf(request),
      origin: url.origin,
      accounts: opts.accounts ?? neonAccounts,
    });
    return result instanceof Reply ? respond(result.data, result.status) : respond(result);
  } catch (e) {
    if (e instanceof HttpError) return failure(e.status, e.message, e.code);
    if (e instanceof UserError) return failure(400, e.message);
    if (e instanceof db.ConfigError) return failure(500, e.message);
    console.error(e);
    return failure(500, "Erro interno. Tente de novo em instantes.");
  }
}
