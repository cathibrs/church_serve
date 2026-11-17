import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Image,
  Loader2,
  Printer,
  Search,
  Settings2,
  Sparkles,
  StickyNote,
  UserCheck,
  Users,
} from "lucide-react";
import {
  api,
  FACTORY_ACTIVE,
  POSITIONS,
  type Assignment,
  type Issue,
  type Me,
  type Position,
  type Sheet,
  type Volunteer,
} from "@/lib/api";
import { ENTRY_CATS, EXIT_CATS, MAP_CATS, REC, allowed, swapGroup } from "@/lib/rules";
import { FICHA, downloadPNG, fichaSVG, mapSVG, type MapState } from "@/lib/map";
import { cn, normalize, teamLabel } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Confirm } from "@/components/ui/alert-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { PersonPicker, type PickerTarget } from "@/components/PersonPicker";
import { PositionsSheet } from "@/components/PositionsSheet";

/** Posições por código. São fixas: vêm do catálogo que já está dentro do site. */
const positions: Record<string, Position> = Object.fromEntries(POSITIONS.map((p) => [p.code, p]));
const recCodes = POSITIONS.filter((p) => p.category === REC).map((p) => p.code);

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; msg: string };

function nextService(todayIso: string) {
  const t = new Date(todayIso + "T12:00:00");
  const dow = t.getDay();
  if (dow !== 0 && dow !== 3) t.setDate(t.getDate() + ((7 - dow) % 7));
  return t.toISOString().slice(0, 10);
}

export function EscalaPage({
  me,
  goto,
  onGotoDone,
}: {
  me: Me;
  goto: { date: string; team: string } | null;
  onGotoDone: () => void;
}) {
  const [defaults, setDefaults] = useState<string[]>(FACTORY_ACTIVE);

  const [date, setDate] = useState(() => nextService(me.today));
  const [team, setTeam] = useState<string | null>(null); // null = sugestão automática
  const [day, setDay] = useState<Sheet | null>(null);
  const [present, setPresent] = useState<Set<number>>(new Set());
  const [reasons, setReasons] = useState<Record<number, string>>({}); // motivo da falta
  const [active, setActive] = useState<Set<string>>(new Set(FACTORY_ACTIVE));
  const [assign, setAssign] = useState<Record<string, number>>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [sheet, setSheet] = useState(false);
  const [confirmGen, setConfirmGen] = useState(false);
  const [presenceOpen, setPresenceOpen] = useState(true);
  const [presenceQ, setPresenceQ] = useState("");
  const [generating, setGenerating] = useState(false);
  const [version, setVersion] = useState(0); // muda a cada edição manual -> salvamento automático

  const vols = useMemo<Record<number, Volunteer>>(
    () => Object.fromEntries((day?.volunteers ?? []).map((v) => [v.id, v])),
    [day],
  );
  const hasSchedule = Object.keys(assign).length > 0;

  // ---------------------------------------------------------------- carregar dia
  // Um pedido traz a equipe, a escala salva e as regras quebradas dela.
  const load = useCallback(
    async (d: string, t: string | null) => {
      try {
        const data = await api.sheet(d, t);
        setDay(data);
        setDefaults(data.default_active); // o padrão de posições é de cada equipe
        const activeIds = data.volunteers.filter((v) => v.active).map((v) => v.id);
        const next: Record<string, number> = {};
        let act = new Set(data.default_active);
        if (data.saved) {
          const abs = new Set(data.saved.absent_ids);
          setPresent(new Set(activeIds.filter((id) => !abs.has(id))));
          setReasons(
            Object.fromEntries(Object.entries(data.saved.absent_reasons ?? {}).map(([k, v]) => [Number(k), v])),
          );
          act = new Set(data.saved.active_codes ?? data.default_active);
          data.saved.assignments.forEach((a) => {
            if (positions[a.position_code]) {
              next[a.position_code] = a.volunteer_id;
              act.add(a.position_code);
            }
          });
          setSave({ kind: "saved", at: data.saved.created_at.slice(11, 16) });
          const pick = location.hash.match(/^#pick=(.+)$/);
          if (pick) setTimeout(() => {
            const el = document.querySelector(`[data-code="${pick[1]}"]`);
            if (el) setPicker({ code: pick[1], rect: el.getBoundingClientRect() });
          }, 400);
          setPresenceOpen(false);
        } else {
          setPresent(new Set(activeIds));
          setReasons({});
          setSave({ kind: "idle" });
          setPresenceOpen(true);
        }
        setActive(act);
        setAssign(next);
        setWarnings([]);
        setIssues(data.issues);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [],
  );

  useEffect(() => {
    if (goto) {
      setDate(goto.date);
      setTeam(goto.team);
      onGotoDone();
      return;
    }
    load(date, team);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, team, goto]);

  // ---------------------------------------------------------------- salvar (automático)
  const latest = useRef({ day, present, active, assign, vols, reasons });
  latest.current = { day, present, active, assign, vols, reasons };

  const doSave = useCallback(async () => {
    const s = latest.current;
    if (!s.day || !Object.keys(s.assign).length) return;
    setSave({ kind: "saving" });
    const body = {
      present_ids: [...s.present],
      active_codes: [...s.active],
      assignments: toAssignments(s.assign, s.vols),
      absent_reasons: Object.fromEntries(
        Object.entries(s.reasons).filter(([id, r]) => r.trim() && !s.present.has(Number(id))),
      ),
    };
    try {
      // gravar já devolve as regras quebradas: não há um pedido separado só para conferir
      const r = await api.saveSchedule(s.day.date, s.day.team, body);
      setIssues(r.issues);
      setSave({ kind: "saved", at: r.saved_at.slice(0, 5) });
    } catch (e) {
      setSave({ kind: "error", msg: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    if (!version) return;
    setSave({ kind: "pending" });
    const t = setTimeout(doSave, 900);
    return () => clearTimeout(t);
  }, [version, doSave]);

  const edited = () => setVersion((v) => v + 1);

  // ---------------------------------------------------------------- gerar
  const generate = async () => {
    if (!day) return;
    setGenerating(true);
    try {
      const r = await api.suggestSchedule(day.date, day.team, {
        present_ids: [...present],
        active_codes: [...active],
      });
      const next: Record<string, number> = {};
      r.assignments.forEach((a) => (next[a.position_code] = a.volunteer_id));
      // a geração pode ligar vagas extras da recepção para caber todo mundo
      const act = new Set(active);
      Object.keys(next).forEach((c) => act.add(c));
      setActive(act);
      setAssign(next);
      setWarnings(r.warnings);
      setIssues(r.issues);
      setPresenceOpen(false);
      latest.current = { ...latest.current, assign: next, active: act };
      await doSave();
      const people = new Set(r.assignments.map((a) => a.volunteer_id)).size;
      toast.success(`Escala gerada e salva · ${people} pessoas em ${r.assignments.length} posições`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  // ---------------------------------------------------------------- edição manual
  const choose = (code: string, vid: number) => {
    setAssign((prev) => {
      const next = { ...prev };
      const g = swapGroup(positions[code]);
      const other = Object.keys(next).find((c) => next[c] === vid && c !== code && swapGroup(positions[c]) === g);
      const old = next[code];
      if (other) {
        if (old && allowed(vols[old], positions[other])) {
          next[other] = old;
          toast(`Troca feita: ${vols[vid]?.name} ↔ ${vols[old]?.name}`);
        } else delete next[other];
      }
      next[code] = vid;
      return next;
    });
    setPicker(null);
    edited();
  };
  const clear = (code: string) => {
    setAssign((p) => {
      const n = { ...p };
      delete n[code];
      return n;
    });
    setPicker(null);
    edited();
  };
  const setActiveCode = (code: string, on: boolean) => {
    setActive((p) => {
      const n = new Set(p);
      if (on) n.add(code);
      else n.delete(code);
      return n;
    });
    if (!on) {
      setAssign((p) => {
        const n = { ...p };
        delete n[code];
        return n;
      });
    }
    setPicker(null);
    if (hasSchedule) edited();
  };
  const changeActive = (next: Set<string>) => {
    setActive(next);
    setAssign((p) => Object.fromEntries(Object.entries(p).filter(([c]) => next.has(c))));
    if (hasSchedule) edited();
  };

  const openSlot = (code: string, el: Element) => {
    if (!active.has(code)) {
      setActiveCode(code, true);
      toast(`${positions[code]?.name} ativada`, { description: "Clique de novo para escolher a pessoa." });
      return;
    }
    setPicker({ code, rect: el.getBoundingClientRect() });
  };

  const togglePresence = (id: number) => {
    const n = new Set(present);
    if (n.has(id)) {
      n.delete(id);
      const where = Object.keys(assign).filter((c) => assign[c] === id);
      if (where.length) {
        setAssign((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== id)));
        toast(`${vols[id]?.name} com falta`, { description: `Retirado(a) de ${where.length} posição(ões).` });
      }
    } else n.add(id);
    setPresent(n);
    if (hasSchedule) edited();
  };

  /** Coloca na recepção (vagas livres, ligando as extras se precisar) quem está presente e fora do mapa.
   *  Recepção não faz entrada: a entrada da pessoa passa para alguém do mapa sem entrada (ou fica vazia).
   *  No último domingo a recepção também não faz saída: idem para a saída. */
  const fitReception = () => {
    const next = { ...assign };
    const act = new Set(active);
    const where = (vid: number) => Object.keys(next).filter((c) => next[c] === vid);
    const onMap = (vid: number) => where(vid).some((c) => MAP_CATS.has(positions[c]?.category) || positions[c]?.category === REC);
    const out = activeVols.filter((v) => present.has(v.id) && !onMap(v.id));
    const freeRec = [...recCodes.filter((c) => act.has(c) && !next[c]), ...recCodes.filter((c) => !act.has(c) && !next[c])];
    const placed: string[] = [];
    const moved: string[] = [];
    const emptied: string[] = [];
    for (const v of out) {
      if (!v.can_recepcao) continue;
      const slot = freeRec.shift();
      if (!slot) break;
      next[slot] = v.id;
      act.add(slot);
      placed.push(v.name);
      for (const code of where(v.id)) {
        const cat = positions[code]?.category;
        const group = ENTRY_CATS.has(cat) ? ENTRY_CATS : day?.last_sunday && EXIT_CATS.has(cat) ? EXIT_CATS : null;
        if (!group) continue;
        // alguém no mapa (fora recepção e banheiro fixo), sem tarefa nesse momento, que possa ficar na posição
        const sub = activeVols.find((o) => {
          if (!present.has(o.id) || o.id === v.id || !allowed(o, positions[code])) return false;
          const mine = where(o.id);
          return (
            mine.some((c) => MAP_CATS.has(positions[c]?.category) && c !== "BM" && c !== "BF") &&
            !mine.some((c) => group.has(positions[c]?.category))
          );
        });
        if (sub) {
          next[code] = sub.id;
          moved.push(`${positions[code].name} → ${sub.name}`);
        } else {
          delete next[code];
          emptied.push(positions[code].name);
        }
      }
    }
    if (!placed.length) {
      toast.warning("Não há vaga livre na recepção (ou a pessoa não pode ficar na recepção).");
      return;
    }
    setActive(act);
    setAssign(next);
    setWarnings((w) => w.filter((x) => !x.startsWith("Só na ficha")));
    edited();
    toast.success(`Encaixado(s) na recepção: ${placed.join(", ")}`, {
      description: [moved.length ? `Tarefa passada: ${moved.join("; ")}.` : "", emptied.length ? `Ficou vazio: ${emptied.join(", ")}.` : ""]
        .filter(Boolean)
        .join(" "),
    });
  };

  const setReason = (id: number, text: string) => {
    setReasons((p) => ({ ...p, [id]: text }));
    if (hasSchedule) edited();
  };

  // ---------------------------------------------------------------- derivados
  const bad = useMemo(() => new Set(issues.flatMap((i) => i.codes)), [issues]);
  const mapState: MapState = { positions, active, assign, vols, bad, day };
  const svg = useMemo(() => mapSVG(mapState), [active, assign, vols, bad, day]); // eslint-disable-line
  const activeVols = (day?.volunteers ?? []).filter((v) => v.active).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const absentCount = activeVols.filter((v) => !present.has(v.id)).length;
  const filteredVols = presenceQ ? activeVols.filter((v) => normalize(v.name).includes(normalize(presenceQ))) : activeVols;
  const absentVols = activeVols.filter((v) => !present.has(v.id));
  const outsideMap = hasSchedule
    ? activeVols.filter(
        (v) =>
          present.has(v.id) &&
          !Object.keys(assign).some(
            (c) => assign[c] === v.id && (MAP_CATS.has(positions[c]?.category) || positions[c]?.category === REC),
          ),
      )
    : [];
  const recLast = recCodes.reduce((m, c, i) => (active.has(c) || assign[c] ? i : m), -1);
  const recVisible = recCodes.slice(0, Math.min(recCodes.length, Math.max(recLast + 2, 20)));
  const tag = day ? `${day.date}_${day.team}` : "";

  const exportPng = async (kind: "map" | "ficha") => {
    try {
      if (kind === "map") await downloadPNG(mapSVG(mapState, true), `mapa_${tag}.png`);
      else await downloadPNG(fichaSVG(mapState), `ficha_${tag}.png`, 2);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ------------------------------------------------ barra superior */}
      <header className="no-print sticky top-0 z-20 flex items-center gap-2 border-b bg-background/85 px-5 py-2.5 backdrop-blur">
        <div className="mr-1 min-w-[132px]">
          <h1 className="text-[15px] leading-tight font-semibold whitespace-nowrap">
            Escala · <span className="font-normal text-muted-foreground">{day?.weekday.replace("-Feira", "-feira") ?? ""}</span>
          </h1>
          <SaveIndicator state={save} />
        </div>
        <Input
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="w-[150px]"
          aria-label="Data do culto"
        />
        <Select value={day?.team ?? ""} onValueChange={(v) => setTeam(v)}>
          <SelectTrigger className="w-[200px]">
            <Users className="size-4 text-muted-foreground" />
            <SelectValue placeholder="Equipe" />
          </SelectTrigger>
          <SelectContent>
            {me.teams.map((t) => (
              <SelectItem key={t} value={t}>
                {teamLabel(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {day?.last_sunday && (
          <Tooltip content="Quem estiver na recepção fica só na recepção (nem entrada, nem saída).">
            <Badge variant="warning" className="h-9 rounded-md px-2.5 text-[13px]">
              <AlertTriangle /> Último domingo
            </Badge>
          </Tooltip>
        )}

        <div className="flex-1" />
        <Tooltip content="Ativar ou desativar posições do culto">
          <Button variant="outline" onClick={() => setSheet(true)}>
            <Settings2 /> Posições <span className="text-muted-foreground tabular-nums">{active.size}</span>
          </Button>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={!hasSchedule}>
              <Download /> Exportar <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => exportPng("map")}>
              <Image /> Mapa em PNG
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportPng("ficha")}>
              <Image /> Ficha posicional em PNG
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTimeout(() => window.print(), 50)}>
              <Printer /> Imprimir
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button onClick={() => (hasSchedule ? setConfirmGen(true) : generate())} disabled={generating || !day}>
          {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
          Gerar escala
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {/* ------------------------------------------------ presença */}
        <Card className="no-print">
          <CardHeader className={cn(!presenceOpen && "border-b-0")}>
            <button className="flex items-center gap-2 text-left" onClick={() => setPresenceOpen((o) => !o)}>
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !presenceOpen && "-rotate-90")} />
              <CardTitle>
                <UserCheck className="size-4" /> Presença
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                <b className="text-foreground">{activeVols.length - absentCount}</b> presentes ·{" "}
                <b className={cn(absentCount ? "text-destructive" : "text-foreground")}>{absentCount}</b> falta(s)
              </span>
            </button>
            {presenceOpen && (
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={presenceQ}
                    onChange={(e) => setPresenceQ(e.target.value)}
                    placeholder="Buscar nome"
                    className="h-8 w-48 pl-8 text-[13px]"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPresent(new Set(activeVols.map((v) => v.id)));
                    if (hasSchedule) edited();
                  }}
                >
                  Todos presentes
                </Button>
              </div>
            )}
          </CardHeader>
          <AnimatePresence initial={false}>
            {presenceOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="px-4 pt-2 pb-3">
                  <p className="mb-2 text-xs text-muted-foreground">Clique no nome para marcar falta. Quem falta não entra na escala.</p>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1">
                    {filteredVols.map((v) => {
                      const ok = present.has(v.id);
                      return (
                        <button
                          key={v.id}
                          onClick={() => togglePresence(v.id)}
                          title={`${v.faltas} falta(s) no histórico${v.observation ? `
Obs.: ${v.observation}` : ""}`}
                          className={cn(
                            "flex h-7 items-center gap-1.5 rounded-md border px-2 text-left text-[13px] transition-colors",
                            ok
                              ? "border-input bg-background hover:bg-accent"
                              : "border-destructive/30 bg-destructive-soft text-destructive line-through",
                          )}
                        >
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              v.gender === "Feminino" ? "bg-rose-500" : "bg-sky-600",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">{v.name}</span>
                          {v.observation && <StickyNote className="size-3 shrink-0 text-amber-600" aria-label="Tem observação" />}
                          {v.faltas > 0 && <span className="text-[11px] text-muted-foreground no-underline">{v.faltas}</span>}
                        </button>
                      );
                    })}
                  </div>
                  {absentVols.length > 0 && (
                    <div className="mt-3 rounded-md border border-destructive/20 bg-destructive-soft/40 p-2.5">
                      <div className="mb-1.5 text-xs font-semibold text-destructive">
                        Motivo da falta <span className="font-normal text-muted-foreground">· opcional, fica no histórico</span>
                      </div>
                      <datalist id="motivos-falta">
                        {MOTIVOS.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-3 gap-y-1">
                        {absentVols.map((v) => (
                          <label key={v.id} className="flex items-center gap-2 text-[13px]">
                            <span className="w-32 shrink-0 truncate font-medium" title={v.name}>
                              {v.name}
                            </span>
                            <Input
                              list="motivos-falta"
                              value={reasons[v.id] ?? ""}
                              onChange={(e) => setReason(v.id, e.target.value)}
                              placeholder="Ex.: doente, viagem, trabalho"
                              maxLength={200}
                              className="h-7 bg-background text-[13px]"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>

        {/* ------------------------------------------------ alertas */}
        <div className="no-print space-y-2">
          {outsideMap.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3.5 py-2 text-[13px] text-sky-950">
              <Users className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <b>{outsideMap.length}</b> pessoa(s) fora do mapa: {outsideMap.map((v) => v.name).join(", ")}.
              </span>
              <Button size="sm" onClick={fitReception}>
                Encaixar na recepção
              </Button>
            </div>
          )}
          {issues.length > 0 && (
            <div className="rounded-lg border border-destructive/25 bg-destructive-soft px-3.5 py-2.5 text-[13px] text-destructive">
              <div className="flex items-center gap-2 font-semibold">
                <CircleAlert className="size-4" /> {issues.length} regra(s) quebrada(s) — posições em vermelho
              </div>
              <ul className="mt-1 ml-6 list-disc space-y-0.5">
                {issues.map((i, k) => (
                  <li key={k}>{i.message}</li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <details className="rounded-lg border border-warning/40 bg-warning-soft px-3.5 py-2 text-[13px] text-[oklch(0.42_0.1_70)]">
              <summary className="cursor-pointer font-medium">{warnings.length} aviso(s) da geração</summary>
              <ul className="mt-1 ml-5 list-disc space-y-0.5">
                {warnings.map((w, k) => (
                  <li key={k}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          {day && !hasSchedule && (
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px]">
              <Sparkles className="size-4" />
              Marque as faltas e clique em <b>Gerar escala</b>. Depois clique em qualquer nome para trocar — tudo é salvo
              automaticamente.
            </div>
          )}
        </div>

        {/* ------------------------------------------------ mapa + ficha */}
        <div className="grid items-start gap-3 min-[1700px]:grid-cols-[minmax(0,1fr)_440px]">
          <Card className="overflow-hidden">
            <CardHeader className="no-print">
              <CardTitle>Mapa do templo</CardTitle>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <Legend className="border border-dashed border-neutral-400 bg-white" label="vazio" />
                <Legend className="bg-neutral-300" label="desativada · clique para ativar" />
                <Legend className="bg-red-600" label="regra quebrada" />
              </div>
            </CardHeader>
            <div
              className="p-3 [&_svg]:h-auto [&_svg]:w-full"
              onClick={(e) => {
                const g = (e.target as Element).closest(".slot");
                if (g) openSlot(g.getAttribute("data-code")!, g);
              }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </Card>

          <Card className="print-break @container overflow-hidden">
            <CardHeader>
              <CardTitle>Ficha posicional</CardTitle>
              <span className="text-xs text-muted-foreground">clique para trocar</span>
            </CardHeader>
            <div className="grid gap-x-5 gap-y-4 p-3 @2xl:grid-cols-2">
              {[
                ...FICHA,
                {
                  side: "rec" as const,
                  title: "Recepção",
                  groups: [["Recepção", recVisible] as [string, string[]]],
                },
              ].map((sec) => {
                const t = MOMENT[sec.side];
                return (
                  <section key={sec.side} className={cn(sec.side === "rec" && "@2xl:col-span-2")}>
                    <div className={cn("mb-2.5 flex items-center justify-between rounded-md px-3 py-2 text-white", t.header)}>
                      <span className="text-[13px] font-bold tracking-wide uppercase">{t.title}</span>
                      <span className="text-xs opacity-90">
                        {sec.side === "in"
                          ? "recepção não pode"
                          : sec.side === "out"
                            ? day?.last_sunday
                              ? "último domingo: recepção não pode"
                              : ""
                            : day?.last_sunday
                              ? "último domingo: só recepção"
                              : "não fica na entrada"}
                      </span>
                    </div>
                    <div className="space-y-3">
                      {sec.groups.map(([label, codes]) => {
                        const list = codes.filter((c) => positions[c]);
                        const filled = list.filter((c) => assign[c]).length;
                        return (
                          <div key={label}>
                            {sec.side !== "rec" && (
                              <div className={cn("mb-1.5 flex items-center gap-2 border-l-[3px] pl-2", t.labelBar)}>
                                <span className={cn("text-sm font-bold", t.label)}>{label}</span>
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {filled}/{list.filter((c) => active.has(c)).length}
                                </span>
                              </div>
                            )}
                            <div
                              className={cn(
                                "grid grid-cols-3 gap-1 @5xl:grid-cols-4",
                                sec.side === "rec" && "grid-cols-4 @3xl:grid-cols-5",
                              )}
                            >
                              {list.map((c, i) => {
                                const on = active.has(c);
                                const vid = assign[c];
                                const name = vid ? vols[vid]?.name : "";
                                return (
                                  <button
                                    key={c}
                                    data-code={c}
                                    onClick={(e) => openSlot(c, e.currentTarget)}
                                    className={cn(
                                      "group flex h-8 min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-[13px] transition-[border-color,background-color]",
                                      !on && "border-dashed border-input bg-background text-muted-foreground/70 hover:text-foreground",
                                      on && !name && cn("border-dashed", t.empty),
                                      on && name && t.slot,
                                      bad.has(c) && "border-destructive bg-destructive-soft text-destructive",
                                    )}
                                  >
                                    <span className={cn("w-4 shrink-0 text-right text-[11px] font-semibold tabular-nums", t.num)}>
                                      {i + 1}
                                    </span>
                                    <span className={cn("min-w-0 flex-1 truncate", name && "font-semibold")}>
                                      {!on ? "+ ativar" : name || "vazio"}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </Card>
        </div>
      </div>

      <PersonPicker
        target={picker}
        onClose={() => setPicker(null)}
        positions={positions}
        vols={vols}
        present={present}
        assign={assign}
        lastSunday={!!day?.last_sunday}
        onChoose={choose}
        onClear={clear}
        onDisable={(c) => setActiveCode(c, false)}
      />
      <PositionsSheet
        open={sheet}
        onOpenChange={setSheet}
        positions={positions}
        active={active}
        defaults={defaults}
        onChange={changeActive}
        onSaveDefault={async () => {
          try {
            if (!day) return;
            const r = await api.setTeamPositions(day.team, [...active]);
            setDefaults(r.codes);
            toast.success("Posições salvas como padrão para os próximos cultos desta equipe.");
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
      <Confirm
        open={confirmGen}
        onOpenChange={setConfirmGen}
        title="Gerar a escala de novo?"
        description="A escala atual, inclusive as trocas feitas à mão, será substituída por uma nova sugestão."
        confirmLabel="Gerar de novo"
        onConfirm={generate}
      />
    </div>
  );
}

const MOTIVOS = ["Doente", "Viagem", "Trabalho", "Compromisso familiar", "Avisou que não viria", "Sem aviso"];

/** Cor de cada momento: entrada (verde), saída (laranja), recepção (azul). */
const MOMENT = {
  in: {
    title: "Entrada · antes do culto",
    header: "bg-emerald-800",
    label: "text-emerald-900",
    labelBar: "border-emerald-600",
    slot: "border-emerald-300 bg-emerald-50 text-emerald-950 hover:border-emerald-600 hover:bg-emerald-100",
    empty: "border-emerald-300 bg-emerald-50/40 text-emerald-700/70 hover:border-emerald-500",
    num: "text-emerald-700",
  },
  out: {
    title: "Saída · depois do culto",
    header: "bg-orange-800",
    label: "text-orange-900",
    labelBar: "border-orange-500",
    slot: "border-orange-300 bg-orange-50 text-orange-950 hover:border-orange-600 hover:bg-orange-100",
    empty: "border-orange-300 bg-orange-50/40 text-orange-700/70 hover:border-orange-500",
    num: "text-orange-700",
  },
  rec: {
    title: "Recepção",
    header: "bg-sky-800",
    label: "text-sky-900",
    labelBar: "border-sky-600",
    slot: "border-sky-300 bg-sky-50 text-sky-950 hover:border-sky-600 hover:bg-sky-100",
    empty: "border-sky-300 bg-sky-50/40 text-sky-700/70 hover:border-sky-500",
    num: "text-sky-700",
  },
} as const;

function toAssignments(assign: Record<string, number>, vols: Record<number, Volunteer>): Assignment[] {
  return Object.entries(assign).map(([code, vid]) => ({
    position_code: code,
    volunteer_id: vid,
    volunteer_name: vols[vid]?.name ?? "",
  }));
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <i className={cn("inline-block size-2.5 rounded-[3px]", className)} />
      {label}
    </span>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const base = "flex h-4 items-center gap-1 text-xs leading-none whitespace-nowrap";
  if (state.kind === "idle") return <span className={cn(base, "text-muted-foreground")}>Ainda não gerada</span>;
  if (state.kind === "pending" || state.kind === "saving")
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <Loader2 className="size-3 animate-spin" /> Salvando…
      </span>
    );
  if (state.kind === "error")
    return (
      <Tooltip content={state.msg}>
        <span className={cn(base, "text-destructive")}>
          <CircleAlert className="size-3" /> Erro ao salvar
        </span>
      </Tooltip>
    );
  return (
    <Tooltip content="Escala salva.">
      <span className={cn(base, "text-emerald-700")}>
        <Check className="size-3" />
        Salvo às {state.at}
      </span>
    </Tooltip>
  );
}
