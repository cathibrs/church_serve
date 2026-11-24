import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CalendarRange,
  FilterX,
  KeyRound,
  Loader2,
  Search,
  Settings2,
  ShieldCheck,
  StickyNote,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { api, type ActivityFilter, type ActivityGroup, type ActivityItem, type ActivityPage, type Me } from "@/lib/api";
import { br, cn, normalize, teamLabel } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const GROUPS: Record<ActivityGroup, { label: string; icon: LucideIcon; tone: string }> = {
  schedule: { label: "Escalas", icon: CalendarRange, tone: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" },
  volunteer: { label: "Cadastro de voluntários", icon: Users, tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  note: { label: "Observações", icon: StickyNote, tone: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  positions: { label: "Posições padrão", icon: Settings2, tone: "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300" },
  user: { label: "Acessos", icon: KeyRound, tone: "bg-violet-100 text-violet-700" },
  rules: { label: "Regras", icon: ShieldCheck, tone: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
};

const groupOf = (action: string) => GROUPS[action.split(".")[0] as ActivityGroup] ?? GROUPS.rules;

/** "Hoje", "Ontem" ou a data, para separar a lista por dia. */
function dayLabel(date: string, today: string, yesterday: string) {
  if (date === today) return "Hoje";
  if (date === yesterday) return "Ontem";
  return br(date);
}

function localDay(offsetDays = 0): string {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}

/**
 * Registro de atividades (só administrador): quem cadastrou, alterou, escalou, escreveu
 * observações e mexeu nos acessos. A primeira página chega pronta; os filtros pedem de novo.
 */
export function AtividadePage({ me, page }: { me: Me; page: ActivityPage }) {
  const [items, setItems] = useState<ActivityItem[]>(page.items);
  const [next, setNext] = useState<number | null>(page.next);
  const [actors, setActors] = useState<string[]>(page.actors);
  const [filter, setFilter] = useState<ActivityFilter>({});
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  /** Pede a lista com os filtros; `more` = continua de onde parou. */
  const fetchList = async (f: ActivityFilter, more = false) => {
    setBusy(true);
    try {
      const r = await api.activity(more && next ? { ...f, before: next } : f);
      setItems((old) => (more ? [...old, ...r.items] : r.items));
      setNext(r.next);
      setActors(r.actors);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const change = (patch: ActivityFilter) => {
    const f = { ...filter, ...patch };
    setFilter(f);
    fetchList(f);
  };

  const shown = useMemo(() => {
    const nq = normalize(q);
    if (!nq) return items;
    return items.filter((i) => normalize(`${i.summary} ${i.actor} ${i.actor_name ?? ""}`).includes(nq));
  }, [items, q]);

  const days = useMemo(() => {
    const out: { day: string; items: ActivityItem[] }[] = [];
    for (const item of shown) {
      const day = item.at.slice(0, 10);
      if (out.at(-1)?.day !== day) out.push({ day, items: [] });
      out.at(-1)!.items.push(item);
    }
    return out;
  }, [shown]);

  const today = localDay();
  const yesterday = localDay(1);
  const filtersOn = filter.actor || filter.group || filter.team || q;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background/85 px-3 py-2.5 backdrop-blur md:px-5">
        <div className="mr-auto">
          <h1 className="text-lg leading-tight font-semibold">Atividade</h1>
          <p className="text-xs text-muted-foreground">
            Quem fez o quê no sistema: escalas salvas, cadastros, observações e acessos. Só administradores veem.
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5 md:px-5">
        <div className="relative max-md:min-w-0 max-md:basis-full">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar no que já carregou" className="pl-8 md:w-60" />
        </div>
        <Select value={filter.actor ?? "all"} onValueChange={(v) => change({ actor: v === "all" ? undefined : v })}>
          <SelectTrigger className="w-[230px] max-md:flex-1" aria-label="Pessoa">
            <UserRound className="size-4 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as pessoas</SelectItem>
            {actors.map((a) => (
              <SelectItem key={a} value={a}>
                {a === me.email ? `${a} (você)` : a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filter.group ?? "all"}
          onValueChange={(v) => change({ group: v === "all" ? undefined : (v as ActivityGroup) })}
        >
          <SelectTrigger className="w-[220px] max-md:flex-1" aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tudo</SelectItem>
            {(Object.keys(GROUPS) as ActivityGroup[]).map((g) => (
              <SelectItem key={g} value={g}>
                {GROUPS[g].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.team ?? "all"} onValueChange={(v) => change({ team: v === "all" ? undefined : v })}>
          <SelectTrigger className="w-[200px] max-md:flex-1" aria-label="Equipe">
            <Users className="size-4 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as equipes</SelectItem>
            {me.teams.map((t) => (
              <SelectItem key={t} value={t}>
                {teamLabel(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersOn ? (
          <Button
            variant="ghost"
            onClick={() => {
              setQ("");
              setFilter({});
              fetchList({});
            }}
          >
            <FilterX /> Limpar filtros
          </Button>
        ) : null}
        {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Carregando" />}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 md:px-5">
        {days.length === 0 && (
          <Card className="py-12 text-center text-sm text-muted-foreground">
            {items.length ? "Nada com essa busca." : "Nenhuma atividade registrada com esses filtros."}
          </Card>
        )}
        <div className="space-y-4">
          {days.map(({ day, items: list }) => (
            <section key={day}>
              <h2 className="mb-1.5 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {dayLabel(day, today, yesterday)}
              </h2>
              <Card className="divide-y overflow-hidden">
                {list.map((item) => {
                  const g = groupOf(item.action);
                  const Icon = g.icon;
                  return (
                    <div key={item.id} className="flex items-start gap-3 px-3 py-2.5 md:px-4">
                      <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", g.tone)}>
                        <Icon className="size-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm break-words">{item.summary}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80" title={item.actor}>
                            {item.actor_name ?? item.actor}
                          </span>
                          {item.team && <Badge variant="secondary">{teamLabel(item.team)}</Badge>}
                          {item.repeats > 1 && (
                            <span title="Gravações seguidas da mesma coisa, juntadas nesta linha">
                              salvo {item.repeats} vezes
                            </span>
                          )}
                        </p>
                      </div>
                      <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={item.at}>
                        {item.at.slice(11, 16)}
                      </time>
                    </div>
                  );
                })}
              </Card>
            </section>
          ))}
        </div>
        {next && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" disabled={busy} onClick={() => fetchList(filter, true)}>
              {busy && <Loader2 className="animate-spin" />} Carregar mais antigas
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
