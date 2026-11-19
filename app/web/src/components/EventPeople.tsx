import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Eraser, History, Plus, Search, StickyNote, UserPlus, X } from "lucide-react";
import type { Volunteer } from "@/lib/api";
import { br, cn, normalize, teamLabel } from "@/lib/utils";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";

/**
 * Quem vai servir no evento. Ninguém começa escolhido: dá para trazer uma equipe inteira,
 * todo mundo, as mesmas pessoas do evento anterior, ou procurar pelo nome. Tocar num nome
 * escolhido tira a pessoa (e das posições, se a escala já estiver feita).
 */
export function EventPeople({
  volunteers,
  chosen,
  lastEvent,
  onChange,
}: {
  /** todos os voluntários ativos, de todas as equipes, em ordem de nome */
  volunteers: Volunteer[];
  chosen: Set<number>;
  lastEvent: { date: string; ids: number[] } | null;
  onChange: (next: Set<number>) => void;
}) {
  const [q, setQ] = useState("");

  const teams = useMemo(() => {
    const byTeam = new Map<string, number[]>();
    for (const v of volunteers) {
      if (!byTeam.has(v.team)) byTeam.set(v.team, []);
      byTeam.get(v.team)!.push(v.id);
    }
    return [...byTeam].sort(([a], [b]) => a.localeCompare(b, "pt-BR"));
  }, [volunteers]);

  const known = useMemo(() => new Set(volunteers.map((v) => v.id)), [volunteers]);
  const picked = volunteers.filter((v) => chosen.has(v.id));
  const women = picked.filter((v) => v.gender === "Feminino").length;
  const nq = normalize(q);
  const rest = volunteers.filter((v) => !chosen.has(v.id) && (!nq || normalize(v.name).includes(nq)));
  // do evento anterior, só quem continua ativo
  const repeat = lastEvent ? lastEvent.ids.filter((id) => known.has(id)) : [];

  /** Troca a lista e, se alguém saiu, oferece desfazer. */
  const apply = (next: Set<number>, message?: string) => {
    const before = chosen;
    onChange(next);
    const removed = [...before].filter((id) => !next.has(id)).length;
    if (message || removed > 1) {
      toast(message ?? `${removed} pessoas saíram do evento.`, {
        action: removed ? { label: "Desfazer", onClick: () => onChange(before) } : undefined,
      });
    }
  };

  const add = (ids: number[]) => apply(new Set([...chosen, ...ids]));
  const remove = (ids: number[]) => {
    const out = new Set(ids);
    apply(new Set([...chosen].filter((id) => !out.has(id))));
  };
  const toggle = (id: number) => (chosen.has(id) ? remove([id]) : add([id]));

  return (
    <Card className="no-print">
      {/* atalhos */}
      <div className="space-y-3 border-b px-3 py-3 md:px-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm">
            <b className="text-base text-emerald-700 tabular-nums">{picked.length}</b>{" "}
            {picked.length === 1 ? "vai servir" : "vão servir"}
            {picked.length > 0 && (
              <span className="text-muted-foreground">
                {" "}
                · {women} {women === 1 ? "mulher" : "mulheres"} · {picked.length - women}{" "}
                {picked.length - women === 1 ? "homem" : "homens"}
              </span>
            )}
          </span>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            {repeat.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => add(repeat)}>
                <History /> Repetir o evento de {br(lastEvent!.date).slice(0, 5)} ({repeat.length})
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => add(volunteers.map((v) => v.id))}
              disabled={picked.length === volunteers.length}
            >
              <UserPlus /> Adicionar todos
            </Button>
            {picked.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => apply(new Set(), `Lista esvaziada (${picked.length} ${picked.length === 1 ? "pessoa" : "pessoas"}).`)}
              >
                <Eraser /> Limpar
              </Button>
            )}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Equipe inteira (toque de novo para tirar)</div>
          <div className="flex flex-wrap gap-1.5">
            {teams.map(([team, ids]) => {
              const n = ids.filter((id) => chosen.has(id)).length;
              const all = n === ids.length;
              return (
                <button
                  key={team}
                  onClick={() => (all ? remove(ids) : add(ids))}
                  aria-pressed={all}
                  className={cn(
                    "flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors",
                    all
                      ? "border-emerald-600 bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
                      : "border-input bg-background hover:bg-accent",
                  )}
                >
                  {all ? <Check className="size-3.5 text-emerald-700" strokeWidth={2.5} /> : <Plus className="size-3.5" />}
                  {teamLabel(team) || "Sem equipe"}
                  <span className="text-xs text-muted-foreground tabular-nums">{n && !all ? `${n} de ${ids.length}` : ids.length}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* escolhidos */}
      <div className="border-b p-3 md:p-4">
        <div className="mb-2 text-sm font-semibold">Vão servir</div>
        {picked.length ? (
          <PeopleGrid people={picked} chosen onToggle={toggle} />
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
            Ninguém escolhido ainda. Use os botões acima ou procure pelo nome logo abaixo.
          </p>
        )}
      </div>

      {/* adicionar */}
      <div className="p-3 md:p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="mr-auto text-sm font-semibold">Adicionar pessoas</span>
          <div className="relative min-w-0 flex-1 sm:max-w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar pelo nome" className="pl-8" />
          </div>
        </div>
        {rest.length ? (
          <PeopleGrid people={rest} onToggle={toggle} />
        ) : (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {nq ? "Ninguém com esse nome fora da lista." : "Todos já estão na lista."}
          </p>
        )}
      </div>
    </Card>
  );
}

function PeopleGrid({ people, chosen, onToggle }: { people: Volunteer[]; chosen?: boolean; onToggle: (id: number) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5 md:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
      {people.map((v) => (
        <button
          key={v.id}
          onClick={() => onToggle(v.id)}
          aria-label={`${v.name}: ${chosen ? "tirar do evento" : "colocar no evento"}`}
          className={cn(
            "flex min-h-11 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm leading-tight transition-colors",
            chosen
              ? "border-emerald-300 bg-emerald-50 text-emerald-950 hover:border-destructive/40 hover:bg-destructive-soft"
              : "border-input border-dashed bg-background text-muted-foreground hover:border-solid hover:bg-accent hover:text-foreground",
          )}
        >
          {chosen ? <X className="size-4 shrink-0 opacity-60" strokeWidth={2.5} /> : <Plus className="size-4 shrink-0" strokeWidth={2.5} />}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="flex items-start gap-1.5">
              <i className={cn("mt-1.5 size-2 shrink-0 rounded-full", v.gender === "Feminino" ? "bg-rose-500" : "bg-sky-600")} />
              <span className={cn("line-clamp-2 break-words", chosen && "font-medium")}>{v.name}</span>
            </span>
            <span className="block truncate pl-3.5 text-xs opacity-70">{teamLabel(v.team)}</span>
          </span>
          {v.observation && <StickyNote className="size-3.5 shrink-0 text-amber-600" aria-label="Tem recado" />}
        </button>
      ))}
    </div>
  );
}
