"""Gera server/fixtures/parity.json com escalas calculadas pelo motor antigo em Python.

O teste server/parity.test.ts roda os mesmos casos no motor em TypeScript e exige
o mesmo resultado, posição por posição.

Uso (na pasta app/web):  py -3 scripts/gen_parity.py
"""
import json
import random
import sys
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))  # app/

from escala.config import DEFAULT_POSITIONS  # noqa: E402
from escala.engine import HistoryContext, active_positions, build_schedule, validate  # noqa: E402
from escala.models import Position, Volunteer  # noqa: E402

POSITIONS = [Position(p.code, p.name, p.category, p.allowed_gender, p.quantity, p.normal_active, p.event_only)
             for p in DEFAULT_POSITIONS]
POS = {p.code: p for p in POSITIONS}
SPARE = [p for p in POSITIONS if p.category == "Recepcao"]
MAP_CODES = [p.code for p in POSITIONS if p.category in {"Corredor", "Banheiro", "Bercario", "Galeria"}]
NAMES = ["Ana", "Élida", "Bruno", "carla", "Zé", "Ágata", "João", "Íris", "Davi", "Óscar", "maria", "Úrsula"]


def make_volunteers(rnd, n_f, n_m, restricted):
    vols = []
    for i in range(n_f + n_m):
        g = "Feminino" if i < n_f else "Masculino"
        name = f"{rnd.choice(NAMES)} {rnd.choice(NAMES)} {i + 1:03d}"

        def flag(p):
            return rnd.random() > p if restricted else True

        vols.append(Volunteer(i + 1, name, g, "T", True, g == "Feminino" and flag(.3), flag(.15), flag(.1),
                              flag(.1), flag(.15)))
    rnd.shuffle(vols)
    return sorted(vols, key=lambda v: v.name.lower())  # mesma ordem que o banco devolve


def make_history(rnd, vols):
    stats, last_pos = {}, {}
    for v in vols:
        if rnd.random() < .8:
            counts = {c: rnd.randint(0, 6) for c in rnd.sample(sorted({p.category for p in POSITIONS}), 5)}
            pcounts = {c: rnd.randint(0, 3) for c in rnd.sample(MAP_CODES, 6)}
            stats[v.id] = {"counts": counts, "position_counts": pcounts, "total": sum(counts.values())}
        if rnd.random() < .7:
            last_pos[v.id] = set(rnd.sample([p.code for p in POSITIONS], rnd.randint(1, 3)))
    ids = [v.id for v in vols]
    rec = set(rnd.sample(ids, len(ids) // 3))
    on_map = set(rnd.sample([i for i in ids if i not in rec], len(ids) // 3))
    return HistoryContext(stats=stats, last_reception_ids=rec, last_map_ids=on_map, last_positions=last_pos,
                          last_altar_gender=rnd.choice([None, "Feminino", "Masculino"]))


def history_json(h):
    return {
        "stats": {str(k): v for k, v in h.stats.items()},
        "last_reception_ids": sorted(h.last_reception_ids),
        "last_map_ids": sorted(h.last_map_ids),
        "last_positions": {str(k): sorted(v) for k, v in h.last_positions.items()},
        "last_altar_gender": h.last_altar_gender,
    }


def main():
    cases = []
    sizes = [(30, 15), (20, 10), (34, 17), (12, 6), (5, 3), (40, 30), (9, 22), (25, 0), (0, 14), (48, 24), (1, 1)]
    seed = 0
    for n_f, n_m in sizes:
        for variant in range(6):
            seed += 1
            rnd = random.Random(seed)
            restricted = variant % 2 == 1
            vols = make_volunteers(rnd, n_f, n_m, restricted)
            history = make_history(rnd, vols) if variant >= 2 else HistoryContext()
            last_sunday = variant in (3, 5)
            if variant >= 4:  # posições escolhidas à mão, incluindo as de evento
                codes = {p.code for p in POSITIONS if rnd.random() < .75}
            else:
                codes = None
            positions = active_positions(POSITIONS, codes)
            res = build_schedule(vols, positions, history, last_sunday, spare_reception=SPARE)
            by_id = {v.id: v for v in vols}
            # validação da escala gerada e de uma versão bagunçada à mão
            messy = list(res.assignments)
            if len(messy) > 4:
                from dataclasses import replace
                a, b = rnd.sample(range(len(messy)), 2)
                messy[a] = replace(messy[a], volunteer_id=messy[b].volunteer_id,
                                   volunteer_name=messy[b].volunteer_name)
                del messy[rnd.randrange(len(messy))]
            absent = set(rnd.sample(sorted(by_id), min(2, len(by_id))))
            cases.append({
                "seed": seed,
                "volunteers": [asdict(v) for v in vols],
                "active_codes": sorted(codes) if codes is not None else None,
                "history": history_json(history),
                "last_sunday": last_sunday,
                "expected": {"assignments": [asdict(a) for a in res.assignments], "warnings": res.warnings},
                "validate_clean": validate(res.assignments, by_id, POS, last_sunday, present_ids=set(by_id)),
                "messy": [asdict(a) for a in messy],
                "messy_absent": sorted(absent),
                "validate_messy": validate(messy, by_id, POS, last_sunday, absent, set(by_id)),
            })
    out = HERE.parent / "server" / "fixtures" / "parity.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"positions": [asdict(p) for p in POSITIONS], "cases": cases}, ensure_ascii=False),
                   encoding="utf-8")
    print(f"{len(cases)} casos gravados em {out}")


if __name__ == "__main__":
    main()
