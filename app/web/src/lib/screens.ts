/**
 * Telas do sistema: cada uma tem o seu endereço e os seus dados.
 *
 *   /escala[/:data[/:equipe]]   folha do culto (sem data: o próximo culto; sem equipe: a sugerida)
 *   /voluntarios                cadastro
 *   /historico[/:equipe]        histórico e faltas
 *   /acessos                    quem pode entrar e regras para coordenadores (só administrador)
 *   /atividade                  registro de quem fez o quê (só administrador)
 *
 * Os dados são pedidos ANTES de a tela aparecer: ao trocar de tela, a anterior continua
 * visível até a nova estar completa, então nenhuma tela é desenhada vazia para ser
 * preenchida depois. Passar o mouse no menu já adianta o pedido.
 */
import {
  api,
  type AccessUser,
  type ActivityPage,
  type HistoryRow,
  type ScheduleRow,
  type Sheet,
  type Volunteer,
} from "./api";

export type Route =
  | { page: "escala"; date?: string; team?: string }
  | { page: "voluntarios" }
  | { page: "historico"; team?: string }
  | { page: "acessos" }
  | { page: "atividade" };

export type Page = Route["page"];

/** Telas que só o administrador abre. */
export const ADMIN_PAGES: Page[] = ["acessos", "atividade"];

/** O que cada tela recebe pronto. */
export interface ScreenData {
  escala: Sheet;
  voluntarios: Volunteer[];
  historico: { people: HistoryRow[]; schedules: ScheduleRow[] };
  acessos: AccessUser[];
  atividade: ActivityPage;
}

/** Tela pronta para aparecer: o endereço e os dados dela, já carregados. */
export type Screen = { [P in Page]: { page: P; route: Extract<Route, { page: P }>; data: ScreenData[P] } }[Page];

// ---------------------------------------------------------------- endereços

const seg = encodeURIComponent;

export function href(route: Route): string {
  switch (route.page) {
    case "escala":
      if (!route.date) return "/escala";
      return `/escala/${route.date}${route.team ? `/${seg(route.team)}` : ""}`;
    case "historico":
      return `/historico${route.team ? `/${seg(route.team)}` : ""}`;
    default:
      return `/${route.page}`;
  }
}

const decode = (part: string | undefined) => {
  try {
    return part ? decodeURIComponent(part) : undefined;
  } catch {
    return undefined; // %xx malformado
  }
};

/** Tela de um endereço. Endereço desconhecido cai na escala. */
export function parse(where: { pathname: string; hash: string } = location): Route {
  const [page, a, b] = where.pathname.split("/").filter(Boolean);
  switch (page) {
    case "escala":
      return /^\d{4}-\d{2}-\d{2}$/.test(a ?? "") ? { page, date: a, team: decode(b) } : { page };
    case "historico":
      return { page, team: decode(a) };
    case "voluntarios":
    case "acessos":
    case "atividade":
      return { page };
  }
  // endereços antigos, de quando a tela ficava depois do "#"
  const old = where.hash.slice(1);
  if (old === "voluntarios" || old === "historico" || old === "acessos") return { page: old };
  return { page: "escala" };
}

// ---------------------------------------------------------------- datas

/** Hoje em São Paulo (AAAA-MM-DD), onde quer que o navegador esteja. */
function today(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Próximo culto: hoje, se for domingo ou quarta; senão o próximo domingo. */
export function nextService(from = today()): string {
  const t = new Date(from + "T12:00:00Z");
  const dow = t.getUTCDay();
  if (dow !== 0 && dow !== 3) t.setUTCDate(t.getUTCDate() + ((7 - dow) % 7));
  return t.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- dados

async function fetchScreen(route: Route): Promise<Screen> {
  switch (route.page) {
    case "escala":
      return { page: "escala", route, data: await api.sheet(route.date ?? nextService(), route.team) };
    case "voluntarios":
      return { page: "voluntarios", route, data: await api.volunteers() };
    case "historico": {
      const [people, schedules] = await Promise.all([api.history(route.team), api.schedules(route.team)]);
      return { page: "historico", route, data: { people, schedules } };
    }
    case "acessos":
      return { page: "acessos", route, data: await api.users() };
    case "atividade":
      return { page: "atividade", route, data: await api.activity() };
  }
}

/** Pedidos adiantados: valem por pouco tempo e servem a uma única abertura de tela. */
const ahead = new Map<string, { at: number; screen: Promise<Screen> }>();
const AHEAD_MS = 15_000;

/** Adianta o pedido de uma tela (mouse ou foco no menu). Repetir não pede de novo. */
export function prefetch(route: Route): Promise<Screen> {
  const key = href(route);
  const hit = ahead.get(key);
  if (hit && Date.now() - hit.at < AHEAD_MS) return hit.screen;
  const screen = fetchScreen(route);
  ahead.set(key, { at: Date.now(), screen });
  screen.catch(() => ahead.delete(key)); // se falhar, a abertura de verdade tenta de novo e mostra o erro
  return screen;
}

/** Esquece os pedidos adiantados (troca de conta). */
export function forget() {
  ahead.clear();
}

/** Dados da tela para mostrar agora: aproveita o pedido adiantado, se houver. */
export function load(route: Route): Promise<Screen> {
  const screen = prefetch(route);
  ahead.delete(href(route)); // a próxima abertura busca dados novos
  return screen;
}
