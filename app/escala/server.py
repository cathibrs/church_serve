"""Servidor local (somente biblioteca padrão). Abre o navegador em http://127.0.0.1:8765."""
from __future__ import annotations

import json
import mimetypes
import os
import socket
import sys
import threading
import time
import traceback
import webbrowser
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import db, engine, planilha
from .config import (EXCEL_BASE_PATH, EXPORTS_DIR, TEAM_OPTIONS, is_last_sunday, resource_dir, team_for_date,
                     weekday_name)
from .models import Assignment

HOST, PORT = "127.0.0.1", int(os.environ.get("ESCALA_PORT") or 8765)
STATIC_DIR = resource_dir() / "static"
IDLE_SECONDS = 300  # fecha sozinho se o navegador ficar fechado por 5 min

_lock = threading.RLock()
_conn = None
_last_ping = time.time()
_startup_notes: list[str] = []


# ====================================================================== inicialização

def startup() -> None:
    global _conn
    from .config import DB_PATH, ROOT_DIR, ensure_seed_files
    try:
        if ensure_seed_files():
            _startup_notes.append(f"Primeira vez neste computador: os dados e as planilhas ficam em {ROOT_DIR}.")
    except OSError as exc:
        _startup_notes.append(f"Não consegui criar os arquivos iniciais em {ROOT_DIR}: {exc}")
    if not DB_PATH.exists() and not EXCEL_BASE_PATH.exists():
        _startup_notes.append(
            f"Atenção: a pasta {ROOT_DIR} não tem o banco (data/igreja_escala.db) nem a planilha. "
            "O programa abriu vazio."
        )
    _conn = db.connect()
    db.init_db(_conn)
    empty = _conn.execute("SELECT COUNT(*) FROM volunteers").fetchone()[0] == 0
    try:
        rows = planilha.read_base(EXCEL_BASE_PATH)
    except Exception as exc:  # planilha corrompida/aberta não impede o app de abrir
        rows = []
        _startup_notes.append(f"Não consegui ler a planilha: {exc}")
    if rows:
        n = db.import_volunteer_rows(_conn, rows, with_history=empty)
        if n:
            _startup_notes.append(f"{n} voluntário(s) novo(s) importado(s) da planilha.")
        marks = {r["name"]: r["data_falta"] or "" for r in rows if r["falta"]}
        db.set_meta(_conn, "faltas_planilha", marks)
    refresh_template(only_if_needed=True)


def refresh_template(only_if_needed: bool = False) -> str | None:
    """Atualiza estrutura e BASE_TAREFAS do modelo. Retorna aviso (ou None)."""
    if not EXCEL_BASE_PATH.exists():
        return "Planilha modelo não encontrada ao lado do programa."
    try:
        if only_if_needed:
            book = planilha.Book(EXCEL_BASE_PATH)
            prepared = book.sheet_path(planilha.LIST_SHEET) and "Total_Faltas" in book.text(
                book.sheet_path(planilha.BASE_SHEET) or "xl/workbook.xml")
            if prepared:
                return None
        names = sorted({v.name for v in db.get_volunteers(_conn)}, key=str.lower)
        planilha.update_template(EXCEL_BASE_PATH, names, base_rows())
    except planilha.PlanilhaEmUso as exc:
        return str(exc)
    except Exception as exc:
        traceback.print_exc()
        return f"Não consegui atualizar a planilha modelo: {exc}"
    return None


def base_rows() -> list[dict]:
    marks = db.get_meta(_conn, "faltas_planilha", {}) or {}
    rows = []
    for r in db.get_history_matrix(_conn):
        if not r.get("Ativo"):
            continue
        mark = r["Voluntarios"] in marks
        d = marks.get(r["Voluntarios"]) or ""
        rows.append({**r, "Falta": "Sim" if mark else "", "Data_Falta": _br(d) if d else ""})
    rows.sort(key=lambda r: (str(r["Equipe"]).lower(), str(r["Voluntarios"]).lower()))
    return rows


# ====================================================================== API

def api_init(_q):
    today = date.today()
    return {
        "today": today.isoformat(),
        "teams": db.get_available_teams(_conn),
        "team": _suggest_team(today),
        "positions": [p.to_dict() for p in db.get_positions(_conn)],
        "default_active": _default_active(),
        "notes": _startup_notes,
        "excel": str(EXCEL_BASE_PATH),
    }


def api_day(q):
    d = _date(q.get("date"))
    team = q.get("team") or _suggest_team(d)
    vols = db.get_volunteers(_conn, active_only=False, team=team)
    absences = db.absence_info(_conn)
    marks = db.get_meta(_conn, "faltas_planilha", {}) or {}
    sid = db.find_schedule(_conn, d.isoformat(), team)
    saved = None
    if sid:
        sched, items, absent = db.get_schedule(_conn, sid)
        codes = json.loads(sched["active_codes"]) if sched["active_codes"] else None
        saved = {"id": sid, "created_at": _local(sched["created_at"]), "assignments": [a.to_dict() for a in items],
                 "absent_ids": sorted(absent), "absent_reasons": {str(k): v for k, v in absent.items() if v},
                 "active_codes": codes,
                 "workbook": _workbook_path(d, team) if _workbook_path(d, team).exists() else None}
    marked_absent = [v.id for v in vols if v.name in marks and (not marks[v.name] or marks[v.name] == d.isoformat())]
    return {
        "date": d.isoformat(), "weekday": weekday_name(d), "last_sunday": is_last_sunday(d), "team": team,
        "suggested_team": _suggest_team(d),
        "volunteers": [{**v.to_dict(), "faltas": absences.get(v.id, {}).get("total", 0)} for v in vols],
        "marked_absent": marked_absent,
        "default_active": _default_active(),
        "saved": saved,
    }


def api_generate(body):
    d = _date(body.get("date"))
    team = body.get("team")
    present = {int(i) for i in body.get("present_ids", [])}
    codes = set(body["active_codes"]) if body.get("active_codes") is not None else None
    res = engine.generate_schedule(_conn, present, codes, team, d)
    return {"assignments": [a.to_dict() for a in res.assignments], "warnings": res.warnings,
            "issues": _validate(res.assignments, team, d, present)}


def api_validate(body):
    d = _date(body.get("date"))
    present = {int(i) for i in body.get("present_ids", [])}
    return {"issues": _validate(_assignments(body), body.get("team"), d, present)}


def api_save(body):
    d = _date(body.get("date"))
    team = body.get("team") or _suggest_team(d)
    present = {int(i) for i in body.get("present_ids", [])}
    assignments = _assignments(body)
    team_vols = db.get_volunteers(_conn, team=team)
    codes = body.get("active_codes")
    reasons = {int(k): str(v) for k, v in (body.get("absent_reasons") or {}).items() if v}
    sid = db.save_schedule(_conn, d.isoformat(), weekday_name(d), team, assignments, present,
                           [v.id for v in team_vols], active_codes=codes, absent_reasons=reasons)
    # marcações de falta vindas da planilha já usadas neste culto
    marks = db.get_meta(_conn, "faltas_planilha", {}) or {}
    team_names = {v.name for v in team_vols}
    marks = {n: dt for n, dt in marks.items() if not (n in team_names and (not dt or dt <= d.isoformat()))}
    db.set_meta(_conn, "faltas_planilha", marks)

    warnings = []
    fill = {a.position_code: a.volunteer_name for a in assignments}
    names = sorted({v.name for v in team_vols if v.id in present}, key=str.lower)
    out = _workbook_path(d, team)
    title = f"POSICIONAMENTO DOS VOLUNTÁRIOS - {_br(d.isoformat())} - {team.replace('_', ' ')}"
    path = None
    try:
        path = str(planilha.export_workbook(EXCEL_BASE_PATH, out, fill, names, base_rows(), title))
    except planilha.PlanilhaEmUso as exc:
        warnings.append(str(exc))
    except FileNotFoundError:
        warnings.append("Planilha modelo não encontrada; a escala foi salva só no sistema.")
    note = refresh_template()
    if note:
        warnings.append(note)
    return {"schedule_id": sid, "workbook": path, "warnings": warnings,
            "saved_at": datetime.now().strftime("%H:%M:%S")}


def api_volunteer(body):
    vid = db.upsert_volunteer(
        _conn, name=body.get("name", ""), gender=body.get("gender", "Masculino"), team=body.get("team", ""),
        active=bool(body.get("active", True)), can_bercario=bool(body.get("can_bercario")),
        can_cozinha=bool(body.get("can_cozinha", True)), can_recepcao=bool(body.get("can_recepcao", True)),
        can_banheiro=bool(body.get("can_banheiro", True)), can_limpar_altar=bool(body.get("can_limpar_altar", True)),
        volunteer_id=body.get("id") or None, observation=body.get("observation"))
    return {"id": vid}


def api_volunteers(q):
    team = q.get("team") or None
    absences = db.absence_info(_conn)
    served = db.service_info(_conn)
    return {"volunteers": [{**v.to_dict(), "faltas": absences.get(v.id, {}).get("total", 0),
                            "vezes": served.get(v.id, {}).get("vezes", 0),
                            "ultima_vez": served.get(v.id, {}).get("ultima")}
                           for v in db.get_volunteers(_conn, active_only=False, team=team)],
            "teams": db.get_available_teams(_conn)}


def api_positions_default(body):
    codes = sorted(set(body.get("codes") or []))
    db.set_meta(_conn, "posicoes_padrao", codes)
    return {"default_active": codes}


def api_history(q):
    team = q.get("team") or None
    schedules = db.list_schedules(_conn, 200)
    if team:
        schedules = [s for s in schedules if s["team"] == team]
    rows = db.get_history_matrix(_conn, team)
    active = [r for r in rows if r.get("Ativo")]
    total_abs = sum(s["faltas"] for s in schedules)
    kpis = {
        "escalas": len(schedules),
        "faltas": total_abs,
        "media_faltas": round(total_abs / len(schedules), 1) if schedules else 0,
        "ativos": len(active),
        "com_faltas": sum(1 for r in active if r["Total_Faltas"]),
    }
    ids = {r["id"] for r in rows}
    absences = {str(k): v for k, v in db.absence_details(_conn).items() if k in ids}
    return {"headers": db.HISTORY_HEADERS, "rows": rows, "schedules": schedules, "kpis": kpis,
            "absences": absences}


def api_open(body):
    target = Path(body.get("path") or EXPORTS_DIR)
    root = EXPORTS_DIR.parent.resolve()
    if not str(target.resolve()).startswith(str(root)):
        raise ValueError("Caminho inválido.")
    if not target.exists():
        target = EXPORTS_DIR
        target.mkdir(parents=True, exist_ok=True)
    os.startfile(str(target))  # type: ignore[attr-defined]
    return {"ok": True}


def api_quit(_body):
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"ok": True}


GET_ROUTES = {"/api/init": api_init, "/api/day": api_day, "/api/volunteers": api_volunteers,
              "/api/history": api_history}
POST_ROUTES = {"/api/positions/default": api_positions_default, "/api/generate": api_generate, "/api/validate": api_validate, "/api/save": api_save,
               "/api/volunteer": api_volunteer, "/api/open": api_open, "/api/quit": api_quit}


def _validate(assignments, team, d, present):
    vols = {v.id: v for v in db.get_volunteers(_conn, active_only=False, team=team or None)}
    pos = {p.code: p for p in db.get_positions(_conn)}
    absent = {vid for vid in vols if vid not in present} if present else set()
    must_place = {vid for vid in present if vid in vols and vols[vid].active}
    return engine.validate(assignments, vols, pos, is_last_sunday(d), absent, must_place)


def _assignments(body) -> list[Assignment]:
    pos = {p.code: p for p in db.get_positions(_conn)}
    out = []
    for i, a in enumerate(body.get("assignments", []), start=1):
        p = pos.get(a["position_code"])
        if not p or not a.get("volunteer_id"):
            continue
        out.append(Assignment(p.code, p.name, p.category, int(a["volunteer_id"]), a.get("volunteer_name", ""), i))
    return out


def _local(utc_text: str) -> str:
    """SQLite grava CURRENT_TIMESTAMP em UTC; converte para o horário local."""
    try:
        from datetime import timezone
        dt = datetime.strptime(utc_text[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return utc_text


def _workbook_path(d: date, team: str) -> Path:
    return EXPORTS_DIR / f"escala_{d.isoformat()}_{team}.xlsx"


def _default_active() -> list[str]:
    saved = db.get_meta(_conn, "posicoes_padrao")
    codes = {p.code for p in db.get_positions(_conn)}
    if saved:
        return [c for c in saved if c in codes]
    return [p.code for p in db.get_positions(_conn) if p.normal_active and not p.event_only]


def _suggest_team(d: date) -> str:
    """Equipe da última escala salva no mesmo dia da semana; senão, a padrão."""
    row = _conn.execute("SELECT team FROM schedules WHERE service_type = ? AND team <> '' "
                        "ORDER BY service_date DESC, id DESC LIMIT 1", (weekday_name(d),)).fetchone()
    return row["team"] if row else team_for_date(d)


def _date(value) -> date:
    if not value:
        return date.today()
    return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()


def _br(iso: str) -> str:
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%d/%m/%Y")
    except ValueError:
        return iso


# ====================================================================== HTTP

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silencioso
        pass

    def _send(self, code: int, payload: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, data, code=200):
        self._send(code, json.dumps(data, ensure_ascii=False, default=str).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _run(self, fn, arg):
        global _last_ping
        _last_ping = time.time()
        try:
            with _lock:
                self._json(fn(arg))
        except Exception as exc:
            traceback.print_exc()
            self._json({"error": str(exc)}, 500)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/ping":
            global _last_ping
            _last_ping = time.time()
            return self._json({"ok": True})
        if url.path in GET_ROUTES:
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            return self._run(GET_ROUTES[url.path], q)
        rel = "index.html" if url.path in ("/", "") else url.path.lstrip("/")
        f = (STATIC_DIR / rel).resolve()
        if not str(f).startswith(str(STATIC_DIR.resolve())) or not f.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(200, f.read_bytes(), ctype)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path not in POST_ROUTES:
            return self._json({"error": "rota inválida"}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json({"error": "JSON inválido"}, 400)
        self._run(POST_ROUTES[url.path], body)


def _port_in_use() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((HOST, PORT)) == 0


def _idle_watch():
    while True:
        time.sleep(30)
        if time.time() - _last_ping > IDLE_SECONDS:
            os._exit(0)


def main(open_browser: bool = True) -> None:
    url = f"http://{HOST}:{PORT}/"
    if _port_in_use():  # já está aberto: só mostra de novo
        webbrowser.open(url)
        return
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("font/woff2", ".woff2")
    mimetypes.add_type("image/svg+xml", ".svg")
    startup()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        threading.Thread(target=_idle_watch, daemon=True).start()
    print(f"Escala da Igreja rodando em {url}  (feche o navegador para encerrar)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main("--no-browser" not in sys.argv)
