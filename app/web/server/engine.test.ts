/** Regras da escala (mesmos testes de app/tests/test_engine.py). */
import { describe, expect, it } from "vitest";
import { DEFAULT_POSITIONS, ENTRY_CATEGORIES, EXIT_CATEGORIES, MAP_CATEGORIES } from "./config.ts";
import { activePositions, buildSchedule, validate } from "./engine.ts";
import { emptyHistory, type GenerationResult, type HistoryContext, type Volunteer } from "./models.ts";

const POS = new Map(DEFAULT_POSITIONS.map((p) => [p.code, p]));
const SPARE_REC = DEFAULT_POSITIONS.filter((p) => p.category === "Recepcao");
const onMapOrRec = (c: string) => MAP_CATEGORIES.has(c) || c === "Recepcao";

/** Gerador simples e repetível (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeVolunteers(nF: number, nM: number, seed = 1): Volunteer[] {
  const rnd = rng(seed);
  return Array.from({ length: nF + nM }, (_, i) => {
    const gender = i < nF ? "Feminino" : "Masculino";
    return {
      id: i + 1,
      name: `V${String(i + 1).padStart(3, "0")}`,
      gender,
      team: "T",
      active: true,
      can_bercario: gender === "Feminino",
      can_cozinha: rnd() > 0.1,
      can_recepcao: true,
      can_banheiro: true,
      can_limpar_altar: true,
      observation: "",
    };
  });
}

function run(vols: Volunteer[], lastSunday = false, history: HistoryContext = emptyHistory()): GenerationResult {
  return buildSchedule(vols, activePositions(DEFAULT_POSITIONS, null), history, lastSunday, SPARE_REC);
}

const idsIn = (res: GenerationResult, test: (category: string) => boolean) =>
  new Set(res.assignments.filter((a) => test(a.category)).map((a) => a.volunteer_id));

function checkCommon(vols: Volunteer[], res: GenerationResult, lastSunday: boolean) {
  const by = new Map<number, string[]>();
  for (const a of res.assignments) by.set(a.volunteer_id, [...(by.get(a.volunteer_id) ?? []), a.category]);
  const V = new Map(vols.map((v) => [v.id, v]));
  expect(new Set(by.keys()), "alguém ficou de fora da escala").toEqual(new Set(V.keys()));
  for (const [vid, cats] of by) {
    const entries = cats.filter((c) => ENTRY_CATEGORIES.has(c));
    const exits = cats.filter((c) => EXIT_CATEGORIES.has(c));
    expect(entries.length, `${vid} com mais de uma entrada`).toBeLessThanOrEqual(1);
    expect(exits.length, `${vid} com mais de uma saída`).toBeLessThanOrEqual(1);
    expect(cats.filter(onMapOrRec).length, `${vid} fora do mapa`).toBe(1);
    if (cats.includes("Recepcao")) {
      expect(entries, "recepção em entrada").toEqual([]);
      if (lastSunday) expect(exits, "recepção em saída no último domingo").toEqual([]);
    }
  }
  for (const a of res.assignments) {
    const p = POS.get(a.position_code)!;
    if (p.allowed_gender !== "Qualquer") expect(V.get(a.volunteer_id)!.gender, a.position_code).toBe(p.allowed_gender);
  }
  expect(res.assignments.filter((a) => a.category === "Limpeza Altar")).toHaveLength(4);
  expect(res.assignments.filter((a) => a.category === "Limpeza Conf").length).toBeLessThanOrEqual(8);
  const kitchen = new Set(
    res.assignments.filter((a) => a.category === "Cozinha").map((a) => V.get(a.volunteer_id)!.gender),
  );
  expect(kitchen.size).toBeLessThanOrEqual(1);
  expect(validate(res.assignments, V, POS, lastSunday, undefined, new Set(V.keys()))).toEqual([]);
}

describe("regras da escala", () => {
  it("domingo normal", () => {
    for (const [nf, nm] of [[30, 15], [20, 10], [34, 17], [12, 6]]) {
      const vols = makeVolunteers(nf, nm);
      checkCommon(vols, run(vols), false);
    }
  });

  it("último domingo do mês", () => {
    for (const [nf, nm] of [[30, 15], [20, 10], [34, 17]]) {
      const vols = makeVolunteers(nf, nm);
      checkCommon(vols, run(vols, true), true);
    }
  });

  it("todo mundo fica no mapa ou na recepção", () => {
    const vols = makeVolunteers(34, 17); // 51 pessoas: mais que mapa (21) + 20 vagas da recepção
    const res = run(vols);
    expect(idsIn(res, onMapOrRec)).toEqual(new Set(vols.map((v) => v.id)));
    expect(res.assignments.filter((a) => a.category === "Recepcao")).toHaveLength(51 - 21);
    expect(res.warnings.some((w) => w.includes("vaga(s) a mais"))).toBe(true);
  });

  it("entradas só para quem está no mapa", () => {
    const res = run(makeVolunteers(28, 14));
    const onMap = idsIn(res, (c) => MAP_CATEGORIES.has(c));
    const entry = idsIn(res, (c) => ENTRY_CATEGORIES.has(c));
    expect([...entry].every((i) => onMap.has(i))).toBe(true);
    const fixed = res.assignments.filter((a) => ["BM", "BF"].includes(a.position_code)).map((a) => a.volunteer_id);
    expect(fixed.some((i) => entry.has(i))).toBe(false);
  });

  it("saídas vão primeiro para quem ainda não tem tarefa", () => {
    const vols = makeVolunteers(20, 10); // 30: recepção 9 + banheiros fixos 2 = 11 sem entrada, 16 saídas
    const withTask = idsIn(run(vols), (c) => ENTRY_CATEGORIES.has(c) || EXIT_CATEGORIES.has(c));
    expect(withTask).toEqual(new Set(vols.map((v) => v.id)));
  });

  it("quem não pode recepção vai para o mapa", () => {
    const vols = makeVolunteers(30, 15).map((v) => ([40, 41, 42].includes(v.id) ? { ...v, can_recepcao: false } : v));
    const onMap = idsIn(run(vols), (c) => MAP_CATEGORIES.has(c));
    expect([40, 41, 42].every((i) => onMap.has(i))).toBe(true);
  });

  it("a validação aponta saída duplicada e quem ficou de fora", () => {
    const vols = makeVolunteers(30, 15);
    const res = run(vols);
    const V = new Map(vols.map((v) => [v.id, v]));
    const conf = res.assignments.find((a) => a.category === "Confete")!;
    const kitchen = res.assignments.find((a) => a.category === "Cozinha")!;
    const edited = res.assignments.map((a) =>
      a === kitchen ? { ...a, volunteer_id: conf.volunteer_id, volunteer_name: conf.volunteer_name } : a,
    );
    const msgs = (issues: { message: string }[]) => issues.map((i) => i.message).join(" ");
    expect(msgs(validate(edited, V, POS, false))).toContain("mais de uma tarefa de saída");
    const dropped = res.assignments.filter((a) => a.volunteer_id !== 1);
    expect(msgs(validate(dropped, V, POS, false, undefined, new Set(V.keys())))).toContain("Fora da escala");
  });

  it("limpeza do altar com um só gênero, alternando", () => {
    const vols = makeVolunteers(30, 15);
    const altarGenders = (last: string) =>
      new Set(
        run(vols, false, emptyHistory({ last_altar_gender: last }))
          .assignments.filter((a) => a.category === "Limpeza Altar")
          .map((a) => vols[a.volunteer_id - 1].gender),
      );
    expect(altarGenders("Feminino")).toEqual(new Set(["Masculino"]));
    expect(altarGenders("Masculino")).toEqual(new Set(["Feminino"]));
  });

  it("rotatividade evita a mesma posição do mapa", () => {
    const vols = makeVolunteers(30, 15);
    const last = new Map<number, Set<string>>();
    for (const a of run(vols).assignments) {
      if (!last.has(a.volunteer_id)) last.set(a.volunteer_id, new Set());
      last.get(a.volunteer_id)!.add(a.position_code);
    }
    for (const a of run(vols, false, emptyHistory({ last_positions: last })).assignments) {
      if (a.category === "Corredor") expect(last.get(a.volunteer_id)?.has(a.position_code) ?? false).toBe(false);
    }
  });

  it("quem estava na recepção vai para o mapa no culto seguinte", () => {
    const vols = makeVolunteers(30, 15);
    const rec = idsIn(run(vols), (c) => c === "Recepcao");
    const corr = idsIn(run(vols, false, emptyHistory({ last_reception_ids: rec })), (c) => c === "Corredor");
    const both = [...rec].filter((i) => corr.has(i)).length;
    expect(both).toBeGreaterThanOrEqual(Math.min(rec.size, corr.size) - 2);
  });

  it("a validação aponta erros de edição manual", () => {
    const vols = makeVolunteers(30, 15);
    const res = run(vols);
    const V = new Map(vols.map((v) => [v.id, v]));
    const rec = res.assignments.find((a) => a.category === "Recepcao")!;
    const ent = res.assignments.find((a) => a.category === "Cadeiras Entrada")!;
    const edited = res.assignments.map((a) =>
      a === ent ? { ...a, volunteer_id: rec.volunteer_id, volunteer_name: rec.volunteer_name } : a,
    );
    expect(validate(edited, V, POS, false).map((i) => i.message).join(" ")).toContain("recepção");
  });
});
