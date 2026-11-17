/**
 * Contrato entre o site e a API: o cliente de verdade (src/lib/api.ts) falando com as rotas
 * de verdade. Pega endereço, verbo ou formato de resposta que não batem entre os dois lados.
 */
import { beforeAll, expect, it, vi } from "vitest";
import type { Accounts } from "./accounts.ts";
import { handle, type HandleOptions } from "./routes.ts";
import { createTestDb } from "./testdb.ts";

const ADMIN = "lider@igreja.org";

// O login do navegador não existe aqui: o token é o próprio e-mail (ver `verify` abaixo).
vi.mock("../src/lib/auth.ts", () => ({ getToken: async () => ADMIN, clearToken: () => {} }));

const { api, ApiError, FACTORY_ACTIVE } = await import("../src/lib/api.ts");
const { href, load, nextService, parse, prefetch } = await import("../src/lib/screens.ts");

const TEAM = "Quarta-Feira_Noite_A"; // com hífen, para exercitar o endereço
const DATE = "2026-12-09"; // quarta-feira
const requests: string[] = [];

beforeAll(async () => {
  const { sql } = await createTestDb();
  await sql`INSERT INTO app_users (email, role) VALUES (${ADMIN}, 'admin')`;
  const accounts: Accounts = {
    async create(db, { email, name }) {
      await db`INSERT INTO neon_auth."user" (name, email, "emailVerified") VALUES (${name}, ${email}, true)`;
      return true;
    },
    async remove(db, email) {
      await db`DELETE FROM neon_auth."user" WHERE lower(email) = ${email}`;
    },
  };
  const opts: HandleOptions = {
    sql,
    accounts,
    verify: async (token) => ({ sub: `id-${token}`, email: token, emailVerified: true }),
  };
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${path}`);
    return handle(new Request(`https://escala.test${path}`, init), opts);
  });
});

it("o site percorre todas as rotas: voluntários, escala, histórico e acessos", async () => {
  const me = await api.me();
  expect(me).toMatchObject({ email: ADMIN, role: "admin" });
  expect(me.teams).toContain(TEAM);

  // voluntários: cria, lista e altera um campo
  const ids: number[] = [];
  for (let i = 1; i <= 30; i++) {
    const v = await api.createVolunteer({
      name: `Pessoa ${String(i).padStart(2, "0")}`,
      gender: i <= 18 ? "Feminino" : "Masculino",
      team: TEAM,
      can_bercario: i <= 18,
    });
    ids.push(v.id);
  }
  expect(await api.volunteers(TEAM)).toHaveLength(30);
  expect(await api.volunteers("Domingo_Noite_B")).toEqual([]);
  expect(await api.updateVolunteer(ids[0], { observation: "chega cedo" })).toMatchObject({
    id: ids[0],
    observation: "chega cedo",
    team: TEAM,
  });

  // escala: a folha sem equipe usa a sugerida para a quarta-feira
  const empty = await api.sheet(DATE);
  expect(empty).toMatchObject({ team: TEAM, weekday: "Quarta-Feira", saved: null, issues: [] });
  expect(empty.default_active).toEqual(FACTORY_ACTIVE);
  const present = ids.slice(0, 28);
  const suggestion = await api.suggestSchedule(DATE, TEAM, { present_ids: present, active_codes: FACTORY_ACTIVE });
  expect(suggestion.issues).toEqual([]);
  const saved = await api.saveSchedule(DATE, TEAM, {
    present_ids: present,
    active_codes: FACTORY_ACTIVE,
    assignments: suggestion.assignments.map((a) => ({
      position_code: a.position_code,
      volunteer_id: a.volunteer_id,
      volunteer_name: a.volunteer_name,
    })),
    absent_reasons: { [ids[29]]: "viagem" },
  });
  expect(saved.issues).toEqual([]);
  expect(saved.saved_at).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  const filled = await api.sheet(DATE, TEAM);
  expect(filled.saved?.assignments).toHaveLength(suggestion.assignments.length);
  expect(filled.saved?.absent_ids).toEqual([ids[28], ids[29]]);
  expect(filled.saved?.absent_reasons).toEqual({ [ids[29]]: "viagem" });
  expect(filled.issues).toEqual([]);

  expect(await api.setTeamPositions(TEAM, ["02", "01"])).toEqual({ codes: ["01", "02"] });
  expect((await api.sheet(DATE, TEAM)).default_active).toEqual(["01", "02"]);

  // histórico: dois recursos
  expect(await api.schedules(TEAM)).toMatchObject([{ service_date: DATE, team: TEAM, faltas: 2 }]);
  expect(await api.schedules()).toHaveLength(1);
  const history = await api.history(TEAM);
  expect(history).toHaveLength(30);
  expect(history.find((r) => r.id === ids[29])).toMatchObject({
    faltas: 1,
    absences: [{ date: DATE, team: TEAM, reason: "viagem" }],
  });

  // acessos: libera, altera, gera senha e remove (e-mail com "+", que precisa ir codificado)
  const email = "nova+pessoa@igreja.org";
  const created = await api.saveUser(email, { role: "coordinator", teams: [TEAM], name: "Nova Pessoa" });
  expect(created.user).toMatchObject({ email, role: "coordinator", teams: [TEAM], name: "Nova Pessoa", has_account: true });
  expect(created.password).toMatch(/^.{4}-.{4}-.{4}$/);
  const edited = await api.saveUser(email, { role: "admin", teams: [] });
  expect(edited).toMatchObject({ user: { email, role: "admin", teams: [] }, password: null });
  expect((await api.newPassword(email)).password).toMatch(/^.{4}-.{4}-.{4}$/);
  expect((await api.users()).map((u) => u.email)).toEqual([ADMIN, email]);
  expect(await api.removeUser(email)).toBeNull(); // 204, sem corpo
  expect((await api.users()).map((u) => u.email)).toEqual([ADMIN]);

  // nenhum pedido caiu em rota inexistente, e o endereço leva a equipe e o e-mail codificados
  expect(requests).toContain(`PUT /api/schedules/${DATE}/${TEAM}`);
  expect(requests).toContain(`POST /api/schedules/${DATE}/${TEAM}/suggestion`);
  expect(requests).toContain("PUT /api/users/nova%2Bpessoa%40igreja.org");
  expect(requests).toContain("DELETE /api/users/nova%2Bpessoa%40igreja.org");
});

it("cada tela tem o seu endereço", () => {
  const at = (pathname: string, hash = "") => parse({ pathname, hash });
  expect(at("/")).toEqual({ page: "escala" });
  expect(at("/escala")).toEqual({ page: "escala" });
  expect(at("/escala/2026-12-09")).toEqual({ page: "escala", date: DATE, team: undefined });
  expect(at(`/escala/${DATE}/${TEAM}`)).toEqual({ page: "escala", date: DATE, team: TEAM });
  expect(at("/escala/Domingo%20%C3%A0%20noite")).toEqual({ page: "escala" }); // sem data válida
  expect(at("/voluntarios")).toEqual({ page: "voluntarios" });
  expect(at("/historico")).toEqual({ page: "historico", team: undefined });
  expect(at("/historico/Domingo%20Manha")).toEqual({ page: "historico", team: "Domingo Manha" });
  expect(at("/acessos")).toEqual({ page: "acessos" });
  expect(at("/nao-existe/1")).toEqual({ page: "escala" });
  expect(at("/", "#historico")).toEqual({ page: "historico" }); // endereço antigo, com "#"

  // ida e volta: o endereço montado leva à mesma tela
  for (const route of [
    { page: "escala" },
    { page: "escala", date: DATE },
    { page: "escala", date: DATE, team: TEAM },
    { page: "voluntarios" },
    { page: "historico" },
    { page: "historico", team: "Equipe com espaço/barra" },
    { page: "acessos" },
  ] as const) {
    expect(parse({ pathname: href(route), hash: "" })).toMatchObject(route);
  }
});

it("sem data no endereço, a escala abre no próximo culto", () => {
  expect(nextService("2026-12-06")).toBe("2026-12-06"); // domingo: hoje
  expect(nextService("2026-12-09")).toBe("2026-12-09"); // quarta: hoje
  expect(nextService("2026-12-07")).toBe("2026-12-13"); // segunda: próximo domingo
  expect(nextService("2026-12-31")).toBe("2027-01-03"); // vira o ano
  expect(nextService()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

it("os dados de cada tela vêm prontos antes de ela aparecer, e o pedido adiantado é aproveitado", async () => {
  const sheet = await load({ page: "escala", date: DATE, team: TEAM });
  expect(sheet).toMatchObject({ page: "escala", data: { date: DATE, team: TEAM } });
  if (sheet.page === "escala") expect(sheet.data.saved?.assignments.length).toBeGreaterThan(0);
  expect((await load({ page: "escala" })).page).toBe("escala"); // sem data: próximo culto, equipe sugerida

  const volunteers = await load({ page: "voluntarios" });
  expect(volunteers.page === "voluntarios" && volunteers.data).toHaveLength(30);
  const history = await load({ page: "historico", team: TEAM });
  expect(history.page === "historico" && history.data.people).toHaveLength(30);
  expect(history.page === "historico" && history.data.schedules).toHaveLength(1);
  const access = await load({ page: "acessos" });
  expect(access.page === "acessos" && access.data.map((u) => u.email)).toEqual([ADMIN]);

  // passar o mouse no menu adianta o pedido: abrir a tela em seguida não pede de novo
  requests.length = 0;
  const ahead = prefetch({ page: "voluntarios" });
  expect(prefetch({ page: "voluntarios" })).toBe(ahead);
  expect(load({ page: "voluntarios" })).toBe(ahead);
  await ahead;
  expect(requests).toEqual(["GET /api/volunteers"]);
  // a abertura seguinte busca dados novos
  await load({ page: "voluntarios" });
  expect(requests).toEqual(["GET /api/volunteers", "GET /api/volunteers"]);
});

it("erro da API vira ApiError com a mensagem e o status", async () => {
  const failure = await api.createVolunteer({ name: "Pessoa 01", gender: "Feminino" }).catch((e) => e);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ status: 400, denied: false });
  expect(failure.message).toContain("Já existe");
  const missing = await api.updateVolunteer(999999, { active: false }).catch((e) => e);
  expect(missing).toMatchObject({ status: 404, message: "Voluntário não encontrado." });
});
