import { Check, RotateCcw, Save } from "lucide-react";
import type { Position } from "@/lib/api";
import { FICHA } from "@/lib/map";
import { REC } from "@/lib/rules";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Sheet, SheetContent } from "./ui/sheet";
import { Switch } from "./ui/switch";

interface Group {
  title: string;
  codes: string[];
}

function groups(positions: Record<string, Position>): { section: string; items: Group[] }[] {
  const corridors = Object.values(positions)
    .filter((p) => p.category === "Corredor")
    .map((p) => p.code)
    .sort();
  const rec = Object.values(positions)
    .filter((p) => p.category === REC)
    .map((p) => p.code)
    .sort();
  return [
    {
      section: "Mapa",
      items: [
        { title: "Corredores", codes: corridors },
        { title: "Banheiros, berçário e galerias", codes: ["BM", "BF", "BK", "GM", "GF"] },
        { title: "Recepção", codes: rec },
      ],
    },
    ...FICHA.map((sec) => ({
      section: sec.side === "in" ? "Entrada (antes do culto)" : "Saída (depois do culto)",
      items: sec.groups.map(([title, codes]) => ({ title, codes })),
    })),
  ];
}

function chipLabel(p: Position) {
  if (p.category === REC) return p.code.slice(1);
  if (/^\d+$/.test(p.code) || ["BM", "BF", "BK", "GM", "GF"].includes(p.code)) return p.code;
  const m = p.code.match(/(\d+)$/);
  return m ? m[1] : p.code;
}

export function PositionsSheet({
  open,
  onOpenChange,
  positions,
  active,
  defaults,
  onChange,
  onSaveDefault,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  positions: Record<string, Position>;
  active: Set<string>;
  defaults: string[];
  onChange: (next: Set<string>) => void;
  onSaveDefault: () => void;
}) {
  const toggle = (codes: string[], on: boolean) => {
    const n = new Set(active);
    codes.forEach((c) => (on ? n.add(c) : n.delete(c)));
    onChange(n);
  };
  const total = Object.keys(positions).length;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="Posições do culto"
        description={`${active.size} de ${total} posições ativas. Clique para ativar ou desativar.`}
        className="max-w-lg"
      >
        <div className="flex items-center gap-2 border-b px-5 py-2.5">
          <Button size="xs" variant="outline" onClick={() => onChange(new Set(defaults))}>
            <RotateCcw /> Padrão
          </Button>
          <Button size="xs" variant="outline" onClick={() => onChange(new Set(Object.keys(positions)))}>
            Todas
          </Button>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" onClick={onSaveDefault}>
            <Save /> Usar como padrão
          </Button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {groups(positions).map((sec) => (
            <section key={sec.section}>
              <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{sec.section}</h4>
              <div className="space-y-3">
                {sec.items.map((g) => {
                  const codes = g.codes.filter((c) => positions[c]);
                  const on = codes.filter((c) => active.has(c)).length;
                  return (
                    <div key={g.title} className="rounded-lg border p-2.5">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[13px] font-medium">
                          {g.title} <span className="font-normal text-muted-foreground">· {on}/{codes.length}</span>
                        </span>
                        <Switch checked={on === codes.length} onCheckedChange={(v) => toggle(codes, v)} />
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {codes.map((c) => {
                          const isOn = active.has(c);
                          return (
                            <button
                              key={c}
                              title={positions[c].name}
                              onClick={() => toggle([c], !isOn)}
                              className={cn(
                                "flex h-7 min-w-9 items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors",
                                isOn
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-dashed border-input text-muted-foreground hover:border-ring hover:text-foreground",
                              )}
                            >
                              {isOn && <Check className="size-3" strokeWidth={3} />}
                              {chipLabel(positions[c])}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
