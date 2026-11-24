/** API REST de ponta a ponta sobre um Postgres embutido: login, escala, e voluntários. */
import { beforeAll, describe, expect, it } from "vitest";
import { FACTORY_ACTIVE, POSITIONS } from "../shared/catalog.ts";
import type { Accounts } from "./accounts.ts";
import { setMeta, type Sql } from "./db.ts";
import { handle, type HandleOptions } from "./routes.ts";
import { createTestDb } from "./testdb.ts";

const LEADER = "lider@igreja.org";
let sql: Sql;
let opts: HandleOptions;

/** Token de teste no formato "email|verificado". */
const verify = async (token: string) => {
  if (token === "ruim") throw new Error("assinatura inválida");
  const [email, verified] = token.split("|");
  return { sub: `id-${email}`, email, emailVerified: verified !== "nao" };
};

async function call(method: string, path: string, body?: unknown, token: string | null = LEADER) {
  const res = await handle(
    new Request(`https://escala.test${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    opts,
  );
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as any, cache: res.headers.get("cache-control") };
}

const get = (path: string, token: string | null = LEADER) => call("GET", path, undefined, token);

const TEAM = "Domingo_Manha_A";
const DATE = "2026-12-06"; // domingo comum
const NEXT = "2026-12-13";

/** Endereço da folha (e da escala) de um culto. */
const sheet = (date: string, team?: string) => `/api/schedules/${date}${team ? `/${team}` : ""}`;
const userPath = (email: string) => `/api/users/${encodeURIComponent(email)}`;

/** Contas de login de mentira: gravam na tabela neon_auth."user" do banco de teste. */
const createdPasswords = new Map<string, string>();
const accounts: Accounts = {
  async create(db, { email, name, password }) {
    if ((await db`SELECT 1 FROM neon_auth."user" WHERE lower(email) = ${email}`).length) return false;
    await db`INSERT INTO neon_auth."user" (name, email, "emailVerified") VALUES (${name}, ${email}, true)`;
    createdPasswords.set(email, password);
    return true;
  },
  async remove(db, email) {
    await db`DELETE FROM neon_auth."user" WHERE lower(email) = ${email}`;
    createdPasswords.delete(email);
  },
};
const PASSWORD = /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/;

beforeAll(async () => {
  sql = (await createTestDb()).sql;
  opts = { sql, verify, accounts };
  await sql`INSERT INTO app_users (email, role) VALUES (${LEADER}, 'admin')`;
  for (let i = 1; i <= 36; i++) {
    const r = await call("POST", "/api/volunteers", {
      name: `Pessoa ${String(i).padStart(2, "0")}`,
      gender: i <= 22 ? "Feminino" : "Masculino",
      team: TEAM,
      can_bercario: i <= 22,
    });
    expect(r.status).toBe(201);
  }
});

describe("acesso", () => {
  it("sem token: 401", async () => {
    const r = await get("/api/me", null);
    expect(r.status).toBe(401);
    expect(r.data.code).toBe("unauthenticated");
    expect(r.data.error).toContain("login");
  });

  it("token inválido: 401", async () => {
    expect((await get("/api/me", "ruim")).status).toBe(401);
  });

  it("e-mail fora da lista: recusado, mesmo com conta válida", async () => {
    const r = await get("/api/volunteers", "curioso@gmail.com");
    expect(r.status).toBe(401);
    expect(r.data.code).toBe("forbidden");
    expect(Object.keys(r.data).sort()).toEqual(["code", "error"]);
  });

  it("e-mail da lista ainda não verificado: recusado", async () => {
    const r = await get("/api/me", `${LEADER}|nao`);
    expect(r.status).toBe(401);
    expect(r.data.code).toBe("unverified");
    expect(r.data.error).toContain("Confirme");
  });

  it("gravação também exige acesso", async () => {
    const r = await call("POST", "/api/volunteers", { name: "Intruso", gender: "Masculino" }, "curioso@gmail.com");
    expect(r.data.code).toBe("forbidden");
    expect((await get("/api/volunteers")).data.some((v: any) => v.name === "Intruso")).toBe(false);
  });

  it("endereço do login é público e não traz nenhum dado", async () => {
    process.env.NEON_AUTH_BASE_URL = "https://auth.exemplo/neondb/auth";
    const r = await get("/api/config", null);
    expect(r).toEqual({ status: 200, data: { auth_url: "https://auth.exemplo/neondb/auth" }, cache: "no-store" });
    delete process.env.NEON_AUTH_BASE_URL;
    expect(await get("/api/config", null)).toEqual({ status: 200, data: { auth_url: null }, cache: "no-store" });
  });

  it("as respostas nunca ficam em cache no navegador", async () => {
    expect((await get("/api/volunteers")).cache).toBe("no-store");
  });

  it("endereço ou verbo que não existe: 404", async () => {
    expect((await call("POST", "/api/quit", {})).status).toBe(404);
    expect((await call("POST", "/api/save", {})).status).toBe(404); // rota do contrato antigo
    expect((await call("DELETE", "/api/volunteers/1")).status).toBe(404);
  });
});

describe("acessos: admin e coordenador", () => {
  const COORD = "coordenador@igreja.org";
  const OTHER = "Domingo_Noite_A";
  const WED = "Quarta-Feira_Noite_A";
  const summary = async () =>
    (await get("/api/users")).data.map((u: any) => `${u.email}:${u.role}:${u.teams.join("+")}`);
  const forbidden = (r: any) => r.status === 401 && r.data.code === "forbidden";
  let outsiderId: number;

  it("/api/me informa quem está logado, o papel e as equipes", async () => {
    const { data } = await get("/api/me");
    expect(data).toMatchObject({ email: LEADER, role: "admin" });
    expect(data.teams.length).toBeGreaterThanOrEqual(6);
    const created = await call("POST", "/api/volunteers", { name: "De Outra Equipe", gender: "Feminino", team: OTHER });
    expect(created.data).toMatchObject({ name: "De Outra Equipe", team: OTHER, active: true });
    outsiderId = created.data.id;
  });

  it("coordenador só é liberado com pelo menos uma equipe válida", async () => {
    expect(forbidden(await get("/api/me", COORD))).toBe(true);
    expect((await call("PUT", userPath(COORD), { role: "coordinator" })).status).toBe(400);
    expect((await call("PUT", userPath(COORD), { role: "coordinator", teams: [] })).status).toBe(400);
    expect((await call("PUT", userPath(COORD), { role: "coordinator", teams: ["Equipe Inventada"] })).status).toBe(400);
    expect((await call("PUT", userPath(COORD), { role: "member", teams: [TEAM] })).status).toBe(400);

    // as tentativas recusadas não criaram conta de login
    expect(createdPasswords.size).toBe(0);

    const r = await call("PUT", userPath(`  ${COORD.toUpperCase()} `), {
      name: "  Fulana   de Tal ",
      role: "coordinator",
      teams: [WED, TEAM, TEAM],
    });
    expect(r.status).toBe(201); // acesso novo
    // a conta de login é criada junto, já confirmada, e a senha aleatória volta para o admin
    expect(r.data.user).toMatchObject({
      email: COORD,
      role: "coordinator",
      teams: [TEAM, WED],
      created_by: LEADER,
      name: "Fulana de Tal",
      has_account: true,
      verified: true,
    });
    expect(r.data.user.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(r.data.password).toMatch(PASSWORD);
    expect(createdPasswords.get(COORD)).toBe(r.data.password);
    expect(await summary()).toEqual([`${LEADER}:admin:`, `${COORD}:coordinator:${TEAM}+${WED}`]);
  });

  it("a senha só é mostrada na criação; mudar papel ou equipes não gera outra", async () => {
    const first = createdPasswords.get(COORD);
    const edit = await call("PUT", userPath(COORD), { role: "coordinator", teams: [TEAM, WED] });
    expect(edit.status).toBe(200); // acesso que já existia
    expect(edit.data.password).toBeNull();
    expect(createdPasswords.get(COORD)).toBe(first);
  });

  it("admin gera uma senha nova para quem já está liberado", async () => {
    const first = createdPasswords.get(COORD);
    const r = await call("POST", `${userPath(COORD)}/password`);
    expect(r.status).toBe(201);
    expect(r.data.password).toMatch(PASSWORD);
    expect(r.data.password).not.toBe(first);
    expect(createdPasswords.get(COORD)).toBe(r.data.password);
    // a conta continua existindo, com o mesmo nome, e o acesso não mudou
    expect(r.data.user).toMatchObject({ email: COORD, name: "Fulana de Tal", has_account: true, role: "coordinator" });
    // não vale para si mesmo nem para quem não está liberado
    expect((await call("POST", `${userPath(LEADER)}/password`)).status).toBe(400);
    expect((await call("POST", `${userPath("estranho@gmail.com")}/password`)).status).toBe(404);
  });

  it("as senhas geradas não se repetem", async () => {
    const { generatePassword } = await import("./accounts.ts");
    const many = new Set(Array.from({ length: 500 }, generatePassword));
    expect(many.size).toBe(500);
    for (const p of many) expect(p).toMatch(PASSWORD);
  });

  it("coordenador só recebe as equipes dele", async () => {
    const { data } = await get("/api/me", COORD);
    expect(data).toMatchObject({ email: COORD, role: "coordinator", teams: [TEAM, WED] });
    // sem equipe no endereço, quarta-feira sugere a equipe de quarta dele
    expect((await get(sheet("2026-12-09"), COORD)).data.team).toBe(WED);
  });

  it("coordenador vê a equipe dele e a API recusa as outras", async () => {
    const own = await get(sheet(DATE, TEAM), COORD);
    expect(own.status).toBe(200);
    expect(own.data.volunteers).toHaveLength(36);

    const other = await get(sheet(DATE, OTHER), COORD);
    expect(forbidden(other)).toBe(true);
    expect(other.data.volunteers).toBeUndefined();
    for (const path of ["/api/volunteers", "/api/history", "/api/schedules"]) {
      expect(forbidden(await get(`${path}?team=${OTHER}`, COORD))).toBe(true);
    }

    // sem filtro, só vem o que é das equipes dele
    const vols = (await get("/api/volunteers", COORD)).data;
    expect(vols).toHaveLength(36);
    expect(vols.some((v: any) => v.id === outsiderId)).toBe(false);
    const hist = (await get("/api/history", COORD)).data;
    expect(hist).toHaveLength(36);
    expect(hist.every((r: any) => r.team === TEAM)).toBe(true);
    // o admin continua vendo tudo
    expect((await get("/api/volunteers")).data.some((v: any) => v.id === outsiderId)).toBe(true);
    expect((await get("/api/history")).data.some((r: any) => r.id === outsiderId)).toBe(true);
    expect((await get(`/api/volunteers?team=${OTHER}`)).data.map((v: any) => v.id)).toEqual([outsiderId]);
  });

  it("coordenador não gera nem salva escala de outra equipe", async () => {
    const mine = (await get(sheet(DATE, TEAM), COORD)).data.volunteers.map((v: any) => v.id);
    const body = { present_ids: [outsiderId], assignments: [] };
    expect(forbidden(await call("POST", `${sheet(DATE, OTHER)}/suggestion`, body, COORD))).toBe(true);
    expect(forbidden(await call("PUT", sheet(DATE, OTHER), body, COORD))).toBe(true);
    // na equipe dele, mas com gente de fora
    const mixed = await call("PUT", sheet("2027-02-07", TEAM), { present_ids: [...mine, outsiderId], assignments: [] }, COORD);
    expect(mixed.status).toBe(400);
    expect(mixed.data.error).toContain("não são desta equipe");
    const [saved] = await sql`SELECT COUNT(*)::int AS n FROM schedules`;
    expect(saved.n).toBe(0);
    // na equipe dele, funciona (e gerar não grava nada)
    const gen = await call("POST", `${sheet(DATE, TEAM)}/suggestion`, { present_ids: mine }, COORD);
    expect(gen.status).toBe(200);
    expect(gen.data.assignments.length).toBeGreaterThan(36);
    expect((await sql`SELECT COUNT(*)::int AS n FROM schedules`)[0].n).toBe(0);
  });

  it("coordenador não cadastra nem altera voluntário de outra equipe", async () => {
    expect(forbidden(await call("POST", "/api/volunteers", { name: "Novo De Fora", gender: "Masculino", team: OTHER }, COORD))).toBe(true);
    // não pode puxar para a equipe dele alguém de outra
    expect(forbidden(await call("PATCH", `/api/volunteers/${outsiderId}`, { team: TEAM }, COORD))).toBe(true);
    expect(forbidden(await call("PATCH", `/api/volunteers/${outsiderId}`, { active: false }, COORD))).toBe(true);
    const [still] = await sql`SELECT team, active FROM volunteers WHERE id = ${outsiderId}`;
    expect(still).toEqual({ team: OTHER, active: true });
    // nem mandar para fora alguém da equipe dele
    const own = (await get(`/api/volunteers?team=${TEAM}`, COORD)).data[0];
    expect(forbidden(await call("PATCH", `/api/volunteers/${own.id}`, { team: OTHER }, COORD))).toBe(true);
    // na própria equipe pode editar
    expect((await call("PATCH", `/api/volunteers/${own.id}`, { observation: "" }, COORD)).status).toBe(200);
  });

  it("posições padrão do coordenador valem só para a equipe dele", async () => {
    expect(forbidden(await call("PUT", `/api/teams/${OTHER}/positions`, { codes: ["01"] }, COORD))).toBe(true);
    const saved = await call("PUT", `/api/teams/${WED}/positions`, { codes: ["R02", "03", "03", "NAO_EXISTE"] }, COORD);
    expect(saved).toMatchObject({ status: 200, data: { codes: ["03", "R02"] } });
    expect((await get(sheet("2026-12-09", WED), COORD)).data.default_active).toEqual(["03", "R02"]);
    // as outras equipes continuam com o padrão de fábrica
    expect((await get(sheet(DATE, TEAM))).data.default_active).toEqual(FACTORY_ACTIVE);
  });

  it("coordenador não vê nem altera os acessos", async () => {
    for (const r of [
      await get("/api/users", COORD),
      await call("PUT", userPath("amigo@gmail.com"), { role: "admin" }, COORD),
      await call("DELETE", userPath(LEADER), undefined, COORD),
      await call("POST", `${userPath(LEADER)}/password`, undefined, COORD),
    ]) {
      expect(forbidden(r)).toBe(true);
      expect(Object.keys(r.data).sort()).toEqual(["code", "error"]);
    }
    expect(await summary()).toEqual([`${LEADER}:admin:`, `${COORD}:coordinator:${TEAM}+${WED}`]);
  });

  it("o último admin não pode ser rebaixado nem removido, nem tirar o próprio acesso", async () => {
    expect((await call("PUT", userPath(LEADER), { role: "coordinator", teams: [TEAM] })).status).toBe(400);
    expect((await call("DELETE", userPath(LEADER))).status).toBe(400);

    await call("PUT", userPath(COORD), { role: "admin" });
    const promoted = (await get("/api/me", COORD)).data;
    expect(promoted.role).toBe("admin");
    expect(promoted.teams).toContain(OTHER); // admin recebe todas as equipes
    // com dois admins: um rebaixa o outro, mas ninguém rebaixa a si mesmo
    expect((await call("PUT", userPath(LEADER), { role: "coordinator", teams: [TEAM] })).status).toBe(400);
    expect((await call("PUT", userPath(LEADER), { role: "coordinator", teams: [TEAM] }, COORD)).status).toBe(200);
    expect((await call("PUT", userPath(COORD), { role: "coordinator", teams: [TEAM] }, COORD)).status).toBe(400);
    expect((await call("PUT", userPath(LEADER), { role: "admin" }, COORD)).status).toBe(200);
    expect((await call("PUT", userPath(COORD), { role: "coordinator", teams: [TEAM, WED] })).status).toBe(200);
  });

  it("coordenador sem equipe (registro antigo) não entra", async () => {
    await sql`INSERT INTO app_users (email, role) VALUES ('antigo@igreja.org', 'coordinator')`;
    const r = await get("/api/me", "antigo@igreja.org");
    expect(forbidden(r)).toBe(true);
    expect(r.data.error).toContain("equipe");
    await sql`DELETE FROM app_users WHERE email = 'antigo@igreja.org'`;
  });

  it("remover o acesso bloqueia a pessoa na hora", async () => {
    const r = await call("DELETE", userPath(COORD));
    expect(r).toMatchObject({ status: 204, data: null });
    expect(await summary()).toEqual([`${LEADER}:admin:`]);
    expect(forbidden(await get("/api/volunteers", COORD))).toBe(true);
    // remover de novo não é erro: o resultado é o mesmo
    expect((await call("DELETE", userPath(COORD))).status).toBe(204);
  });

  it("e-mail ou papel inválido: 400", async () => {
    expect((await call("PUT", userPath("sem-arroba"), { role: "admin" })).status).toBe(400);
    expect((await call("PUT", userPath("a@b.co"), { role: "dono" })).status).toBe(400);
  });
});

describe("escala", () => {
  let present: number[];
  const suggest = (date: string, body: unknown) => call("POST", `${sheet(date, TEAM)}/suggestion`, body);

  it("as posições são fixas e vêm do catálogo, não da API", () => {
    expect(POSITIONS).toHaveLength(97);
    expect(FACTORY_ACTIVE).toHaveLength(21 + 20 + 8 + 16 + 4 + 2 + 2 + 8);
  });

  it("folha de um culto sem escala salva", async () => {
    const { data } = await get(sheet(DATE, TEAM));
    expect(data).toMatchObject({ date: DATE, weekday: "Domingo", last_sunday: false, team: TEAM, saved: null, issues: [] });
    expect(data.volunteers).toHaveLength(36);
    expect(data.volunteers[0].faltas).toBe(0);
    expect(data.volunteers[0].vezes).toBeUndefined(); // a folha leva só o que a tela da escala usa
    expect(data.default_active).toEqual(FACTORY_ACTIVE);
    present = data.volunteers.map((v: any) => v.id).slice(0, 34);
  });

  it("gera, salva e lê de volta", async () => {
    const gen = await suggest(DATE, { present_ids: present });
    expect(gen.status).toBe(200);
    expect(gen.data.issues).toEqual([]);
    const placed = new Set(gen.data.assignments.map((a: any) => a.volunteer_id));
    expect(placed).toEqual(new Set(present));

    const absent = (await get(sheet(DATE, TEAM))).data.volunteers
      .map((v: any) => v.id)
      .filter((id: number) => !present.includes(id));
    const saved = await call("PUT", sheet(DATE, TEAM), {
      present_ids: present,
      active_codes: ["01", "02", "R01"],
      assignments: gen.data.assignments,
      absent_reasons: { [absent[0]]: "viagem" },
    });
    expect(saved.status).toBe(200);
    expect(saved.data.id).toBeGreaterThan(0);
    expect(saved.data.saved_at).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(saved.data.issues).toEqual([]); // gravar já confere as regras

    const { data } = await get(sheet(DATE, TEAM));
    expect(data.saved.assignments).toEqual(gen.data.assignments);
    expect(data.saved.absent_ids).toEqual(absent);
    expect(data.saved.absent_reasons).toEqual({ [absent[0]]: "viagem" });
    expect(data.saved.active_codes).toEqual(["01", "02", "R01"]);
    expect(data.saved.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(data.issues).toEqual([]);
    expect(data.volunteers.find((v: any) => v.id === absent[0]).faltas).toBe(1);
    const listed = (await get(`/api/volunteers?team=${TEAM}`)).data;
    expect(listed.find((v: any) => v.id === present[0])).toMatchObject({ faltas: 0, vezes: 1, ultima_vez: DATE });
    expect(listed.find((v: any) => v.id === absent[0])).toMatchObject({ faltas: 1, vezes: 0, ultima_vez: null });
  });

  it("salvar de novo substitui a escala do mesmo dia e equipe", async () => {
    const gen = await suggest(DATE, { present_ids: present });
    await call("PUT", sheet(DATE, TEAM), { present_ids: present, assignments: gen.data.assignments });
    const { data } = await get(`/api/schedules?team=${TEAM}`);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ service_date: DATE, service_type: "Domingo", team: TEAM, faltas: 2 });
    expect(data[0].itens).toBe(gen.data.assignments.length);
    const [count] = await sql`SELECT COUNT(*)::int AS n FROM schedule_items`;
    expect(count.n).toBe(gen.data.assignments.length);
  });

  it("histórico: só ativos, só as colunas em que a pessoa serviu, com as faltas", async () => {
    const { data } = await get(`/api/history?team=${TEAM}`);
    expect(data).toHaveLength(36);
    const absentees = data.filter((r: any) => r.faltas > 0);
    expect(absentees).toHaveLength(2);
    expect(absentees[0]).toMatchObject({ faltas: 1, counts: {}, absences: [{ date: DATE, team: TEAM, reason: "" }] });
    const served = data.find((r: any) => r.id === present[0]);
    expect(served).toMatchObject({ faltas: 0, absences: [] });
    // cada posição do mapa conta uma vez, e não vem coluna zerada
    const columns = Object.entries(served.counts as Record<string, number>);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every(([column, n]) => n === 1 && /^(POS_|Cozinha|Confete|Banheiro|Limpeza|Recepção)/.test(column))).toBe(true);
  });

  it("no culto seguinte ninguém repete a posição do mapa e a equipe sugerida é a última usada", async () => {
    const before = (await get(sheet(DATE, TEAM))).data.saved.assignments;
    const last = new Map(before.map((a: any) => [`${a.volunteer_id}:${a.position_code}`, true]));
    expect((await get(sheet(NEXT))).data.team).toBe(TEAM);
    const gen = await suggest(NEXT, { present_ids: present });
    for (const a of gen.data.assignments) {
      if (a.category === "Corredor") expect(last.has(`${a.volunteer_id}:${a.position_code}`)).toBe(false);
    }
  });

  it("edição manual que quebra regra é gravada e as regras quebradas voltam na resposta", async () => {
    const full = (await get(sheet(DATE, TEAM))).data.saved.assignments;
    const edited = await call("PUT", sheet(DATE, TEAM), { present_ids: present, assignments: full.slice(1) });
    expect(edited.status).toBe(200);
    expect(edited.data.issues.length).toBeGreaterThan(0);
    // quem abre a folha depois recebe as mesmas regras quebradas, sem outro pedido
    expect((await get(sheet(DATE, TEAM))).data.issues).toEqual(edited.data.issues);
    // corrigindo, somem
    const fixed = await call("PUT", sheet(DATE, TEAM), { present_ids: present, assignments: full });
    expect(fixed.data.issues).toEqual([]);
  });

  it("posições padrão: a equipe guarda as suas; sem elas vale o padrão geral antigo", async () => {
    await setMeta(sql, "posicoes_padrao", ["02", "01", "R01", "NAO_EXISTE"]); // herdado do programa antigo
    expect((await get(sheet(DATE, TEAM))).data.default_active).toEqual(["02", "01", "R01"]);
    const saved = await call("PUT", `/api/teams/${TEAM}/positions`, { codes: ["05", "04", "04"] });
    expect(saved.data).toEqual({ codes: ["04", "05"] });
    expect((await get(sheet(DATE, TEAM))).data.default_active).toEqual(["04", "05"]);
  });

  it("entradas inválidas viram erro 400 com mensagem", async () => {
    expect((await get(sheet("31-12-2026"))).status).toBe(400);
    expect((await suggest(DATE, { present_ids: "todos" })).status).toBe(400);
    expect((await call("PUT", sheet(DATE, TEAM), { assignments: "nenhuma" })).status).toBe(400);
    expect((await call("PUT", sheet(DATE, TEAM), [1, 2])).status).toBe(400); // corpo precisa ser um objeto
    expect((await call("POST", "/api/volunteers", { name: "  ", gender: "Feminino" })).status).toBe(400);
  });
});

describe("voluntários", () => {
  it("altera só os campos enviados", async () => {
    const { data } = await get(`/api/volunteers?team=${TEAM}`);
    const v = data[0];
    expect(v.vezes).toBe(1);
    const edit = await call("PATCH", `/api/volunteers/${v.id}`, { active: false, observation: "  só até as 10h " });
    expect(edit.status).toBe(200);
    expect(edit.data).toEqual({
      id: v.id,
      name: v.name,
      gender: v.gender,
      team: v.team,
      active: false,
      can_bercario: v.can_bercario,
      can_cozinha: v.can_cozinha,
      can_recepcao: v.can_recepcao,
      can_banheiro: v.can_banheiro,
      can_limpar_altar: v.can_limpar_altar,
      observation: "só até as 10h",
    });
    const after = (await get("/api/volunteers")).data.find((x: any) => x.id === v.id);
    expect(after).toMatchObject({ active: false, observation: "só até as 10h", vezes: 1 });
    // um interruptor da lista manda só o campo dele
    const toggled = await call("PATCH", `/api/volunteers/${v.id}`, { can_cozinha: false });
    expect(toggled.data).toMatchObject({ can_cozinha: false, active: false, observation: "só até as 10h" });
    // inativo sai do histórico, mas continua no cadastro
    expect((await get(`/api/history?team=${TEAM}`)).data.some((r: any) => r.id === v.id)).toBe(false);
  });

  it("nome repetido é recusado com mensagem clara, ao criar e ao alterar", async () => {
    const { data } = await get(`/api/volunteers?team=${TEAM}`);
    const dup = await call("POST", "/api/volunteers", { name: data[1].name, gender: "Feminino" });
    expect(dup.status).toBe(400);
    expect(dup.data.error).toContain("Já existe");
    const renamed = await call("PATCH", `/api/volunteers/${data[0].id}`, { name: data[1].name });
    expect(renamed.status).toBe(400);
    expect(renamed.data.error).toContain("Já existe");
    expect((await call("PATCH", `/api/volunteers/${data[0].id}`, { name: "   " })).status).toBe(400);
  });

  it("voluntário que não existe: 404", async () => {
    expect((await call("PATCH", "/api/volunteers/999999", { active: false })).status).toBe(404);
    expect((await call("PATCH", "/api/volunteers/abc", { active: false })).status).toBe(404);
  });
});
