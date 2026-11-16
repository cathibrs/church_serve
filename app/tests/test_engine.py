import random
import sys
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from escala.config import DEFAULT_POSITIONS, ENTRY_CATEGORIES, EXIT_CATEGORIES, MAP_CATEGORIES  # noqa: E402
from escala.engine import HistoryContext, active_positions, build_schedule, validate  # noqa: E402
from escala.models import Position, Volunteer  # noqa: E402

POSITIONS = [Position(p.code, p.name, p.category, p.allowed_gender, p.quantity, p.normal_active, p.event_only)
             for p in DEFAULT_POSITIONS]
POS = {p.code: p for p in POSITIONS}


def make_volunteers(n_f, n_m, seed=1):
    rnd = random.Random(seed)
    vols = []
    for i in range(n_f + n_m):
        g = "Feminino" if i < n_f else "Masculino"
        vols.append(Volunteer(i + 1, f"V{i + 1:03d}", g, "T", True, g == "Feminino",
                              rnd.random() > .1, True, True, True))
    return vols


SPARE_REC = [p for p in POSITIONS if p.category == "Recepcao"]


def run(vols, last_sunday=False, history=None, positions=None):
    pos = positions or active_positions(POSITIONS, None)
    return build_schedule(vols, pos, history or HistoryContext(), last_sunday, spare_reception=SPARE_REC)


class EngineRules(unittest.TestCase):
    def check_common(self, vols, res, last_sunday):
        by = {}
        for a in res.assignments:
            by.setdefault(a.volunteer_id, []).append(a.category)
        V = {v.id: v for v in vols}
        self.assertEqual(set(by), {v.id for v in vols}, "alguém ficou de fora da escala")
        for vid, cats in by.items():
            entries = [c for c in cats if c in ENTRY_CATEGORIES]
            self.assertLessEqual(len(entries), 1, f"{vid} com mais de uma entrada")
            self.assertLessEqual(len([c for c in cats if c in EXIT_CATEGORIES]), 1, f"{vid} com mais de uma saída")
            self.assertEqual(sum(c in MAP_CATEGORIES or c == "Recepcao" for c in cats), 1, f"{vid} fora do mapa")
            if "Recepcao" in cats:
                self.assertFalse(entries, "recepção em entrada")
                if last_sunday:
                    self.assertFalse([c for c in cats if c in EXIT_CATEGORIES], "recepção em saída no último domingo")
            self.assertLessEqual(sum(c in MAP_CATEGORIES or c == "Recepcao" for c in cats), 1)
        for a in res.assignments:
            p = POS[a.position_code]
            if p.allowed_gender != "Qualquer":
                self.assertEqual(V[a.volunteer_id].gender, p.allowed_gender, a.position_code)
        altar = [a for a in res.assignments if a.category == "Limpeza Altar"]
        self.assertEqual(len(altar), 4)
        self.assertLessEqual(len([a for a in res.assignments if a.category == "Limpeza Conf"]), 8)
        kitchen = {V[a.volunteer_id].gender for a in res.assignments if a.category == "Cozinha"}
        self.assertLessEqual(len(kitchen), 1)
        self.assertEqual(validate(res.assignments, V, POS, last_sunday, present_ids=set(V)), [])

    def test_normal_sunday(self):
        for nf, nm in ((30, 15), (20, 10), (34, 17), (12, 6)):
            vols = make_volunteers(nf, nm)
            self.check_common(vols, run(vols), False)

    def test_last_sunday(self):
        for nf, nm in ((30, 15), (20, 10), (34, 17)):
            vols = make_volunteers(nf, nm)
            self.check_common(vols, run(vols, last_sunday=True), True)

    def test_everyone_on_map_or_reception(self):
        vols = make_volunteers(34, 17)  # 51 pessoas: mais que mapa (21) + 20 vagas da recepção
        res = run(vols)
        map_or_rec = {a.volunteer_id for a in res.assignments if a.category in MAP_CATEGORIES | {"Recepcao"}}
        self.assertEqual({v.id for v in vols}, map_or_rec)
        rec = [a for a in res.assignments if a.category == "Recepcao"]
        self.assertEqual(len(rec), 51 - 21)
        self.assertTrue(any("vaga(s) a mais" in w for w in res.warnings))

    def test_entries_only_for_map_people(self):
        vols = make_volunteers(28, 14)
        res = run(vols)
        on_map = {a.volunteer_id for a in res.assignments if a.category in MAP_CATEGORIES}
        entry = {a.volunteer_id for a in res.assignments if a.category in ENTRY_CATEGORIES}
        self.assertTrue(entry <= on_map)
        fixed = {a.volunteer_id for a in res.assignments if a.position_code in ("BM", "BF")}
        self.assertFalse(entry & fixed)

    def test_exit_tasks_go_first_to_people_without_task(self):
        vols = make_volunteers(20, 10)  # 30: recepção 9 + banheiros fixos 2 = 11 sem entrada, 16 saídas
        res = run(vols)
        with_task = {a.volunteer_id for a in res.assignments if a.category in ENTRY_CATEGORIES | EXIT_CATEGORIES}
        self.assertEqual(with_task, {v.id for v in vols})

    def test_cant_reception_gets_map(self):
        vols = make_volunteers(30, 15)
        vols = [replace(v, can_recepcao=False) if v.id in (40, 41, 42) else v for v in vols]
        res = run(vols)
        on_map = {a.volunteer_id for a in res.assignments if a.category in MAP_CATEGORIES}
        self.assertTrue({40, 41, 42} <= on_map)

    def test_validate_flags_duplicate_exit_and_left_out(self):
        vols = make_volunteers(30, 15)
        res = run(vols)
        V = {v.id: v for v in vols}
        conf = next(a for a in res.assignments if a.category == "Confete")
        kitchen = next(a for a in res.assignments if a.category == "Cozinha")
        edited = [replace(a, volunteer_id=conf.volunteer_id, volunteer_name=conf.volunteer_name) if a is kitchen
                  else a for a in res.assignments]
        msgs = " ".join(i["message"] for i in validate(edited, V, POS, False))
        self.assertIn("mais de uma tarefa de saída", msgs)
        dropped = [a for a in res.assignments if a.volunteer_id != 1]
        msgs = " ".join(i["message"] for i in validate(dropped, V, POS, False, present_ids=set(V)))
        self.assertIn("Fora da escala", msgs)

    def test_altar_single_gender_alternates(self):
        vols = make_volunteers(30, 15)
        r1 = run(vols, history=HistoryContext(last_altar_gender="Feminino"))
        g = {vols[a.volunteer_id - 1].gender for a in r1.assignments if a.category == "Limpeza Altar"}
        self.assertEqual(g, {"Masculino"})
        r2 = run(vols, history=HistoryContext(last_altar_gender="Masculino"))
        g = {vols[a.volunteer_id - 1].gender for a in r2.assignments if a.category == "Limpeza Altar"}
        self.assertEqual(g, {"Feminino"})

    def test_rotation_avoids_same_map_position(self):
        vols = make_volunteers(30, 15)
        r1 = run(vols)
        last = {}
        for a in r1.assignments:
            last.setdefault(a.volunteer_id, set()).add(a.position_code)
        r2 = run(vols, history=HistoryContext(last_positions=last))
        for a in r2.assignments:
            if a.category == "Corredor":
                self.assertNotIn(a.position_code, last.get(a.volunteer_id, set()))

    def test_reception_goes_to_map_next(self):
        vols = make_volunteers(30, 15)
        r1 = run(vols)
        rec = {a.volunteer_id for a in r1.assignments if a.category == "Recepcao"}
        r2 = run(vols, history=HistoryContext(last_reception_ids=rec))
        corr = {a.volunteer_id for a in r2.assignments if a.category == "Corredor"}
        self.assertTrue(len(rec & corr) >= min(len(rec), len(corr)) - 2)

    def test_validate_flags_manual_errors(self):
        vols = make_volunteers(30, 15)
        res = run(vols)
        V = {v.id: v for v in vols}
        rec = next(a for a in res.assignments if a.category == "Recepcao")
        ent = next(a for a in res.assignments if a.category == "Cadeiras Entrada")
        edited = [replace(a, volunteer_id=rec.volunteer_id, volunteer_name=rec.volunteer_name) if a is ent else a
                  for a in res.assignments]
        msgs = " ".join(i["message"] for i in validate(edited, V, POS, False))
        self.assertIn("recepção", msgs)


if __name__ == "__main__":
    unittest.main()
