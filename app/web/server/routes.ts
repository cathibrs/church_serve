/**
 * API REST (/api/*). Cada endereço é um recurso e o verbo diz o que fazer com ele:
 *
 *   GET    /api/config                             público: endereço do login
 *   GET    /api/me                                 quem está logado, papel, equipes e regras
 *
 *   GET    /api/volunteers[?team=]                 voluntários, com faltas, vezes que serviram e observações
 *   POST   /api/volunteers                         cadastra (201)
 *   PATCH  /api/volunteers/:id                     altera só os campos enviados
 *   GET    /api/volunteers/:id/notes               observações datadas do voluntário
 *   POST   /api/volunteers/:id/notes               escreve uma observação (201)
 *   DELETE /api/volunteers/:id/notes/:note         apaga (quem escreveu ou admin) (204)
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
 *   PATCH  /api/users/:email                       suspende ou reativa o acesso ({ suspended })
 *   DELETE /api/users/:email                       remove o acesso (204)
 *   POST   /api/users/:email/password              gera uma senha nova (201)
 *   PUT    /api/rules                              regras para coordenadores (só admin)
 *   GET    /api/activity[?actor=&group=&team=&before=]  registro de quem fez o quê (só admin)
 *
 * Erros respondem { error, code? } com o status HTTP correspondente. O que é fixo (posições,
 * regras) não passa por aqui: está em shared/catalog.ts e já vai dentro do site.
 */
import { generatePassword, neonAccounts, type Accounts } from "./accounts.ts";
import { authenticate, denied, HttpError, type AuthOptions, type AuthUser } from "./auth.ts";
import {
  EVENT_FACTORY_ACTIVE,
  EVENT_TEAM,
  FACTORY_ACTIVE,
  isEventTeam,
  envelopeSunday,
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
import { isMissingSchema, upgradeSchema } from "./upgrade.ts";

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

/** Para as frases do registro de atividades. */
const teamName = (team: string) => team.replaceAll("_", " ");
const brDate = (iso: string) => iso.split("-").reverse().join("/");
const snippet = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ====================================================================== registro de atividades

/**
 * Anota quem fez o quê. A ação já foi gravada quando chega aqui: se a anotação falhar, o
 * pedido não vira erro (a pessoa tentaria de novo algo que deu certo), só fica no log do servidor.
 */
async function log({ sql, user }: Ctx, entry: Omit<db.ActivityInput, "actor">, merge?: "30 minutes"): Promise<void> {
  try {
    await db.logActivity(sql, { actor: user.email, ...entry }, merge);
  } catch (e) {
    console.error("registro de atividades:", e);
  }
}

const PERM_LABEL = {
  can_bercario: "Berçário",
  can_cozinha: "Cozinha",
  can_recepcao: "Recepção",
  can_banheiro: "Banheiro",
  can_limpar_altar: "Altar",
} as const;

/** O que mudou no cadastro, em palavras ("equipe: A → B", "desativado", "não pode Cozinha"). */
function volunteerChanges(a: Volunteer, b: Volunteer): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`nome: ${a.name} → ${b.name}`);
  if (a.gender !== b.gender) out.push(`gênero: ${b.gender}`);
  if (a.team !== b.team) out.push(`equipe: ${teamName(a.team)} → ${teamName(b.team)}`);
  if (a.active !== b.active) out.push(b.active ? "ativado" : "desativado");
  for (const [key, label] of Object.entries(PERM_LABEL) as [keyof typeof PERM_LABEL, string][]) {
    if (a[key] !== b[key]) out.push(`${b[key] ? "pode" : "não pode"} ${label}`);
  }
  if ((a.observation ?? "") !== (b.observation ?? "")) out.push(b.observation ? "recado alterado" : "recado apagado");
  return out;
}

/** Só os campos que mudaram, antes e depois (vão em `details`). */
function changedFields(a: Volunteer, b: Volunteer) {
  const keys = (Object.keys(b) as (keyof Volunteer)[]).filter((k) => k !== "id" && a[k] !== b[k]);
  return { before: Object.fromEntries(keys.map((k) => [k, a[k]])), after: Object.fromEntries(keys.map((k) => [k, b[k]])) };
}

const roleText = (role: db.Role, teams: string[]) =>
  role === "admin" ? "administrador" : `coordenador de ${teams.map(teamName).join(", ")}`;

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

/**
 * Equipe da última escala salva no mesmo dia da semana; senão, a padrão. Sempre uma equipe da
 * pessoa, e Eventos só quando ela não tem outra: o evento se escolhe de propósito.
 */
async function suggestTeam(sql: Sql, date: string, user: AuthUser): Promise<string> {
  const mine = ownTeams(user);
  const weekday = weekdayName(date);
  const last = await db.lastTeamFor(sql, weekday, mine);
  if (last) return last;
  const fallback = teamForDate(date);
  if (mine === null || canUseTeam(user, fallback)) return fallback;
  return mine.find((t) => t.startsWith(weekday)) ?? mine.find((t) => !isEventTeam(t)) ?? mine[0];
}

/** Quem pode entrar na escala da equipe: no evento, todos os voluntários (null). */
const rosterTeams = (team: string): db.Teams => (isEventTeam(team) ? null : [team]);

/** Ninguém é cadastrado em Eventos: a equipe junta todos e cada evento escolhe os seus. */
function rejectEventTeam(team: unknown): void {
  if (team !== undefined && team !== null && isEventTeam(String(team))) {
    throw new UserError(`Ninguém é cadastrado na equipe ${EVENT_TEAM}: ela junta todos os voluntários.`);
  }
}

const DEFAULT_POSITIONS_KEY = "posicoes_padrao";

/**
 * Posições ligadas por padrão: as da equipe, se ela guardou as suas; senão as gerais; senão as
 * de fábrica. Evento não usa as gerais (que são de culto): sem as suas, abre também as de evento.
 */
async function defaultActive(sql: Sql, team: string): Promise<string[]> {
  const event = isEventTeam(team);
  const own = `${DEFAULT_POSITIONS_KEY}:${team}`;
  const keys = event ? [own] : [own, DEFAULT_POSITIONS_KEY];
  const saved = await db.getMetaMany(sql, keys);
  for (const key of keys) {
    const codes = saved.get(key);
    if (Array.isArray(codes) && codes.length) return codes.filter((c) => POSITION_BY_CODE.has(c));
  }
  return event ? EVENT_FACTORY_ACTIVE : FACTORY_ACTIVE;
}

// ====================================================================== regras da escala

/**
 * Regras quebradas na escala. `roster`: todos da equipe (ativos e inativos), já carregados.
 * No evento quem não foi escolhido não faltou: só não foi chamado.
 */
function issuesOf(roster: Volunteer[], assignments: Assignment[], lastSunday: boolean, present: Set<number>, event = false): Issue[] {
  const vols = new Map(roster.map((v) => [v.id, v]));
  const absent =
    present.size && !event ? new Set([...vols.keys()].filter((id) => !present.has(id))) : new Set<number>();
  const mustPlace = new Set([...present].filter((id) => vols.get(id)?.active));
  return validate(assignments, vols, POSITION_BY_CODE, lastSunday, absent, mustPlace);
}

// ====================================================================== sessão

async function getMe({ sql, user }: Ctx) {
  const [teams, rules] = await Promise.all([ownTeams(user) ?? db.getAvailableTeams(sql), db.getRules(sql)]);
  return { email: user.email, role: user.role, teams, rules };
}

// ====================================================================== regras para coordenadores

/** Recusa a alteração do cadastro quando o admin travou o cadastro para coordenadores. */
async function checkVolunteerEditing(sql: Sql, user: AuthUser): Promise<void> {
  if (user.role === "admin") return;
  if (!(await db.getRules(sql)).coordinators_edit_volunteers) {
    throw denied("forbidden", "O cadastro de voluntários está travado pelo administrador. Só observações podem ser escritas.");
  }
}

/** Recusa mudar a escala de um culto que já passou, quando o admin travou as escalas passadas. */
async function checkPastSchedule(sql: Sql, user: AuthUser, date: string): Promise<void> {
  if (user.role === "admin" || date >= localNow().date) return;
  if ((await db.getRules(sql)).lock_past_schedules) {
    throw denied("forbidden", "As escalas de cultos que já passaram estão travadas pelo administrador.");
  }
}

async function putRules(ctx: Ctx) {
  requireAdmin(ctx.user);
  const before = await db.getRules(ctx.sql);
  const rules = await db.setRules(ctx.sql, ctx.body);
  const parts: string[] = [];
  if (before.coordinators_edit_volunteers !== rules.coordinators_edit_volunteers) {
    parts.push(rules.coordinators_edit_volunteers ? "liberou o cadastro de voluntários" : "travou o cadastro de voluntários");
  }
  if (before.lock_past_schedules !== rules.lock_past_schedules) {
    parts.push(rules.lock_past_schedules ? "travou as escalas passadas" : "liberou as escalas passadas");
  }
  if (parts.length) {
    const text = parts.join(" e ");
    await log(ctx, {
      action: "rules.save",
      target: "rules",
      summary: `Para coordenadores: ${text}.`,
      details: { before, after: rules },
    });
  }
  return rules;
}

// ====================================================================== voluntários

async function listVolunteers({ sql, user, query }: Ctx) {
  return db.getVolunteersWithStats(sql, scopeOf(user, query.team));
}

async function createVolunteer(ctx: Ctx) {
  const { sql, user, body } = ctx;
  rejectEventTeam(body.team);
  if (ownTeams(user) !== null) {
    // coordenador só cadastra em equipe dele, e só se o admin não travou o cadastro
    checkTeam(user, db.cleanTeam(body.team));
    await checkVolunteerEditing(sql, user);
  }
  const saved = await db.createVolunteer(sql, body);
  await log(ctx, {
    action: "volunteer.create",
    target: `volunteer:${saved.id}`,
    team: saved.team,
    summary: `Cadastrou ${saved.name} em ${teamName(saved.team)}.`,
  });
  return new Reply(201, saved);
}

async function updateVolunteer(ctx: Ctx) {
  const { sql, user, params, body } = ctx;
  const id = idOf(params.id);
  rejectEventTeam(body.team);
  if (ownTeams(user) !== null) {
    // coordenador só altera quem já é de uma equipe dele, e não manda ninguém para outra
    if (body.team !== undefined && body.team !== null) checkTeam(user, db.cleanTeam(body.team));
  }
  const before = await db.getVolunteer(sql, id);
  if (!before) throw notFound("Voluntário não encontrado.");
  if (ownTeams(user) !== null) {
    checkTeam(user, before.team);
    await checkVolunteerEditing(sql, user);
  }
  const saved = await db.updateVolunteer(sql, id, body);
  if (!saved) throw notFound("Voluntário não encontrado.");
  const changes = volunteerChanges(before, saved);
  if (changes.length) {
    await log(ctx, {
      action: "volunteer.update",
      target: `volunteer:${id}`,
      team: saved.team,
      summary: `Alterou ${saved.name}: ${changes.join(", ")}.`,
      details: changedFields(before, saved),
    });
  }
  return saved;
}

// ====================================================================== observações dos voluntários

/** Voluntário do endereço, se existe e é de uma equipe da pessoa. */
async function volunteerOf(sql: Sql, user: AuthUser, idText: string): Promise<Volunteer> {
  const volunteer = await db.getVolunteer(sql, idOf(idText));
  if (!volunteer) throw notFound("Voluntário não encontrado.");
  checkTeam(user, volunteer.team);
  return volunteer;
}

const toNote = (n: db.VolunteerNote) => ({ ...n, created_at: localStamp(n.created_at) });

async function listNotes({ sql, user, params }: Ctx) {
  const volunteer = await volunteerOf(sql, user, params.id);
  return (await db.listNotes(sql, volunteer.id)).map(toNote);
}

/** Observação nova. Vale mesmo com o cadastro travado: escrever não muda a escala. */
async function addNote(ctx: Ctx) {
  const volunteer = await volunteerOf(ctx.sql, ctx.user, ctx.params.id);
  const note = await db.addNote(ctx.sql, volunteer.id, ctx.body.body, ctx.user.email);
  await log(ctx, {
    action: "note.add",
    target: `volunteer:${volunteer.id}`,
    team: volunteer.team,
    summary: `Escreveu sobre ${volunteer.name}: "${snippet(note.body)}"`,
  });
  return new Reply(201, toNote(note));
}

async function removeNote(ctx: Ctx) {
  const { sql, user, params } = ctx;
  const volunteer = await volunteerOf(sql, user, params.id);
  const noteId = Number(params.note);
  const note = Number.isInteger(noteId) && noteId > 0 ? await db.getNote(sql, volunteer.id, noteId) : null;
  if (!note) throw notFound("Observação não encontrada.");
  if (note.author !== user.email && user.role !== "admin") {
    throw denied("forbidden", "Só quem escreveu a observação, ou um administrador, pode apagá-la.");
  }
  await db.removeNote(sql, note.id);
  await log(ctx, {
    action: "note.remove",
    target: `volunteer:${volunteer.id}`,
    team: volunteer.team,
    summary: `Apagou uma observação sobre ${volunteer.name}${note.author === user.email ? "" : ` (escrita por ${note.author})`}: "${snippet(note.body)}"`,
    details: { body: note.body, author: note.author, created_at: localStamp(note.created_at) },
  });
  return new Reply(204);
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
  const event = isEventTeam(team);
  const [volunteers, schedule, active, lastEvent] = await Promise.all([
    db.getRoster(sql, rosterTeams(team)),
    db.findSchedule(sql, date, team),
    defaultActive(sql, team),
    event ? db.lastEventPeople(sql, date) : null,
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
      present_ids: schedule.present,
      active_codes: schedule.active_codes,
    };
    // confere a escala salva com o cadastro de hoje (alguém pode ter mudado de permissão ou saído)
    const names = new Map(volunteers.map((v) => [v.id, v.name]));
    const byCode = new Map(schedule.assignments.map((a) => [a.position_code, a]));
    const current = assignmentsOf(
      [...byCode.values()].map((a) => ({ ...a, volunteer_name: names.get(a.volunteer_id) ?? a.volunteer_name })),
    );
    // no evento, presentes são só os escolhidos; no culto, todos os ativos menos quem faltou
    const present = event
      ? new Set(schedule.present)
      : new Set(volunteers.filter((v) => v.active && !schedule.absent.has(v.id)).map((v) => v.id));
    issues = issuesOf(volunteers, current, envelopeSunday(date, team), present, event);
  }
  return {
    date,
    weekday: weekdayName(date),
    last_sunday: envelopeSunday(date, team),
    team,
    volunteers,
    default_active: active,
    saved,
    issues,
    // evento: quem serviu no anterior, para repetir as mesmas pessoas
    last_event: lastEvent,
  };
}

/** Grava a escala do culto e devolve as regras quebradas: um pedido só em vez de validar e salvar. */
async function putSchedule({ sql, user, params, body }: Ctx) {
  const date = dateOf(params.date);
  const team = checkTeam(user, params.team);
  const event = isEventTeam(team);
  const present = idSet(body.present_ids);
  const assignments = assignmentsOf(body.assignments ?? []);
  const reasons = new Map<number, string>();
  if (event) {
    // no evento, quem está na escala foi escolhido (e ninguém ganha falta)
    for (const a of assignments) present.add(a.volunteer_id);
  } else {
    for (const [id, reason] of Object.entries(body.absent_reasons ?? {})) {
      if (reason) reasons.set(Number(id), String(reason));
    }
  }
  const roster = await db.getVolunteers(sql, { activeOnly: false, teams: rosterTeams(team) });
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
    // evento: só os escolhidos entram na presença, então quem não foi chamado não ganha falta
    allVolunteerIds: event ? [] : roster.filter((v) => v.active).map((v) => v.id),
    activeCodes: codeList(body.active_codes),
    absentReasons: reasons,
  });
  return { id, saved_at: localNow().time, issues: issuesOf(roster, assignments, envelopeSunday(date, team), present, event) };
}

/** Sugestão de escala para os presentes. Não grava nada: o site grava com PUT quando aceita. */
async function suggestSchedule({ sql, user, params, body }: Ctx) {
  const date = dateOf(params.date);
  const team = checkTeam(user, params.team);
  const present = idSet(body.present_ids);
  const codes = codeList(body.active_codes);
  const event = isEventTeam(team);
  const roster = await db.getVolunteers(sql, { activeOnly: false, teams: rosterTeams(team) });
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
    envelopeSunday(date, team),
    all.filter((p) => p.category === RECEPTION_CATEGORY),
  );
  if ([...present].some((id) => !ids.includes(id))) {
    result.warnings.push("Alguns marcados como presentes não pertencem à equipe ou estão inativos.");
  }
  return {
    assignments: result.assignments,
    warnings: result.warnings,
    issues: issuesOf(roster, result.assignments, envelopeSunday(date, team), present, event),
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

// ====================================================================== gravações com regra e registro

/**
 * Grava a escala conferindo a trava de escalas passadas e anota no registro. A escala salva
 * sozinha a cada troca na tela: as gravações seguidas do mesmo culto viram uma linha só.
 */
async function putScheduleChecked(ctx: Ctx) {
  const date = dateOf(ctx.params.date);
  checkTeam(ctx.user, ctx.params.team);
  await checkPastSchedule(ctx.sql, ctx.user, date);
  const result = await putSchedule(ctx);
  const filled = assignmentsOf(ctx.body.assignments ?? []).length;
  const present = idSet(ctx.body.present_ids).size;
  await log(
    ctx,
    {
      action: "schedule.save",
      target: `schedule:${date}:${ctx.params.team}`,
      team: ctx.params.team,
      summary: `Salvou a escala de ${brDate(date)} · ${teamName(ctx.params.team)}: ${filled} posições, ${present} presentes.`,
    },
    "30 minutes",
  );
  return result;
}

async function putTeamPositionsLogged(ctx: Ctx) {
  const result = await putTeamPositions(ctx);
  await log(
    ctx,
    {
      action: "positions.save",
      target: `positions:${ctx.params.team}`,
      team: ctx.params.team,
      summary: `Mudou as posições ligadas por padrão de ${teamName(ctx.params.team)} (${result.codes.length} ligadas).`,
    },
    "30 minutes",
  );
  return result;
}

// ====================================================================== acessos (só admin)

function requireAdmin(user: AuthUser, what = "gerenciar os acessos"): void {
  if (user.role !== "admin") throw denied("forbidden", `Só administradores podem ${what}.`);
}

const toUser = (u: db.AppUser) => ({
  ...u,
  created_at: localStamp(u.created_at),
  last_seen_at: u.last_seen_at ? localStamp(u.last_seen_at) : null,
});

/** Nome para a conta de login: o informado ou, na falta, o começo do e-mail. */
const accountName = (value: unknown, email: string) => db.cleanName(value).slice(0, 80) || email.split("@")[0];

async function listUsers({ sql, user }: Ctx) {
  requireAdmin(user);
  return (await db.listAppUsers(sql)).map(toUser);
}

/**
 * Recusa mudanças que deixariam o sistema sem admin ou tirariam o acesso de quem está pedindo.
 * `next` null = a pessoa perde o acesso (removida ou suspensa). Admin suspenso já não conta.
 */
async function guardAdminChange(
  sql: Sql,
  user: AuthUser,
  email: string,
  current: db.StoredAccess | null,
  next: db.Role | null,
) {
  if (current?.role !== "admin" || current.suspended || next === "admin") return;
  if (email === user.email) {
    throw new UserError("Você não pode tirar o seu próprio acesso de administrador. Peça a outro administrador.");
  }
  if ((await db.countAdmins(sql)) <= 1) throw new UserError("O sistema precisa de pelo menos um administrador.");
}

/**
 * Libera um e-mail ou muda o papel e as equipes de quem já está liberado. Quem ainda não tem
 * conta de login ganha uma, com senha aleatória que volta aqui uma única vez (não é guardada).
 */
async function putUser(ctx: Ctx) {
  const { sql, user, params, body, origin, accounts } = ctx;
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
  if (!current || current.role !== role || !sameTeams([...current.teams].sort(), teams)) {
    await log(ctx, {
      action: "user.save",
      target: `user:${email}`,
      summary: current
        ? `Mudou o acesso de ${email}: ${roleText(current.role, current.teams)} → ${roleText(role, teams)}.`
        : `Liberou ${email} como ${roleText(role, teams)}.`,
      details: { before: current && { role: current.role, teams: current.teams }, after: { role, teams } },
    });
  }
  const [saved] = await db.listAppUsers(sql, email);
  return new Reply(current ? 200 : 201, { user: toUser(saved), password });
}

const sameTeams = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Suspende ou reativa um acesso. Suspenso não entra, mas o papel e as equipes ficam guardados. */
async function patchUser(ctx: Ctx) {
  const { sql, user, params, body } = ctx;
  requireAdmin(user);
  const email = db.cleanEmail(params.email);
  if (typeof body.suspended !== "boolean") throw new UserError("Informe se o acesso fica suspenso (suspended).");
  if (email === user.email) throw new UserError("Você não pode suspender nem reativar o seu próprio acesso.");
  const current = await db.getAccess(sql, email);
  if (!current) throw notFound("Esse e-mail não está liberado.");
  if (body.suspended) await guardAdminChange(sql, user, email, current, null);
  if (current.suspended !== body.suspended) {
    await db.setSuspended(sql, email, body.suspended);
    await log(ctx, {
      action: body.suspended ? "user.suspend" : "user.reactivate",
      target: `user:${email}`,
      summary: `${body.suspended ? "Suspendeu" : "Reativou"} o acesso de ${email}.`,
    });
  }
  const [saved] = await db.listAppUsers(sql, email);
  return toUser(saved);
}

async function deleteUser(ctx: Ctx) {
  const { sql, user, params } = ctx;
  requireAdmin(user);
  const email = db.cleanEmail(params.email);
  if (email === user.email) throw new UserError("Você não pode remover o seu próprio acesso.");
  const current = await db.getAccess(sql, email);
  await guardAdminChange(sql, user, email, current, null);
  await db.removeAppUser(sql, email);
  if (current) {
    await log(ctx, {
      action: "user.remove",
      target: `user:${email}`,
      summary: `Removeu o acesso de ${email} (${roleText(current.role, current.teams)}).`,
    });
  }
  return new Reply(204);
}

/** Gera uma senha nova para alguém já liberado: a conta de login é recriada com ela. */
async function resetPassword(ctx: Ctx) {
  const { sql, user, params, origin, accounts } = ctx;
  requireAdmin(user);
  const email = db.cleanEmail(params.email);
  if (email === user.email) throw new UserError('Para trocar a sua própria senha, use "Alterar senha" no menu.');
  const [access, account] = await Promise.all([db.getAccess(sql, email), db.getAccountName(sql, email)]);
  if (!access) throw notFound("Esse e-mail não está liberado.");
  const password = generatePassword();
  await accounts.remove(sql, email);
  const created = await accounts.create(sql, { email, name: accountName(account?.name, email), password }, origin);
  if (!created) throw new HttpError(502, "Não foi possível recriar a conta de login. Tente de novo.");
  await log(ctx, { action: "user.password", target: `user:${email}`, summary: `Gerou uma senha nova para ${email}.` });
  const [saved] = await db.listAppUsers(sql, email);
  return new Reply(201, { user: toUser(saved), password });
}

// ====================================================================== registro de atividades (só admin)

const ACTIVITY_PAGE = 50;
const ACTIVITY_GROUPS = new Set(["volunteer", "note", "schedule", "positions", "user", "rules"]);

/** Uma página do registro, da mais recente para a mais antiga. `next`: id para pedir a página seguinte. */
async function listActivity({ sql, user, query }: Ctx) {
  requireAdmin(user, "ver o registro de atividades");
  const before = query.before ? Number(query.before) : null;
  if (before !== null && (!Number.isInteger(before) || before <= 0)) throw new UserError("Página inválida.");
  const group = query.group || null;
  if (group && !ACTIVITY_GROUPS.has(group)) throw new UserError("Tipo de atividade inválido.");
  const [rows, actors] = await Promise.all([
    db.listActivity(sql, {
      actor: query.actor ? query.actor.trim().toLowerCase() : null,
      group,
      team: query.team || null,
      before,
      limit: ACTIVITY_PAGE + 1,
    }),
    db.activityActors(sql),
  ]);
  const page = rows.slice(0, ACTIVITY_PAGE);
  return {
    items: page.map((r) => ({ ...r, at: localStamp(r.at) })),
    next: rows.length > ACTIVITY_PAGE ? page[page.length - 1].id : null,
    actors,
  };
}

// ====================================================================== rotas

type Handler = (ctx: Ctx) => Promise<unknown>;

const ROUTES: { method: string; parts: string[]; handler: Handler }[] = (
  [
    ["GET", "/api/me", getMe],
    ["GET", "/api/volunteers", listVolunteers],
    ["POST", "/api/volunteers", createVolunteer],
    ["PATCH", "/api/volunteers/:id", updateVolunteer],
    ["GET", "/api/volunteers/:id/notes", listNotes],
    ["POST", "/api/volunteers/:id/notes", addNote],
    ["DELETE", "/api/volunteers/:id/notes/:note", removeNote],
    ["GET", "/api/schedules", listSchedules],
    ["GET", "/api/schedules/:date", getSheet],
    ["GET", "/api/schedules/:date/:team", getSheet],
    ["PUT", "/api/schedules/:date/:team", putScheduleChecked],
    ["POST", "/api/schedules/:date/:team/suggestion", suggestSchedule],
    ["PUT", "/api/teams/:team/positions", putTeamPositionsLogged],
    ["GET", "/api/history", getHistory],
    ["GET", "/api/users", listUsers],
    ["PUT", "/api/users/:email", putUser],
    ["PATCH", "/api/users/:email", patchUser],
    ["DELETE", "/api/users/:email", deleteUser],
    ["POST", "/api/users/:email/password", resetPassword],
    ["PUT", "/api/rules", putRules],
    ["GET", "/api/activity", listActivity],
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

function respond(data: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
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

/** Bancos já atualizados nesta instância da função (um por conexão). */
const upgraded = new WeakSet<Sql>();

/**
 * Login do pedido. Se o banco ainda não tem as colunas que o login lê (versão nova recém-
 * publicada), aplica a atualização do esquema uma vez e tenta de novo. É no login, antes de
 * qualquer gravação, que isso aparece, então repetir não grava nada em dobro.
 */
async function authenticateUpgrading(request: Request, sql: Sql, opts: AuthOptions): Promise<AuthUser> {
  try {
    return await authenticate(request, sql, opts);
  } catch (e) {
    if (!isMissingSchema(e) || upgraded.has(sql)) throw e;
    upgraded.add(sql);
    console.log("Banco sem as tabelas ou colunas desta versão: aplicando a atualização do esquema.");
    await upgradeSchema(sql);
    return authenticate(request, sql, opts);
  }
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
    // Pública: o navegador precisa do endereço do login antes de existir sessão. Ele guarda o
    // endereço entre as visitas e usa esta rota só para conferir se mudou (ver src/main.tsx).
    if (request.method === "GET" && path === "/api/config") {
      return respond({ auth_url: process.env.NEON_AUTH_BASE_URL || null });
    }
    const route = match(request.method, path);
    if (!route) return failure(404, "rota inválida");

    const sql = opts.sql ?? db.connect();
    const user = await authenticateUpgrading(request, sql, opts);
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
