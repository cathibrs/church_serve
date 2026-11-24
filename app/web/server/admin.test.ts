/**
 * Observações dos voluntários e controle do administrador: registro de atividades, acesso
 * suspenso, último acesso, regras para coordenadores e a atualização automática do banco.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Accounts } from "./accounts.ts";
import { applySchema, type Sql } from "./db.ts";
import { handle, type HandleOptions } from "./routes.ts";
import { createTestDb, SCHEMA } from "./testdb.ts";
import { UPGRADE } from "./upgrade.ts";

const ADMIN = "admin@igreja.org";
const ADMIN2 = "vice@igreja.org";
const COORD = "coord@igreja.org";
const TEAM = "Domingo_Manha_A";
const OTHER = "Domingo_Noite_A";

let sql: Sql;
let opts: HandleOptions;

const verify = async (token: string) => ({ sub: `id-${token}`, email: token, emailVerified: true });
const accounts: Accounts = { create: async () => false, remove: async () => {} };

async function call(method: string, path: string, body?: unknown, token = ADMIN, options = opts) {
  const res = await handle(
    new Request(`https://escala.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    options,
  );
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as any };
}
const get = (path: string, token = ADMIN) => call("GET", path, undefined, token);
const forbidden = (r: { status: number; data: any }) => r.status === 401 && r.data?.code === "forbidden";
const activity = async (query = "") => (await get(`/api/activity${query}`)).data;

let mine: number; // voluntário da equipe do coordenador
let theirs: number; // de outra equipe

beforeAll(async () => {
  sql = (await createTestDb()).sql;
  opts = { sql, verify, accounts };
  await sql`INSERT INTO app_users (email, role) VALUES (${ADMIN}, 'admin'), (${ADMIN2}, 'admin')`;
  await sql`INSERT INTO app_users (email, role, teams) VALUES (${COORD}, 'coordinator', ${[TEAM]}::text[])`;
  await sql`INSERT INTO neon_auth."user" (name, email, "emailVerified") VALUES ('Coordenadora Ana', ${COORD}, true)`;
  mine = (await call("POST", "/api/volunteers", { name: "Bia", gender: "Feminino", team: TEAM })).data.id;
  theirs = (await call("POST", "/api/volunteers", { name: "Caio", gender: "Masculino", team: OTHER })).data.id;
});

describe("observações dos voluntários", () => {
  const notes = (id: number) => `/api/volunteers/${id}/notes`;
  let adminNote: number;
  let coordNote: number;

  it("admin e coordenador escrevem; a lista vem da mais recente, com autor e data", async () => {
    const a = await call("POST", notes(mine), { body: "  Avisou que viaja em janeiro.  " });
    expect(a.status).toBe(201);
    expect(a.data).toMatchObject({ volunteer_id: mine, body: "Avisou que viaja em janeiro.", author: ADMIN });
    expect(a.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    adminNote = a.data.id;

    const c = await call("POST", notes(mine), { body: "Pediu para não ficar na cozinha." }, COORD);
    expect(c.status).toBe(201);
    expect(c.data.author_name).toBe("Coordenadora Ana");
    coordNote = c.data.id;

    const list = await get(notes(mine), COORD);
    expect(list.data.map((n: any) => n.id)).toEqual([coordNote, adminNote]);
  });

  it("a lista de voluntários traz quantas observações há e a mais recente", async () => {
    const bia = (await get("/api/volunteers")).data.find((v: any) => v.id === mine);
    expect(bia).toMatchObject({ notas: 2, ultima_nota: "Pediu para não ficar na cozinha." });
    const caio = (await get("/api/volunteers")).data.find((v: any) => v.id === theirs);
    expect(caio).toMatchObject({ notas: 0, ultima_nota: null });
  });

  it("observação vazia: 400; voluntário que não existe: 404", async () => {
    expect((await call("POST", notes(mine), { body: "   " })).status).toBe(400);
    expect((await call("POST", notes(99999), { body: "x" })).status).toBe(404);
  });

  it("coordenador não lê nem escreve sobre voluntário de outra equipe", async () => {
    expect(forbidden(await get(notes(theirs), COORD))).toBe(true);
    expect(forbidden(await call("POST", notes(theirs), { body: "x" }, COORD))).toBe(true);
  });

  it("só quem escreveu ou um admin apaga", async () => {
    expect(forbidden(await call("DELETE", `${notes(mine)}/${adminNote}`, undefined, COORD))).toBe(true);
    expect((await call("DELETE", `${notes(mine)}/${coordNote}`, undefined, ADMIN)).status).toBe(204);
    expect((await call("DELETE", `${notes(mine)}/${coordNote}`)).status).toBe(404);
    // observação de outro voluntário não é apagada por um endereço trocado
    expect((await call("DELETE", `${notes(theirs)}/${adminNote}`)).status).toBe(404);
    expect((await get(notes(mine))).data.map((n: any) => n.id)).toEqual([adminNote]);
  });
});

describe("registro de atividades", () => {
  it("só o admin vê", async () => {
    expect(forbidden(await get("/api/activity", COORD))).toBe(true);
  });

  it("anota cadastros, alterações e observações, com quem fez", async () => {
    await call("PATCH", `/api/volunteers/${mine}`, { active: false, can_cozinha: false, team: TEAM }, COORD);
    const { items, actors } = await activity();
    expect(items[0]).toMatchObject({
      actor: COORD,
      actor_name: "Coordenadora Ana",
      action: "volunteer.update",
      team: TEAM,
      summary: "Alterou Bia: desativado, não pode Cozinha.",
      details: { before: { active: true, can_cozinha: true }, after: { active: false, can_cozinha: false } },
    });
    expect(items.some((i: any) => i.action === "volunteer.create" && i.summary === "Cadastrou Caio em Domingo Noite A.")).toBe(true);
    expect(items.some((i: any) => i.action === "note.remove" && i.summary.includes("escrita por coord@igreja.org"))).toBe(true);
    expect(actors).toEqual([ADMIN, COORD]);
  });

  it("alteração que não muda nada não é anotada", async () => {
    const before = (await activity()).items.length;
    await call("PATCH", `/api/volunteers/${mine}`, { active: false });
    expect((await activity()).items.length).toBe(before);
  });

  it("gravações seguidas da mesma escala viram uma linha só", async () => {
    const path = `/api/schedules/2026-12-06/${TEAM}`;
    for (const n of [1, 2, 3]) {
      const r = await call("PUT", path, { present_ids: [mine], assignments: n === 3 ? [{ position_code: "01", volunteer_id: mine }] : [] });
      expect(r.status).toBe(200);
    }
    const saves = (await activity("?group=schedule")).items;
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ repeats: 3, summary: `Salvou a escala de 06/12/2026 · Domingo Manha A: 1 posições, 1 presentes.` });
  });

  it("filtra por pessoa e por equipe, e pagina", async () => {
    const byCoord = (await activity(`?actor=${encodeURIComponent(COORD)}`)).items;
    expect(byCoord.length).toBeGreaterThan(0);
    expect(byCoord.every((i: any) => i.actor === COORD)).toBe(true);
    expect((await activity(`?team=${OTHER}`)).items.every((i: any) => i.team === OTHER)).toBe(true);
    const first = await activity();
    expect(first.next).toBeNull(); // menos de uma página
    const older = await activity(`?before=${first.items[1].id}`);
    expect(older.items[0].id).toBe(first.items[2].id);
    expect((await get("/api/activity?group=hack")).status).toBe(400);
  });
});

describe("acesso suspenso e último acesso", () => {
  const user = (email: string) => `/api/users/${encodeURIComponent(email)}`;
  const listed = async (email: string) => (await get("/api/users")).data.find((u: any) => u.email === email);

  it("anota o último acesso de quem usa o sistema", async () => {
    await get("/api/me", COORD);
    expect((await listed(COORD)).last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("suspenso não entra; reativado volta com o mesmo papel e equipes", async () => {
    const r = await call("PATCH", user(COORD), { suspended: true });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ email: COORD, suspended: true, teams: [TEAM] });
    const blocked = await get("/api/me", COORD);
    expect(forbidden(blocked)).toBe(true);
    expect(blocked.data.error).toContain("suspenso");

    expect((await call("PATCH", user(COORD), { suspended: false })).data.suspended).toBe(false);
    expect((await get("/api/me", COORD)).data).toMatchObject({ role: "coordinator", teams: [TEAM] });
    const actions = (await activity("?group=user")).items.map((i: any) => i.action);
    expect(actions.slice(0, 2)).toEqual(["user.reactivate", "user.suspend"]);
  });

  it("ninguém suspende a si mesmo; admin suspenso não age e pode ser removido", async () => {
    expect((await call("PATCH", user(ADMIN), { suspended: true })).status).toBe(400);
    expect((await call("PATCH", user(ADMIN2), { suspended: true })).status).toBe(200);
    expect(forbidden(await call("PATCH", user(ADMIN), { suspended: true }, ADMIN2))).toBe(true);
    // ADMIN é o único admin ativo agora, mas remover o suspenso não deixa o sistema sem admin
    expect((await call("DELETE", user(ADMIN2))).status).toBe(204);
  });

  it("pedido inválido: 400; e-mail não liberado: 404; coordenador: recusado", async () => {
    expect((await call("PATCH", user(COORD), { suspended: "sim" })).status).toBe(400);
    expect((await call("PATCH", user("ninguem@igreja.org"), { suspended: true })).status).toBe(404);
    expect(forbidden(await call("PATCH", user(ADMIN), { suspended: true }, COORD))).toBe(true);
  });
});

describe("regras para coordenadores", () => {
  const past = "2020-01-05"; // domingo que já passou

  it("começam liberadas e vêm no /api/me", async () => {
    expect((await get("/api/me", COORD)).data.rules).toEqual({ coordinators_edit_volunteers: true, lock_past_schedules: false });
  });

  it("só o admin muda; valor que não é sim/não: 400", async () => {
    expect(forbidden(await call("PUT", "/api/rules", { lock_past_schedules: true }, COORD))).toBe(true);
    expect((await call("PUT", "/api/rules", { lock_past_schedules: "sim" })).status).toBe(400);
  });

  it("cadastro travado: coordenador não cadastra nem altera, mas escreve observações", async () => {
    const r = await call("PUT", "/api/rules", { coordinators_edit_volunteers: false });
    expect(r.data).toEqual({ coordinators_edit_volunteers: false, lock_past_schedules: false });
    expect(forbidden(await call("PATCH", `/api/volunteers/${mine}`, { active: true }, COORD))).toBe(true);
    expect(forbidden(await call("POST", "/api/volunteers", { name: "Nova", gender: "Feminino", team: TEAM }, COORD))).toBe(true);
    expect((await call("POST", `/api/volunteers/${mine}/notes`, { body: "Ok" }, COORD)).status).toBe(201);
    // o admin continua alterando
    expect((await call("PATCH", `/api/volunteers/${mine}`, { active: true })).status).toBe(200);
    expect((await activity("?group=rules")).items[0].summary).toBe("Para coordenadores: travou o cadastro de voluntários.");
  });

  it("escalas passadas travadas: coordenador não grava culto que já passou; o futuro e o admin, sim", async () => {
    await call("PUT", "/api/rules", { lock_past_schedules: true });
    const body = { present_ids: [mine], assignments: [] };
    const blocked = await call("PUT", `/api/schedules/${past}/${TEAM}`, body, COORD);
    expect(forbidden(blocked)).toBe(true);
    expect(blocked.data.error).toContain("já passaram");
    expect((await call("PUT", `/api/schedules/2099-01-04/${TEAM}`, body, COORD)).status).toBe(200);
    expect((await call("PUT", `/api/schedules/${past}/${TEAM}`, body)).status).toBe(200);
    // a sugestão não grava nada: continua liberada
    expect((await call("POST", `/api/schedules/${past}/${TEAM}/suggestion`, body, COORD)).status).toBe(200);

    await call("PUT", "/api/rules", { coordinators_edit_volunteers: true, lock_past_schedules: false });
    expect((await call("PUT", `/api/schedules/${past}/${TEAM}`, body, COORD)).status).toBe(200);
  });
});

describe("atualização automática do banco", () => {
  it("os comandos da atualização são os mesmos do fim de db/schema.sql", () => {
    const flat = (s: string) => s.replace(/\s+/g, " ").trim();
    const schema = flat(SCHEMA.replace(/^\s*--.*$/gm, ""));
    for (const statement of UPGRADE) expect(schema).toContain(flat(statement));
  });

  it("banco da versão anterior: o primeiro pedido cria o que falta e funciona", async () => {
    const { sql: old } = await createTestDb({ schema: false });
    await applySchema(old, SCHEMA.slice(0, SCHEMA.indexOf("-- Observações sobre um voluntário")));
    await old`INSERT INTO app_users (email, role) VALUES (${ADMIN}, 'admin')`;
    const options = { sql: old, verify, accounts };

    const me = await call("GET", "/api/me", undefined, ADMIN, options);
    expect(me.status).toBe(200);
    const v = await call("POST", "/api/volunteers", { name: "Dani", gender: "Feminino", team: TEAM }, ADMIN, options);
    expect(v.status).toBe(201);
    expect((await call("POST", `/api/volunteers/${v.data.id}/notes`, { body: "Primeira" }, ADMIN, options)).status).toBe(201);
    expect((await call("GET", "/api/activity", undefined, ADMIN, options)).data.items).toHaveLength(2);
  });
});
