import { Command } from "cmdk";
import { AlertTriangle, ArrowLeftRight, EyeOff, Search, StickyNote, UserX } from "lucide-react";
import type { Position, Volunteer } from "@/lib/api";
import { allowed, conflict, shortPos } from "@/lib/rules";
import { normalize } from "@/lib/utils";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Button } from "./ui/button";

export interface PickerTarget {
  code: string;
  rect: DOMRect;
}

export function PersonPicker({
  target,
  onClose,
  positions,
  vols,
  present,
  assign,
  lastSunday,
  onChoose,
  onClear,
  onDisable,
}: {
  target: PickerTarget | null;
  onClose: () => void;
  positions: Record<string, Position>;
  vols: Record<number, Volunteer>;
  present: Set<number>;
  assign: Record<string, number>;
  lastSunday: boolean;
  onChoose: (code: string, vid: number) => void;
  onClear: (code: string) => void;
  onDisable: (code: string) => void;
}) {
  const p = target ? positions[target.code] : null;
  const cur = target ? assign[target.code] : undefined;

  const where = (vid: number) =>
    Object.entries(assign)
      .filter(([c, v]) => v === vid && c !== target?.code)
      .map(([c]) => shortPos(positions[c]));

  const items = p
    ? Object.values(vols)
        .filter((v) => v.active && present.has(v.id) && v.id !== cur && allowed(v, p))
        .map((v) => ({ v, c: conflict(v.id, p.code, assign, positions, lastSunday), w: where(v.id) }))
        .sort((a, b) => a.v.name.localeCompare(b.v.name, "pt-BR"))
    : [];
  const free = items.filter((x) => !x.c && !x.w.length);
  const busy = items.filter((x) => !x.c && x.w.length);
  const blocked = items.filter((x) => x.c);

  const rect = target?.rect;
  return (
    <Popover open={!!target} onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>
        <div
          style={{
            position: "fixed",
            left: rect?.left ?? 0,
            top: rect?.top ?? 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="w-80 p-0" align="start" collisionPadding={12}>
        {p && (
          <Command
            filter={(value, search) => (normalize(value).includes(normalize(search)) ? 1 : 0)}
            className="flex max-h-[min(460px,70vh)] flex-col"
          >
            <div className="border-b px-3 pt-2.5 pb-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{p.name}</span>
                {p.allowed_gender !== "Qualquer" && (
                  <span className="text-xs text-muted-foreground">somente {p.allowed_gender.toLowerCase()}</span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {cur ? (
                  <>
                    Atual: <b className="text-foreground">{vols[cur]?.name}</b>
                    {vols[cur]?.observation && (
                      <span className="mt-0.5 flex items-start gap-1 text-amber-700">
                        <StickyNote className="mt-px size-3 shrink-0" /> {vols[cur]?.observation}
                      </span>
                    )}
                  </>
                ) : (
                  "Posição vazia"
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 text-muted-foreground" />
              <Command.Input
                autoFocus
                placeholder="Buscar pessoa…"
                className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
              />
            </div>
            <Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">Ninguém encontrado.</Command.Empty>
              {free.length > 0 && (
                <Command.Group heading={`Livres · ${free.length}`} className="picker-group">
                  {free.map((x) => (
                    <Row key={x.v.id} x={x} onSelect={() => onChoose(p.code, x.v.id)} />
                  ))}
                </Command.Group>
              )}
              {busy.length > 0 && (
                <Command.Group heading="Já têm função · escolher faz troca" className="picker-group">
                  {busy.map((x) => (
                    <Row key={x.v.id} x={x} onSelect={() => onChoose(p.code, x.v.id)} />
                  ))}
                </Command.Group>
              )}
              {blocked.length > 0 && (
                <Command.Group heading="Quebra uma regra" className="picker-group">
                  {blocked.map((x) => (
                    <Row key={x.v.id} x={x} onSelect={() => onChoose(p.code, x.v.id)} />
                  ))}
                </Command.Group>
              )}
            </Command.List>
            <div className="flex gap-1 border-t p-1.5">
              <Button variant="ghost" size="xs" className="flex-1" onClick={() => onClear(p.code)} disabled={!cur}>
                <UserX /> Deixar vazio
              </Button>
              <Button variant="ghost" size="xs" className="flex-1" onClick={() => onDisable(p.code)}>
                <EyeOff /> Desativar posição
              </Button>
            </div>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Row({ x, onSelect }: { x: { v: Volunteer; c: string; w: string[] }; onSelect: () => void }) {
  return (
    <Command.Item
      value={x.v.name}
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent"
    >
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-bold text-white ${x.v.gender === "Feminino" ? "bg-rose-500" : "bg-sky-600"}`}
      >
        {x.v.gender[0]}
      </span>
      <span className="min-w-0 flex-1 truncate" title={x.v.observation ? `Obs.: ${x.v.observation}` : undefined}>
        {x.v.name}
        {x.v.observation && <StickyNote className="ml-1 inline size-3 align-[-1px] text-amber-600" />}
      </span>
      {x.c ? (
        <span className="flex items-center gap-1 text-xs text-amber-700">
          <AlertTriangle className="size-3" /> {x.c}
        </span>
      ) : x.w.length ? (
        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          <ArrowLeftRight className="size-3" /> {x.w.join(", ")}
        </span>
      ) : null}
    </Command.Item>
  );
}
