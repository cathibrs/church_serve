"""Motor da escala.

Ordem de preenchimento:
  1. Mapa: banheiros fixos (BM/BF), berçário, galerias e corredores
  2. Recepção: todos que sobraram do mapa (a recepção conta como mapa: ninguém fica de fora).
     Se as vagas ativas da recepção acabarem, as vagas desativadas são usadas.
  3. Entradas: Banheiro Entrada, Limpeza do Altar (sempre 4), Cadeiras e Envelopes.
     Só quem está no mapa (fora a recepção e os banheiros fixos). No máximo 1 por pessoa.
  4. Saídas: Banheiro Saída, Confete, Cozinha (mesmo gênero), Limpeza Confete (máx. 8).
     No máximo 1 por pessoa; quem ainda não tem tarefa na ficha vem primeiro.

Regras mantidas do sistema antigo: rotatividade (histórico de posição/categoria, quem
estava na recepção vai para o mapa, não repetir a mesma posição do último culto),
gênero por posição, permissões (pode berçário/cozinha/recepção/banheiro/altar),
Limpeza do Altar com um único gênero alternando a cada culto, Cozinha com um só gênero.

Regras:
  * Todo presente fica no mapa ou na recepção.
  * Recepção nunca fica nas entradas; pode ficar nas saídas.
  * No último domingo do mês, quem está na recepção fica só na recepção.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import date

from . import db
from .config import (ALTAR_SLOTS, BATHROOM_FIXED_CODES, CATEGORY_LABEL, ENTRY_CATEGORIES, EXIT_CATEGORIES, FICHA_CATEGORIES,
                     FUNCTION_ORDER, LIMPEZA_CONFETE_MAX, MAP_CATEGORIES, RECEPTION_CATEGORY,
                     VISIBLE_MAP_CATEGORIES, is_last_sunday)
from .models import Assignment, GenerationResult, Position, Volunteer


@dataclass
class HistoryContext:
    stats: dict[int, dict] = field(default_factory=dict)
    last_reception_ids: set[int] = field(default_factory=set)
    last_map_ids: set[int] = field(default_factory=set)
    last_positions: dict[int, set[str]] = field(default_factory=dict)
    last_altar_gender: str | None = None


# ====================================================================== entrada pública

def generate_schedule(conn: sqlite3.Connection, present_ids: set[int], active_position_codes: set[str] | None = None,
                      team: str | None = None, service_date: date | None = None) -> GenerationResult:
    volunteers = [v for v in db.get_volunteers(conn, team=team) if v.id in present_ids]
    ids = {v.id for v in volunteers}
    history = HistoryContext(
        stats=db.get_history_stats(conn, team=team),
        last_reception_ids=db.last_assignment_ids(conn, ids, {RECEPTION_CATEGORY}),
        last_map_ids=db.last_assignment_ids(conn, ids, MAP_CATEGORIES),
        last_positions=db.last_position_by_volunteer(conn, ids),
        last_altar_gender=db.get_last_altar_gender(conn),
    )
    all_positions = db.get_positions(conn)
    positions = active_positions(all_positions, active_position_codes)
    last_sunday = bool(service_date and is_last_sunday(service_date))
    result = build_schedule(volunteers, positions, history, last_sunday,
                            spare_reception=[p for p in all_positions if p.category == RECEPTION_CATEGORY])
    if present_ids - ids:
        result.warnings.append("Alguns marcados como presentes não pertencem à equipe ou estão inativos.")
    return result


def active_positions(positions: list[Position], active_codes: set[str] | None) -> list[Position]:
    if active_codes is not None:
        return [p for p in positions if p.code in active_codes]
    return [p for p in positions if p.normal_active and not p.event_only]


# ====================================================================== algoritmo

class _Builder:
    def __init__(self, volunteers: list[Volunteer], history: HistoryContext):
        self.volunteers = volunteers
        self.history = history
        self.assignments: list[Assignment] = []
        self.warnings: list[str] = []
        self.load: dict[int, int] = {}
        self.pending_ficha: set[int] = {v.id for v in volunteers}  # ainda sem tarefa na ficha
        self.missing_by_cat: dict[str, int] = {}

    # -------------------------------------------------------------- escolha
    def choose(self, position: Position, blocked: set[int] = frozenset(), prefer: set[int] = frozenset(),
               only: set[int] | None = None, avoid_same_position: bool = False, use_pending: bool = False,
               forced_gender: str | None = None, first: set[int] = frozenset()) -> Volunteer | None:
        last = self.history.last_positions
        candidates = [
            v for v in self.volunteers
            if v.id not in blocked
            and (only is None or v.id in only)
            and (not forced_gender or v.gender == forced_gender)
            and (not avoid_same_position or position.code not in last.get(v.id, ()))
            and allowed_for_position(v, position)
        ]
        if not candidates:
            return None
        pending = self.pending_ficha if use_pending else set()
        return min(candidates, key=lambda v: self._score(v, position, prefer, pending, first))

    def _score(self, v: Volunteer, position: Position, prefer: set[int], pending: set[int], first: set[int]):
        item = self.history.stats.get(v.id, {})
        return (
            0 if v.id in first else 1,                           # obrigatório neste passo (ex.: não pode recepção)
            0 if v.id in pending else 1,                         # quem ainda não tem tarefa primeiro
            0 if v.id in prefer else 1,                          # preferência do passo
            self.load.get(v.id, 0),                              # quantas tarefas já tem neste culto
            int(item.get("position_counts", {}).get(position.code, 0)),  # rotatividade por posição
            int(item.get("counts", {}).get(position.category, 0)),       # rotatividade por categoria
            int(item.get("total", 0)),
            v.name.lower(),
        )

    def add(self, position: Position, v: Volunteer) -> None:
        self.assignments.append(Assignment(position.code, position.name, position.category, v.id, v.name,
                                           len(self.assignments) + 1))
        self.load[v.id] = self.load.get(v.id, 0) + 1
        if position.category in FICHA_CATEGORIES:
            self.pending_ficha.discard(v.id)

    def missing(self, position: Position) -> None:
        self.missing_by_cat[position.category] = self.missing_by_cat.get(position.category, 0) + 1

    # -------------------------------------------------------------- setor simples
    def fill_sector(self, positions: list[Position], blocked: set[int] = frozenset(), only: set[int] | None = None,
                    prefer: set[int] = frozenset(), limit: int | None = None, forced_gender: str | None = None
                    ) -> set[int]:
        used: set[int] = set()
        slots = sort_positions(positions)
        if limit is not None:
            slots = slots[:limit]
        for position in slots:
            v = self.choose(position, blocked=blocked | used, only=only, prefer=prefer, use_pending=True,
                            forced_gender=forced_gender)
            if not v:
                self.missing(position)
                continue
            self.add(position, v)
            used.add(v.id)
        return used

    def fill_same_gender_sector(self, positions: list[Position], blocked: set[int] = frozenset(),
                                only: set[int] | None = None) -> set[int]:
        """Cozinha: todas as vagas com o mesmo gênero (escolhe o que preenche mais vagas,
        depois o que tem mais gente ainda sem tarefa, depois o de menor histórico na categoria)."""
        if not positions:
            return set()
        options = []
        for gender in ("Feminino", "Masculino"):
            eligible = {v.id for v in self.volunteers
                        if v.gender == gender and v.id not in blocked and (only is None or v.id in only)
                        and any(allowed_for_position(v, p) for p in positions)}
            target = min(len(positions), len(eligible))
            if not target:
                continue
            pending = min(len(positions), len(eligible & self.pending_ficha))
            load = sum(int(self.history.stats.get(i, {}).get("counts", {}).get(positions[0].category, 0))
                       for i in eligible)
            options.append((-target, -pending, load, gender))
        if not options:
            for p in positions:
                self.missing(p)
            return set()
        gender = sorted(options)[0][-1]
        return self.fill_sector(positions, blocked=blocked, only=only, forced_gender=gender)


def build_schedule(volunteers: list[Volunteer], positions: list[Position], history: HistoryContext,
                   last_sunday: bool = False, spare_reception: list[Position] | None = None) -> GenerationResult:
    b = _Builder(volunteers, history)
    by_cat = lambda *cats: [p for p in positions if p.category in cats]  # noqa: E731

    # ---- 1. MAPA -------------------------------------------------------------
    # Quem não pode ficar na recepção precisa de lugar no mapa: entra primeiro.
    no_reception = {v.id for v in volunteers if not v.can_recepcao}
    map_used: set[int] = set()
    fixed_bathroom: set[int] = set()
    by_id = {v.id: v for v in volunteers}
    # Só quem está no mapa faz entrada: o mapa precisa ter gente do gênero dos banheiros de
    # entrada e da limpeza do altar (que é de um gênero só, alternando).
    altar_gender = next_altar_gender(history.last_altar_gender)
    need = {g: len([p for p in by_cat("Banheiro Entrada") if p.allowed_gender == g])
            for g in ("Feminino", "Masculino")}
    need[altar_gender] += min(ALTAR_SLOTS, len(by_cat("Limpeza Altar")))

    def gender_gap() -> dict[str, int]:
        pool = [by_id[i] for i in map_used - fixed_bathroom]
        return {g: n - sum(1 for v in pool if v.gender == g and (v.can_banheiro or v.can_limpar_altar))
                for g, n in need.items()}

    map_positions = sort_positions(by_cat(*MAP_CATEGORIES))
    for idx, position in enumerate(map_positions):
        forced = None
        if position.allowed_gender == "Qualquer":
            free_left = sum(1 for p in map_positions[idx:] if p.allowed_gender == "Qualquer")
            gap = {g: n for g, n in gender_gap().items() if n > 0}
            if gap and sum(gap.values()) >= free_left:
                forced = max(gap, key=gap.get)
        v = None
        for g in ((forced, None) if forced else (None,)):
            v = (b.choose(position, blocked=map_used, prefer=history.last_reception_ids, avoid_same_position=True,
                          first=no_reception, forced_gender=g)
                 or b.choose(position, blocked=map_used, prefer=history.last_reception_ids, first=no_reception,
                             forced_gender=g))
            if v:
                break
        if not v:
            b.missing(position)
            continue
        b.add(position, v)
        map_used.add(v.id)
        if position.code.upper() in BATHROOM_FIXED_CODES:
            fixed_bathroom.add(v.id)

    # ---- 2. RECEPÇÃO: todos que sobraram do mapa ----------------------------------
    active_rec = sort_positions(by_cat(RECEPTION_CATEGORY))
    active_codes = {p.code for p in active_rec}
    extra_rec = [p for p in sort_positions(spare_reception or []) if p.code not in active_codes]
    extra_codes = {p.code for p in extra_rec}
    leftovers = [v for v in volunteers if v.id not in map_used]
    # rotatividade: quem estava no mapa no último culto entra primeiro; quem já estava na recepção por último
    leftovers.sort(key=lambda v: (0 if v.id in history.last_map_ids else 1,
                                  1 if v.id in history.last_reception_ids else 0,
                                  int(history.stats.get(v.id, {}).get("counts", {}).get(RECEPTION_CATEGORY, 0)),
                                  v.name.lower()))
    slots = iter(active_rec + extra_rec)
    outside: list[Volunteer] = []
    for v in leftovers:
        position = next(slots, None) if v.can_recepcao else None
        if position is None:
            outside.append(v)
            continue
        b.add(position, v)
    opened = [a for a in b.assignments if a.position_code in extra_codes]
    if opened:
        b.warnings.append(f"Recepção: {len(opened)} vaga(s) a mais foram ativadas para caber todo mundo.")
    cant = [v.name for v in outside if not v.can_recepcao]
    full = [v.name for v in outside if v.can_recepcao]
    if cant:
        b.warnings.append(f"Mapa cheio e sem permissão para a recepção: {', '.join(cant)}. "
                          f"Ative mais posições no mapa.")
    if full:
        b.warnings.append(f"Recepção cheia ({len(active_rec) + len(extra_rec)} vagas). Sem lugar: {', '.join(full)}. "
                          f"Ative mais posições no mapa.")

    # ---- 3. ENTRADAS (só quem está no mapa, fora recepção e banheiro fixo; 1 por pessoa) ----
    entry_pool = map_used - fixed_bathroom
    entry_used: set[int] = set()

    bathroom_entry = b.fill_sector(by_cat("Banheiro Entrada"), only=entry_pool)
    entry_used |= bathroom_entry

    altar_positions = sort_positions(by_cat("Limpeza Altar"))[:ALTAR_SLOTS]
    if altar_positions:
        gender = next_altar_gender(history.last_altar_gender)
        same = [v for v in volunteers
                if v.gender == gender and v.id in entry_pool and v.id not in entry_used and v.can_limpar_altar]
        if len(same) >= len(altar_positions):
            entry_used |= b.fill_sector(altar_positions, blocked=entry_used, only=entry_pool, forced_gender=gender)
        else:
            first = b.fill_sector(altar_positions[:len(same)], blocked=entry_used, only=entry_pool,
                                  forced_gender=gender)
            rest = b.fill_sector(altar_positions[len(same):], blocked=entry_used | first, only=entry_pool)
            entry_used |= first | rest
            b.warnings.append(f"Limpeza do Altar: só {len(same)} pessoa(s) do gênero {gender}; "
                              f"vagas completadas com o outro gênero.")

    entry_used |= b.fill_sector(by_cat("Cadeiras Entrada"), blocked=entry_used, only=entry_pool)

    # ---- 4. SAÍDAS (1 por pessoa; quem ainda não tem tarefa vem primeiro) ---------------
    # No último domingo, quem está na recepção fica só na recepção.
    exit_only = map_used if last_sunday else None
    exit_used: set[int] = set()
    exit_used |= b.fill_sector(by_cat("Banheiro Saida"), blocked=bathroom_entry, only=exit_only)
    exit_used |= b.fill_sector(by_cat("Confete"), blocked=exit_used, only=exit_only)
    exit_used |= b.fill_same_gender_sector(by_cat("Cozinha"), blocked=exit_used, only=exit_only)
    exit_used |= b.fill_sector(by_cat("Limpeza Conf"), blocked=exit_used, only=exit_only, limit=LIMPEZA_CONFETE_MAX)

    for cat, n in b.missing_by_cat.items():
        b.warnings.append(f"{CATEGORY_LABEL.get(cat, cat)}: {n} vaga(s) sem ninguém disponível.")
    if b.missing_by_cat.keys() & ENTRY_CATEGORIES:
        b.warnings.append("Só quem está no mapa (fora a recepção e os banheiros fixos) faz entrada. "
                          "Para preencher mais entradas, ative mais posições no mapa.")
    b.warnings.extend(coverage_warnings(volunteers, b.assignments, last_sunday))
    return GenerationResult(assignments=b.assignments, warnings=b.warnings)


# ====================================================================== validação de edição manual

def validate(assignments: list[Assignment], volunteers: dict[int, Volunteer], positions: dict[str, Position],
             last_sunday: bool, absent_ids: set[int] = frozenset(),
             present_ids: set[int] | None = None) -> list[dict]:
    """Confere uma escala (gerada ou editada à mão). Retorna [{codes, message}].

    ``present_ids``: quem está presente e precisa aparecer no mapa (ou na recepção)."""
    issues: list[dict] = []

    def issue(codes, message):
        issues.append({"codes": sorted(set(codes)), "message": message})

    by_vol: dict[int, list[Assignment]] = {}
    for a in assignments:
        by_vol.setdefault(a.volunteer_id, []).append(a)
        v, p = volunteers.get(a.volunteer_id), positions.get(a.position_code)
        if a.volunteer_id in absent_ids:
            issue([a.position_code], f"{a.volunteer_name} está marcado(a) com falta e está em {a.position_name}.")
        if v and p and not allowed_for_position(v, p):
            issue([a.position_code], f"{v.name} não pode ficar em {p.name} (gênero ou permissão).")

    for vid, items in by_vol.items():
        name = items[0].volunteer_name
        cats = [a.category for a in items]
        map_items = [a for a in items if a.category in VISIBLE_MAP_CATEGORIES]
        entries = [a for a in items if a.category in ENTRY_CATEGORIES]
        exits = [a for a in items if a.category in EXIT_CATEGORIES]
        in_reception = RECEPTION_CATEGORY in cats
        if len(map_items) > 1:
            issue([a.position_code for a in map_items], f"{name} está em mais de um lugar no mapa.")
        if len(entries) > 1:
            issue([a.position_code for a in entries], f"{name} está em mais de uma tarefa de entrada.")
        if len(exits) > 1:
            issue([a.position_code for a in exits], f"{name} está em mais de uma tarefa de saída.")
        if not map_items:
            issue([a.position_code for a in items], f"{name} não está no mapa nem na recepção.")
        if in_reception and entries:
            issue([a.position_code for a in entries], f"{name} está na recepção e não pode ficar na entrada.")
        if in_reception and exits and last_sunday:
            issue([a.position_code for a in exits],
                  f"Último domingo do mês: {name} está na recepção e não pode ficar na saída.")
        if any(a.position_code.upper() in BATHROOM_FIXED_CODES for a in items) and entries:
            issue([a.position_code for a in entries], f"{name} está fixo(a) no banheiro e não pode pegar entrada.")
        if "Banheiro Entrada" in cats and "Banheiro Saida" in cats:
            issue([a.position_code for a in items if a.category.startswith("Banheiro ")],
                  f"{name} está no banheiro na entrada e na saída.")

    if present_ids is not None:
        left_out = sorted((volunteers[i].name for i in present_ids - set(by_vol) if i in volunteers), key=str.lower)
        if left_out:
            issue([], f"Fora da escala (sem lugar no mapa nem na recepção): {', '.join(left_out)}.")

    altar = [a for a in assignments if a.category == "Limpeza Altar"]
    if altar and len(altar) != ALTAR_SLOTS:
        issue([a.position_code for a in altar], f"Limpeza do Altar deve ter {ALTAR_SLOTS} pessoas ({len(altar)}).")
    conf = [a for a in assignments if a.category == "Limpeza Conf"]
    if len(conf) > LIMPEZA_CONFETE_MAX:
        issue([a.position_code for a in conf], f"Limpeza Confete com mais de {LIMPEZA_CONFETE_MAX} pessoas.")
    kitchen_genders = {volunteers[a.volunteer_id].gender for a in assignments
                       if a.category == "Cozinha" and a.volunteer_id in volunteers}
    if len(kitchen_genders) > 1:
        issue([a.position_code for a in assignments if a.category == "Cozinha"], "Cozinha deve ter um só gênero.")
    return issues


# ====================================================================== auxiliares

def allowed_for_position(v: Volunteer, p: Position) -> bool:
    if p.allowed_gender != "Qualquer" and v.gender != p.allowed_gender:
        return False
    if p.category == "Bercario" and not v.can_bercario:
        return False
    if p.category == "Cozinha" and not v.can_cozinha:
        return False
    if p.category == RECEPTION_CATEGORY and not v.can_recepcao:
        return False
    if p.category in {"Banheiro", "Banheiro Entrada", "Banheiro Saida"} and not v.can_banheiro:
        return False
    if p.category == "Limpeza Altar" and not v.can_limpar_altar:
        return False
    return True


def next_altar_gender(last_gender: str | None) -> str:
    return "Masculino" if last_gender == "Feminino" else "Feminino"


def natural_code_key(code: str) -> tuple:
    n = code.strip().upper()
    if n.isdigit():
        return ((0, int(n)),)
    return tuple((1, int(part)) if part.isdigit() else (2, part) for part in n.split("_"))


def sort_positions(positions: list[Position]) -> list[Position]:
    return sorted(positions, key=lambda p: (FUNCTION_ORDER.get(p.category, 999), natural_code_key(p.code)))


def coverage_warnings(volunteers: list[Volunteer], assignments: list[Assignment],
                      last_sunday: bool = False) -> list[str]:
    by_id = {v.id: v for v in volunteers}
    map_ids = {a.volunteer_id for a in assignments if a.category in VISIBLE_MAP_CATEGORIES}
    rec_ids = {a.volunteer_id for a in assignments if a.category == RECEPTION_CATEGORY}
    ficha_ids = {a.volunteer_id for a in assignments if a.category in FICHA_CATEGORIES}
    names = lambda ids: ", ".join(sorted((by_id[i].name for i in ids), key=str.lower))  # noqa: E731
    out = []
    nothing = set(by_id) - map_ids - ficha_ids
    if nothing:
        out.append(f"Sem nenhuma função: {names(nothing)}.")
    only_ficha = (set(by_id) - map_ids) & ficha_ids
    if only_ficha:
        out.append(f"Só na ficha (não aparecem no mapa): {names(only_ficha)}.")
    # no último domingo, quem está na recepção fica só na recepção (é a função dele)
    no_task = (map_ids - ficha_ids) - (rec_ids if last_sunday else set())
    if no_task:
        out.append(f"Sem tarefa de entrada/saída (vagas da ficha esgotadas ou bloqueadas por regra): "
                   f"{names(no_task)}.")
    return out
