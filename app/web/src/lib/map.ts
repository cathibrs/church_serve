import type { Position, Sheet, Volunteer } from "./api";
import { REC } from "./rules";
import { br, teamLabel } from "./utils";

export interface MapState {
  positions: Record<string, Position>;
  active: Set<string>;
  assign: Record<string, number>;
  vols: Record<number, Volunteer>;
  bad: Set<string>;
  day: Sheet | null;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const COLORS = {
  purple: { dark: "#7b3fb5", light: "#ede1fb", seat: "#a98ae0" },
  red: { dark: "#d32f2f", light: "#fcdcdc", seat: "#ec7b7b" },
  green: { dark: "#1f9e46", light: "#d6f1dd", seat: "#5cc27a" },
  yellow: { dark: "#c99a00", light: "#fff7cf", seat: "#f1d15e" },
  blue: { dark: "#1d8fd1", light: "#dbeffb", seat: "#5fb3e6" },
  orange: { dark: "#e0701c", light: "#fde8cf", seat: "#f3ab6a" },
} as const;
type ColorKey = keyof typeof COLORS;

const COLOR_OF: Record<string, ColorKey> = {};
(
  [
    ["purple", "01 02 03 04 BM"],
    ["red", "05 06 07 GM"],
    ["green", "08 09"],
    ["yellow", "10 11 12 13 14 15"],
    ["blue", "16 17 18 GF BK"],
    ["orange", "19 20 21 22 BF"],
  ] as [ColorKey, string][]
).forEach(([c, codes]) => codes.split(" ").forEach((k) => (COLOR_OF[k] = c)));

// [código, badgeX, badgeY, nomeX, nomeY, alinhamento, larguraMáx]
type Align = "start" | "end" | "vl" | "vr";
const LABELS: [string, number, number, number, number, Align, number][] = [
  ["04", 530, 452, 518, 474, "end", 330], ["22", 1276, 460, 1328, 482, "start", 350],
  ["03", 214, 500, 262, 523, "start", 212], ["07", 486, 508, 534, 531, "start", 175],
  ["12", 720, 514, 768, 537, "start", 175], ["15", 1158, 514, 1146, 537, "end", 175],
  ["18", 1376, 514, 1364, 537, "end", 150], ["21", 1578, 512, 1566, 535, "end", 140],
  ["02", 78, 726, 126, 749, "start", 158], ["06", 292, 728, 340, 751, "start", 126], ["09", 474, 728, 522, 751, "start", 150],
  ["17", 1436, 726, 1424, 749, "end", 160], ["20", 1640, 726, 1628, 749, "end", 140],
  ["11", 680, 760, 700, 880, "vl", 240], ["14", 1212, 760, 1222, 880, "vr", 240],
  ["01", 78, 1012, 126, 1035, "start", 158], ["05", 292, 1012, 340, 1035, "start", 126], ["08", 474, 1012, 522, 1035, "start", 185],
  ["10", 720, 1012, 768, 1035, "start", 175], ["13", 1158, 1012, 1146, 1035, "end", 175],
  ["16", 1436, 1012, 1424, 1035, "end", 160], ["19", 1640, 1012, 1628, 1035, "end", 140],
  ["BM", 32, 1062, 80, 1085, "start", 168], ["GM", 258, 1062, 306, 1085, "start", 340],
  ["GF", 1374, 1062, 1362, 1085, "end", 180], ["BK", 1374, 1158, 1362, 1181, "end", 180], ["BF", 1640, 1062, 1628, 1085, "end", 185],
];
// Recepção: até 20 nomes em 2 colunas; acima disso, 3 colunas (até 30).
const REC_LAYOUT = {
  2: { x: [748, 948], w: 172, font: 23 },
  3: { x: [700, 856, 1012], w: 146, font: 19 },
} as const;
const REC_Y0 = 1150;
const REC_DY = 33;
const REC_ROWS = 10;
const FONT = '"Inter Variable", "Segoe UI", Arial, sans-serif';

let _ctx: CanvasRenderingContext2D | null = null;
function fit(text: string, maxW: number, size = 24) {
  _ctx ??= document.createElement("canvas").getContext("2d");
  if (!_ctx) return "";
  _ctx.font = `700 ${size}px ${FONT}`;
  return _ctx.measureText(text).width > maxW ? ` textLength="${maxW}" lengthAdjust="spacingAndGlyphs"` : "";
}

function seats(c: ColorKey, shape: { x?: number; y?: number; w?: number; h?: number; points?: string }) {
  const col = COLORS[c];
  if (shape.points) {
    return `<polygon points="${shape.points}" fill="${col.light}" stroke="${col.dark}" stroke-opacity=".35" stroke-width="2" stroke-linejoin="round"/><polygon points="${shape.points}" fill="url(#seat-${c})"/>`;
  }
  const { x = 0, y = 0, w = 0, h = 0 } = shape;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${col.light}" stroke="${col.dark}" stroke-opacity=".35" stroke-width="2"/><rect x="${x + 8}" y="${y + 8}" width="${w - 16}" height="${h - 16}" fill="url(#seat-${c})"/>`;
}

function room(c: ColorKey, x: number, y: number, w: number, h: number, lines: string[]) {
  const col = COLORS[c];
  const cy = y + h / 2 - ((lines.length - 1) * 28) / 2 + 8;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${col.light}" stroke="${col.dark}" stroke-width="2.5"/>${lines
    .map((l, i) => `<text x="${x + w / 2}" y="${cy + i * 28}" class="room">${l}</text>`)
    .join("")}`;
}

export function mapSVG(s: MapState, forExport = false) {
  const pats = (Object.keys(COLORS) as ColorKey[])
    .map(
      (c) =>
        `<pattern id="seat-${c}" width="38" height="30" patternUnits="userSpaceOnUse"><rect x="6" y="5" width="26" height="20" rx="5" fill="${COLORS[c].seat}"/><rect x="9" y="5" width="20" height="5" rx="2" fill="#fff" fill-opacity=".35"/></pattern>`,
    )
    .join("");

  let labels = "";
  for (const [code, bx, by, nx, ny, al, maxW] of LABELS) {
    if (!s.positions[code]) continue;
    const on = s.active.has(code);
    if (forExport && !on) continue;
    const vid = s.assign[code];
    const name = vid ? (s.vols[vid]?.name ?? "?") : "";
    const bad = s.bad.has(code);
    const fill = !on ? "#c4c7cc" : bad ? "#dc2626" : COLORS[COLOR_OF[code]].dark;
    const txt = !on ? "+ ativar" : name || (forExport ? "" : "vazio");
    const cls = !on ? "nm off" : name ? (bad ? "nm bad" : "nm") : "nm empty";
    const f = name && on ? fit(txt, maxW) : "";
    const vertical = al === "vl" || al === "vr";
    const nameEl = vertical
      ? `<text x="${nx}" y="${ny}" class="${cls}" text-anchor="middle"${f} transform="rotate(${al === "vl" ? -90 : 90} ${nx} ${ny})">${esc(txt)}</text>`
      : `<text x="${nx}" y="${ny}" class="${cls}" text-anchor="${al}"${f}>${esc(txt)}</text>`;
    const hitX = al === "end" ? nx - maxW - 6 : al === "start" ? bx - 4 : nx - 20;
    const hitW = vertical ? 44 : al === "end" ? bx + 44 - hitX : maxW + 58;
    const hitH = vertical ? 250 : 36;
    labels += `<g class="slot" data-code="${code}"><rect class="hit" x="${hitX}" y="${by - 4}" width="${hitW}" height="${hitH}" rx="6" fill="transparent"/><rect x="${bx}" y="${by}" width="40" height="28" rx="6" fill="${fill}"/><text x="${bx + 20}" y="${by + 20}" class="badge-t">${code}</text>${nameEl}</g>`;
  }

  const recCodes = Object.keys(s.positions)
    .filter((k) => s.positions[k].category === REC)
    .sort();
  // na tela: as vagas até a última ativa/preenchida (mínimo 20); na exportação: só as preenchidas.
  // As vagas 21-30 são ligadas pela geração (quando falta lugar) ou pelo botão "Posições".
  const lastUsed = recCodes.reduce((m, c, i) => (s.active.has(c) || s.assign[c] ? i : m), -1);
  const recShown = forExport
    ? recCodes.filter((c) => s.active.has(c) && s.assign[c])
    : recCodes.slice(0, Math.min(recCodes.length, Math.max(lastUsed + 1, 20)));
  const lay = REC_LAYOUT[recShown.length > 20 ? 3 : 2];
  const cols = lay.x.length;
  const perCol = Math.max(REC_ROWS, Math.ceil(recShown.length / cols));
  const dy = (REC_DY * REC_ROWS) / perCol;
  let rec = "";
  recShown.forEach((code, i) => {
    const on = s.active.has(code);
    const vid = s.assign[code];
    const name = vid ? (s.vols[vid]?.name ?? "?") : "";
    const x = lay.x[i % cols];
    const y = REC_Y0 + Math.floor(i / cols) * dy;
    const bad = s.bad.has(code);
    const cls = !on ? "rn off" : name ? (bad ? "rn bad" : "rn") : "rn empty";
    const label = !on ? "+ ativar" : name || "vazio";
    rec += `<g class="slot" data-code="${code}"><rect class="hit" x="${x - 6}" y="${y - lay.font}" width="${lay.w + 12}" height="${dy - 2}" rx="5" fill="transparent"/><text x="${x}" y="${y}" class="${cls}" style="font-size:${on ? lay.font : 16}px"${name && on ? fit(name, lay.w, lay.font) : ""}>${esc(label)}</text></g>`;
  });
  const recWide = cols === 3;

  const d = s.day;
  const title = d
    ? `POSICIONAMENTO DOS VOLUNTÁRIOS — ${br(d.date)} — ${teamLabel(d.team)}`
    : "POSICIONAMENTO DOS VOLUNTÁRIOS";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 214 1720 1316" width="1720" height="1316" class="map-svg" font-family='${FONT}'>
<defs>${pats}
<linearGradient id="altar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffdf7"/><stop offset="1" stop-color="#efe3c8"/></linearGradient>
<style>
.badge-t{font:700 16px ${FONT};fill:#fff;text-anchor:middle}
.nm{font:700 24px ${FONT};fill:#0a0a0a;paint-order:stroke;stroke:#fff;stroke-width:6px;stroke-linejoin:round}
.nm.empty,.rn.empty{fill:#a3a3a3;font-weight:400;font-style:italic}
.nm.off,.rn.off{fill:#b5b5b5;font-weight:500;font-size:17px}
.nm.bad,.rn.bad{fill:#dc2626}
.rn{font:700 23px ${FONT};fill:#0a0a0a}
.room{font:700 22px ${FONT};fill:#262626;text-anchor:middle;letter-spacing:.5px}
.ttl{font:800 28px ${FONT};fill:#fff;text-anchor:middle;letter-spacing:.5px}
</style></defs>
<rect x="0" y="214" width="1720" height="1316" fill="#fff"/>
<rect x="20" y="226" width="1680" height="52" rx="10" fill="#0a0a0a"/>
<text x="860" y="262" class="ttl">${esc(title)}</text>
<rect x="4" y="290" width="1712" height="1232" rx="26" fill="none" stroke="#d4d4d4" stroke-width="2"/>
${seats("purple", { x: 160, y: 318, w: 420, h: 130 })}
<rect x="628" y="318" width="600" height="160" rx="24" fill="url(#altar)" stroke="#a3a3a3" stroke-width="2"/>
<rect x="922" y="330" width="12" height="62" rx="2" fill="#c9a15a"/><rect x="902" y="345" width="52" height="11" rx="2" fill="#c9a15a"/>
<text x="928" y="452" text-anchor="middle" font-size="56" font-weight="800" fill="#b38b4d" letter-spacing="8" font-family="Georgia, serif">ALTAR</text>
${seats("orange", { x: 1268, y: 318, w: 420, h: 135 })}
${seats("purple", { points: "84,702 372,702 452,540 164,540" })}
${seats("red", { points: "380,702 662,702 700,544 460,544" })}
${seats("yellow", { x: 714, y: 548, w: 492, h: 458 })}
${seats("blue", { points: "1258,548 1438,548 1476,706 1296,706" })}
${seats("orange", { points: "1452,548 1626,548 1666,706 1492,706" })}
${seats("purple", { x: 74, y: 760, w: 202, h: 244 })}
${seats("red", { x: 288, y: 760, w: 176, h: 244 })}
${seats("green", { x: 470, y: 760, w: 206, h: 244 })}
${seats("blue", { x: 1298, y: 760, w: 182, h: 244 })}
${seats("orange", { x: 1492, y: 760, w: 194, h: 244 })}
${room("purple", 30, 1094, 212, 170, ["BANHEIRO", "MASCULINO"])}
${room("red", 256, 1094, 410, 170, ["GALERIA MASCULINA"])}
${room("blue", 1176, 1094, 240, 52, ["GALERIA FEMININA"])}
${room("blue", 1178, 1190, 238, 76, ["BERÇÁRIO"])}
${room("orange", 1432, 1094, 256, 170, ["BANHEIRO", "FEMININO"])}
${
  recWide
    ? `<rect x="680" y="1046" width="490" height="460" rx="22" fill="#fafafa" stroke="#0a0a0a" stroke-width="2"/>
<text x="925" y="1092" class="room" font-size="28">RECEPÇÃO</text>
<line x1="848" y1="1110" x2="848" y2="1490" stroke="#d4d4d4" stroke-width="1.5"/><line x1="1004" y1="1110" x2="1004" y2="1490" stroke="#d4d4d4" stroke-width="1.5"/>`
    : `<rect x="724" y="1046" width="412" height="460" rx="22" fill="#fafafa" stroke="#0a0a0a" stroke-width="2"/>
<text x="930" y="1092" class="room" font-size="28">RECEPÇÃO</text>
<line x1="930" y1="1110" x2="930" y2="1490" stroke="#d4d4d4" stroke-width="1.5"/>`
}
${labels}${rec}
</svg>`;
}

// ------------------------------------------------------------------ ficha
export const FICHA: { side: "in" | "out"; title: string; groups: [string, string[]][] }[] = [
  {
    side: "in",
    title: "Entrada",
    groups: [
      ["Banheiro M", ["BM_ENTRADA_1", "BM_ENTRADA_2"]],
      ["Banheiro F", ["BF_ENTRADA_1", "BF_ENTRADA_2"]],
      ["Limpeza do altar", ["LA1", "LA2", "LA3", "LA4"]],
      ["Cadeiras e envelopes", Array.from({ length: 16 }, (_, i) => `CAD_ENV_ENTRADA_${i + 1}`)],
    ],
  },
  {
    side: "out",
    title: "Saída",
    groups: [
      ["Banheiro M", ["BM_SAIDA_1", "BM_SAIDA_2"]],
      ["Banheiro F", ["BF_SAIDA_1", "BF_SAIDA_2"]],
      ["Estourar confetes", ["CONFETE_1", "CONFETE_2"]],
      ["Cozinha", ["COZINHA_1", "COZINHA_2"]],
      ["Limpeza do confete", Array.from({ length: 8 }, (_, i) => `LIMPEZA_CONFETE_${i + 1}`)],
    ],
  },
];

const MOMENT_COLORS = {
  in: { head: "#065f46", label: "#064e3b", bar: "#059669", fill: "#ecfdf5", stroke: "#6ee7b7", title: "ENTRADA — ANTES DO CULTO" },
  out: { head: "#9a3412", label: "#7c2d12", bar: "#f97316", fill: "#fff7ed", stroke: "#fdba74", title: "SAÍDA — DEPOIS DO CULTO" },
  rec: { head: "#075985", label: "#0c4a6e", bar: "#0284c7", fill: "#f0f9ff", stroke: "#7dd3fc", title: "RECEPÇÃO" },
} as const;

export function fichaSVG(s: MapState) {
  const W = 900;
  const colW = (W - 60) / 4;
  const d = s.day!;
  let y = 80;
  let out = `<rect x="0" y="0" width="${W}" height="60" fill="#0a0a0a"/><text x="${W / 2}" y="39" class="t">FICHA POSICIONAL — ${br(d.date)} — ${esc(teamLabel(d.team))}</text>`;
  const cell = (x: number, yy: number, name: string, c: (typeof MOMENT_COLORS)[keyof typeof MOMENT_COLORS]) =>
    `<rect x="${x}" y="${yy}" width="${colW}" height="30" rx="5" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/><text x="${x + 10}" y="${yy + 20}" class="n">${esc(name)}</text>`;
  const rec = Object.keys(s.positions)
    .filter((c) => s.positions[c]?.category === REC && s.active.has(c) && s.assign[c])
    .sort();
  const sections = [
    ...FICHA.map((f) => ({ key: f.side as "in" | "out", groups: f.groups })),
    { key: "rec" as const, groups: [["", rec]] as [string, string[]][] },
  ];
  for (const sec of sections) {
    const c = MOMENT_COLORS[sec.key];
    out += `<rect x="20" y="${y}" width="${W - 40}" height="34" rx="6" fill="${c.head}"/><text x="34" y="${y + 23}" class="h">${c.title}</text>`;
    y += 46;
    for (const [lbl, codes] of sec.groups) {
      const act = codes.filter((code) => s.active.has(code));
      if (!act.length) continue;
      if (lbl) {
        out += `<rect x="20" y="${y}" width="4" height="20" rx="1" fill="${c.bar}"/><text x="32" y="${y + 15}" class="l" fill="${c.label}">${esc(lbl)}</text>`;
        y += 26;
      }
      act.forEach((code, i) => {
        const vid = s.assign[code];
        out += cell(20 + (i % 4) * (colW + 6.6), y + Math.floor(i / 4) * 36, vid ? (s.vols[vid]?.name ?? "") : "", c);
      });
      y += Math.ceil(act.length / 4) * 36 + 10;
    }
    y += 8;
  }
  y += 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${y}" width="${W}" height="${y}"><style>.t{font:800 22px ${FONT};text-anchor:middle;fill:#fff}.h{font:800 15px ${FONT};fill:#fff;letter-spacing:.6px}.l{font:800 16px ${FONT}}.n{font:600 15px ${FONT};fill:#0a0a0a}</style><rect width="${W}" height="${y}" fill="#fff"/>${out}</svg>`;
}

export function downloadPNG(svgText: string, filename: string, scale = 1.5) {
  return new Promise<void>((resolve, reject) => {
    const vb = svgText.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/)!;
    const w = Number(vb[1]);
    const h = Number(vb[2]);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w * scale;
      c.height = h * scale;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b!);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        resolve();
      }, "image/png");
    };
    img.onerror = () => reject(new Error("Não consegui gerar a imagem."));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
  });
}
