"""Banco SQLite (mesmo esquema do sistema antigo, com pequenas correções)."""
from __future__ import annotations

import json
import sqlite3
import unicodedata
from pathlib import Path
from typing import Iterable

from .config import DB_PATH, DEFAULT_POSITIONS, TEAM_OPTIONS
from .models import Assignment, Position, Volunteer

SCHEMA = """
CREATE TABLE IF NOT EXISTS volunteers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    gender TEXT NOT NULL CHECK (gender IN ('Masculino', 'Feminino')),
    team TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    observation TEXT,
    can_bercario INTEGER NOT NULL DEFAULT 0,
    can_cozinha INTEGER NOT NULL DEFAULT 1,
    can_recepcao INTEGER NOT NULL DEFAULT 1,
    can_banheiro INTEGER NOT NULL DEFAULT 1,
    can_limpar_altar INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS positions (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    allowed_gender TEXT NOT NULL DEFAULT 'Qualquer',
    quantity INTEGER NOT NULL DEFAULT 1,
    normal_active INTEGER NOT NULL DEFAULT 1,
    event_only INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS history_seed (
    volunteer_id INTEGER NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (volunteer_id, category)
);
CREATE TABLE IF NOT EXISTS history_position_seed (
    volunteer_id INTEGER NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
    position_code TEXT NOT NULL,
    category TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (volunteer_id, position_code)
);
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_date TEXT NOT NULL,
    service_type TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'rascunho',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS schedule_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    position_code TEXT NOT NULL,
    position_name TEXT NOT NULL,
    category TEXT NOT NULL,
    volunteer_id INTEGER NOT NULL REFERENCES volunteers(id),
    volunteer_name TEXT NOT NULL,
    item_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS presence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    volunteer_id INTEGER NOT NULL REFERENCES volunteers(id),
    confirmed INTEGER NOT NULL DEFAULT 0,
    absent INTEGER NOT NULL DEFAULT 0,
    justification TEXT,
    UNIQUE (schedule_id, volunteer_id)
);
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

# Marcador "data + id" usado para achar o último culto de cada voluntário
_MARK = "s.service_date || printf('%010d', s.id)"


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    _ensure_column(conn, "volunteers", "team", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "schedules", "team", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "schedules", "active_codes", "TEXT")
    _ensure_column(conn, "volunteers", "observation", "TEXT")
    _ensure_column(conn, "presence", "justification", "TEXT")
    _backfill_schedule_team(conn)
    seed_positions(conn)
    conn.commit()


def seed_positions(conn: sqlite3.Connection) -> None:
    codes = sorted({p.code for p in DEFAULT_POSITIONS})
    conn.execute(f"DELETE FROM positions WHERE code NOT IN ({_ph(codes)})", codes)
    for p in DEFAULT_POSITIONS:
        conn.execute(
            """
            INSERT INTO positions (code, name, category, allowed_gender, quantity, normal_active, event_only)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                name = excluded.name, category = excluded.category,
                allowed_gender = excluded.allowed_gender, quantity = excluded.quantity,
                normal_active = excluded.normal_active, event_only = excluded.event_only
            """,
            (p.code, p.name, p.category, p.allowed_gender, p.quantity, int(p.normal_active), int(p.event_only)),
        )


# ---------------------------------------------------------------- meta

def get_meta(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
    if not row or row["value"] is None:
        return default
    try:
        return json.loads(row["value"])
    except ValueError:
        return default


def set_meta(conn: sqlite3.Connection, key: str, value) -> None:
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )
    conn.commit()


# ---------------------------------------------------------------- voluntários

def get_volunteers(conn: sqlite3.Connection, active_only: bool = True, team: str | None = None) -> list[Volunteer]:
    sql = "SELECT * FROM volunteers"
    if active_only:
        sql += " WHERE active = 1"
    sql += " ORDER BY name COLLATE NOCASE"
    vols = [_volunteer_from_row(r) for r in conn.execute(sql)]
    if team:
        t = normalize_team(team)
        vols = [v for v in vols if normalize_team(v.team) == t]
    return vols


def get_available_teams(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT team, COUNT(*) AS total FROM volunteers WHERE active = 1 AND team <> '' "
        "GROUP BY team ORDER BY total DESC, team COLLATE NOCASE"
    )
    found = [r["team"] for r in rows]
    return sorted(set(found) | set(TEAM_OPTIONS))


def upsert_volunteer(conn: sqlite3.Connection, name: str, gender: str, team: str = "", active: bool = True,
                     can_bercario: bool | None = None, can_cozinha: bool = True, can_recepcao: bool = True,
                     can_banheiro: bool = True, can_limpar_altar: bool = True,
                     volunteer_id: int | None = None, observation: str | None = None) -> int:
    name = clean_name(name)
    if not name:
        raise ValueError("Informe o nome do voluntário.")
    gender = clean_gender(gender) or "Masculino"
    team = clean_team(team)
    if can_bercario is None:
        can_bercario = gender == "Feminino"
    obs = clean_text(observation)
    values = (name, gender, team, int(active), int(can_bercario), int(can_cozinha), int(can_recepcao),
              int(can_banheiro), int(can_limpar_altar), obs)
    if volunteer_id:
        conn.execute(
            "UPDATE volunteers SET name=?, gender=?, team=?, active=?, can_bercario=?, can_cozinha=?, "
            "can_recepcao=?, can_banheiro=?, can_limpar_altar=?, observation=? WHERE id=?",
            (*values, volunteer_id),
        )
        conn.commit()
        return int(volunteer_id)
    cur = conn.execute(
        "INSERT INTO volunteers (name, gender, team, active, can_bercario, can_cozinha, can_recepcao, "
        "can_banheiro, can_limpar_altar, observation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        values,
    )
    conn.commit()
    return int(cur.lastrowid)


def set_volunteer_active(conn: sqlite3.Connection, volunteer_id: int, active: bool) -> None:
    conn.execute("UPDATE volunteers SET active = ? WHERE id = ?", (int(active), volunteer_id))
    conn.commit()


def import_volunteer_rows(conn: sqlite3.Connection, rows: list[dict], with_history: bool) -> int:
    """Importa linhas lidas da BASE_TAREFAS.

    Voluntários novos são criados; os existentes só têm gênero/equipe atualizados.
    O histórico semente só é gravado quando ``with_history`` (banco vazio), para não
    duplicar contagens a cada abertura como acontecia no sistema antigo.
    """
    imported = 0
    for row in rows:
        name, gender = clean_name(row.get("name")), clean_gender(row.get("gender"))
        if not name or not gender:
            continue
        team = clean_team(row.get("team"))
        existing = conn.execute("SELECT id FROM volunteers WHERE name = ?", (name,)).fetchone()
        if existing:
            conn.execute("UPDATE volunteers SET gender = ?, team = ? WHERE id = ?", (gender, team, existing["id"]))
            continue
        cur = conn.execute(
            "INSERT INTO volunteers (name, gender, team, active, can_bercario) VALUES (?, ?, ?, 1, ?)",
            (name, gender, team, int(gender == "Feminino")),
        )
        imported += 1
        if with_history:
            vid = cur.lastrowid
            for category, count in (row.get("category_counts") or {}).items():
                conn.execute("INSERT OR REPLACE INTO history_seed (volunteer_id, category, count) VALUES (?, ?, ?)",
                             (vid, category, count))
            for code, (category, count) in (row.get("position_counts") or {}).items():
                conn.execute(
                    "INSERT OR REPLACE INTO history_position_seed (volunteer_id, position_code, category, count) "
                    "VALUES (?, ?, ?, ?)",
                    (vid, code, category, count),
                )
    conn.commit()
    return imported


# ---------------------------------------------------------------- posições

def get_positions(conn: sqlite3.Connection) -> list[Position]:
    return [_position_from_row(r) for r in conn.execute("SELECT * FROM positions ORDER BY code")]


# ---------------------------------------------------------------- histórico

def get_history_stats(conn: sqlite3.Connection, team: str | None = None) -> dict[int, dict]:
    vols = get_volunteers(conn, active_only=False, team=team)
    ids = sorted(v.id for v in vols)
    stats: dict[int, dict] = {i: {"counts": {}, "position_counts": {}, "total": 0} for i in ids}
    if not ids:
        return stats
    ph = _ph(ids)
    for r in conn.execute(f"SELECT volunteer_id, category, count FROM history_seed WHERE volunteer_id IN ({ph})", ids):
        item = stats[r["volunteer_id"]]
        item["counts"][r["category"]] = item["counts"].get(r["category"], 0) + int(r["count"])
        item["total"] += int(r["count"])
    for r in conn.execute(
            f"SELECT volunteer_id, position_code, count FROM history_position_seed WHERE volunteer_id IN ({ph})", ids):
        pc = stats[r["volunteer_id"]]["position_counts"]
        pc[r["position_code"]] = pc.get(r["position_code"], 0) + int(r["count"])
    for r in conn.execute(
            f"SELECT volunteer_id, category, position_code, COUNT(*) AS n FROM schedule_items "
            f"WHERE volunteer_id IN ({ph}) GROUP BY volunteer_id, category, position_code", ids):
        item = stats[r["volunteer_id"]]
        item["counts"][r["category"]] = item["counts"].get(r["category"], 0) + int(r["n"])
        item["position_counts"][r["position_code"]] = item["position_counts"].get(r["position_code"], 0) + int(r["n"])
        item["total"] += int(r["n"])
    return stats


def get_last_altar_gender(conn: sqlite3.Connection) -> str | None:
    row = conn.execute(
        """
        SELECT v.gender FROM schedule_items si
        JOIN schedules s ON s.id = si.schedule_id
        JOIN volunteers v ON v.id = si.volunteer_id
        WHERE si.category = 'Limpeza Altar'
        ORDER BY s.service_date DESC, s.id DESC, si.item_order ASC
        LIMIT 1
        """
    ).fetchone()
    return row["gender"] if row else None


def last_assignment_ids(conn: sqlite3.Connection, volunteer_ids: set[int], categories: set[str]) -> set[int]:
    """Voluntários que estavam nessas categorias no último culto em que alguma delas foi usada."""
    if not volunteer_ids or not categories:
        return set()
    cats, ids = sorted(categories), sorted(volunteer_ids)
    marker = conn.execute(
        f"SELECT MAX({_MARK}) AS m FROM schedule_items si JOIN schedules s ON s.id = si.schedule_id "
        f"WHERE si.category IN ({_ph(cats)}) AND si.volunteer_id IN ({_ph(ids)})",
        (*cats, *ids),
    ).fetchone()["m"]
    if not marker:
        return set()
    rows = conn.execute(
        f"SELECT si.volunteer_id FROM schedule_items si JOIN schedules s ON s.id = si.schedule_id "
        f"WHERE si.category IN ({_ph(cats)}) AND si.volunteer_id IN ({_ph(ids)}) AND {_MARK} = ?",
        (*cats, *ids, marker),
    )
    return {r["volunteer_id"] for r in rows}


def last_position_by_volunteer(conn: sqlite3.Connection, volunteer_ids: set[int]) -> dict[int, set[str]]:
    """Posições (códigos) que cada voluntário ocupou no seu último culto."""
    if not volunteer_ids:
        return {}
    ids = sorted(volunteer_ids)
    rows = conn.execute(
        f"""
        SELECT si.volunteer_id, si.position_code
        FROM schedule_items si
        JOIN schedules s ON s.id = si.schedule_id
        JOIN (
            SELECT si2.volunteer_id, MAX(s2.service_date || printf('%010d', s2.id)) AS marker
            FROM schedule_items si2 JOIN schedules s2 ON s2.id = si2.schedule_id
            WHERE si2.volunteer_id IN ({_ph(ids)})
            GROUP BY si2.volunteer_id
        ) last ON last.volunteer_id = si.volunteer_id AND last.marker = {_MARK}
        """,
        ids,
    )
    result: dict[int, set[str]] = {}
    for r in rows:
        result.setdefault(r["volunteer_id"], set()).add(r["position_code"])
    return result


# ---------------------------------------------------------------- escalas

def save_schedule(conn: sqlite3.Connection, service_date: str, service_type: str, team: str,
                  assignments: Iterable[Assignment], present_ids: Iterable[int],
                  all_volunteer_ids: Iterable[int], notes: str = "", status: str = "finalizada",
                  active_codes: Iterable[str] | None = None,
                  absent_reasons: dict[int, str] | None = None) -> int:
    """Salva a escala. Se já existir escala para a mesma data e equipe, ela é substituída
    (no sistema antigo cada clique gerava uma cópia e inflava o histórico).

    ``absent_reasons``: motivo da falta por voluntário (gravado em presence.justification)."""
    present = set(present_ids)
    reasons = absent_reasons or {}
    with conn:
        conn.execute("DELETE FROM schedules WHERE service_date = ? AND team = ?", (service_date, team))
        cur = conn.execute(
            "INSERT INTO schedules (service_date, service_type, notes, status, team, active_codes) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (service_date, service_type, notes, status, team,
             json.dumps(sorted(active_codes)) if active_codes is not None else None),
        )
        sid = int(cur.lastrowid)
        for a in assignments:
            conn.execute(
                "INSERT INTO schedule_items (schedule_id, position_code, position_name, category, volunteer_id, "
                "volunteer_name, item_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, a.position_code, a.position_name, a.category, a.volunteer_id, a.volunteer_name, a.order),
            )
        for vid in sorted(set(all_volunteer_ids) | present):
            ok = vid in present
            reason = None if ok else (clean_text(reasons.get(vid)) or None)
            conn.execute("INSERT INTO presence (schedule_id, volunteer_id, confirmed, absent, justification) "
                         "VALUES (?, ?, ?, ?, ?)", (sid, vid, int(ok), int(not ok), reason))
    return sid


def find_schedule(conn: sqlite3.Connection, service_date: str, team: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM schedules WHERE service_date = ? AND team = ? ORDER BY id DESC LIMIT 1",
        (service_date, team),
    ).fetchone()
    return int(row["id"]) if row else None


def get_schedule(conn: sqlite3.Connection, schedule_id: int
                 ) -> tuple[sqlite3.Row, list[Assignment], dict[int, str]]:
    """Escala salva: (cabeçalho, posições, {id de quem faltou: motivo})."""
    sched = conn.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,)).fetchone()
    items = [
        Assignment(r["position_code"], r["position_name"], r["category"], r["volunteer_id"], r["volunteer_name"],
                   r["item_order"])
        for r in conn.execute("SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY item_order", (schedule_id,))
    ]
    absent = {r["volunteer_id"]: r["justification"] or "" for r in
              conn.execute("SELECT volunteer_id, justification FROM presence WHERE schedule_id = ? AND absent = 1",
                           (schedule_id,))}
    return sched, items, absent


def list_schedules(conn: sqlite3.Connection, limit: int = 30) -> list[dict]:
    rows = conn.execute(
        "SELECT s.id, s.service_date, s.service_type, s.team, s.created_at, "
        "(SELECT COUNT(*) FROM schedule_items i WHERE i.schedule_id = s.id) AS itens, "
        "(SELECT COUNT(*) FROM presence p WHERE p.schedule_id = s.id AND p.absent = 1) AS faltas "
        "FROM schedules s ORDER BY s.service_date DESC, s.id DESC LIMIT ?",
        (limit,),
    )
    return [dict(r) for r in rows]


def service_info(conn: sqlite3.Connection) -> dict[int, dict]:
    """Quantas vezes cada voluntário serviu e a data da última vez."""
    rows = conn.execute(
        "SELECT si.volunteer_id, COUNT(DISTINCT s.id) AS vezes, MAX(s.service_date) AS ultima "
        "FROM schedule_items si JOIN schedules s ON s.id = si.schedule_id GROUP BY si.volunteer_id"
    )
    return {r["volunteer_id"]: {"vezes": int(r["vezes"]), "ultima": r["ultima"]} for r in rows}


def absence_info(conn: sqlite3.Connection) -> dict[int, dict]:
    """Total de faltas e data da última falta por voluntário."""
    rows = conn.execute(
        "SELECT p.volunteer_id, COUNT(*) AS total, MAX(s.service_date) AS ultima "
        "FROM presence p JOIN schedules s ON s.id = p.schedule_id WHERE p.absent = 1 GROUP BY p.volunteer_id"
    )
    return {r["volunteer_id"]: {"total": int(r["total"]), "ultima": r["ultima"]} for r in rows}


def absence_details(conn: sqlite3.Connection) -> dict[int, list[dict]]:
    """Cada falta registrada (mais recente primeiro): data, equipe e motivo."""
    rows = conn.execute(
        "SELECT p.volunteer_id, s.service_date, s.team, p.justification FROM presence p "
        "JOIN schedules s ON s.id = p.schedule_id WHERE p.absent = 1 "
        "ORDER BY s.service_date DESC, s.id DESC"
    )
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r["volunteer_id"], []).append(
            {"date": r["service_date"], "team": r["team"], "reason": r["justification"] or ""})
    return out


HISTORY_HEADERS = [
    "Voluntarios", "Genero", "Equipe", "Total_Faltas", "Ultima_Falta",
    "Cozinha", "Confete", "Banheiro (Entrada)", "Banheiro (Saída)",
    "Limpeza Altar", "Limpeza Confete", "Recepção",
    "POS_BM", "POS_GM", "POS_GF", "POS_BK", "POS_BF",
    *[f"POS_{i:02d}" for i in range(1, 23)],
]

_CATEGORY_COLUMN = {
    "Cozinha": "Cozinha",
    "Confete": "Confete",
    "Banheiro Entrada": "Banheiro (Entrada)",
    "Banheiro Saida": "Banheiro (Saída)",
    "Limpeza Altar": "Limpeza Altar",
    "Limpeza Conf": "Limpeza Confete",
    "Recepcao": "Recepção",
}


def _matrix_column(category: str, code: str) -> str | None:
    code = (code or "").strip().upper()
    if category in {"Corredor", "Galeria", "Banheiro", "Bercario"}:
        if code in {"BM", "GM", "GF", "BK", "BF"}:
            return f"POS_{code}"
        if code.isdigit():
            return f"POS_{code.zfill(2)}"
        return None
    return _CATEGORY_COLUMN.get(category)


def get_history_matrix(conn: sqlite3.Connection, team: str | None = None) -> list[dict]:
    vols = get_volunteers(conn, active_only=False, team=team)
    rows: dict[int, dict] = {}
    for v in vols:
        row = {h: 0 for h in HISTORY_HEADERS}
        row.update({"id": v.id, "Voluntarios": v.name, "Genero": v.gender, "Equipe": v.team, "Ultima_Falta": "",
                    "Ativo": v.active})
        rows[v.id] = row
    for r in conn.execute("SELECT volunteer_id, category, count FROM history_seed"):
        col = _CATEGORY_COLUMN.get(r["category"])
        if col and r["volunteer_id"] in rows:
            rows[r["volunteer_id"]][col] += int(r["count"])
    for r in conn.execute("SELECT volunteer_id, position_code, count FROM history_position_seed"):
        col = _matrix_column("Corredor", r["position_code"])
        if col and r["volunteer_id"] in rows:
            rows[r["volunteer_id"]][col] += int(r["count"])
    for r in conn.execute("SELECT volunteer_id, category, position_code, COUNT(*) AS n FROM schedule_items "
                          "GROUP BY volunteer_id, category, position_code"):
        col = _matrix_column(r["category"], r["position_code"])
        if col and r["volunteer_id"] in rows:
            rows[r["volunteer_id"]][col] += int(r["n"])
    for vid, info in absence_info(conn).items():
        if vid in rows:
            rows[vid]["Total_Faltas"] = info["total"]
            rows[vid]["Ultima_Falta"] = info["ultima"] or ""
    return sorted(rows.values(), key=lambda r: str(r["Voluntarios"]).lower())


# ---------------------------------------------------------------- utilitários

def _ph(items) -> str:
    return ", ".join("?" for _ in items)


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _backfill_schedule_team(conn: sqlite3.Connection) -> None:
    """Escalas do sistema antigo não guardavam a equipe: usa a equipe da maioria dos escalados."""
    conn.execute(
        """
        UPDATE schedules SET team = COALESCE((
            SELECT v.team FROM schedule_items si JOIN volunteers v ON v.id = si.volunteer_id
            WHERE si.schedule_id = schedules.id
            GROUP BY v.team ORDER BY COUNT(*) DESC LIMIT 1), '')
        WHERE team = ''
        """
    )


def _volunteer_from_row(r: sqlite3.Row) -> Volunteer:
    return Volunteer(r["id"], r["name"], r["gender"], r["team"], bool(r["active"]), bool(r["can_bercario"]),
                     bool(r["can_cozinha"]), bool(r["can_recepcao"]), bool(r["can_banheiro"]),
                     bool(r["can_limpar_altar"]), r["observation"] or "")


def _position_from_row(r: sqlite3.Row) -> Position:
    return Position(r["code"], r["name"], r["category"], r["allowed_gender"], int(r["quantity"]),
                    bool(r["normal_active"]), bool(r["event_only"]))


def normalize(value: object) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFD", str(value).strip().lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return " ".join(text.split())


def normalize_team(value: object) -> str:
    return normalize(value).replace("-", "_").replace(" ", "_")


def clean_name(value: object) -> str:
    return "" if value is None else " ".join(str(value).strip().split())


def clean_text(value: object, limit: int = 500) -> str:
    """Texto livre (observação, motivo): sem espaços sobrando e com tamanho limitado."""
    return "" if value is None else str(value).strip()[:limit]


def clean_gender(value: object) -> str | None:
    n = normalize(value)
    if n.startswith("masc"):
        return "Masculino"
    if n.startswith("fem"):
        return "Feminino"
    return None


def clean_team(value: object) -> str:
    raw = "" if value is None else str(value).strip()
    if not raw:
        return TEAM_OPTIONS[0]
    n = normalize_team(raw)
    for option in TEAM_OPTIONS:
        if normalize_team(option) == n:
            return option
    return raw
