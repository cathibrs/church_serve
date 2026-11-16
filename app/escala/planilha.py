"""Leitura e escrita de "POSICIONAMENTO E TAREFAS.xlsx" direto no XML (sem openpyxl e sem Excel).

Editar o XML preserva o mapa (formas, imagens e grupos), o que o openpyxl não faz.

O que é feito na planilha:
  * aba POSICIONAMENTO_ANTIGO oculta;
  * aba oculta LISTAS com os nomes (origem das listas suspensas);
  * listas suspensas em todas as células de posição (mapa, ficha e recepção);
  * bloco RECEPÇÃO na ficha (células REC_CELL_01..20);
  * formas POS_xx / REC_xx do desenho ligadas às células (trocar a célula troca o mapa);
  * campos extintos (Altar 5-8, Limpeza Confete 9-12) limpos e em cinza;
  * BASE_TAREFAS reescrita com todos os voluntários, coluna Total_Faltas e lista Falta (Sim).
"""
from __future__ import annotations

import posixpath
import re
import shutil
import uuid
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

from .config import ALTAR_SLOTS, LIMPEZA_CONFETE_MAX, RECEPTION_SLOTS

POS_SHEET = "POSICIONAMENTO"
BASE_SHEET = "BASE_TAREFAS"
OLD_SHEET = "POSICIONAMENTO_ANTIGO"
LIST_SHEET = "LISTAS"

# código da posição -> nome definido (célula) na planilha
CORRIDOR_FIELDS = {
    "01": "CORR1_POS_1", "02": "CORR1_POS_2", "03": "CORR1_POS_3", "04": "CORR1_POS_4", "BM": "CORR1_POS_BM",
    "05": "CORR2_POS_5", "06": "CORR2_POS_6", "07": "CORR2_POS_7", "GM": "CORR2_POS_GM",
    "08": "CORR3_POS_8", "09": "CORR3_POS_9",
    "10": "CORR4_POS_10", "11": "CORR4_POS_11", "12": "CORR4_POS_12",
    "13": "CORR5_POS_13", "14": "CORR5_POS_14", "15": "CORR5_POS_15",
    "16": "CORR6_POS_16", "17": "CORR6_POS_17", "18": "CORR6_POS_18", "GF": "CORR6_POS_GF", "BK": "CORR6_POS_BK",
    "19": "CORR7_POS_19", "20": "CORR7_POS_20", "21": "CORR7_POS_21", "22": "CORR7_POS_22", "BF": "CORR7_POS_BF",
}


def _ficha_fields() -> dict[str, str]:
    f = {}
    for sex in ("BM", "BF"):
        for kind in ("ENTRADA", "SAIDA"):
            for i in (1, 2):
                f[f"{sex}_{kind}_{i}"] = f"{sex}_{kind}_{i}"
    for i in range(1, ALTAR_SLOTS + 1):
        f[f"LA{i}"] = f"LIMPEZA_ALTAR_INICIO_{i}"
    for i in range(1, 17):
        f[f"CAD_ENV_ENTRADA_{i}"] = f"CAD_ENV_ENTRADA_{i}"
    for i in (1, 2):
        f[f"CONFETE_{i}"] = f"CONFETE_{i}"
        f[f"COZINHA_{i}"] = f"COZINHA_{i}"
    for i in range(1, LIMPEZA_CONFETE_MAX + 1):
        f[f"LIMPEZA_CONFETE_{i}"] = f"LIMPEZA_CONFETE_{i}"
    return f


FICHA_FIELDS = _ficha_fields()
DISABLED_FIELDS = ([f"LIMPEZA_ALTAR_INICIO_{i}" for i in range(ALTAR_SLOTS + 1, 9)]
                   + [f"LIMPEZA_CONFETE_{i}" for i in range(LIMPEZA_CONFETE_MAX + 1, 13)])

# Bloco da recepção na ficha (linhas 31-36, colunas Y..AB)
REC_HEADER_ROW = 31
REC_COLS = ["Y", "Z", "AA", "AB"]
REC_CELLS = {f"R{i:02d}": f"{REC_COLS[(i - 1) % 4]}{REC_HEADER_ROW + 1 + (i - 1) // 4}"
             for i in range(1, RECEPTION_SLOTS + 1)}

BASE_HEADERS = [
    "Equipe", "Voluntarios", "Genero", "Falta", "Data_Falta", "Total_Faltas",
    "Cozinha", "Confete", "Banheiro (Entrada)", "Banheiro (Saída)", "Limpeza Altar", "Limpeza Confete", "Recepção",
    "POS_BM", "POS_GM", "POS_GF", "POS_BK", "POS_BF", *[f"POS_{i:02d}" for i in range(1, 23)],
]

GRAY_RGB = "FFD9D9D9"


class PlanilhaEmUso(Exception):
    pass


# ====================================================================== pacote xlsx

class Book:
    def __init__(self, path: Path):
        with zipfile.ZipFile(path) as z:
            self.order = z.namelist()
            self.parts = {n: z.read(n) for n in self.order}
        self._sst = None

    def text(self, name: str) -> str:
        return self.parts[name].decode("utf-8")

    def put(self, name: str, content: str) -> None:
        if name not in self.parts:
            self.order.append(name)
        self.parts[name] = content.encode("utf-8")

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for n in self.order:
                z.writestr(n, self.parts[n])
        try:
            tmp.replace(path)
        except PermissionError as exc:
            tmp.unlink(missing_ok=True)
            raise PlanilhaEmUso(f"Feche a planilha '{path.name}' no Excel e tente de novo.") from exc

    # ---- estrutura
    def sheets(self) -> list[dict]:
        wb = self.text("xl/workbook.xml")
        rels = self._rels("xl/workbook.xml")
        out = []
        for m in re.finditer(r"<sheet\b[^>]*/>", wb):
            tag = m.group(0)
            name = _unxml(_attr(tag, "name"))
            rid = _attr(tag, "r:id")
            out.append({"name": name, "tag": tag, "rid": rid, "path": rels.get(rid)})
        return out

    def sheet_path(self, name: str) -> str | None:
        return next((s["path"] for s in self.sheets() if s["name"] == name), None)

    def _rels(self, part: str) -> dict[str, str]:
        base = posixpath.dirname(part)
        rel_name = posixpath.join(base, "_rels", posixpath.basename(part) + ".rels")
        if rel_name not in self.parts:
            return {}
        out = {}
        for m in re.finditer(r"<Relationship\b[^>]*/>", self.text(rel_name)):
            target = _attr(m.group(0), "Target")
            path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
            out[_attr(m.group(0), "Id")] = path
        return out

    def drawing_of(self, sheet_part: str) -> str | None:
        xml = self.text(sheet_part)
        m = re.search(r'<drawing r:id="([^"]+)"', xml)
        return self._rels(sheet_part).get(m.group(1)) if m else None

    def shared_strings(self) -> list[str]:
        if self._sst is None:
            self._sst = []
            if "xl/sharedStrings.xml" in self.parts:
                for si in re.findall(r"<si>(.*?)</si>", self.text("xl/sharedStrings.xml"), re.S):
                    self._sst.append(_unxml("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S))))
        return self._sst

    def defined_names(self) -> dict[str, str]:
        wb = self.text("xl/workbook.xml")
        return {m.group(1): _unxml(m.group(2)) for m in
                re.finditer(r'<definedName name="([^"]+)"[^>]*>([^<]*)</definedName>', wb)}

    def set_defined_name(self, name: str, ref: str, extra: str = "") -> None:
        wb = self.text("xl/workbook.xml")
        tag = f'<definedName name="{name}"{extra}>{escape(ref)}</definedName>'
        pat = re.compile(rf'<definedName name="{re.escape(name)}"[^>]*>[^<]*</definedName>')
        if pat.search(wb):
            wb = pat.sub(lambda _m: tag, wb, count=1)
        elif "<definedNames>" in wb:
            # Excel exige ordem alfabética só por convenção; inserir no fim é aceito
            wb = wb.replace("</definedNames>", tag + "</definedNames>", 1)
        else:
            wb = wb.replace("</sheets>", f"</sheets><definedNames>{tag}</definedNames>", 1)
        self.put("xl/workbook.xml", wb)


# ====================================================================== células

def col_to_idx(col: str) -> int:
    n = 0
    for ch in col:
        n = n * 26 + ord(ch) - 64
    return n


def idx_to_col(i: int) -> str:
    s = ""
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def split_ref(ref: str) -> tuple[str, int]:
    m = re.match(r"\$?([A-Z]+)\$?(\d+)", ref)
    return m.group(1), int(m.group(2))


class Sheet:
    """Edita <sheetData> preservando o resto do XML."""

    def __init__(self, xml: str):
        start = xml.index("<sheetData")
        end_tag = "</sheetData>"
        if re.search(r"<sheetData\s*/>", xml):
            m = re.search(r"<sheetData\s*/>", xml)
            self.head, body, self.tail = xml[:m.start()], "", xml[m.end():]
        else:
            open_end = xml.index(">", start) + 1
            close = xml.index(end_tag)
            self.head, body, self.tail = xml[:start], xml[open_end:close], xml[close + len(end_tag):]
        self.rows: dict[int, dict] = {}
        for m in re.finditer(r"<row\b([^>]*?)(/>|>(.*?)</row>)", body, re.S):
            attrs = re.sub(r'\s+spans="[^"]*"', "", m.group(1))
            r = int(_attr("<x" + attrs + ">", "r"))
            cells = {}
            for c in re.finditer(r"<c\b[^>]*?(?:/>|>.*?</c>)", m.group(3) or "", re.S):
                col, _ = split_ref(_attr(c.group(0), "r"))
                cells[col_to_idx(col)] = c.group(0)
            self.rows[r] = {"attrs": attrs, "cells": cells}

    def cell_xml(self, ref: str) -> str | None:
        col, row = split_ref(ref)
        return self.rows.get(row, {}).get("cells", {}).get(col_to_idx(col))

    def style(self, ref: str) -> str | None:
        c = self.cell_xml(ref)
        return _attr(c, "s") if c else None

    def set(self, ref: str, value, style: str | None = None, keep_style: bool = True) -> None:
        col, row = split_ref(ref)
        s = style if style is not None else (self.style(ref) if keep_style else None)
        s_attr = f' s="{s}"' if s else ""
        r = f"{col}{row}"
        if value is None or value == "":
            xml = f'<c r="{r}"{s_attr}/>'
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            xml = f'<c r="{r}"{s_attr}><v>{value}</v></c>'
        else:
            xml = f'<c r="{r}"{s_attr} t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>'
        self.rows.setdefault(row, {"attrs": f' r="{row}"', "cells": {}})["cells"][col_to_idx(col)] = xml

    def clear_rows(self, first: int) -> None:
        for r in [r for r in self.rows if r >= first]:
            del self.rows[r]

    def xml(self) -> str:
        out = []
        for r in sorted(self.rows):
            row = self.rows[r]
            cells = "".join(row["cells"][k] for k in sorted(row["cells"]))
            out.append(f"<row{row['attrs']}>{cells}</row>" if cells else f"<row{row['attrs']}/>")
        return f"{self.head}<sheetData>{''.join(out)}</sheetData>{self.tail}"


def _cell_value(cell_xml: str, sst: list[str]):
    t = _attr(cell_xml, "t")
    if t == "inlineStr":
        return _unxml("".join(re.findall(r"<t[^>]*>(.*?)</t>", cell_xml, re.S)))
    m = re.search(r"<v>(.*?)</v>", cell_xml, re.S)
    if not m:
        return None
    v = m.group(1)
    if t == "s":
        return sst[int(v)]
    if t in ("str", "e"):
        return _unxml(v)
    try:
        f = float(v)
        return int(f) if f.is_integer() else f
    except ValueError:
        return _unxml(v)


# ====================================================================== leitura (importação)

def read_base(path: Path) -> list[dict]:
    """Lê BASE_TAREFAS: nome, gênero, equipe, marca de falta e contagens do histórico."""
    if not path.exists():
        return []
    book = Book(path)
    part = book.sheet_path(BASE_SHEET) or book.sheet_path("TAREFAS")
    if not part:
        return []
    sheet = Sheet(book.text(part))
    sst = book.shared_strings()
    grid = {r: {c: _cell_value(x, sst) for c, x in row["cells"].items()} for r, row in sheet.rows.items()}
    if 1 not in grid:
        return []
    from .db import normalize
    header = {normalize(v): c for c, v in grid[1].items() if v not in (None, "")}

    def col(*names):
        return next((header[n] for n in names if n in header), None)

    c_name, c_gender, c_team = col("voluntarios", "voluntario", "nome"), col("genero"), col("equipe")
    c_falta, c_data = col("falta"), col("data_falta", "data falta")
    if c_name is None or c_gender is None:
        return []
    count_cols = {c: (_history_category(n), _history_code(n)) for n, c in header.items() if _history_category(n)}
    rows = []
    for r in sorted(grid):
        if r == 1:
            continue
        g = grid[r]
        name = g.get(c_name)
        if not name or normalize(name) == "falta":
            continue
        cat_counts, pos_counts = {}, {}
        for c, (cat, code) in count_cols.items():
            n = _as_int(g.get(c))
            if n <= 0:
                continue
            cat_counts[cat] = cat_counts.get(cat, 0) + n
            if code:
                pc = pos_counts.get(code, (cat, 0))
                pos_counts[code] = (pc[0], pc[1] + n)
        falta = g.get(c_falta) if c_falta else None
        rows.append({
            "name": name, "gender": g.get(c_gender), "team": g.get(c_team) if c_team else None,
            "falta": normalize(falta) in {"sim", "s", "x", "1", "true", "falta"} if falta not in (None, "") else False,
            "data_falta": _as_date(g.get(c_data)) if c_data else None,
            "category_counts": cat_counts, "position_counts": pos_counts,
        })
    return rows


def _history_category(h: str) -> str | None:
    if h in ("total_faltas", "falta", "data_falta"):
        return None
    if h == "cozinha":
        return "Cozinha"
    if h == "confete":
        return "Confete"
    if h in ("banheiro", "banheiro (entrada)"):
        return "Banheiro Entrada"
    if h == "banheiro (saida)":
        return "Banheiro Saida"
    if h.startswith(("pos_bm", "pos_bf")):
        return "Banheiro"
    if h.startswith(("pos_gm", "pos_gf")):
        return "Galeria"
    if h.startswith("pos_bk") or h == "fixo bercario":
        return "Bercario"
    if h.startswith("pos_") or h.startswith("corredor"):
        return "Corredor"
    if h == "limpeza altar":
        return "Limpeza Altar"
    if h in ("limpeza conf", "limpeza confete"):
        return "Limpeza Conf"
    if h == "recepcao":
        return "Recepcao"
    return None


def _history_code(h: str) -> str | None:
    if not h.startswith("pos_"):
        return None
    code = h[4:].strip().upper()
    if code.isdigit():
        return code.zfill(2)
    return code if code in {"BM", "GM", "GF", "BK", "BF"} else None


# ====================================================================== escrita

def export_workbook(template: Path, out_path: Path, fill: dict[str, str], names: list[str],
                    base_rows: list[dict], title: str = "") -> Path:
    """Copia o modelo para ``out_path`` e preenche as posições (código -> nome)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(template, out_path)
    book = Book(out_path)
    _apply(book, fill, names, base_rows, title)
    book.save(out_path)
    return out_path


def update_template(template: Path, names: list[str], base_rows: list[dict]) -> None:
    """Atualiza o modelo: estrutura (listas, faltas, aba oculta) sem mexer nos nomes do mapa."""
    book = Book(template)
    _apply(book, None, names, base_rows, None)
    book.save(template)


def _apply(book: Book, fill: dict[str, str] | None, names: list[str], base_rows: list[dict],
           title: str | None) -> None:
    _hide_sheet(book, OLD_SHEET)
    _write_list_sheet(book, names)
    _write_positions(book, fill, title)
    _write_base(book, base_rows)


# ---------------------------------------------------------------- workbook

def _hide_sheet(book: Book, name: str) -> None:
    wb = book.text("xl/workbook.xml")
    for s in book.sheets():
        if s["name"] == name and 'state="' not in s["tag"]:
            wb = wb.replace(s["tag"], s["tag"].replace("<sheet ", '<sheet state="hidden" ', 1))
    # a aba ativa não pode ser uma aba oculta: garante POSICIONAMENTO como ativa
    sheets = [s["name"] for s in book.sheets()]
    if POS_SHEET in sheets:
        idx = sheets.index(POS_SHEET)
        wb = re.sub(r'(<workbookView\b[^>]*?)\s+(?:activeTab|firstSheet)="\d+"', r"\1", wb)
        wb = re.sub(r"<workbookView\b", f'<workbookView activeTab="{idx}"', wb, count=1) if idx else wb
    book.put("xl/workbook.xml", wb)
    # aba oculta não pode ficar "selecionada"
    for s in book.sheets():
        if s["name"] != POS_SHEET and s["path"] in book.parts:
            x = book.text(s["path"])
            if 'tabSelected="1"' in x:
                book.put(s["path"], x.replace(' tabSelected="1"', ""))


def _write_list_sheet(book: Book, names: list[str]) -> None:
    part = book.sheet_path(LIST_SHEET)
    rows = ['<row r="1"><c r="A1" t="inlineStr"><is><t>Nomes</t></is></c></row>']
    for i, n in enumerate(names, start=2):
        rows.append(f'<row r="{i}"><c r="A{i}" t="inlineStr"><is><t xml:space="preserve">{escape(n)}</t></is></c></row>')
    xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
           '<cols><col min="1" max="1" width="28" customWidth="1"/></cols>'
           f'<sheetData>{"".join(rows)}</sheetData></worksheet>')
    if not part:
        n = 1
        while f"xl/worksheets/sheet{n}.xml" in book.parts:
            n += 1
        part = f"xl/worksheets/sheet{n}.xml"
        rels_name = "xl/_rels/workbook.xml.rels"
        rels = book.text(rels_name)
        ids = [int(x) for x in re.findall(r'Id="rId(\d+)"', rels)]
        rid = f"rId{max(ids, default=0) + 1}"
        rels = rels.replace("</Relationships>",
                            f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                            f'relationships/worksheet" Target="worksheets/sheet{n}.xml"/></Relationships>')
        book.put(rels_name, rels)
        ct = book.text("[Content_Types].xml").replace(
            "</Types>", f'<Override PartName="/{part}" ContentType="application/vnd.openxmlformats-officedocument.'
                        f'spreadsheetml.worksheet+xml"/></Types>')
        book.put("[Content_Types].xml", ct)
        wb = book.text("xl/workbook.xml")
        sheet_ids = [int(x) for x in re.findall(r'<sheet\b[^>]*sheetId="(\d+)"', wb)]
        wb = wb.replace("</sheets>", f'<sheet name="{LIST_SHEET}" sheetId="{max(sheet_ids) + 1}" state="hidden" '
                                     f'r:id="{rid}"/></sheets>', 1)
        book.put("xl/workbook.xml", wb)
    book.put(part, xml)
    book.set_defined_name("NOMES", f"{LIST_SHEET}!$A$2:$A${max(len(names) + 1, 2)}")


# ---------------------------------------------------------------- POSICIONAMENTO

def _write_positions(book: Book, fill: dict[str, str] | None, title: str | None) -> None:
    part = book.sheet_path(POS_SHEET)
    if not part:
        return
    sheet = Sheet(book.text(part))
    dn = book.defined_names()

    def ref_of(name: str) -> str | None:
        v = dn.get(name)
        if not v or "!" not in v:
            return None
        return v.split("!", 1)[1].replace("$", "").split(":")[0]

    data_style = sheet.style("Y27") or sheet.style("Y15")
    header_style = sheet.style("Y26")
    gray = _gray_style(book, data_style)

    # bloco da recepção
    sheet.set(f"Y{REC_HEADER_ROW}", "RECEPÇÃO (não fica na entrada)", style=header_style)
    for c, s in (("Z", sheet.style("Z26")), ("AA", sheet.style("AA26")), ("AB", sheet.style("AB26"))):
        sheet.set(f"{c}{REC_HEADER_ROW}", None, style=s)
    for code, ref in REC_CELLS.items():
        sheet.set(ref, None if fill is None else fill.get(code, ""), style=data_style, keep_style=False)
    for code, ref in REC_CELLS.items():
        book.set_defined_name(f"REC_CELL_{code[1:]}", f"{POS_SHEET}!${split_ref(ref)[0]}${split_ref(ref)[1]}")
    book.set_defined_name("FICHA_POSICIONAL", f"{POS_SHEET}!$X$1:$AC${REC_HEADER_ROW + 1 + (RECEPTION_SLOTS - 1) // 4 + 1}")

    # campos extintos
    for name in DISABLED_FIELDS:
        ref = ref_of(name)
        if ref:
            sheet.set(ref, None, style=gray)

    # células das posições
    targets: dict[str, str] = {}
    for code, name in {**CORRIDOR_FIELDS, **FICHA_FIELDS}.items():
        ref = ref_of(name)
        if ref:
            targets[code] = ref
    targets.update(REC_CELLS)
    if fill is not None:
        for code, ref in targets.items():
            sheet.set(ref, fill.get(code, ""))
        if title:
            sheet.set("B2", title)

    xml = sheet.xml()
    xml = _ensure_merge(xml, f"Y{REC_HEADER_ROW}:AB{REC_HEADER_ROW}")
    xml = _set_validations(xml, [(" ".join(sorted(set(targets.values()), key=_ref_key)), "NOMES")])
    book.put(part, xml)

    # mapa desenhado: liga as formas às células
    drawing = book.drawing_of(part)
    if drawing:
        shape_cells = {f"POS_{code}": targets[code] for code in CORRIDOR_FIELDS if code in targets}
        shape_cells.update({f"REC_{code[1:]}": REC_CELLS[code] for code in REC_CELLS})
        values = {}
        for shape, ref in shape_cells.items():
            values[shape] = _cell_text(sheet, ref, book.shared_strings())
        xml = _reception_shapes(book.text(drawing))
        book.put(drawing, _link_shapes(xml, shape_cells, values))


# Área das caixas REC_xx dentro do quadro RECEPÇÃO do desenho (coordenadas do grupo do mapa, em EMU).
# Originalmente 20 caixas em 2 colunas; agora RECEPTION_SLOTS caixas em 3 colunas de 10.
REC_AREA_LEFT, REC_AREA_RIGHT = 6832599, 10101102
REC_AREA_TOP, REC_ROW_STEP, REC_BOX_H = 11101871, 371728, 306000
REC_ROWS = 10
REC_FONT_SZ = 1200  # 12 pt (era 16 pt com 2 colunas)

_SP_RE = re.compile(r"<xdr:sp\b[^>]*>.*?</xdr:sp>", re.S)


def _reception_shapes(xml: str) -> str:
    """Cria as caixas REC_xx que faltam (copiando a REC_01) e distribui todas em colunas."""
    found: dict[str, re.Match] = {}
    for sp in _SP_RE.finditer(xml):
        nm = re.search(r'<xdr:cNvPr [^>]*name="([^"]+)"', sp.group(0))
        if nm and re.fullmatch(r"REC_\d+", nm.group(1)):
            found[nm.group(1)] = sp
    if "REC_01" not in found:
        return xml
    # 1) cria as que faltam logo depois da última REC existente
    template = found["REC_01"].group(0)
    next_id = max(int(x) for x in re.findall(r'<xdr:cNvPr id="(\d+)"', xml)) + 1
    clones = []
    for i in range(1, RECEPTION_SLOTS + 1):
        name = f"REC_{i:02d}"
        if name in found:
            continue
        sp = re.sub(r'(<xdr:cNvPr id=")\d+(" name=")REC_01(")', rf"\g<1>{next_id}\g<2>{name}\g<3>", template, count=1)
        sp = re.sub(r'(<a16:creationId [^>]*id=")\{[^}]+\}', rf"\g<1>{{{str(uuid.uuid4()).upper()}}}", sp, count=1)
        clones.append(sp)
        next_id += 1
    if clones:
        last = max(found.values(), key=lambda m: m.end())
        xml = xml[:last.end()] + "".join(clones) + xml[last.end():]
    # 2) reposiciona todas: coluna a coluna, 10 por coluna
    cols = -(-RECEPTION_SLOTS // REC_ROWS)
    col_w = (REC_AREA_RIGHT - REC_AREA_LEFT) // cols

    def place(m: re.Match) -> str:
        sp = m.group(0)
        nm = re.search(r'<xdr:cNvPr [^>]*name="(REC_(\d+))"', sp)
        if not nm:
            return sp
        i = int(nm.group(2)) - 1
        x = REC_AREA_LEFT + (i // REC_ROWS) * col_w
        y = REC_AREA_TOP + (i % REC_ROWS) * REC_ROW_STEP
        return re.sub(r'<a:off x="\d+" y="\d+"/><a:ext cx="\d+" cy="\d+"/>',
                      f'<a:off x="{x}" y="{y}"/><a:ext cx="{col_w}" cy="{REC_BOX_H}"/>', sp, count=1)

    return _SP_RE.sub(place, xml)


def _cell_text(sheet: Sheet, ref: str, sst: list[str]) -> str:
    x = sheet.cell_xml(ref)
    v = _cell_value(x, sst) if x else None
    return "" if v is None else str(v)


def _link_shapes(xml: str, shape_cells: dict[str, str], values: dict[str, str]) -> str:
    def repl(m: re.Match) -> str:
        sp = m.group(0)
        nm = re.search(r'<xdr:cNvPr [^>]*name="([^"]+)"', sp)
        if not nm or nm.group(1) not in shape_cells:
            return sp
        name = nm.group(1)
        sz = REC_FONT_SZ if name.startswith("REC_") else 1600
        col, row = split_ref(shape_cells[name])
        open_tag = re.match(r"<xdr:sp\b[^>]*>", sp).group(0)
        new_open = re.sub(r'\s+textlink="[^"]*"', "", open_tag)
        new_open = new_open[:-1] + f' textlink="${col}${row}">'
        sp = new_open + sp[len(open_tag):]
        text = escape(values.get(name, ""))
        run = (f'<a:rPr lang="pt-BR" sz="{sz}" b="1"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>'
               '<a:latin typeface="Calibri"/></a:rPr>')
        para = (f'<a:p><a:fld id="{{{str(uuid.uuid4()).upper()}}}" type="TxLink">{run}<a:t>{text}</a:t></a:fld>'
                f'<a:endParaRPr lang="pt-BR" sz="{sz}" b="1"/></a:p>')
        tb = re.search(r"<xdr:txBody>(<a:bodyPr\b[^>]*?(?:/>|>.*?</a:bodyPr>))(<a:lstStyle\s*/>|<a:lstStyle>.*?</a:lstStyle>)?"
                       r".*?</xdr:txBody>", sp, re.S)
        if not tb:
            return sp
        body = f"<xdr:txBody>{tb.group(1)}{tb.group(2) or '<a:lstStyle/>'}{para}</xdr:txBody>"
        return sp[:tb.start()] + body + sp[tb.end():]

    return re.sub(r"<xdr:sp\b[^>]*>.*?</xdr:sp>", repl, xml, flags=re.S)


def _ref_key(ref: str):
    col, row = split_ref(ref)
    return row, col_to_idx(col)


def _ensure_merge(xml: str, ref: str) -> str:
    if f'<mergeCell ref="{ref}"/>' in xml:
        return xml
    if "<mergeCells" in xml:
        xml = xml.replace("</mergeCells>", f'<mergeCell ref="{ref}"/></mergeCells>', 1)
        n = len(re.findall(r"<mergeCell ", xml))
        return re.sub(r'<mergeCells count="\d+"', f'<mergeCells count="{n}"', xml, count=1)
    return xml.replace("</sheetData>", f'</sheetData><mergeCells count="1"><mergeCell ref="{ref}"/></mergeCells>', 1)


def _set_validations(xml: str, rules: list[tuple[str, str]]) -> str:
    """rules: [(sqref, formula)]. Lista suspensa que também aceita digitar outro nome."""
    xml = re.sub(r"<dataValidations\b.*?</dataValidations>", "", xml, flags=re.S)
    body = "".join(
        f'<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="0" sqref="{sq}">'
        f'<formula1>{escape(f)}</formula1></dataValidation>' for sq, f in rules)
    block = f'<dataValidations count="{len(rules)}">{body}</dataValidations>'
    for anchor in ("<hyperlinks", "<printOptions", "<pageMargins", "<pageSetup", "<headerFooter", "<drawing",
                   "<legacyDrawing", "<tableParts", "<extLst", "</worksheet>"):
        i = xml.find(anchor)
        if i >= 0:
            return xml[:i] + block + xml[i:]
    return xml


def _gray_style(book: Book, base_xf: str | None) -> str:
    styles = book.text("xl/styles.xml")
    fill_xml = f'<fill><patternFill patternType="solid"><fgColor rgb="{GRAY_RGB}"/><bgColor indexed="64"/></patternFill></fill>'
    fills_block = re.search(r"<fills count=\"\d+\">(.*?)</fills>", styles, re.S)
    fills = re.findall(r"<fill>.*?</fill>|<fill/>", fills_block.group(1), re.S)
    if fill_xml in fills:
        fill_id = fills.index(fill_xml)
    else:
        fill_id = len(fills)
        new_block = f'<fills count="{fill_id + 1}">{fills_block.group(1)}{fill_xml}</fills>'
        styles = styles[:fills_block.start()] + new_block + styles[fills_block.end():]
    xfs_block = re.search(r"<cellXfs count=\"\d+\">(.*?)</cellXfs>", styles, re.S)
    xfs = re.findall(r"<xf\b[^>]*?(?:/>|>.*?</xf>)", xfs_block.group(1), re.S)
    base = xfs[int(base_xf)] if base_xf and int(base_xf) < len(xfs) else '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    new_xf = re.sub(r'fillId="\d+"', f'fillId="{fill_id}"', base)
    if 'applyFill="' not in new_xf:
        new_xf = new_xf.replace("<xf ", '<xf applyFill="1" ', 1)
    if new_xf in xfs:
        return str(xfs.index(new_xf))
    idx = len(xfs)
    new_block = f'<cellXfs count="{idx + 1}">{xfs_block.group(1)}{new_xf}</cellXfs>'
    styles = styles[:xfs_block.start()] + new_block + styles[xfs_block.end():]
    book.put("xl/styles.xml", styles)
    return str(idx)


# ---------------------------------------------------------------- BASE_TAREFAS

def _write_base(book: Book, base_rows: list[dict]) -> None:
    part = book.sheet_path(BASE_SHEET)
    if not part or not base_rows:
        return
    sheet = Sheet(book.text(part))
    head_style = sheet.style("A1") or sheet.style("B1")
    text_style = sheet.style("B2") or sheet.style("A2")
    num_style = sheet.style("F2") or text_style
    sheet.clear_rows(1)
    last_col = idx_to_col(len(BASE_HEADERS))
    for i, h in enumerate(BASE_HEADERS, start=1):
        sheet.set(f"{idx_to_col(i)}1", h, style=head_style)
    sheet.rows[1]["attrs"] = ' r="1" ht="15" customHeight="1"'
    for r, row in enumerate(base_rows, start=2):
        for i, h in enumerate(BASE_HEADERS, start=1):
            v = row.get(h, "")
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0 and h != "Total_Faltas":
                v = ""
            style = text_style if i <= 5 else num_style
            sheet.set(f"{idx_to_col(i)}{r}", v, style=style)
    n = len(base_rows) + 1
    xml = sheet.xml()
    xml = re.sub(r'<dimension ref="[^"]*"/>', f'<dimension ref="A1:{last_col}{n}"/>', xml, count=1)
    widths = {1: 22, 2: 20, 3: 11, 4: 7, 5: 12, 6: 12, 9: 18, 10: 16, 11: 14, 12: 15}
    cols = "".join(f'<col min="{i}" max="{i}" width="{widths.get(i, 12 if i < 14 else 9)}" customWidth="1"/>'
                   for i in range(1, len(BASE_HEADERS) + 1))
    xml = re.sub(r"<cols>.*?</cols>", f"<cols>{cols}</cols>", xml, count=1, flags=re.S)
    xml = re.sub(r"<autoFilter\b[^>]*/>|<autoFilter\b.*?</autoFilter>", "", xml, flags=re.S)
    xml = xml.replace("</sheetData>", f'</sheetData><autoFilter ref="A1:{last_col}{n}"/>', 1)
    xml = _set_validations(xml, [(f"D2:D{max(n, 2)}", '"Sim"')])
    # congela a linha do cabeçalho e as colunas de nome
    if "<pane " not in xml:
        xml = re.sub(r"(<sheetView\b[^>]*?)/>",
                     r'\1><pane xSplit="3" ySplit="1" topLeftCell="D2" activePane="bottomRight" state="frozen"/>'
                     r'<selection pane="bottomRight" activeCell="D2" sqref="D2"/></sheetView>', xml, count=1)
    book.put(part, xml)
    idx = [s["name"] for s in book.sheets()].index(BASE_SHEET)
    book.set_defined_name("_xlnm._FilterDatabase", f"{BASE_SHEET}!$A$1:${last_col}${n}",
                          extra=f' localSheetId="{idx}" hidden="1"')


# ====================================================================== utilitários

def _attr(tag: str, name: str) -> str | None:
    m = re.search(rf'\s{re.escape(name)}="([^"]*)"', tag)
    return m.group(1) if m else None


def _unxml(s: str | None) -> str:
    if s is None:
        return ""
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")
            .replace("&amp;", "&"))


def _as_int(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _as_date(v) -> str | None:
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return (date(1899, 12, 30) + timedelta(days=int(v))).isoformat()
    s = str(v).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None
