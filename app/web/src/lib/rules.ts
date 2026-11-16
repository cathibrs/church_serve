import type { Position, Volunteer } from "./api";

export const MAP_CATS = new Set(["Banheiro", "Bercario", "Galeria", "Corredor"]);
export const ENTRY_CATS = new Set(["Banheiro Entrada", "Limpeza Altar", "Cadeiras Entrada"]);
export const EXIT_CATS = new Set(["Banheiro Saida", "Confete", "Cozinha", "Limpeza Conf"]);
export const REC = "Recepcao";

export function allowed(v: Volunteer, p: Position) {
  if (p.allowed_gender !== "Qualquer" && v.gender !== p.allowed_gender) return false;
  if (p.category === "Bercario" && !v.can_bercario) return false;
  if (p.category === "Cozinha" && !v.can_cozinha) return false;
  if (p.category === REC && !v.can_recepcao) return false;
  if (["Banheiro", "Banheiro Entrada", "Banheiro Saida"].includes(p.category) && !v.can_banheiro) return false;
  if (p.category === "Limpeza Altar" && !v.can_limpar_altar) return false;
  return true;
}

/** Grupo usado para trocas: mapa+recepção, entradas ou saídas (1 lugar por pessoa em cada grupo). */
export function swapGroup(p: Position) {
  if (MAP_CATS.has(p.category) || p.category === REC) return "map";
  if (ENTRY_CATS.has(p.category)) return "in";
  if (EXIT_CATS.has(p.category)) return "out";
  return "cat:" + p.category;
}

/** Motivo pelo qual colocar a pessoa nesta posição quebraria uma regra ("" = ok). */
export function conflict(
  vid: number,
  code: string,
  assign: Record<string, number>,
  positions: Record<string, Position>,
  lastSunday: boolean,
) {
  const p = positions[code];
  const mine = Object.entries(assign)
    .filter(([c, v]) => v === vid && c !== code)
    .map(([c]) => c);
  const cats = mine.map((c) => positions[c]?.category);
  const inRec = cats.includes(REC);
  const fixedBath = mine.some((c) => c === "BM" || c === "BF");
  if (MAP_CATS.has(p.category) || p.category === REC) {
    if (p.category === REC && cats.some((c) => ENTRY_CATS.has(c!))) return "tem tarefa de entrada";
    if (p.category === REC && lastSunday && cats.some((c) => EXIT_CATS.has(c!))) return "tem saída (último domingo)";
  }
  if (ENTRY_CATS.has(p.category)) {
    if (inRec) return "está na recepção";
    if (fixedBath) return "fixo no banheiro";
    if (!cats.some((c) => MAP_CATS.has(c!))) return "não está no mapa";
  }
  if (EXIT_CATS.has(p.category)) {
    if (inRec && lastSunday) return "recepção (último domingo)";
    if (p.category === "Banheiro Saida" && cats.includes("Banheiro Entrada")) return "fez banheiro na entrada";
  }
  return "";
}

export function shortPos(p?: Position) {
  if (!p) return "";
  if (p.category === REC) return "Recepção";
  if (p.category === "Corredor") return `Corredor ${p.code}`;
  return p.name
    .replace("Cadeiras e Envelopes Entrada", "Cadeiras")
    .replace("Banheiro Masculino", "Banh. M")
    .replace("Banheiro Feminino", "Banh. F")
    .replace("Limpeza Confete", "Limp. confete")
    .replace("Limpeza Altar", "Altar");
}
