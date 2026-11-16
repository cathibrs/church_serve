import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { motion } from "motion/react";
import { CalendarCheck, ChevronRight, Search, TrendingDown, UserX, Users } from "lucide-react";
import { api, type AbsenceItem, type HistoryData, type InitData } from "@/lib/api";
import { br, cn, normalize, teamLabel } from "@/lib/utils";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";

const TASKS = ["Cozinha", "Confete", "Banheiro (Entrada)", "Banheiro (Saída)", "Limpeza Altar", "Limpeza Confete", "Recepção"];
const TASK_SHORT: Record<string, string> = {
  Cozinha: "Coz",
  Confete: "Conf",
  "Banheiro (Entrada)": "Ban E",
  "Banheiro (Saída)": "Ban S",
  "Limpeza Altar": "Altar",
  "Limpeza Confete": "L.Conf",
  "Recepção": "Rec",
};

export function HistoricoPage({ init, onOpen }: { init: InitData; onOpen: (date: string, team: string) => void }) {
  const [team, setTeam] = useState("all");
  const [data, setData] = useState<HistoryData | null>(null);
  const [q, setQ] = useState("");
  const [onlyAbs, setOnlyAbs] = useState(false);

  useEffect(() => {
    api
      .history(team === "all" ? "" : team)
      .then(setData)
      .catch((e) => toast.error(e.message));
  }, [team]);

  const rows = useMemo(() => {
    const nq = normalize(q);
    return (data?.rows ?? []).filter(
      (r) => r.Ativo && (!nq || normalize(r.Voluntarios).includes(nq)) && (!onlyAbs || r.Total_Faltas > 0),
    );
  }, [data, q, onlyAbs]);
  const posCols = (data?.headers ?? []).filter((h) => h.startsWith("POS_"));
  const ranking = useMemo(
    () => (data?.rows ?? []).filter((r) => r.Ativo && r.Total_Faltas > 0).sort((a, b) => b.Total_Faltas - a.Total_Faltas),
    [data],
  );
  const maxAbs = Math.max(1, ...ranking.map((r) => r.Total_Faltas));
  const sched = data?.schedules ?? [];
  const recent = [...sched].reverse().slice(-16);
  const maxSchedAbs = Math.max(1, ...recent.map((s) => s.faltas));
  const maxCell = useMemo(() => {
    let m = 1;
    rows.forEach((r) => [...TASKS, ...posCols].forEach((h) => (m = Math.max(m, Number(r[h]) || 0))));
    return m;
  }, [rows, posCols]);

  const k = data?.kpis;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background/85 px-5 py-2.5 backdrop-blur">
        <div className="mr-auto">
          <h1 className="text-[15px] leading-tight font-semibold">Histórico e faltas</h1>
          <p className="text-xs text-muted-foreground">Quem serviu em quê, quantas vezes, e quem mais falta.</p>
        </div>
        <Select value={team} onValueChange={setTeam}>
          <SelectTrigger className="w-[210px]">
            <Users className="size-4 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as equipes</SelectItem>
            {init.teams.map((t) => (
              <SelectItem key={t} value={t}>
                {teamLabel(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-3">
        {/* indicadores */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Kpi icon={<CalendarCheck />} label="Escalas salvas" value={k?.escalas} />
          <Kpi icon={<UserX />} label="Faltas registradas" value={k?.faltas} tone="bad" />
          <Kpi icon={<TrendingDown />} label="Média de faltas por culto" value={k?.media_faltas} />
          <Kpi icon={<Users />} label="Voluntários ativos" value={k?.ativos} />
          <Kpi icon={<UserX />} label="Ativos com alguma falta" value={k?.com_faltas} />
        </div>

        {/* ranking + escalas + faltas por culto */}
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="flex h-[300px] flex-col overflow-hidden">
            <CardHeader className="min-h-10 py-1.5">
              <CardTitle>Quem mais faltou</CardTitle>
              <span className="text-xs text-muted-foreground">{ranking.length} pessoa(s)</span>
            </CardHeader>
            <div className="min-h-0 flex-1 space-y-[3px] overflow-y-auto px-3 py-2">
              {ranking.map((r, i) => (
                <Tooltip key={r.id} side="right" content={<AbsenceList items={data?.absences[String(r.id)]} />}>
                <div className="grid cursor-default grid-cols-[120px_1fr_24px] items-center gap-2 text-xs">
                  <span className="truncate text-right">{r.Voluntarios}</span>
                  <div className="h-3 rounded-sm bg-muted">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${(r.Total_Faltas / maxAbs) * 100}%` }}
                      transition={{ duration: 0.5, delay: Math.min(i * 0.015, 0.4) }}
                      className="h-full rounded-sm bg-red-500"
                    />
                  </div>
                  <b className="tabular-nums">{r.Total_Faltas}</b>
                </div>
                </Tooltip>
              ))}
              {!ranking.length && <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma falta registrada.</p>}
            </div>
          </Card>

          <Card className="flex h-[300px] flex-col overflow-hidden">
            <CardHeader className="min-h-10 py-1.5">
              <CardTitle>Escalas salvas</CardTitle>
              <span className="text-xs text-muted-foreground">clique para abrir</span>
            </CardHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/90 text-muted-foreground">
                  <tr className="h-7 text-left [&>th]:font-medium">
                    <th className="pl-3">Data</th>
                    <th>Equipe</th>
                    <th className="text-center">Posições</th>
                    <th className="text-center">Faltas</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sched.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => s.team && onOpen(s.service_date, s.team)}
                      className="group h-7 cursor-pointer border-t hover:bg-muted/50"
                    >
                      <td className="pl-3 tabular-nums">
                        {br(s.service_date)} <span className="text-muted-foreground">{s.service_type.slice(0, 3)}</span>
                      </td>
                      <td className="truncate">{teamLabel(s.team)}</td>
                      <td className="text-center tabular-nums">{s.itens}</td>
                      <td className={cn("text-center tabular-nums", s.faltas && "font-semibold text-red-600")}>{s.faltas}</td>
                      <td className="pr-2 text-right">
                        <ChevronRight className="inline size-3.5 opacity-0 transition group-hover:opacity-60" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="flex h-[300px] flex-col overflow-hidden">
            <CardHeader className="min-h-10 py-1.5">
              <CardTitle>Faltas por culto</CardTitle>
              <span className="text-xs text-muted-foreground">últimos {recent.length}</span>
            </CardHeader>
            <div className="flex min-h-0 flex-1 items-end gap-1 px-3 pt-3 pb-1">
              {recent.map((s, i) => (
                <Tooltip key={s.id} content={`${br(s.service_date)} · ${teamLabel(s.team)} · ${s.faltas} falta(s)`}>
                  <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-[11px] font-semibold tabular-nums">{s.faltas}</span>
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: `${(s.faltas / maxSchedAbs) * 100}%` }}
                      transition={{ duration: 0.5, delay: i * 0.02 }}
                      className="w-full max-w-7 rounded-t-sm bg-neutral-900"
                    />
                  </div>
                </Tooltip>
              ))}
            </div>
            <div className="flex gap-1 px-3 pb-2">
              {recent.map((s, i) => (
                <span key={s.id} style={{ visibility: recent.length > 10 && i % 2 ? "hidden" : "visible" }} className="min-w-0 flex-1 overflow-visible text-center text-[11px] tracking-tight whitespace-nowrap text-muted-foreground tabular-nums">
                  {br(s.service_date).slice(0, 5)}
                </span>
              ))}
            </div>
          </Card>
        </div>

        {/* matriz */}
        <Card className="overflow-hidden">
          <CardHeader className="min-h-10 py-1.5">
            <CardTitle>
              Quantas vezes cada um serviu em cada função
              <span className="text-xs font-normal text-muted-foreground">· {rows.length} pessoa(s)</span>
            </CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" className="h-8 w-44 pl-8 text-[13px]" />
              </div>
              <Label className="h-8 rounded-md border border-input px-2.5 text-xs">
                <Switch checked={onlyAbs} onCheckedChange={setOnlyAbs} /> Só com faltas
              </Label>
            </div>
          </CardHeader>
          <div className="max-h-[calc(100vh-150px)] overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
                <tr className="h-6 text-[11px] tracking-wide uppercase">
                  <th className="sticky left-0 z-20 bg-muted" colSpan={3} />
                  <th className="border-l px-1" colSpan={TASKS.length}>
                    Tarefas
                  </th>
                  <th className="border-l px-1" colSpan={posCols.length}>
                    Posições do mapa
                  </th>
                </tr>
                <tr className="h-7 whitespace-nowrap [&>th]:font-medium">
                  <th className="sticky left-0 z-20 min-w-[150px] bg-muted pl-3 text-left">Voluntário</th>
                  <th className="px-1 text-left">Equipe</th>
                  <th className="px-1 text-center">Faltas</th>
                  {TASKS.map((t, i) => (
                    <th key={t} className={cn("px-1 text-center", i === 0 && "border-l")} title={t}>
                      {TASK_SHORT[t]}
                    </th>
                  ))}
                  {posCols.map((p, i) => (
                    <th key={p} className={cn("w-7 px-0.5 text-center", i === 0 && "border-l")}>
                      {p.slice(4)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="h-6 border-t hover:bg-muted/40">
                    <td className="sticky left-0 z-[1] truncate bg-card pl-3 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <i className={cn("size-1.5 rounded-full", r.Genero === "Feminino" ? "bg-rose-500" : "bg-sky-600")} />
                        {r.Voluntarios}
                      </span>
                    </td>
                    <td className="truncate px-1 text-muted-foreground">{teamLabel(String(r.Equipe)).replace("Domingo ", "Dom ").replace("Quarta-Feira ", "Qua ")}</td>
                    <td className="px-1 text-center">
                      {r.Total_Faltas ? (
                        <Tooltip side="right" content={<AbsenceList items={data?.absences[String(r.id)]} />}>
                          <b className="cursor-default text-red-600 tabular-nums">{r.Total_Faltas}</b>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground/40">·</span>
                      )}
                    </td>
                    {[...TASKS, ...posCols].map((h, i) => {
                      const v = Number(r[h]) || 0;
                      return (
                        <td
                          key={h}
                          className={cn("px-0.5 text-center tabular-nums", (i === 0 || i === TASKS.length) && "border-l")}
                          style={v ? { background: `oklch(0.55 0 0 / ${0.08 + (v / maxCell) * 0.42})` } : undefined}
                        >
                          {v || <span className="text-muted-foreground/30">·</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Faltas de uma pessoa com data e motivo (mais recentes primeiro). */
function AbsenceList({ items }: { items?: AbsenceItem[] }) {
  if (!items?.length) return null;
  const shown = items.slice(0, 8);
  return (
    <div className="space-y-0.5 py-0.5">
      <div className="font-semibold">Faltas</div>
      {shown.map((a, i) => (
        <div key={i} className="flex gap-2">
          <span className="tabular-nums opacity-80">{br(a.date)}</span>
          <span>{a.reason || <i className="opacity-60">sem motivo</i>}</span>
        </div>
      ))}
      {items.length > shown.length && <div className="opacity-70">+ {items.length - shown.length} anterior(es)</div>}
    </div>
  );
}

function Kpi({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value?: number; tone?: "bad" }) {
  return (
    <Card className="flex items-center gap-3 px-3.5 py-2.5">
      <span
        className={cn(
          "flex size-8 items-center justify-center rounded-md [&>svg]:size-4",
          tone === "bad" ? "bg-destructive-soft text-destructive" : "bg-muted text-foreground",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-lg leading-tight font-semibold tabular-nums">{value ?? "–"}</div>
        <div className="truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}
