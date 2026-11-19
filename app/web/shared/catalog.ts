/**
 * Catálogo fixo: equipes, posições e regras de quantidade.
 *
 * É código, não dado: o servidor e o site importam este arquivo, então as posições já vêm
 * dentro do site e não são pedidas à API. Não coloque aqui nada que seja segredo.
 */

export type Gender = "Masculino" | "Feminino";

export interface Position {
  code: string;
  name: string;
  category: string;
  allowed_gender: "Qualquer" | Gender;
  quantity: number;
  normal_active: boolean;
  event_only: boolean;
}

export const TEAM_OPTIONS = [
  "Domingo_Manha_A",
  "Domingo_Noite_A",
  "Domingo_Manha_B",
  "Domingo_Noite_B",
  "Quarta-Feira_Noite_A",
  "Quarta-Feira_Noite_B",
];

/**
 * Equipe dos eventos: junta todos os voluntários e ninguém é cadastrado nela. A cada evento
 * se escolhe quem vai servir; quem não foi escolhido não ganha falta.
 */
export const EVENT_TEAM = "Eventos";

/** Compara como as equipes no banco: sem maiúsculas, com espaço e hífen iguais a sublinhado. */
export const isEventTeam = (team: string | null | undefined): boolean =>
  (team ?? "").trim().toLowerCase().replace(/[- ]/g, "_") === EVENT_TEAM.toLowerCase();

// Regras de quantidade
export const ALTAR_SLOTS = 4; // Limpeza do altar: sempre 4 pessoas
export const LIMPEZA_CONFETE_MAX = 8; // Limpeza do confete: no máximo 8 pessoas
export const RECEPTION_SLOTS = 30; // R01..R30
export const RECEPTION_DEFAULT_ON = 20; // R21..R30 ficam desligadas; a geração liga quando precisa

// Categorias
export const MAP_CATEGORIES = new Set(["Banheiro", "Bercario", "Galeria", "Corredor"]);
export const ENTRY_CATEGORIES = new Set(["Banheiro Entrada", "Limpeza Altar", "Cadeiras Entrada"]);
export const EXIT_CATEGORIES = new Set(["Banheiro Saida", "Confete", "Cozinha", "Limpeza Conf"]);
export const FICHA_CATEGORIES = new Set([...ENTRY_CATEGORIES, ...EXIT_CATEGORIES]);
export const RECEPTION_CATEGORY = "Recepcao";
export const VISIBLE_MAP_CATEGORIES = new Set([...MAP_CATEGORIES, RECEPTION_CATEGORY]);
export const BATHROOM_FIXED_CODES = new Set(["BM", "BF"]);

export const FUNCTION_ORDER: Record<string, number> = {
  Banheiro: 10,
  Bercario: 11,
  Galeria: 12,
  Corredor: 30,
  Recepcao: 40,
  "Banheiro Entrada": 50,
  "Limpeza Altar": 51,
  "Cadeiras Entrada": 52,
  "Banheiro Saida": 60,
  Confete: 61,
  Cozinha: 62,
  "Limpeza Conf": 63,
};

export const CATEGORY_LABEL: Record<string, string> = {
  Banheiro: "Banheiro",
  Bercario: "Berçário",
  Galeria: "Galeria",
  Corredor: "Corredores",
  Recepcao: "Recepção",
  "Banheiro Entrada": "Banheiro (entrada)",
  "Limpeza Altar": "Limpeza do altar",
  "Cadeiras Entrada": "Cadeiras e envelopes",
  "Banheiro Saida": "Banheiro (saída)",
  Confete: "Confete",
  Cozinha: "Cozinha",
  "Limpeza Conf": "Limpeza do confete",
};

function seed(
  code: string,
  name: string,
  category: string,
  allowed_gender: Position["allowed_gender"] = "Qualquer",
  normal_active = true,
  event_only = false,
): Position {
  return { code, name, category, allowed_gender, quantity: 1, normal_active, event_only };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const EVENT_ONLY_CORRIDORS = new Set(["04", "11", "14", "22"]);

function corridorPositions(): Position[] {
  return range(1, 22).map((n) => {
    const code = pad2(n);
    const eventOnly = EVENT_ONLY_CORRIDORS.has(code);
    return seed(code, `Corredor ${code}`, "Corredor", "Qualquer", !eventOnly, eventOnly);
  });
}

function specialPositions(): Position[] {
  return [
    seed("BM", "Banheiro Masculino", "Banheiro", "Masculino"),
    seed("BF", "Banheiro Feminino", "Banheiro", "Feminino"),
    seed("BK", "Bercario", "Bercario", "Feminino"),
    seed("GM", "Galeria Masculina", "Galeria", "Masculino", false, true),
    seed("GF", "Galeria Feminina", "Galeria", "Feminino", false, true),
  ];
}

function receptionPositions(): Position[] {
  return range(1, RECEPTION_SLOTS).map((i) =>
    seed(`R${pad2(i)}`, `Recepcao ${pad2(i)}`, "Recepcao", "Qualquer", i <= RECEPTION_DEFAULT_ON),
  );
}

function bathroomTaskPositions(): Position[] {
  const out: Position[] = [];
  for (const [sex, gender] of [
    ["BM", "Masculino"],
    ["BF", "Feminino"],
  ] as const) {
    for (const [kind, cat] of [
      ["ENTRADA", "Banheiro Entrada"],
      ["SAIDA", "Banheiro Saida"],
    ] as const) {
      for (const i of [1, 2]) {
        out.push(seed(`${sex}_${kind}_${i}`, `Banheiro ${gender} ${title(kind)} ${i}`, cat, gender));
      }
    }
  }
  return out;
}

function taskPositions(): Position[] {
  return [
    ...range(1, 16).map((i) => seed(`CAD_ENV_ENTRADA_${i}`, `Cadeiras e Envelopes Entrada ${i}`, "Cadeiras Entrada")),
    ...range(1, ALTAR_SLOTS).map((i) => seed(`LA${i}`, `Limpeza Altar ${i}`, "Limpeza Altar")),
    seed("COZINHA_1", "Cozinha 1", "Cozinha"),
    seed("COZINHA_2", "Cozinha 2", "Cozinha"),
    seed("CONFETE_1", "Confete 1", "Confete"),
    seed("CONFETE_2", "Confete 2", "Confete"),
    ...range(1, LIMPEZA_CONFETE_MAX).map((i) => seed(`LIMPEZA_CONFETE_${i}`, `Limpeza Confete ${i}`, "Limpeza Conf")),
  ];
}

export const DEFAULT_POSITIONS: Position[] = [
  ...corridorPositions(),
  ...specialPositions(),
  ...receptionPositions(),
  ...bathroomTaskPositions(),
  ...taskPositions(),
];

/** Todas as posições, em ordem de código. É a lista que o servidor e o site usam. */
export const POSITIONS: Position[] = [...DEFAULT_POSITIONS].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

/** Posições ligadas de fábrica: valem enquanto a equipe não guardar as suas. */
export const FACTORY_ACTIVE: string[] = POSITIONS.filter((p) => p.normal_active && !p.event_only).map((p) => p.code);

/** Posições ligadas de fábrica nos eventos: as normais e as que só abrem em evento. */
export const EVENT_FACTORY_ACTIVE: string[] = POSITIONS.filter((p) => p.normal_active || p.event_only).map((p) => p.code);
