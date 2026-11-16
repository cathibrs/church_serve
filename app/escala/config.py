"""Configuração fixa: caminhos, equipes, posições e regras de quantidade."""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path


DB_NAME = "igreja_escala.db"
EXCEL_NAME = "POSICIONAMENTO E TAREFAS.xlsx"


def _documents_dir() -> Path:
    """Pasta Documentos do usuário (respeita redirecionamento para OneDrive)."""
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:  # CSIDL_PERSONAL
            return Path(buf.value)
    except Exception:
        pass
    return Path.home() / "Documents"


def _root_dir() -> Path:
    # Em desenvolvimento: a pasta acima de app/.
    if not getattr(sys, "frozen", False):
        return Path(__file__).resolve().parent.parent.parent
    # No exe: a pasta do executável, se ela já tem o banco ou a planilha (instalação existente).
    exe_dir = Path(sys.executable).resolve().parent
    if (exe_dir / "data" / DB_NAME).exists() or (exe_dir / EXCEL_NAME).exists():
        return exe_dir
    # Exe sozinho (Downloads, dentro de um zip...): os dados ficam em Documentos\EscalaIgreja.
    return _documents_dir() / "EscalaIgreja"


def resource_dir() -> Path:
    """Pasta dos arquivos estáticos (dentro do exe ou em app/)."""
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base)
    return Path(__file__).resolve().parent.parent


ROOT_DIR = Path(os.environ["ESCALA_ROOT"]) if os.environ.get("ESCALA_ROOT") else _root_dir()
DATA_DIR = ROOT_DIR / "data"
EXPORTS_DIR = ROOT_DIR / "exports"
DB_PATH = DATA_DIR / DB_NAME
EXCEL_BASE_PATH = ROOT_DIR / EXCEL_NAME
SEED_DIR = resource_dir() / "seed"  # cópia do banco e da planilha embutida no exe


def ensure_seed_files() -> list[str]:
    """Cria o banco e a planilha a partir da cópia embutida no exe, se faltarem."""
    created = []
    for src, dst in ((SEED_DIR / DB_NAME, DB_PATH), (SEED_DIR / EXCEL_NAME, EXCEL_BASE_PATH)):
        if src.exists() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            import shutil
            shutil.copyfile(src, dst)
            created.append(dst.name)
    return created

TEAM_OPTIONS = [
    "Domingo_Manha_A",
    "Domingo_Noite_A",
    "Domingo_Manha_B",
    "Domingo_Noite_B",
    "Quarta-Feira_Noite_A",
    "Quarta-Feira_Noite_B",
]

# Regras de quantidade pedidas
ALTAR_SLOTS = 4             # Limpeza do altar: sempre 4 pessoas
LIMPEZA_CONFETE_MAX = 8     # Limpeza do confete: no máximo 8 pessoas
RECEPTION_SLOTS = 30        # Campos REC_01..REC_30 do mapa
RECEPTION_DEFAULT_ON = 20   # REC_21..REC_30 ficam desligadas; a geração liga quando precisa

# Categorias
MAP_CATEGORIES = {"Banheiro", "Bercario", "Galeria", "Corredor"}
ENTRY_CATEGORIES = {"Banheiro Entrada", "Limpeza Altar", "Cadeiras Entrada"}
EXIT_CATEGORIES = {"Banheiro Saida", "Confete", "Cozinha", "Limpeza Conf"}
FICHA_CATEGORIES = ENTRY_CATEGORIES | EXIT_CATEGORIES
RECEPTION_CATEGORY = "Recepcao"
VISIBLE_MAP_CATEGORIES = MAP_CATEGORIES | {RECEPTION_CATEGORY}
BATHROOM_FIXED_CODES = {"BM", "BF"}

FUNCTION_ORDER = {
    "Banheiro": 10,
    "Bercario": 11,
    "Galeria": 12,
    "Corredor": 30,
    "Recepcao": 40,
    "Banheiro Entrada": 50,
    "Limpeza Altar": 51,
    "Cadeiras Entrada": 52,
    "Banheiro Saida": 60,
    "Confete": 61,
    "Cozinha": 62,
    "Limpeza Conf": 63,
}

CATEGORY_LABEL = {
    "Banheiro": "Banheiro",
    "Bercario": "Berçário",
    "Galeria": "Galeria",
    "Corredor": "Corredores",
    "Recepcao": "Recepção",
    "Banheiro Entrada": "Banheiro (entrada)",
    "Limpeza Altar": "Limpeza do altar",
    "Cadeiras Entrada": "Cadeiras e envelopes",
    "Banheiro Saida": "Banheiro (saída)",
    "Confete": "Confete",
    "Cozinha": "Cozinha",
    "Limpeza Conf": "Limpeza do confete",
}


@dataclass(frozen=True)
class PositionSeed:
    code: str
    name: str
    category: str
    allowed_gender: str = "Qualquer"
    quantity: int = 1
    normal_active: bool = True
    event_only: bool = False


EVENT_ONLY_CORRIDORS = {"04", "11", "14", "22"}


def _corridor_positions() -> list[PositionSeed]:
    seeds = []
    for number in range(1, 23):
        code = f"{number:02d}"
        event_only = code in EVENT_ONLY_CORRIDORS
        seeds.append(PositionSeed(code, f"Corredor {code}", "Corredor",
                                  normal_active=not event_only, event_only=event_only))
    return seeds


def _special_positions() -> list[PositionSeed]:
    return [
        PositionSeed("BM", "Banheiro Masculino", "Banheiro", "Masculino"),
        PositionSeed("BF", "Banheiro Feminino", "Banheiro", "Feminino"),
        PositionSeed("BK", "Bercario", "Bercario", "Feminino"),
        PositionSeed("GM", "Galeria Masculina", "Galeria", "Masculino", normal_active=False, event_only=True),
        PositionSeed("GF", "Galeria Feminina", "Galeria", "Feminino", normal_active=False, event_only=True),
    ]


def _reception_positions() -> list[PositionSeed]:
    return [PositionSeed(f"R{i:02d}", f"Recepcao {i:02d}", "Recepcao", normal_active=i <= RECEPTION_DEFAULT_ON)
            for i in range(1, RECEPTION_SLOTS + 1)]


def _bathroom_task_positions() -> list[PositionSeed]:
    seeds = []
    for sex, gender, label in (("BM", "Masculino", "Masculino"), ("BF", "Feminino", "Feminino")):
        for kind, cat in (("ENTRADA", "Banheiro Entrada"), ("SAIDA", "Banheiro Saida")):
            for i in (1, 2):
                seeds.append(PositionSeed(f"{sex}_{kind}_{i}", f"Banheiro {label} {kind.title()} {i}", cat, gender))
    return seeds


def _task_positions() -> list[PositionSeed]:
    return [
        *[PositionSeed(f"CAD_ENV_ENTRADA_{i}", f"Cadeiras e Envelopes Entrada {i}", "Cadeiras Entrada")
          for i in range(1, 17)],
        *[PositionSeed(f"LA{i}", f"Limpeza Altar {i}", "Limpeza Altar") for i in range(1, ALTAR_SLOTS + 1)],
        PositionSeed("COZINHA_1", "Cozinha 1", "Cozinha"),
        PositionSeed("COZINHA_2", "Cozinha 2", "Cozinha"),
        PositionSeed("CONFETE_1", "Confete 1", "Confete"),
        PositionSeed("CONFETE_2", "Confete 2", "Confete"),
        *[PositionSeed(f"LIMPEZA_CONFETE_{i}", f"Limpeza Confete {i}", "Limpeza Conf")
          for i in range(1, LIMPEZA_CONFETE_MAX + 1)],
    ]


DEFAULT_POSITIONS: list[PositionSeed] = [
    *_corridor_positions(),
    *_special_positions(),
    *_reception_positions(),
    *_bathroom_task_positions(),
    *_task_positions(),
]


# ---- datas ----
WEEKDAY_NAMES = ["Segunda-Feira", "Terca-Feira", "Quarta-Feira", "Quinta-Feira",
                 "Sexta-Feira", "Sabado", "Domingo"]


def weekday_name(value: date) -> str:
    return WEEKDAY_NAMES[value.weekday()]


def is_last_sunday(value: date) -> bool:
    """Último domingo do mês: é domingo e o próximo domingo já é de outro mês."""
    return value.weekday() == 6 and (value + timedelta(days=7)).month != value.month


def team_for_date(value: date) -> str:
    if value.weekday() == 2:
        return "Quarta-Feira_Noite_A"
    return "Domingo_Manha_A"
