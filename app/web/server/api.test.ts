/** API de ponta a ponta sobre um Postgres embutido: login, escala, voluntários e importação. */
import { beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./db.ts";
import { applyImport, buildImport, parseBaseSheet, type SourceData } from "./importer.ts";
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

async function call(path: string, body?: unknown, token: string | null = LEADER) {
  const res = await handle(
    new Request(`https://escala.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    opts,
  );
  return { status: res.status, data: (await res.json()) as any };
}

const TEAM = "Domingo_Manha_A";
const DATE = "2026-12-06"; // domingo comum
const NEXT = "2026-12-13";

beforeAll(async () => {
  sql = (await createTestDb()).sql;
  opts = { sql, verify, allowed: new Set([LEADER]) };
  for (let i = 1; i <= 36; i++) {
    const r = await call("/api/volunteer", {
      name: `Pessoa ${String(i).padStart(2, "0")}`,
      gender: i <= 22 ? "Feminino" : "Masculino",
      team: TEAM,
      can_bercario: i <= 22,
    });
    expect(r.status).toBe(200);
  }
});

describe("acesso", () => {
  it("sem token: 401", async () => {
    const r = await call("/api/init", undefined, null);
    expect(r.status).toBe(401);
    expect(r.data.code).toBe("unauthenticated");
    expect(r.data.error).toContain("login");
  });

  it("token inválido: 401", async () => {
    expect((await call("/api/init", undefined, "ruim")).status).toBe(401);
  });

  it("e-mail fora da lista: recusado, mesmo com conta válida", async () => {
    const r = await call("/api/volunteers", undefined, "curioso@gmail.com");
    expect(r.status).toBe(401);
    expect(r.data.code).toBe("forbidden");
    expect(r.data.volunteers).toBeUndefined();
  });

  it("e-mail da lista ainda não verificado: recusado", async () => {
    const r = await call("/api/init", undefined, `${LEADER}|nao`);
    expect(r.status).toBe(401);
    expect(r.data.code).toBe("unverified");
    expect(r.data.error).toContain("Confirme");
  });

  it("gravação também exige acesso", async () => {
    const r = await call("/api/volunteer", { name: "Intruso", gender: "Masculino" }, "curioso@gmail.com");
    expect(r.data.code).toBe("forbidden");
    expect((await call("/api/volunteers")).data.volunteers.some((v: any) => v.name === "Intruso")).toBe(false);
  });

  it("endereço do login é público e não traz nenhum dado", async () => {
    process.env.NEON_AUTH_BASE_URL = "https://auth.exemplo/neondb/auth";
    const r = await call("/api/config", undefined, null);
    expect(r).toEqual({ status: 200, data: { auth_url: "https://auth.exemplo/neondb/auth" } });
    delete process.env.NEON_AUTH_BASE_URL;
    expect((await call("/api/config", undefined, null)).data).toEqual({ auth_url: null });
  });

  it("rota que não existe: 404", async () => {
    expect((await call("/api/quit", {})).status).toBe(404);
  });
});

describe("escala", () => {
  let present: number[];

  it("init traz equipes, posições e as posições ativas padrão", async () => {
    const { data } = await call("/api/init");
    expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.teams).toContain(TEAM);
    expect(data.positions).toHaveLength(97);
    expect(data.default_active).toHaveLength(21 + 20 + 8 + 16 + 4 + 2 + 2 + 8);
  });

  it("dia sem escala salva", async () => {
    const { data } = await call(`/api/day?date=${DATE}&team=${TEAM}`);
    expect(data.weekday).toBe("Domingo");
    expect(data.last_sunday).toBe(false);
    expect(data.saved).toBeNull();
    expect(data.volunteers).toHaveLength(36);
    present = data.volunteers.map((v: any) => v.id).slice(0, 34);
  });

  it("gera, salva e lê de volta", async () => {
    const gen = await call("/api/generate", { date: DATE, team: TEAM, present_ids: present });
    expect(gen.status).toBe(200);
    expect(gen.data.issues).toEqual([]);
    const placed = new Set(gen.data.assignments.map((a: any) => a.volunteer_id));
    expect(placed).toEqual(new Set(present));

    const absent = (await call(`/api/day?date=${DATE}&team=${TEAM}`)).data.volunteers
      .map((v: any) => v.id)
      .filter((id: number) => !present.includes(id));
    const body = {
      date: DATE,
      team: TEAM,
      present_ids: present,
      active_codes: ["01", "02", "R01"],
      assignments: gen.data.assignments,
      absent_reasons: { [absent[0]]: "viagem" },
    };
    const saved = await call("/api/save", body);
    expect(saved.status).toBe(200);
    expect(saved.data.saved_at).toMatch(/^\d{2}:\d{2}:\d{2}$/);

    const { data } = await call(`/api/day?date=${DATE}&team=${TEAM}`);
    expect(data.saved.assignments).toEqual(gen.data.assignments);
    expect(data.saved.absent_ids).toEqual(absent);
    expect(data.saved.absent_reasons).toEqual({ [absent[0]]: "viagem" });
    expect(data.saved.active_codes).toEqual(["01", "02", "R01"]);
    expect(data.saved.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(data.volunteers.find((v: any) => v.id === absent[0]).faltas).toBe(1);
  });

  it("salvar de novo substitui a escala do mesmo dia e equipe", async () => {
    const gen = await call("/api/generate", { date: DATE, team: TEAM, present_ids: present });
    await call("/api/save", { date: DATE, team: TEAM, present_ids: present, assignments: gen.data.assignments });
    const { data } = await call(`/api/history?team=${TEAM}`);
    expect(data.schedules).toHaveLength(1);
    expect(data.kpis).toMatchObject({ escalas: 1, faltas: 2, ativos: 36, com_faltas: 2 });
    const [count] = await sql`SELECT COUNT(*)::int AS n FROM schedule_items`;
    expect(count.n).toBe(gen.data.assignments.length);
  });

  it("no culto seguinte ninguém repete a posição do mapa e a equipe sugerida é a última usada", async () => {
    const before = (await call(`/api/day?date=${DATE}&team=${TEAM}`)).data.saved.assignments;
    const last = new Map(before.map((a: any) => [`${a.volunteer_id}:${a.position_code}`, true]));
    const day = await call(`/api/day?date=${NEXT}`);
    expect(day.data.team).toBe(TEAM);
    const gen = await call("/api/generate", { date: NEXT, team: TEAM, present_ids: present });
    for (const a of gen.data.assignments) {
      if (a.category === "Corredor") expect(last.has(`${a.volunteer_id}:${a.position_code}`)).toBe(false);
    }
  });

  it("valida edição manual", async () => {
    const saved = (await call(`/api/day?date=${DATE}&team=${TEAM}`)).data.saved.assignments;
    const edited = saved.slice(1);
    const { data } = await call("/api/validate", { date: DATE, team: TEAM, present_ids: present, assignments: edited });
    expect(data.issues.length).toBeGreaterThan(0);
  });

  it("posições padrão ficam guardadas", async () => {
    await call("/api/positions/default", { codes: ["02", "01", "01", "R01"] });
    expect((await call("/api/init")).data.default_active).toEqual(["01", "02", "R01"]);
  });

  it("entradas inválidas viram erro 400 com mensagem", async () => {
    expect((await call("/api/day?date=31-12-2026")).status).toBe(400);
    expect((await call("/api/generate", { date: DATE, team: TEAM, present_ids: "todos" })).status).toBe(400);
    expect((await call("/api/volunteer", { name: "  ", gender: "Feminino" })).status).toBe(400);
  });
});

describe("voluntários", () => {
  it("edita, e nome repetido é recusado com mensagem clara", async () => {
    const { data } = await call(`/api/volunteers?team=${TEAM}`);
    const v = data.volunteers[0];
    expect(v.vezes).toBe(1);
    const edit = await call("/api/volunteer", { ...v, active: false, observation: "  só até as 10h " });
    expect(edit.data.id).toBe(v.id);
    const after = (await call("/api/volunteers")).data.volunteers.find((x: any) => x.id === v.id);
    expect(after).toMatchObject({ active: false, observation: "só até as 10h" });

    const dup = await call("/api/volunteer", { name: data.volunteers[1].name, gender: "Feminino" });
    expect(dup.status).toBe(400);
    expect(dup.data.error).toContain("Já existe");
  });
});

describe("carga inicial", () => {
  const source: SourceData = {
    volunteers: [
      { id: 7, name: "Ana", gender: "Feminino", team: "Domingo_Manha_A", active: 1, observation: "obs", can_bercario: 1, can_cozinha: 0, can_recepcao: 1, can_banheiro: 1, can_limpar_altar: 1 },
      { id: 9, name: "Beto", gender: "Masculino", team: "Domingo_Manha_A", active: 0, observation: null, can_bercario: 0, can_cozinha: 1, can_recepcao: 1, can_banheiro: 1, can_limpar_altar: 1 },
    ],
    history_seed: [],
    history_position_seed: [],
    schedules: [{ id: 3, service_date: "2026-11-15", service_type: "Domingo", team: "Domingo_Manha_A", notes: "", status: "finalizada", active_codes: '["01","02"]', created_at: "2026-11-15 12:00:00" }],
    schedule_items: [
      { id: 1, schedule_id: 3, position_code: "01", position_name: "Corredor 01", category: "Corredor", volunteer_id: 7, volunteer_name: "Ana", item_order: 1 },
      { id: 2, schedule_id: 3, position_code: "02", position_name: "Corredor 02", category: "Corredor", volunteer_id: 99, volunteer_name: "Apagado", item_order: 2 },
    ],
    presence: [
      { id: 1, schedule_id: 3, volunteer_id: 7, confirmed: 1, absent: 0, justification: null },
      { id: 2, schedule_id: 3, volunteer_id: 9, confirmed: 0, absent: 1, justification: "doente" },
    ],
    app_meta: [
      { key: "faltas_planilha", value: '{"Ana": ""}' },
      { key: "posicoes_padrao", value: '["01","02"]' },
    ],
  };
  const sheet = parseBaseSheet([
    ["Equipe", "Voluntarios", "Genero", "Falta", "Total_Faltas", "Cozinha", "POS_BM", "POS_3"],
    ["Domingo_Noite_A", "Ana", "feminino", "Sim", 2, 1, null, 4],
    ["domingo noite a", " Caio  Lima ", "Masc", null, 0, 3, 2, 5],
    [null, "Falta", null, null, null, null, null, null],
    ["Domingo_Manha_A", "Sem Genero", null, null, null, null, null, null],
  ]);

  it("lê a aba BASE_TAREFAS", () => {
    expect(sheet).toEqual([
      { name: "Ana", gender: "Feminino", team: "Domingo_Noite_A", category_counts: { Cozinha: 1, Corredor: 4 }, position_counts: { "03": ["Corredor", 4] } },
      { name: "Caio Lima", gender: "Masculino", team: "Domingo_Noite_A", category_counts: { Cozinha: 3, Banheiro: 2, Corredor: 5 }, position_counts: { BM: ["Banheiro", 2], "03": ["Corredor", 5] } },
    ]);
  });

  it("SQLite + planilha: preserva ids, atualiza equipe, cria quem falta e não conta histórico em dobro", async () => {
    const db = (await createTestDb()).sql;
    const plan = buildImport(source, sheet);
    const counts = await applyImport(db, plan);
    expect(counts).toEqual({ volunteers: 3, history_seed: 0, history_position_seed: 0, schedules: 1, schedule_items: 1, presence: 2, app_meta: 1 });
    expect(plan.notes.join(" ")).toContain("1 registro(s)");

    const vols = await db`SELECT id, name, team, active, can_cozinha FROM volunteers ORDER BY id`;
    expect(vols).toEqual([
      { id: 7, name: "Ana", team: "Domingo_Noite_A", active: true, can_cozinha: false },
      { id: 9, name: "Beto", team: "Domingo_Manha_A", active: false, can_cozinha: true },
      { id: 10, name: "Caio Lima", team: "Domingo_Noite_A", active: true, can_cozinha: true },
    ]);
    // o próximo voluntário criado pelo sistema continua a numeração
    const [created] = await db`INSERT INTO volunteers (name, gender) VALUES ('Novo', 'Masculino') RETURNING id`;
    expect(created.id).toBe(11);
    const [meta] = await db`SELECT key, value FROM app_meta`;
    expect(meta).toEqual({ key: "posicoes_padrao", value: ["01", "02"] });

    await expect(applyImport(db, plan)).rejects.toThrow("--force");
    await expect(applyImport(db, plan, { force: true })).resolves.toMatchObject({ volunteers: 3 });
  });

  it("só a planilha: as contagens viram histórico", async () => {
    const db = (await createTestDb()).sql;
    const counts = await applyImport(db, buildImport(null, sheet));
    expect(counts).toMatchObject({ volunteers: 2, history_seed: 5, history_position_seed: 3, schedules: 0 });
  });
});
