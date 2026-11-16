"""Ponto de entrada: python main.py (ou EscalaIgreja.exe)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from escala.config import DATA_DIR  # noqa: E402

# No exe sem console não há stdout/stderr: grava erros em data/escala.log
if sys.stdout is None or sys.stderr is None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _log = open(DATA_DIR / "escala.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

from escala.server import main  # noqa: E402

if __name__ == "__main__":
    main("--no-browser" not in sys.argv)
