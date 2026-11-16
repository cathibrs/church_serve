/**
 * Paridade com o motor antigo em Python: os casos de fixtures/parity.json foram
 * calculados por app/escala/engine.py (ver scripts/gen_parity.py) e o motor em
 * TypeScript tem de devolver exatamente o mesmo.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_POSITIONS } from "./config.ts";
import { activePositions, buildSchedule, validate } from "./engine.ts";
import type { Assignment, HistoryContext, HistoryStats, Issue, Position, Volunteer } from "./models.ts";

interface Case {
  seed: number;
  volunteers: Volunteer[];
  active_codes: string[] | null;
  history: {
    stats: Record<string, HistoryStats>;
    last_reception_ids: number[];
    last_map_ids: number[];
    last_positions: Record<string, string[]>;
    last_altar_gender: string | null;
  };
  last_sunday: boolean;
  expected: { assignments: Assignment[]; warnings: string[] };
  validate_clean: Issue[];
  messy: Assignment[];
  messy_absent: number[];
  validate_messy: Issue[];
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf-8")) as {
  positions: Position[];
  cases: Case[];
};

function history(h: Case["history"]): HistoryContext {
  return {
    stats: new Map(Object.entries(h.stats).map(([k, v]) => [Number(k), v])),
    last_reception_ids: new Set(h.last_reception_ids),
    last_map_ids: new Set(h.last_map_ids),
    last_positions: new Map(Object.entries(h.last_positions).map(([k, v]) => [Number(k), new Set(v)])),
    last_altar_gender: h.last_altar_gender,
  };
}

describe("paridade com o motor em Python", () => {
  it("as posições padrão são as mesmas", () => {
    expect(DEFAULT_POSITIONS).toEqual(fixture.positions);
  });

  const spare = DEFAULT_POSITIONS.filter((p) => p.category === "Recepcao");
  const pos = new Map(DEFAULT_POSITIONS.map((p) => [p.code, p]));

  for (const c of fixture.cases) {
    it(`caso ${c.seed}: ${c.volunteers.length} voluntários`, () => {
      const positions = activePositions(DEFAULT_POSITIONS, c.active_codes && new Set(c.active_codes));
      const res = buildSchedule(c.volunteers, positions, history(c.history), c.last_sunday, spare);
      expect(res.assignments).toEqual(c.expected.assignments);
      expect(res.warnings).toEqual(c.expected.warnings);

      const byId = new Map(c.volunteers.map((v) => [v.id, v]));
      const everyone = new Set(byId.keys());
      expect(validate(res.assignments, byId, pos, c.last_sunday, undefined, everyone)).toEqual(c.validate_clean);
      expect(validate(c.messy, byId, pos, c.last_sunday, new Set(c.messy_absent), everyone)).toEqual(
        c.validate_messy,
      );
    });
  }
});
