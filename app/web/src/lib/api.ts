/**
 * Cliente da API REST (ver a lista de rotas em server/routes.ts).
 *
 * Cada tela pede só o recurso que mostra. O que é fixo (posições e regras) não é pedido à
 * API: vem de shared/catalog.ts, dentro do próprio site.
 */
import { clearToken, getToken } from "./auth";
import type { Gender, Position } from "../../shared/catalog.ts";

export { FACTORY_ACTIVE, POSITIONS } from "../../shared/catalog.ts";
export type { Gender, Position };

export interface Volunteer {
  id: number;
  name: string;
  gender: Gender;
  team: string;
  active: boolean;
  can_bercario: boolean;
  can_cozinha: boolean;
  can_recepcao: boolean;
  can_banheiro: boolean;
  can_limpar_altar: boolean;
  observation?: string;
  faltas: number;
  vezes?: number;
  ultima_vez?: string | null;
}

/** Campos do cadastro (o que se envia ao criar ou alterar um voluntário). */
export type VolunteerFields = Omit<Volunteer, "id" | "faltas" | "vezes" | "ultima_vez">;

/** Voluntário como a API devolve depois de gravar (sem os números do histórico). */
export type SavedVolunteer = VolunteerFields & { id: number };

export interface Assignment {
  position_code: string;
  position_name?: string;
  category?: string;
  volunteer_id: number;
  volunteer_name: string;
  order?: number;
}

export interface Issue {
  codes: string[];
  message: string;
}

/** admin vê todas as equipes e gerencia os acessos; coordinator vê só as equipes dele. */
export type Role = "admin" | "coordinator";

/** Quem está logado, já validado pela API. */
export interface Me {
  email: string;
  role: Role;
  /** equipes que a pessoa pode usar (admin: todas) */
  teams: string[];
  /** data de hoje no horário de São Paulo */
  today: string;
}

/** Um e-mail com acesso liberado e a situação da conta dele no login. */
export interface AccessUser {
  email: string;
  role: Role;
  /** equipes do coordenador (vazio para admin) */
  teams: string[];
  created_at: string;
  created_by: string | null;
  name: string | null;
  has_account: boolean;
  verified: boolean;
}

/** Resultado de liberar um acesso ou gerar senha. `password` vem uma única vez, para o admin repassar. */
export interface AccessChange {
  user: AccessUser;
  password: string | null;
}

/** Folha de um culto: a equipe, as posições ligadas por padrão e a escala salva (se houver). */
export interface Sheet {
  date: string;
  weekday: string;
  last_sunday: boolean;
  team: string;
  volunteers: Volunteer[];
  default_active: string[];
  saved: null | {
    id: number;
    created_at: string;
    assignments: Assignment[];
    absent_ids: number[];
    absent_reasons?: Record<string, string>;
    active_codes: string[] | null;
  };
  /** regras quebradas na escala salva */
  issues: Issue[];
}

/** O que se envia para gravar a escala de um culto. */
export interface ScheduleBody {
  present_ids: number[];
  active_codes: string[];
  assignments: Assignment[];
  absent_reasons: Record<string, string>;
}

export interface SaveResult {
  id: number;
  saved_at: string;
  issues: Issue[];
}

export interface Suggestion {
  assignments: Assignment[];
  warnings: string[];
  issues: Issue[];
}

export interface ScheduleRow {
  id: number;
  service_date: string;
  service_type: string;
  team: string;
  itens: number;
  faltas: number;
}

export interface AbsenceItem {
  date: string;
  team: string;
  reason: string;
}

/** Histórico de um voluntário ativo: só as colunas em que ele já serviu. */
export interface HistoryRow {
  id: number;
  name: string;
  gender: string;
  team: string;
  faltas: number;
  /** coluna (ex.: "Cozinha", "POS_07") -> quantas vezes serviu */
  counts: Record<string, number>;
  /** faltas mais recentes, com data e motivo */
  absences: AbsenceItem[];
}

/** Erro da API. `denied`: há sessão, mas a conta não tem acesso (e-mail não confirmado ou não liberado). */
export class ApiError extends Error {
  readonly status: number;
  readonly denied: boolean;

  constructor(status: number, message: string, denied = false) {
    super(message);
    this.status = status;
    this.denied = denied;
  }
}

interface ErrorBody {
  error?: string;
  /** motivo de um 401: unauthenticated, unverified ou forbidden (ver server/auth.ts) */
  code?: string;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function bodyOf(r: Response): Promise<unknown> {
  if (r.status === 204) return null;
  try {
    return await r.json();
  } catch {
    return undefined; // resposta sem JSON (ex.: erro do provedor)
  }
}

function send(method: Method, path: string, body: unknown, token: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body === undefined) return fetch(path, { method, headers });
  headers["Content-Type"] = "application/json";
  return fetch(path, { method, headers, body: JSON.stringify(body) });
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let token = await getToken();
  if (!token) throw new ApiError(401, "Faça login para continuar.");
  let r = await send(method, path, body, token);
  let data = await bodyOf(r);
  const reason = () => (data as ErrorBody | null | undefined)?.code;
  if (r.status === 401 && (!reason() || reason() === "unauthenticated")) {
    // o token vale 15 minutos: tenta uma vez com um novo antes de desistir
    token = await getToken(true);
    if (token) {
      r = await send(method, path, body, token);
      data = await bodyOf(r);
    }
  }
  if (!r.ok || data === undefined) {
    const denied = r.status === 401 && (reason() === "forbidden" || reason() === "unverified");
    if (r.status === 401 && !denied) clearToken();
    const message = (data as ErrorBody | null | undefined)?.error;
    throw new ApiError(r.status, message || `Não foi possível falar com o servidor (${r.status}).`, denied);
  }
  return data as T;
}

const seg = encodeURIComponent;
const byTeam = (team?: string | null) => (team ? `?team=${seg(team)}` : "");
const schedule = (date: string, team: string) => `/api/schedules/${date}/${seg(team)}`;

export const api = {
  me: () => request<Me>("GET", "/api/me"),

  volunteers: (team?: string) => request<Volunteer[]>("GET", `/api/volunteers${byTeam(team)}`),
  createVolunteer: (fields: Partial<VolunteerFields>) => request<SavedVolunteer>("POST", "/api/volunteers", fields),
  /** Altera só os campos enviados. */
  updateVolunteer: (id: number, fields: Partial<VolunteerFields>) =>
    request<SavedVolunteer>("PATCH", `/api/volunteers/${id}`, fields),

  schedules: (team?: string) => request<ScheduleRow[]>("GET", `/api/schedules${byTeam(team)}`),
  /** Sem equipe, a API escolhe a sugerida para o dia. */
  sheet: (date: string, team?: string | null) =>
    request<Sheet>("GET", team ? schedule(date, team) : `/api/schedules/${date}`),
  saveSchedule: (date: string, team: string, body: ScheduleBody) =>
    request<SaveResult>("PUT", schedule(date, team), body),
  suggestSchedule: (date: string, team: string, body: Pick<ScheduleBody, "present_ids" | "active_codes">) =>
    request<Suggestion>("POST", `${schedule(date, team)}/suggestion`, body),

  setTeamPositions: (team: string, codes: string[]) =>
    request<{ codes: string[] }>("PUT", `/api/teams/${seg(team)}/positions`, { codes }),
  history: (team?: string) => request<HistoryRow[]>("GET", `/api/history${byTeam(team)}`),

  // só para administradores
  users: () => request<AccessUser[]>("GET", "/api/users"),
  saveUser: (email: string, access: { role: Role; teams: string[]; name?: string }) =>
    request<AccessChange>("PUT", `/api/users/${seg(email)}`, access),
  removeUser: (email: string) => request<null>("DELETE", `/api/users/${seg(email)}`),
  newPassword: (email: string) => request<AccessChange>("POST", `/api/users/${seg(email)}/password`),
};
