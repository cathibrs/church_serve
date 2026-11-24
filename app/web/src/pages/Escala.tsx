import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "@/lib/screens";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  Image,
  Loader2,
  Printer,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  StickyNote,
  Users,
  X,
} from "lucide-react";
import {
  api,
  isEventTeam,
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
import { EventPeople } from "@/components/EventPeople";
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

/**
 * Estado inicial da tela a partir da folha: presença, posições ligadas e quem está em cada posição.
 * No culto todos começam presentes; no evento ninguém começa escolhido.
 */
function fromSheet(data: Sheet) {
  const event = isEventTeam(data.team);
  const activeIds = data.volunteers.filter((v) => v.active).map((v) => v.id);
  const assign: Record<string, number> = {};
  if (!data.saved) {
    return {
      present: new Set(event ? [] : activeIds),
      reasons: {} as Record<number, string>,
      active: new Set(data.default_active),
      assign,
    };
  }
  const absent = new Set(data.saved.absent_ids);
  const active = new Set(data.saved.active_codes ?? data.default_active);
  data.saved.assignments.forEach((a) => {
    if (positions[a.position_code]) {
      assign[a.position_code] = a.volunteer_id;
      active.add(a.position_code);
    }
  });
  const chosen = new Set([...data.saved.present_ids, ...Object.values(assign)]);
  return {
    present: new Set(activeIds.filter((id) => (event ? chosen.has(id) : !absent.has(id)))),
    reasons: Object.fromEntries(
      Object.entries(data.saved.absent_reasons ?? {}).map(([k, v]) => [Number(k), v]),
    ) as Record<number, string>,
    active,
    assign,
  };
}

/**
 * Tela da escala de um culto. A folha (`sheet`) chega pronta, então a tela já nasce
 * preenchida; trocar de data ou de equipe abre outro endereço, que traz outra folha.
 */
export function EscalaPage({
  me,
  route,
  sheet: day,
  onOpen,
}: {
  me: Me;
  /** endereço aberto: sem equipe, a API escolheu a sugerida para o dia */
  route: Extract<Route, { page: "escala" }>;
  sheet: Sheet;
  onOpen: (route: Route) => void;
}) {
  const [start] = useState(() => fromSheet(day));
  const [defaults, setDefaults] = useState<string[]>(day.default_active); // o padrão de posições é de cada equipe
  const [date, setDate] = useState(day.date);
  const [present, setPresent] = useState<Set<number>>(start.present);
  const [reasons, setReasons] = useState<Record<number, string>>(start.reasons); // motivo da falta
  const [active, setActive] = useState<Set<string>>(start.active);
  const [assign, setAssign] = useState<Record<string, number>>(start.assign);
  const [issues, setIssues] = useState<Issue[]>(day.issues);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [save, setSave] = useState<SaveState>(
    day.saved ? { kind: "saved", at: day.saved.created_at.slice(11, 16) } : { kind: "idle" },
  );
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [sheet, setSheet] = useState(false);
  const [confirmGen, setConfirmGen] = useState(false);
  const [presenceQ, setPresenceQ] = useState("");
  const [generating, setGenerating] = useState(false);
  const [version, setVersion] = useState(0); // muda a cada edição manual -> salvamento automático

  const vols = useMemo<Record<number, Volunteer>>(() => Object.fromEntries(day.volunteers.map((v) => [v.id, v])), [day]);
  const hasSchedule = Object.keys(assign).length > 0;
  /** evento: a equipe junta todos os voluntários e se escolhe quem serve (ninguém ganha falta) */
  const event = isEventTeam(day.team);

  // endereço com "#pick=CÓDIGO" já abre a troca dessa posição
  useEffect(() => {
    const pick = day.saved && location.hash.match(/^#pick=(.+)$/);
    if (!pick) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-code="${pick[1]}"]`);
      if (el) setPicker({ code: pick[1], rect: el.getBoundingClientRect() });
    }, 400);
    return () => clearTimeout(t);
  }, [day]);

  /** Outra data: mantém a equipe só se ela foi escolhida (senão vale a sugerida para o novo dia). */
  const changeDate = (next: string) => {
    setDate(next);
    onOpen({ page: "escala", date: next, team: route.team });
  };

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
      absent_reasons: isEventTeam(s.day.team)
        ? {}
        : Object.fromEntries(Object.entries(s.reasons).filter(([id, r]) => r.trim() && !s.present.has(Number(id)))),
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
      latest.current = { ...latest.current, assign: next, active: act };
      await doSave();
      const people = new Set(r.assignments.map((a) => a.volunteer_id)).size;
      toast.success(`Escala feita e salva: ${people} pessoas em ${r.assignments.length} posições.`);
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
      toast(`${positions[code]?.name} ligada`, { description: "Toque de novo para escolher a pessoa." });
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
        toast(`${vols[id]?.name} faltou`, {
          description: `Saiu da escala (${where.length} ${where.length === 1 ? "posição ficou vazia" : "posições ficaram vazias"}).`,
        });
      }
    } else n.add(id);
    setPresent(n);
    if (hasSchedule) edited();
  };

  /** Evento: troca a lista de quem vai servir. Quem saiu da lista sai também das posições. */
  const setPeople = (next: Set<number>) => {
    const gone = new Set([...present].filter((id) => !next.has(id)));
    const emptied = Object.keys(assign).filter((c) => gone.has(assign[c]));
    if (emptied.length) {
      setAssign((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => !gone.has(v))));
      if (gone.size === 1) {
        toast(`${vols[[...gone][0]]?.name} saiu do evento`, {
          description: `${emptied.length} ${emptied.length === 1 ? "posição ficou vazia" : "posições ficaram vazias"}.`,
        });
      }
    }
    setPresent(next);
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
      toast.warning("Não deu para colocar na recepção: não há vaga livre, ou a pessoa não pode servir na recepção.");
      return;
    }
    setActive(act);
    setAssign(next);
    setWarnings((w) => w.filter((x) => !x.startsWith("Só na ficha")));
    edited();
    toast.success(`Na recepção agora: ${placed.join(", ")}`, {
      description: [moved.length ? `Tarefa passada para outra pessoa: ${moved.join("; ")}.` : "", emptied.length ? `Ficou vazio: ${emptied.join(", ")}.` : ""]
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
  const tag = day ? `${day.date}_${day.team}` : "";

  const exportPng = async (kind: "map" | "ficha") => {
    try {
      if (kind === "map") await downloadPNG(mapSVG(mapState, true), `mapa_${tag}.png`);
      else await downloadPNG(fichaSVG(mapState), `ficha_${tag}.png`, 2);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const presentCount = activeVols.length - absentCount;
  /** quem veio e deixou algum recado no cadastro (ex.: só pode até as 10h) */
  const notes = activeVols.filter((v) => present.has(v.id) && v.observation?.trim());
  const openPositions = () => setSheet(true);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ------------------------------------------------ barra superior */}
      <header className="no-print sticky top-0 z-20 flex items-center gap-3 border-b bg-background/85 px-3 py-2.5 backdrop-blur md:px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg leading-tight font-semibold">
            Escala do {event ? "evento" : "culto"} <span className="font-normal text-muted-foreground max-sm:hidden">· {weekday(day.weekday)}</span>
          </h1>
          <SaveIndicator state={save} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={!hasSchedule}>
              <Printer /> Imprimir<span className="max-sm:hidden"> ou baixar</span>
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setTimeout(() => window.print(), 50)}>
              <Printer /> Imprimir
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportPng("ficha")}>
              <Image /> Baixar a lista (imagem)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportPng("map")}>
              <Image /> Baixar o mapa (imagem)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3 py-4 md:px-5 md:py-5">
        {/* ------------------------------------------------ 1. culto */}
        <Step
          n={1}
          title={event ? "Qual evento?" : "Qual culto?"}
          hint={event ? "Confira a data. Para um culto comum, troque a equipe." : "Confira a data e a equipe que vai servir."}
        >
          <Card className="no-print space-y-3 p-3 md:p-4">
            <div className="flex flex-wrap gap-3">
              <label className="flex min-w-[150px] flex-1 flex-col gap-1.5 text-sm font-medium sm:max-w-[200px]">
                Data
                <Input type="date" value={date} onChange={(e) => e.target.value && changeDate(e.target.value)} />
              </label>
              <div className="flex min-w-[180px] flex-[2] flex-col gap-1.5 text-sm font-medium sm:max-w-[300px]">
                Equipe
                <Select value={day.team} onValueChange={(team) => onOpen({ page: "escala", date: day.date, team })}>
                  <SelectTrigger aria-label="Equipe">
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
              </div>
            </div>
            {day.last_sunday && (
              <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  <b>Último domingo do mês:</b> quem estiver na recepção fica só na recepção (não faz entrada nem saída).
                </span>
              </p>
            )}
          </Card>
        </Step>

        {/* ------------------------------------------------ 2. presença (no evento: quem vai servir) */}
        {event ? (
          <Step
            n={2}
            title="Quem vai servir?"
            hint={
              <>
                Ninguém começa escolhido. Traga uma equipe inteira, todo mundo ou as pessoas do último evento, e ajuste
                tocando nos nomes. <b className="text-foreground">Quem não for escolhido não ganha falta.</b>
              </>
            }
          >
            <EventPeople volunteers={activeVols} chosen={present} lastEvent={day.last_event} onChange={setPeople} />
            <VolunteerNotes people={notes} />
          </Step>
        ) : (
        <Step
          n={2}
          title="Quem faltou?"
          hint={
            <>
              Todos começam como presentes. Toque no nome de quem <b className="text-foreground">não veio</b>. Quem faltou
              não entra na escala.
            </>
          }
        >
          <Card className="no-print">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2.5 md:px-4">
              <span className="text-sm">
                <b className="text-base text-emerald-700 tabular-nums dark:text-emerald-400">{presentCount}</b> vieram ·{" "}
                <b className={cn("text-base tabular-nums", absentCount ? "text-destructive" : "text-foreground")}>{absentCount}</b>{" "}
                {absentCount === 1 ? "faltou" : "faltaram"}
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <i className="size-2 rounded-full bg-rose-500" /> mulher
                </span>
                <span className="flex items-center gap-1">
                  <i className="size-2 rounded-full bg-sky-600" /> homem
                </span>
              </span>
              <div className="flex flex-1 items-center justify-end gap-2 max-sm:basis-full">
                {activeVols.length > 12 && (
                  <div className="relative min-w-0 flex-1 sm:max-w-56">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={presenceQ}
                      onChange={(e) => setPresenceQ(e.target.value)}
                      placeholder="Procurar pelo nome"
                      className="pl-8"
                    />
                  </div>
                )}
                {absentCount > 0 && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setPresent(new Set(activeVols.map((v) => v.id)));
                      if (hasSchedule) edited();
                    }}
                  >
                    <RotateCcw /> Desmarcar faltas
                  </Button>
                )}
              </div>
            </div>
            <div className="p-3 md:p-4">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5 md:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
                {filteredVols.map((v) => {
                  const ok = present.has(v.id);
                  return (
                    <button
                      key={v.id}
                      onClick={() => togglePresence(v.id)}
                      aria-pressed={!ok}
                      aria-label={`${v.name}: ${ok ? "veio" : "faltou"}`}
                      className={cn(
                        "flex min-h-11 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm leading-tight transition-colors",
                        ok
                          ? "border-input bg-background hover:bg-accent"
                          : "border-destructive/40 bg-destructive-soft text-destructive",
                      )}
                    >
                      {ok ? (
                        <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
                      ) : (
                        <X className="size-4 shrink-0" strokeWidth={2.5} />
                      )}
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="flex items-start gap-1.5">
                          <i
                            className={cn("mt-1.5 size-2 shrink-0 rounded-full", v.gender === "Feminino" ? "bg-rose-500" : "bg-sky-600")}
                          />
                          <span className={cn("line-clamp-2 break-words", !ok && "font-medium")}>{v.name}</span>
                        </span>
                        {!ok && <span className="block text-xs">faltou</span>}
                      </span>
                      {v.observation && <StickyNote className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Tem recado" />}
                    </button>
                  );
                })}
                {!filteredVols.length && (
                  <p className="col-span-full py-4 text-center text-sm text-muted-foreground">Ninguém com esse nome.</p>
                )}
              </div>

              {absentVols.length > 0 && (
                <div className="mt-4 rounded-lg border border-destructive/20 bg-destructive-soft/40 p-3">
                  <div className="mb-2 text-sm font-semibold text-destructive">
                    Por que faltou? <span className="font-normal text-muted-foreground">(opcional — fica guardado no histórico)</span>
                  </div>
                  <datalist id="motivos-falta">
                    {MOTIVOS.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-x-4 gap-y-2">
                    {absentVols.map((v) => (
                      <label key={v.id} className="flex items-center gap-2 text-sm">
                        <span className="w-28 shrink-0 truncate font-medium md:w-36">{v.name}</span>
                        <Input
                          list="motivos-falta"
                          value={reasons[v.id] ?? ""}
                          onChange={(e) => setReason(v.id, e.target.value)}
                          placeholder="Ex.: doente, viagem, trabalho"
                          maxLength={200}
                          className="bg-background"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <VolunteerNotes people={notes} className="mt-4" />
            </div>
          </Card>
        </Step>
        )}

        {/* ------------------------------------------------ 3. gerar */}
        <Step
          n={3}
          title="Fazer a escala"
          hint={
            event && !present.size
              ? "Escolha quem vai servir no passo 2 para fazer a escala."
              : hasSchedule
                ? `A escala já está feita e salva. Mudou ${event ? "quem vai servir" : "quem veio"}? Faça de novo (as trocas feitas à mão serão perdidas).`
                : `O sistema coloca ${event ? "quem vai servir" : "quem veio"} nas posições, seguindo as regras. Você pode trocar qualquer pessoa depois.`
          }
          className="no-print"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              size="lg"
              variant={hasSchedule ? "outline" : "default"}
              className="max-sm:w-full"
              onClick={() => (hasSchedule ? setConfirmGen(true) : generate())}
              disabled={generating || (event && !present.size)}
            >
              {generating ? <Loader2 className="animate-spin" /> : hasSchedule ? <RotateCcw /> : <Sparkles />}
              {generating ? "Fazendo a escala…" : hasSchedule ? "Fazer de novo" : "Fazer a escala"}
            </Button>
            <button
              onClick={openPositions}
              className="flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <Settings2 className="size-4" /> Ligar ou desligar posições ({active.size} ligadas)
            </button>
          </div>
        </Step>

        {/* ------------------------------------------------ 4. conferir */}
        <Step
          n={4}
          title="Confira e troque"
          hint={
            hasSchedule
              ? "Toque num nome para trocar a pessoa. Cada troca é salva sozinha."
              : "A escala aparece aqui depois do passo 3."
          }
          muted={!hasSchedule}
        >
          {hasSchedule && (
            <>
              <div className="no-print space-y-2">
                {outsideMap.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-300 bg-sky-50 px-3.5 py-2.5 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-100">
                    <Users className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 basis-52">
                      <b>
                        {outsideMap.length} {outsideMap.length === 1 ? "pessoa que veio ainda está" : "pessoas que vieram ainda estão"} sem
                        lugar:
                      </b>{" "}
                      {outsideMap.map((v) => v.name).join(", ")}.
                    </span>
                    <Button size="sm" onClick={fitReception}>
                      Colocar na recepção
                    </Button>
                  </div>
                )}
                {issues.length > 0 && (
                  <div className="rounded-lg border border-destructive/25 bg-destructive-soft px-3.5 py-2.5 text-sm text-destructive">
                    <div className="flex items-center gap-2 font-semibold">
                      <CircleAlert className="size-4 shrink-0" /> Atenção: {issues.length}{" "}
                      {issues.length === 1 ? "problema" : "problemas"} na escala (as posições com problema estão em vermelho)
                    </div>
                    <ul className="mt-1 ml-6 list-disc space-y-0.5">
                      {issues.map((i, k) => (
                        <li key={k}>{i.message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {warnings.length > 0 && (
                  <div className="rounded-lg border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-sm text-warning-foreground">
                    <div className="font-semibold">Observações sobre a escala</div>
                    <ul className="mt-1 ml-5 list-disc space-y-0.5">
                      {warnings.map((w, k) => (
                        <li key={k}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Na tela a lista vem antes; na impressão o mapa continua na primeira página. */}
              <div className="flex flex-col gap-4">
                <Card className="@container overflow-hidden print:order-2 print-break">
                  <CardHeader>
                    <CardTitle>Lista de posições</CardTitle>
                    <span className="no-print text-xs text-muted-foreground">toque num nome para trocar</span>
                  </CardHeader>
                  <div className="grid gap-x-6 gap-y-5 p-3 md:p-4 @3xl:grid-cols-2">
                    {[
                      ...FICHA,
                      { side: "rec" as const, title: "Recepção", groups: [["Recepção", recCodes] as [string, string[]]] },
                    ].map((sec) => {
                      const t = MOMENT[sec.side];
                      // só as posições ligadas: as desligadas ficam no mapa e em "Ligar ou desligar posições"
                      const groups = sec.groups
                        .map(([label, codes]) => {
                          const all = codes.filter((c) => positions[c]);
                          return { label, all, shown: all.filter((c) => active.has(c)) };
                        })
                        .filter((g) => g.shown.length);
                      if (!groups.length) return null;
                      return (
                        <section key={sec.side} className={cn("@container/sec", sec.side === "rec" && "@3xl:col-span-2")}>
                          <div className={cn("mb-3 rounded-md px-3 py-2 text-white", t.header)}>
                            <div className="text-sm font-bold tracking-wide uppercase">{t.title}</div>
                            <div className="text-xs opacity-90">{momentNote(sec.side, !!day.last_sunday)}</div>
                          </div>
                          <div className="space-y-4">
                            {groups.map(({ label, all, shown }) => (
                              <div key={label}>
                                {sec.side !== "rec" && (
                                  <div className={cn("mb-1.5 flex items-center gap-2 border-l-[3px] pl-2", t.labelBar)}>
                                    <span className={cn("text-sm font-bold", t.label)}>{label}</span>
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                      {shown.filter((c) => assign[c]).length} de {shown.length}
                                    </span>
                                  </div>
                                )}
                                <div
                                  className={cn(
                                    "grid grid-cols-2 gap-1.5 @[640px]/sec:grid-cols-3 @[900px]/sec:grid-cols-4",
                                    sec.side === "rec" && "@[1150px]/sec:grid-cols-5",
                                  )}
                                >
                                  {shown.map((c) => {
                                    const vid = assign[c];
                                    const name = vid ? vols[vid]?.name : "";
                                    return (
                                      <button
                                        key={c}
                                        data-code={c}
                                        onClick={(e) => openSlot(c, e.currentTarget)}
                                        className={cn(
                                          "flex h-11 min-w-0 items-center gap-1.5 rounded-lg border px-2 text-left text-sm transition-[border-color,background-color] md:h-10",
                                          !name && cn("border-dashed", t.empty),
                                          name && t.slot,
                                          bad.has(c) && "border-destructive bg-destructive-soft text-destructive",
                                        )}
                                      >
                                        <span className={cn("w-5 shrink-0 text-right text-xs font-semibold tabular-nums", t.num)}>
                                          {all.indexOf(c) + 1}
                                        </span>
                                        <span className={cn("min-w-0 flex-1 truncate", name ? "font-semibold" : "italic")}>
                                          {name || "escolher pessoa"}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                  <div className="no-print border-t px-3 py-2.5 text-sm text-muted-foreground md:px-4">
                    Faltou ou sobrou alguma posição?{" "}
                    <button onClick={openPositions} className="font-medium text-foreground underline underline-offset-4">
                      Ligar ou desligar posições
                    </button>
                  </div>
                </Card>

                <Card className="overflow-hidden print:order-1">
                  <CardHeader className="no-print">
                    <CardTitle>
                      A mesma escala, no desenho do templo
                      <span className="text-xs font-normal text-muted-foreground md:hidden">· arraste para os lados</span>
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <Legend className="border border-dashed border-neutral-400 bg-white" label="vaga vazia" />
                      <Legend className="bg-neutral-300 dark:bg-neutral-600" label="desligada (toque para ligar)" />
                      <Legend className="bg-red-600" label="problema" />
                    </div>
                  </CardHeader>
                  <div className="overflow-x-auto">
                    <div
                      className="p-3 max-md:w-[1000px] [&_svg]:h-auto [&_svg]:w-full"
                      onClick={(e) => {
                        const g = (e.target as Element).closest(".slot");
                        if (g) openSlot(g.getAttribute("data-code")!, g);
                      }}
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                  </div>
                </Card>
              </div>
            </>
          )}
        </Step>
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
            toast.success(
              event
                ? "Guardado: os próximos eventos começam com estas posições."
                : "Guardado: os próximos cultos desta equipe começam com estas posições.",
            );
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
      <Confirm
        open={confirmGen}
        onOpenChange={setConfirmGen}
        title="Fazer a escala de novo?"
        description="A escala atual, com as trocas feitas à mão, será substituída por uma nova."
        confirmLabel="Fazer de novo"
        onConfirm={generate}
      />
    </div>
  );
}

/** "Quarta-Feira" -> "Quarta-feira" */
const weekday = (w: string) => w.replace("-Feira", "-feira");

/** Lembrete da regra de cada momento, em palavras simples. */
function momentNote(side: "in" | "out" | "rec", lastSunday: boolean) {
  if (side === "in") return "quem está na recepção não faz entrada";
  if (side === "out") return lastSunday ? "último domingo: quem está na recepção não faz saída" : "pode ser feita por quem está na recepção";
  return lastSunday ? "último domingo: quem está aqui fica só na recepção" : "quem está aqui não faz entrada";
}

/** Um passo da tela: número, título, o que fazer e o conteúdo. */
function Step({
  n,
  title,
  hint,
  muted,
  className,
  children,
}: {
  n: number;
  title: string;
  hint: React.ReactNode;
  muted?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className={cn("space-y-3", className)} aria-label={`Passo ${n}: ${title}`}>
      <div className={cn("no-print flex items-start gap-3", muted && "opacity-60")}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-primary-foreground tabular-nums">
          {n}
        </span>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-lg leading-tight font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

const MOTIVOS = ["Doente", "Viagem", "Trabalho", "Compromisso familiar", "Avisou que não viria", "Sem aviso"];

/** Cor de cada momento: entrada (verde), saída (laranja), recepção (azul). */
const MOMENT = {
  in: {
    title: "Entrada · antes do culto",
    header: "bg-emerald-800",
    label: "text-emerald-900 dark:text-emerald-300",
    labelBar: "border-emerald-600",
    slot: "border-emerald-300 bg-emerald-50 text-emerald-950 hover:border-emerald-600 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-50 dark:hover:border-emerald-500 dark:hover:bg-emerald-900/60",
    empty: "border-emerald-300 bg-emerald-50/40 text-emerald-700/70 hover:border-emerald-500 dark:border-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-300/70",
    num: "text-emerald-700 dark:text-emerald-400",
  },
  out: {
    title: "Saída · depois do culto",
    header: "bg-orange-800",
    label: "text-orange-900 dark:text-orange-300",
    labelBar: "border-orange-500",
    slot: "border-orange-300 bg-orange-50 text-orange-950 hover:border-orange-600 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-950/60 dark:text-orange-50 dark:hover:border-orange-500 dark:hover:bg-orange-900/60",
    empty: "border-orange-300 bg-orange-50/40 text-orange-700/70 hover:border-orange-500 dark:border-orange-800 dark:bg-orange-950/20 dark:text-orange-300/70",
    num: "text-orange-700 dark:text-orange-400",
  },
  rec: {
    title: "Recepção",
    header: "bg-sky-800",
    label: "text-sky-900 dark:text-sky-300",
    labelBar: "border-sky-600",
    slot: "border-sky-300 bg-sky-50 text-sky-950 hover:border-sky-600 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-50 dark:hover:border-sky-500 dark:hover:bg-sky-900/60",
    empty: "border-sky-300 bg-sky-50/40 text-sky-700/70 hover:border-sky-500 dark:border-sky-800 dark:bg-sky-950/20 dark:text-sky-300/70",
    num: "text-sky-700 dark:text-sky-400",
  },
} as const;

function toAssignments(assign: Record<string, number>, vols: Record<number, Volunteer>): Assignment[] {
  return Object.entries(assign).map(([code, vid]) => ({
    position_code: code,
    volunteer_id: vid,
    volunteer_name: vols[vid]?.name ?? "",
  }));
}

/** Recados no cadastro de quem vai servir (ex.: só pode até as 10h). */
function VolunteerNotes({ people, className }: { people: Volunteer[]; className?: string }) {
  if (!people.length) return null;
  return (
    <div className={cn("rounded-lg border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/40", className)}>
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <StickyNote className="size-4" /> Recados dos voluntários
      </div>
      <ul className="space-y-1 text-sm text-amber-950 dark:text-amber-100">
        {people.map((v) => (
          <li key={v.id}>
            <b className="font-medium">{v.name}:</b> {v.observation}
          </li>
        ))}
      </ul>
    </div>
  );
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
  const base = "flex min-h-5 items-center gap-1 text-xs leading-tight";
  if (state.kind === "idle") return <span className={cn(base, "text-muted-foreground")}>Escala ainda não feita</span>;
  if (state.kind === "pending" || state.kind === "saving")
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <Loader2 className="size-3 shrink-0 animate-spin" /> Salvando…
      </span>
    );
  if (state.kind === "error")
    return (
      // a mensagem fica escrita: a pessoa precisa saber que a última mudança não foi guardada
      <span className={cn(base, "text-destructive")} title={state.msg}>
        <CircleAlert className="size-3 shrink-0" /> Não foi possível salvar. Confira a internet e faça a mudança de novo.
      </span>
    );
  return (
    <span className={cn(base, "text-emerald-700 dark:text-emerald-400")}>
      <Check className="size-3 shrink-0" /> Tudo salvo às {state.at}
    </span>
  );
}
