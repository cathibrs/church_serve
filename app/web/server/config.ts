/** Configuração do servidor: o catálogo fixo (equipes, posições, regras) e as datas. */
export * from "../shared/catalog.ts";

/** Fuso usado para "hoje" e para os horários mostrados (o servidor roda em UTC). */
export const TIME_ZONE = "America/Sao_Paulo";

// ---- datas (sempre texto AAAA-MM-DD, sem depender do fuso do servidor) ----
const WEEKDAY_NAMES = ["Domingo", "Segunda-Feira", "Terca-Feira", "Quarta-Feira", "Quinta-Feira", "Sexta-Feira", "Sabado"];

function utcDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error("Data inválida.");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1) throw new Error("Data inválida.");
  return d;
}

/** Valida e devolve a data como AAAA-MM-DD. */
export function isoDate(value: unknown): string {
  return utcDate(String(value)).toISOString().slice(0, 10);
}

export function weekdayName(iso: string): string {
  return WEEKDAY_NAMES[utcDate(iso).getUTCDay()];
}

/** Último domingo do mês: é domingo e o próximo domingo já é de outro mês. */
export function isLastSunday(iso: string): boolean {
  const d = utcDate(iso);
  if (d.getUTCDay() !== 0) return false;
  const next = new Date(d.getTime() + 7 * 86400000);
  return next.getUTCMonth() !== d.getUTCMonth();
}

/**
 * Regra do último domingo (recepção entrega os envelopes e não faz saída). Vale pela data e
 * pela equipe: a equipe de quarta não entrega envelopes, mesmo escalada num domingo.
 */
export function envelopeSunday(iso: string, team: string): boolean {
  return isLastSunday(iso) && !team.startsWith("Quarta");
}

export function teamForDate(iso: string): string {
  return utcDate(iso).getUTCDay() === 3 ? "Quarta-Feira_Noite_A" : "Domingo_Manha_A";
}

/** Data e hora de agora em São Paulo: { date: "AAAA-MM-DD", time: "HH:MM:SS" }. */
export function localNow(at: Date = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
