/**
 * Motor da escala (funções puras, sem banco).
 *
 * Ordem de preenchimento:
 *   1. Mapa: banheiros fixos (BM/BF), berçário, galerias e corredores
 *   2. Recepção: todos que sobraram do mapa (a recepção conta como mapa: ninguém fica de fora).
 *      Se as vagas ativas da recepção acabarem, as vagas desativadas são usadas.
 *   3. Entradas: Banheiro Entrada, Limpeza do Altar (sempre 4), Cadeiras e Envelopes.
 *      Só quem está no mapa (fora a recepção e os banheiros fixos). No máximo 1 por pessoa.
 *   4. Saídas: Banheiro Saída, Confete, Cozinha (mesmo gênero), Limpeza Confete (máx. 8).
 *      No máximo 1 por pessoa; quem ainda não tem tarefa na ficha vem primeiro.
 *
 * Rotatividade: histórico de posição/categoria, quem estava na recepção vai para o mapa,
 * ninguém repete a mesma posição do último culto. Gênero por posição, permissões
 * (berçário/cozinha/recepção/banheiro/altar), Limpeza do Altar com um único gênero
 * alternando a cada culto, Cozinha com um só gênero.
 *
 * Regras:
 *   - Todo presente fica no mapa ou na recepção.
 *   - Recepção nunca fica nas entradas; pode ficar nas saídas.
 *   - No último domingo do mês, quem está na recepção fica só na recepção.
 *
 * A ordem de desempate é a mesma do motor antigo em Python (app/escala/engine.py):
 * as chaves são comparadas elemento a elemento e os nomes por texto em minúsculas,
 * sem regras de idioma, para as duas versões gerarem a mesma escala.
 */
import {
  ALTAR_SLOTS,
  BATHROOM_FIXED_CODES,
  CATEGORY_LABEL,
  ENTRY_CATEGORIES,
  EXIT_CATEGORIES,
  FICHA_CATEGORIES,
  FUNCTION_ORDER,
  LIMPEZA_CONFETE_MAX,
  MAP_CATEGORIES,
  RECEPTION_CATEGORY,
  VISIBLE_MAP_CATEGORIES,
} from "./config.ts";
import type { Assignment, GenerationResult, HistoryContext, Issue, Position, Volunteer } from "./models.ts";

// ====================================================================== comparação de chaves

type Key = number | string | Key[];

/** Compara chaves como as tuplas do Python: elemento a elemento; a mais curta vem antes. */
function cmp(a: Key, b: Key): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Primeiro item com a menor chave (como o min() do Python). */
function minBy<T>(items: T[], key: (item: T) => Key): T {
  let best = items[0];
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const k = key(items[i]);
    if (cmp(k, bestKey) < 0) {
      best = items[i];
      bestKey = k;
    }
  }
  return best;
}

function sortedBy<T>(items: Iterable<T>, key: (item: T) => Key): T[] {
  return [...items].map((item) => ({ item, k: key(item) })).sort((x, y) => cmp(x.k, y.k)).map((x) => x.item);
}

const EMPTY: ReadonlySet<number> = new Set();
const union = (...sets: ReadonlySet<number>[]) => new Set(sets.flatMap((s) => [...s]));

// ====================================================================== posições

export function activePositions(positions: Position[], activeCodes: ReadonlySet<string> | null): Position[] {
  if (activeCodes !== null) return positions.filter((p) => activeCodes.has(p.code));
  return positions.filter((p) => p.normal_active && !p.event_only);
}

export function allowedForPosition(v: Volunteer, p: Position): boolean {
  if (p.allowed_gender !== "Qualquer" && v.gender !== p.allowed_gender) return false;
  if (p.category === "Bercario" && !v.can_bercario) return false;
  if (p.category === "Cozinha" && !v.can_cozinha) return false;
  if (p.category === RECEPTION_CATEGORY && !v.can_recepcao) return false;
  if (["Banheiro", "Banheiro Entrada", "Banheiro Saida"].includes(p.category) && !v.can_banheiro) return false;
  if (p.category === "Limpeza Altar" && !v.can_limpar_altar) return false;
  return true;
}

export function nextAltarGender(lastGender: string | null): "Masculino" | "Feminino" {
  return lastGender === "Feminino" ? "Masculino" : "Feminino";
}

const isDigits = (s: string) => /^\d+$/.test(s);

export function naturalCodeKey(code: string): Key {
  const n = code.trim().toUpperCase();
  if (isDigits(n)) return [[0, Number(n)]];
  return n.split("_").map((part) => (isDigits(part) ? [1, Number(part)] : [2, part]));
}

export function sortPositions(positions: Position[]): Position[] {
  return sortedBy(positions, (p) => [FUNCTION_ORDER[p.category] ?? 999, naturalCodeKey(p.code)]);
}

// ====================================================================== algoritmo

interface ChooseOptions {
  blocked?: ReadonlySet<number>;
  prefer?: ReadonlySet<number>;
  only?: ReadonlySet<number> | null;
  avoidSamePosition?: boolean;
  usePending?: boolean;
  forcedGender?: string | null;
  first?: ReadonlySet<number>;
}

interface SectorOptions {
  blocked?: ReadonlySet<number>;
  only?: ReadonlySet<number> | null;
  prefer?: ReadonlySet<number>;
  limit?: number | null;
  forcedGender?: string | null;
}

class Builder {
  assignments: Assignment[] = [];
  warnings: string[] = [];
  load = new Map<number, number>();
  pendingFicha: Set<number>; // ainda sem tarefa na ficha
  missingByCat = new Map<string, number>();
  readonly volunteers: Volunteer[];
  readonly history: HistoryContext;

  constructor(volunteers: Volunteer[], history: HistoryContext) {
    this.volunteers = volunteers;
    this.history = history;
    this.pendingFicha = new Set(volunteers.map((v) => v.id));
  }

  choose(position: Position, o: ChooseOptions = {}): Volunteer | null {
    const blocked = o.blocked ?? EMPTY;
    const only = o.only ?? null;
    const last = this.history.last_positions;
    const candidates = this.volunteers.filter(
      (v) =>
        !blocked.has(v.id) &&
        (only === null || only.has(v.id)) &&
        (!o.forcedGender || v.gender === o.forcedGender) &&
        (!o.avoidSamePosition || !last.get(v.id)?.has(position.code)) &&
        allowedForPosition(v, position),
    );
    if (!candidates.length) return null;
    const pending = o.usePending ? this.pendingFicha : EMPTY;
    return minBy(candidates, (v) => this.score(v, position, o.prefer ?? EMPTY, pending, o.first ?? EMPTY));
  }

  private score(
    v: Volunteer,
    position: Position,
    prefer: ReadonlySet<number>,
    pending: ReadonlySet<number>,
    first: ReadonlySet<number>,
  ): Key {
    const item = this.history.stats.get(v.id);
    return [
      first.has(v.id) ? 0 : 1, // obrigatório neste passo (ex.: não pode recepção)
      pending.has(v.id) ? 0 : 1, // quem ainda não tem tarefa primeiro
      prefer.has(v.id) ? 0 : 1, // preferência do passo
      this.load.get(v.id) ?? 0, // quantas tarefas já tem neste culto
      item?.position_counts[position.code] ?? 0, // rotatividade por posição
      item?.counts[position.category] ?? 0, // rotatividade por categoria
      item?.total ?? 0,
      v.name.toLowerCase(),
    ];
  }

  add(position: Position, v: Volunteer): void {
    this.assignments.push({
      position_code: position.code,
      position_name: position.name,
      category: position.category,
      volunteer_id: v.id,
      volunteer_name: v.name,
      order: this.assignments.length + 1,
    });
    this.load.set(v.id, (this.load.get(v.id) ?? 0) + 1);
    if (FICHA_CATEGORIES.has(position.category)) this.pendingFicha.delete(v.id);
  }

  missing(position: Position): void {
    this.missingByCat.set(position.category, (this.missingByCat.get(position.category) ?? 0) + 1);
  }

  fillSector(positions: Position[], o: SectorOptions = {}): Set<number> {
    const used = new Set<number>();
    let slots = sortPositions(positions);
    if (o.limit != null) slots = slots.slice(0, o.limit);
    for (const position of slots) {
      const v = this.choose(position, {
        blocked: union(o.blocked ?? EMPTY, used),
        only: o.only,
        prefer: o.prefer,
        usePending: true,
        forcedGender: o.forcedGender,
      });
      if (!v) {
        this.missing(position);
        continue;
      }
      this.add(position, v);
      used.add(v.id);
    }
    return used;
  }

  /**
   * Cozinha: todas as vagas com o mesmo gênero (escolhe o que preenche mais vagas,
   * depois o que tem mais gente ainda sem tarefa, depois o de menor histórico na categoria).
   */
  fillSameGenderSector(positions: Position[], o: { blocked?: ReadonlySet<number>; only?: ReadonlySet<number> | null }): Set<number> {
    if (!positions.length) return new Set();
    const blocked = o.blocked ?? EMPTY;
    const only = o.only ?? null;
    const options: Key[][] = [];
    for (const gender of ["Feminino", "Masculino"]) {
      const eligible = this.volunteers.filter(
        (v) =>
          v.gender === gender &&
          !blocked.has(v.id) &&
          (only === null || only.has(v.id)) &&
          positions.some((p) => allowedForPosition(v, p)),
      );
      const target = Math.min(positions.length, eligible.length);
      if (!target) continue;
      const pending = Math.min(positions.length, eligible.filter((v) => this.pendingFicha.has(v.id)).length);
      const load = eligible.reduce(
        (sum, v) => sum + (this.history.stats.get(v.id)?.counts[positions[0].category] ?? 0),
        0,
      );
      options.push([-target, -pending, load, gender]);
    }
    if (!options.length) {
      positions.forEach((p) => this.missing(p));
      return new Set();
    }
    const best = minBy(options, (x) => x);
    return this.fillSector(positions, { blocked, only, forcedGender: best[3] as string });
  }
}

export function buildSchedule(
  volunteers: Volunteer[],
  positions: Position[],
  history: HistoryContext,
  lastSunday = false,
  spareReception: Position[] = [],
): GenerationResult {
  const b = new Builder(volunteers, history);
  const byCat = (...cats: string[]) => positions.filter((p) => cats.includes(p.category));
  const count = (id: number, category: string) => history.stats.get(id)?.counts[category] ?? 0;

  // ---- 1. MAPA -------------------------------------------------------------
  // Quem não pode ficar na recepção precisa de lugar no mapa: entra primeiro.
  const noReception = new Set(volunteers.filter((v) => !v.can_recepcao).map((v) => v.id));
  const mapUsed = new Set<number>();
  const fixedBathroom = new Set<number>();
  const byId = new Map(volunteers.map((v) => [v.id, v]));
  // Só quem está no mapa faz entrada: o mapa precisa ter gente do gênero dos banheiros de
  // entrada e da limpeza do altar (que é de um gênero só, alternando).
  const altarGender = nextAltarGender(history.last_altar_gender);
  const genders = ["Feminino", "Masculino"] as const;
  const need = new Map<string, number>(
    genders.map((g) => [g, byCat("Banheiro Entrada").filter((p) => p.allowed_gender === g).length]),
  );
  need.set(altarGender, need.get(altarGender)! + Math.min(ALTAR_SLOTS, byCat("Limpeza Altar").length));

  const genderGap = (): [string, number][] => {
    const pool = [...mapUsed].filter((i) => !fixedBathroom.has(i)).map((i) => byId.get(i)!);
    return genders.map((g) => [
      g,
      need.get(g)! - pool.filter((v) => v.gender === g && (v.can_banheiro || v.can_limpar_altar)).length,
    ]);
  };

  const mapPositions = sortPositions(byCat(...MAP_CATEGORIES));
  mapPositions.forEach((position, idx) => {
    let forced: string | null = null;
    if (position.allowed_gender === "Qualquer") {
      const freeLeft = mapPositions.slice(idx).filter((p) => p.allowed_gender === "Qualquer").length;
      const gap = genderGap().filter(([, n]) => n > 0);
      if (gap.length && gap.reduce((s, [, n]) => s + n, 0) >= freeLeft) {
        forced = gap.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
      }
    }
    let v: Volunteer | null = null;
    for (const g of forced ? [forced, null] : [null]) {
      const base = { blocked: mapUsed, prefer: history.last_reception_ids, first: noReception, forcedGender: g };
      v = b.choose(position, { ...base, avoidSamePosition: true }) ?? b.choose(position, base);
      if (v) break;
    }
    if (!v) {
      b.missing(position);
      return;
    }
    b.add(position, v);
    mapUsed.add(v.id);
    if (BATHROOM_FIXED_CODES.has(position.code.toUpperCase())) fixedBathroom.add(v.id);
  });

  // ---- 2. RECEPÇÃO: todos que sobraram do mapa ----------------------------------
  const activeRec = sortPositions(byCat(RECEPTION_CATEGORY));
  const activeCodes = new Set(activeRec.map((p) => p.code));
  const extraRec = sortPositions(spareReception).filter((p) => !activeCodes.has(p.code));
  const extraCodes = new Set(extraRec.map((p) => p.code));
  // rotatividade: quem estava no mapa no último culto entra primeiro; quem já estava na recepção por último
  const leftovers = sortedBy(
    volunteers.filter((v) => !mapUsed.has(v.id)),
    (v) => [
      history.last_map_ids.has(v.id) ? 0 : 1,
      history.last_reception_ids.has(v.id) ? 1 : 0,
      count(v.id, RECEPTION_CATEGORY),
      v.name.toLowerCase(),
    ],
  );
  const slots = [...activeRec, ...extraRec];
  let nextSlot = 0;
  const outside: Volunteer[] = [];
  for (const v of leftovers) {
    const position = v.can_recepcao ? slots[nextSlot++] : undefined;
    if (!position) {
      outside.push(v);
      continue;
    }
    b.add(position, v);
  }
  const opened = b.assignments.filter((a) => extraCodes.has(a.position_code));
  if (opened.length) {
    b.warnings.push(`Recepção: ${opened.length} vaga(s) a mais foram ativadas para caber todo mundo.`);
  }
  const cant = outside.filter((v) => !v.can_recepcao).map((v) => v.name);
  const full = outside.filter((v) => v.can_recepcao).map((v) => v.name);
  if (cant.length) {
    b.warnings.push(
      `Mapa cheio e sem permissão para a recepção: ${cant.join(", ")}. Ative mais posições no mapa.`,
    );
  }
  if (full.length) {
    b.warnings.push(
      `Recepção cheia (${activeRec.length + extraRec.length} vagas). Sem lugar: ${full.join(", ")}. ` +
        `Ative mais posições no mapa.`,
    );
  }

  // ---- 3. ENTRADAS (só quem está no mapa, fora recepção e banheiro fixo; 1 por pessoa) ----
  const entryPool = new Set([...mapUsed].filter((i) => !fixedBathroom.has(i)));
  let entryUsed = new Set<number>();

  const bathroomEntry = b.fillSector(byCat("Banheiro Entrada"), { only: entryPool });
  entryUsed = union(entryUsed, bathroomEntry);

  const altarPositions = sortPositions(byCat("Limpeza Altar")).slice(0, ALTAR_SLOTS);
  if (altarPositions.length) {
    const same = volunteers.filter(
      (v) => v.gender === altarGender && entryPool.has(v.id) && !entryUsed.has(v.id) && v.can_limpar_altar,
    );
    if (same.length >= altarPositions.length) {
      entryUsed = union(
        entryUsed,
        b.fillSector(altarPositions, { blocked: entryUsed, only: entryPool, forcedGender: altarGender }),
      );
    } else {
      const first = b.fillSector(altarPositions.slice(0, same.length), {
        blocked: entryUsed,
        only: entryPool,
        forcedGender: altarGender,
      });
      const rest = b.fillSector(altarPositions.slice(same.length), {
        blocked: union(entryUsed, first),
        only: entryPool,
      });
      entryUsed = union(entryUsed, first, rest);
      b.warnings.push(
        `Limpeza do Altar: só ${same.length} pessoa(s) do gênero ${altarGender}; ` +
          `vagas completadas com o outro gênero.`,
      );
    }
  }

  entryUsed = union(entryUsed, b.fillSector(byCat("Cadeiras Entrada"), { blocked: entryUsed, only: entryPool }));

  // ---- 4. SAÍDAS (1 por pessoa; quem ainda não tem tarefa vem primeiro) ---------------
  // No último domingo, quem está na recepção fica só na recepção.
  const exitOnly = lastSunday ? mapUsed : null;
  let exitUsed = new Set<number>();
  exitUsed = union(exitUsed, b.fillSector(byCat("Banheiro Saida"), { blocked: bathroomEntry, only: exitOnly }));
  exitUsed = union(exitUsed, b.fillSector(byCat("Confete"), { blocked: exitUsed, only: exitOnly }));
  exitUsed = union(exitUsed, b.fillSameGenderSector(byCat("Cozinha"), { blocked: exitUsed, only: exitOnly }));
  exitUsed = union(
    exitUsed,
    b.fillSector(byCat("Limpeza Conf"), { blocked: exitUsed, only: exitOnly, limit: LIMPEZA_CONFETE_MAX }),
  );

  for (const [cat, n] of b.missingByCat) {
    b.warnings.push(`${CATEGORY_LABEL[cat] ?? cat}: ${n} vaga(s) sem ninguém disponível.`);
  }
  if ([...b.missingByCat.keys()].some((c) => ENTRY_CATEGORIES.has(c))) {
    b.warnings.push(
      "Só quem está no mapa (fora a recepção e os banheiros fixos) faz entrada. " +
        "Para preencher mais entradas, ative mais posições no mapa.",
    );
  }
  b.warnings.push(...coverageWarnings(volunteers, b.assignments, lastSunday));
  return { assignments: b.assignments, warnings: b.warnings };
}

// ====================================================================== validação de edição manual

/**
 * Confere uma escala (gerada ou editada à mão).
 * `presentIds`: quem está presente e precisa aparecer no mapa (ou na recepção).
 */
export function validate(
  assignments: Assignment[],
  volunteers: ReadonlyMap<number, Volunteer>,
  positions: ReadonlyMap<string, Position>,
  lastSunday: boolean,
  absentIds: ReadonlySet<number> = EMPTY,
  presentIds: ReadonlySet<number> | null = null,
): Issue[] {
  const issues: Issue[] = [];
  const issue = (codes: string[], message: string) => issues.push({ codes: [...new Set(codes)].sort(), message });
  const codesOf = (items: Assignment[]) => items.map((a) => a.position_code);

  const byVol = new Map<number, Assignment[]>();
  for (const a of assignments) {
    if (!byVol.has(a.volunteer_id)) byVol.set(a.volunteer_id, []);
    byVol.get(a.volunteer_id)!.push(a);
    const v = volunteers.get(a.volunteer_id);
    const p = positions.get(a.position_code);
    if (absentIds.has(a.volunteer_id)) {
      issue([a.position_code], `${a.volunteer_name} está marcado(a) com falta e está em ${a.position_name}.`);
    }
    if (v && p && !allowedForPosition(v, p)) {
      issue([a.position_code], `${v.name} não pode ficar em ${p.name} (gênero ou permissão).`);
    }
  }

  for (const items of byVol.values()) {
    const name = items[0].volunteer_name;
    const cats = items.map((a) => a.category);
    const mapItems = items.filter((a) => VISIBLE_MAP_CATEGORIES.has(a.category));
    const entries = items.filter((a) => ENTRY_CATEGORIES.has(a.category));
    const exits = items.filter((a) => EXIT_CATEGORIES.has(a.category));
    const inReception = cats.includes(RECEPTION_CATEGORY);
    if (mapItems.length > 1) issue(codesOf(mapItems), `${name} está em mais de um lugar no mapa.`);
    if (entries.length > 1) issue(codesOf(entries), `${name} está em mais de uma tarefa de entrada.`);
    if (exits.length > 1) issue(codesOf(exits), `${name} está em mais de uma tarefa de saída.`);
    if (!mapItems.length) issue(codesOf(items), `${name} não está no mapa nem na recepção.`);
    if (inReception && entries.length) {
      issue(codesOf(entries), `${name} está na recepção e não pode ficar na entrada.`);
    }
    if (inReception && exits.length && lastSunday) {
      issue(codesOf(exits), `Último domingo do mês: ${name} está na recepção e não pode ficar na saída.`);
    }
    if (items.some((a) => BATHROOM_FIXED_CODES.has(a.position_code.toUpperCase())) && entries.length) {
      issue(codesOf(entries), `${name} está fixo(a) no banheiro e não pode pegar entrada.`);
    }
    if (cats.includes("Banheiro Entrada") && cats.includes("Banheiro Saida")) {
      issue(
        codesOf(items.filter((a) => a.category.startsWith("Banheiro "))),
        `${name} está no banheiro na entrada e na saída.`,
      );
    }
  }

  if (presentIds !== null) {
    const leftOut = sortedBy(
      [...presentIds].filter((i) => !byVol.has(i) && volunteers.has(i)).map((i) => volunteers.get(i)!.name),
      (n) => n.toLowerCase(),
    );
    if (leftOut.length) {
      issue([], `Fora da escala (sem lugar no mapa nem na recepção): ${leftOut.join(", ")}.`);
    }
  }

  const altar = assignments.filter((a) => a.category === "Limpeza Altar");
  if (altar.length && altar.length !== ALTAR_SLOTS) {
    issue(codesOf(altar), `Limpeza do Altar deve ter ${ALTAR_SLOTS} pessoas (${altar.length}).`);
  }
  const conf = assignments.filter((a) => a.category === "Limpeza Conf");
  if (conf.length > LIMPEZA_CONFETE_MAX) {
    issue(codesOf(conf), `Limpeza Confete com mais de ${LIMPEZA_CONFETE_MAX} pessoas.`);
  }
  const kitchen = assignments.filter((a) => a.category === "Cozinha");
  const kitchenGenders = new Set(
    kitchen.filter((a) => volunteers.has(a.volunteer_id)).map((a) => volunteers.get(a.volunteer_id)!.gender),
  );
  if (kitchenGenders.size > 1) issue(codesOf(kitchen), "Cozinha deve ter um só gênero.");
  return issues;
}

// ====================================================================== avisos de cobertura

export function coverageWarnings(volunteers: Volunteer[], assignments: Assignment[], lastSunday = false): string[] {
  const byId = new Map(volunteers.map((v) => [v.id, v]));
  const idsIn = (cats: ReadonlySet<string>) =>
    new Set(assignments.filter((a) => cats.has(a.category)).map((a) => a.volunteer_id));
  const mapIds = idsIn(VISIBLE_MAP_CATEGORIES);
  const recIds = idsIn(new Set([RECEPTION_CATEGORY]));
  const fichaIds = idsIn(FICHA_CATEGORIES);
  const names = (ids: number[]) =>
    sortedBy(
      ids.map((i) => byId.get(i)!.name),
      (n) => n.toLowerCase(),
    ).join(", ");
  const all = [...byId.keys()];
  const out: string[] = [];
  const nothing = all.filter((i) => !mapIds.has(i) && !fichaIds.has(i));
  if (nothing.length) out.push(`Sem nenhuma função: ${names(nothing)}.`);
  const onlyFicha = all.filter((i) => !mapIds.has(i) && fichaIds.has(i));
  if (onlyFicha.length) out.push(`Só na ficha (não aparecem no mapa): ${names(onlyFicha)}.`);
  // no último domingo, quem está na recepção fica só na recepção (é a função dele)
  const noTask = [...mapIds].filter((i) => byId.has(i) && !fichaIds.has(i) && !(lastSunday && recIds.has(i)));
  if (noTask.length) {
    out.push(
      `Sem tarefa de entrada/saída (vagas da ficha esgotadas ou bloqueadas por regra): ${names(noTask)}.`,
    );
  }
  return out;
}
