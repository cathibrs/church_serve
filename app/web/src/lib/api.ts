import { clearToken, getToken } from "./auth";

export type Gender = "Masculino" | "Feminino";

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

export interface Position {
  code: string;
  name: string;
  category: string;
  allowed_gender: "Qualquer" | Gender;
  quantity: number;
  normal_active: boolean;
  event_only: boolean;
}

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

export interface InitData {
  today: string;
  teams: string[];
  team: string;
  positions: Position[];
  default_active: string[];
  /** quem está logado, já validado pela API */
  user: { email: string; role: Role; teams: string[] };
}

/** admin vê todas as equipes e gerencia os acessos; coordinator vê só as equipes dele. */
export type Role = "admin" | "coordinator";

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

export interface AccessList {
  me: string;
  /** todas as equipes que existem, para escolher as do coordenador */
  teams: string[];
  users: AccessUser[];
  /** senha recém-criada para um e-mail: vem uma única vez, para o admin repassar */
  password: { email: string; value: string } | null;
}

export interface DayData {
  date: string;
  weekday: string;
  last_sunday: boolean;
  team: string;
  suggested_team: string;
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
}

export interface SaveResult {
  schedule_id: number;
  warnings: string[];
  saved_at: string;
}

export interface HistoryRow {
  id: number;
  Voluntarios: string;
  Genero: string;
  Equipe: string;
  Total_Faltas: number;
  Ultima_Falta: string;
  Ativo: boolean;
  [k: string]: string | number | boolean;
}

export interface ScheduleRow {
  id: number;
  service_date: string;
  service_type: string;
  team: string;
  created_at: string;
  itens: number;
  faltas: number;
}

export interface HistoryData {
  headers: string[];
  rows: HistoryRow[];
  schedules: ScheduleRow[];
  kpis: { escalas: number; faltas: number; media_faltas: number; ativos: number; com_faltas: number };
  absences: Record<string, AbsenceItem[]>;
}

export interface AbsenceItem {
  date: string;
  team: string;
  reason: string;
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

async function bodyOf(r: Response): Promise<ErrorBody | null> {
  try {
    return await r.json();
  } catch {
    return null; // resposta sem JSON (ex.: erro do provedor)
  }
}

async function send(path: string, body: unknown, token: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let token = await getToken();
  if (!token) throw new ApiError(401, "Faça login para continuar.");
  let r = await send(path, body, token);
  let data = await bodyOf(r);
  if (r.status === 401 && (!data?.code || data.code === "unauthenticated")) {
    // o token vale 15 minutos: tenta uma vez com um novo antes de desistir
    token = await getToken(true);
    if (token) {
      r = await send(path, body, token);
      data = await bodyOf(r);
    }
  }
  if (!r.ok || !data || data.error) {
    const denied = r.status === 401 && (data?.code === "forbidden" || data?.code === "unverified");
    if (r.status === 401 && !denied) clearToken();
    throw new ApiError(r.status, data?.error || `Não foi possível falar com o servidor (${r.status}).`, denied);
  }
  return data as T;
}

export const api = {
  init: () => request<InitData>("/api/init"),
  day: (date: string, team?: string | null) =>
    request<DayData>(`/api/day?date=${date}${team ? `&team=${encodeURIComponent(team)}` : ""}`),
  generate: (body: unknown) =>
    request<{ assignments: Assignment[]; warnings: string[]; issues: Issue[] }>("/api/generate", body),
  validate: (body: unknown) => request<{ issues: Issue[] }>("/api/validate", body),
  save: (body: unknown) => request<SaveResult>("/api/save", body),
  volunteers: (team?: string) =>
    request<{ volunteers: Volunteer[]; teams: string[] }>(`/api/volunteers?team=${encodeURIComponent(team || "")}`),
  saveVolunteer: (body: Partial<Volunteer>) => request<{ id: number }>("/api/volunteer", body),
  history: (team?: string) => request<HistoryData>(`/api/history?team=${encodeURIComponent(team || "")}`),
  setDefaultPositions: (codes: string[], team: string) =>
    request<{ default_active: string[] }>("/api/positions/default", { codes, team }),
  // só para administradores
  users: () => request<AccessList>("/api/users"),
  saveUser: (user: { email: string; role: Role; teams: string[]; name?: string }) =>
    request<AccessList>("/api/users", user),
  newPassword: (email: string) => request<AccessList>("/api/users/password", { email }),
  removeUser: (email: string) => request<AccessList>("/api/users/remove", { email }),
};
