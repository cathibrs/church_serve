/**
 * Equipe Eventos: junta todos os voluntários, cada evento escolhe quem serve e ninguém ganha
 * falta por não ter sido escolhido.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_FACTORY_ACTIVE, EVENT_TEAM, FACTORY_ACTIVE } from "../shared/catalog.ts";
import type { Accounts } from "./accounts.ts";
import type { Sql } from "./db.ts";
import { handle, type HandleOptions } from "./routes.ts";
import { createTestDb } from "./testdb.ts";

const ADMIN = "admin@igreja.org";
const EVENT_COORD = "eventos@igreja.org";
const TEAM_COORD = "manha@igreja.org";
const A = "Domingo_Manha_A";
const B = "Quarta-Feira_Noite_A";
const EVENT_DATE = "2026-12-05"; // sábado
const NEXT_EVENT = "2026-12-19"; // sábado
const SUNDAY = "2026-12-06";

let sql: Sql;
let opts: HandleOptions;

const verify = async (token: string) => ({ sub: `id-${token}`, email: token, emailVerified: true });
const accounts: Accounts = { create: async () => false, remove: async () => {} };

async function call(method: string, path: string, body?: unknown, token = ADMIN) {
  const res = await handle(
    new Request(`https://escala.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    opts,
  );
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as any };
}
const get = (path: string, token = ADMIN) => call("GET", path, undefined, token);
const sheet = (date: string, team?: string) => `/api/schedules/${date}${team ? `/${team}` : ""}`;
const forbidden = (r: { status: number; data: any }) => r.status === 401 && r.data?.code === "forbidden";

const teamA: number[] = [];
const teamB: number[] = [];

beforeAll(async () => {
  sql = (await createTestDb()).sql;
  opts = { sql, verify, accounts };
  await sql`INSERT INTO app_users (email, role) VALUES (${ADMIN}, 'admin')`;
  await sql`INSERT INTO app_users (email, role, teams) VALUES
    (${EVENT_COORD}, 'coordinator', ${[EVENT_TEAM]}::text[]),
    (${TEAM_COORD}, 'coordinator', ${[A]}::text[])`;
  for (let i = 1; i <= 40; i++) {
    const team = i <= 24 ? A : B;
    const r = await call("POST", "/api/volunteers", {
      name: `Pessoa ${String(i).padStart(2, "0")}`,
      gender: i % 3 === 0 ? "Masculino" : "Feminino",
      team,
      can_bercario: i % 3 !== 0,
    });
    expect(r.status).toBe(201);
    (team === A ? teamA : teamB).push(r.data.id);
  }
});

describe("equipe Eventos", () => {
  let chosen: number[];

  it("aparece por último na lista de equipes e é aceita nos acessos", async () => {
    const teams = (await get("/api/me")).data.teams;
    expect(teams[teams.length - 1]).toBe(EVENT_TEAM);
    const saved = await call("PUT", `/api/users/${encodeURIComponent("novo@igreja.org")}`, { role: "coordinator", teams: ["Eventos"] });
    expect(saved.status).toBe(201);
    expect(saved.data.user.teams).toEqual([EVENT_TEAM]);
  });

  it("ninguém é cadastrado em Eventos", async () => {
    const created = await call("POST", "/api/volunteers", { name: "Sem Equipe", gender: "Feminino", team: "Eventos" });
    expect(created.status).toBe(400);
    expect(created.data.error).toContain("junta todos");
    const moved = await call("PATCH", `/api/volunteers/${teamA[0]}`, { team: EVENT_TEAM });
    expect(moved.status).toBe(400);
  });

  it("a folha do evento traz todos os voluntários, com as posições de evento ligadas", async () => {
    const { status, data } = await get(sheet(EVENT_DATE, EVENT_TEAM));
    expect(status).toBe(200);
    expect(data).toMatchObject({ team: EVENT_TEAM, saved: null, issues: [], last_event: null });
    expect(data.volunteers).toHaveLength(40);
    expect(new Set(data.volunteers.map((v: any) => v.team))).toEqual(new Set([A, B]));
    expect(data.default_active).toEqual(EVENT_FACTORY_ACTIVE);
    expect(data.default_active).toEqual(expect.arrayContaining(["GM", "GF", "04", "11", "14", "22"]));
    expect(data.default_active.length).toBeGreaterThan(FACTORY_ACTIVE.length);
  });

  it("gera e salva com gente de duas equipes; quem não foi escolhido não ganha falta", async () => {
    chosen = [...teamA.slice(0, 15), ...teamB.slice(0, 10)];
    const gen = await call("POST", `${sheet(EVENT_DATE, EVENT_TEAM)}/suggestion`, { present_ids: chosen });
    expect(gen.status).toBe(200);
    expect(gen.data.warnings.join(" ")).not.toContain("não pertencem");
    expect(new Set(gen.data.assignments.map((a: any) => a.volunteer_id))).toEqual(new Set(chosen));

    const saved = await call("PUT", sheet(EVENT_DATE, EVENT_TEAM), {
      present_ids: chosen,
      assignments: gen.data.assignments,
      absent_reasons: { [teamA[20]]: "não deveria contar" },
    });
    expect(saved.status).toBe(200);
    expect(saved.data.issues).toEqual([]);

    const { data } = await get(sheet(EVENT_DATE, EVENT_TEAM));
    expect(data.saved.present_ids).toEqual([...chosen].sort((a, b) => a - b));
    expect(data.saved.absent_ids).toEqual([]);
    expect(data.issues).toEqual([]);
    const vols = (await get("/api/volunteers")).data;
    expect(vols.every((v: any) => v.faltas === 0)).toBe(true);
    expect(vols.find((v: any) => v.id === chosen[0])).toMatchObject({ vezes: 1, ultima_vez: EVENT_DATE });
  });

  it("quem está na escala do evento conta como escolhido, mesmo fora da lista enviada", async () => {
    const { data } = await get(sheet(EVENT_DATE, EVENT_TEAM));
    const saved = await call("PUT", sheet(EVENT_DATE, EVENT_TEAM), { present_ids: [], assignments: data.saved.assignments });
    expect(saved.data.issues).toEqual([]);
    expect((await get(sheet(EVENT_DATE, EVENT_TEAM))).data.saved.present_ids).toEqual([...chosen].sort((a, b) => a - b));
  });

  it("o evento seguinte oferece repetir as pessoas do anterior", async () => {
    const { data } = await get(sheet(NEXT_EVENT, EVENT_TEAM));
    expect(data.saved).toBeNull();
    expect(data.last_event).toEqual({ date: EVENT_DATE, ids: [...chosen].sort((a, b) => a - b) });
    // um culto comum não recebe isso
    expect((await get(sheet(SUNDAY, A))).data.last_event).toBeNull();
  });

  it("um evento não vira a equipe sugerida do dia da semana", async () => {
    const sunday = "2026-12-13";
    const gen = await call("POST", `${sheet(sunday, EVENT_TEAM)}/suggestion`, { present_ids: chosen });
    await call("PUT", sheet(sunday, EVENT_TEAM), { present_ids: chosen, assignments: gen.data.assignments });
    expect((await get(sheet("2026-12-20"))).data.team).toBe(A);
    // coordenador só de Eventos: sem outra equipe, a sugestão é Eventos
    expect((await get(sheet("2026-12-20"), EVENT_COORD)).data.team).toBe(EVENT_TEAM);
  });

  it("coordenador de Eventos escala gente de qualquer equipe; quem não tem Eventos é recusado", async () => {
    const people = [...teamA.slice(10, 20), ...teamB.slice(5, 15)];
    const gen = await call("POST", `${sheet("2027-01-09", EVENT_TEAM)}/suggestion`, { present_ids: people }, EVENT_COORD);
    expect(gen.status).toBe(200);
    const saved = await call(
      "PUT",
      sheet("2027-01-09", EVENT_TEAM),
      { present_ids: people, assignments: gen.data.assignments },
      EVENT_COORD,
    );
    expect(saved.status).toBe(200);
    expect(forbidden(await get(sheet("2027-01-09", EVENT_TEAM), TEAM_COORD))).toBe(true);
    expect(forbidden(await call("PUT", sheet("2027-01-09", EVENT_TEAM), { present_ids: [], assignments: [] }, TEAM_COORD))).toBe(
      true,
    );
    // e o coordenador de Eventos não vira coordenador das equipes
    expect(forbidden(await get(sheet(SUNDAY, A), EVENT_COORD))).toBe(true);
  });

  it("posições padrão do evento são só do evento", async () => {
    await call("PUT", `/api/teams/${EVENT_TEAM}/positions`, { codes: ["GM", "GF", "01"] });
    expect((await get(sheet(NEXT_EVENT, EVENT_TEAM))).data.default_active).toEqual(["01", "GF", "GM"]);
    expect((await get(sheet(SUNDAY, A))).data.default_active).toEqual(FACTORY_ACTIVE);
  });
});
