import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronsUpDown, FilterX, ListFilter, Pencil, Plus, Search, Users } from "lucide-react";
import { api, type Me, type SavedVolunteer, type Volunteer, type VolunteerFields } from "@/lib/api";
import { br, cn, normalize, teamLabel } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { FieldLabel, Label } from "@/components/ui/label";

const PERMS = [
  ["can_bercario", "Berçário"],
  ["can_cozinha", "Cozinha"],
  ["can_recepcao", "Recepção"],
  ["can_banheiro", "Banheiro"],
  ["can_limpar_altar", "Altar"],
] as const;
type PermKey = (typeof PERMS)[number][0];
/** Campos do cadastro: só eles são enviados à API. */
const FIELDS = [
  "name",
  "gender",
  "team",
  "active",
  "can_bercario",
  "can_cozinha",
  "can_recepcao",
  "can_banheiro",
  "can_limpar_altar",
  "observation",
] as const;
type SortKey = "name" | "team" | "faltas" | "vezes" | "ultima_vez";

const EMPTY: Partial<Volunteer> = {
  name: "",
  gender: "Feminino",
  team: "",
  active: true,
  can_bercario: true,
  can_cozinha: true,
  can_recepcao: true,
  can_banheiro: true,
  can_limpar_altar: true,
  observation: "",
};

export function VoluntariosPage({
  me,
  volunteers,
  onReload,
}: {
  me: Me;
  /** a lista chega pronta: a tela nasce preenchida */
  volunteers: Volunteer[];
  /** busca a lista de novo (quando uma gravação falha e a tela pode ter ficado diferente do banco) */
  onReload: () => void;
}) {
  const [list, setList] = useState<Volunteer[]>(volunteers);
  const [q, setQ] = useState("");
  const [team, setTeam] = useState("all");
  const [gender, setGender] = useState<"all" | "Feminino" | "Masculino">("all");
  const [status, setStatus] = useState<"active" | "inactive" | "all">("active");
  const [perms, setPerms] = useState<Set<string>>(new Set()); // "can_x" = pode, "!can_x" = não pode
  const [withAbs, setWithAbs] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [edit, setEdit] = useState<Partial<Volunteer> | null>(null);

  const rows = useMemo(() => {
    const nq = normalize(q);
    const r = list.filter(
      (v) =>
        (!nq || normalize(v.name).includes(nq) || normalize(v.observation ?? "").includes(nq)) &&
        (team === "all" || v.team === team) &&
        (gender === "all" || v.gender === gender) &&
        (status === "all" || (status === "active" ? v.active : !v.active)) &&
        (!withAbs || v.faltas > 0) &&
        [...perms].every((p) => (p.startsWith("!") ? !v[p.slice(1) as PermKey] : v[p as PermKey])),
    );
    const k = sort.key;
    return r.sort((a, b) => {
      const av = a[k] ?? "";
      const bv = b[k] ?? "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv), "pt-BR") * sort.dir;
    });
  }, [list, q, team, gender, status, perms, withAbs, sort]);

  const filtersOn = q || team !== "all" || gender !== "all" || status !== "active" || perms.size || withAbs;
  const clearFilters = () => {
    setQ("");
    setTeam("all");
    setGender("all");
    setStatus("active");
    setPerms(new Set());
    setWithAbs(false);
  };

  /** Põe na lista o cadastro que a API devolveu, sem pedir a lista inteira de novo. */
  const merge = (saved: SavedVolunteer) =>
    setList((l) => {
      const old = l.find((x) => x.id === saved.id);
      const next: Volunteer = { faltas: 0, vezes: 0, ultima_vez: null, ...old, ...saved };
      return old ? l.map((x) => (x.id === saved.id ? next : x)) : [...l, next];
    });

  /** Marca na hora e envia só o campo que mudou. */
  const quickSave = async (v: Volunteer, patch: Partial<VolunteerFields>) => {
    setList((l) => l.map((x) => (x.id === v.id ? { ...x, ...patch } : x)));
    try {
      await api.updateVolunteer(v.id, patch);
    } catch (e) {
      toast.error((e as Error).message);
      onReload();
    }
  };

  const stats = useMemo(
    () => ({
      total: list.filter((v) => v.active).length,
      f: list.filter((v) => v.active && v.gender === "Feminino").length,
      m: list.filter((v) => v.active && v.gender === "Masculino").length,
    }),
    [list],
  );

  const th = (key: SortKey, label: string, className?: string) => (
    <th className={cn("px-2", className)}>
      <button
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === "name" || key === "team" ? 1 : -1 }))}
      >
        {label}
        {sort.key === key ? (
          sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
        ) : (
          <ChevronsUpDown className="size-3 opacity-40" />
        )}
      </button>
    </th>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background/85 px-5 py-2.5 backdrop-blur">
        <div className="mr-auto">
          <h1 className="text-[15px] leading-tight font-semibold">Voluntários</h1>
          <p className="text-xs text-muted-foreground">
            {stats.total} ativos · {stats.f} mulheres · {stats.m} homens ·{" "}
            <b className="font-medium text-foreground">{rows.length} na lista</b>
          </p>
        </div>
        <Button onClick={() => setEdit({ ...EMPTY, team: team !== "all" ? team : (me.teams[0] ?? "") })}>
          <Plus /> Novo voluntário
        </Button>
      </header>

      {/* filtros */}
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome ou observação" className="w-56 pl-8" />
        </div>
        <Select value={team} onValueChange={setTeam}>
          <SelectTrigger className="w-[190px]">
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
        <Segmented
          value={gender}
          onChange={setGender}
          options={[
            { value: "all", label: "Todos" },
            { value: "Feminino", label: "Mulheres" },
            { value: "Masculino", label: "Homens" },
          ]}
        />
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: "active", label: "Ativos" },
            { value: "inactive", label: "Inativos" },
            { value: "all", label: "Todos" },
          ]}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <ListFilter /> Filtros
              {perms.size + (withAbs ? 1 : 0) > 0 && (
                <Badge className="ml-0.5 h-5 min-w-5 rounded-full px-1">{perms.size + (withAbs ? 1 : 0)}</Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuCheckboxItem checked={withAbs} onCheckedChange={(c) => setWithAbs(!!c)}>
              Somente quem tem faltas
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Pode servir em</DropdownMenuLabel>
            {PERMS.map(([k, l]) => (
              <DropdownMenuCheckboxItem
                key={k}
                checked={perms.has(k)}
                onCheckedChange={(c) => {
                  const n = new Set(perms);
                  n.delete("!" + k);
                  if (c) n.add(k);
                  else n.delete(k);
                  setPerms(n);
                }}
              >
                {l}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Não pode servir em</DropdownMenuLabel>
            {PERMS.map(([k, l]) => (
              <DropdownMenuCheckboxItem
                key={"!" + k}
                checked={perms.has("!" + k)}
                onCheckedChange={(c) => {
                  const n = new Set(perms);
                  n.delete(k);
                  if (c) n.add("!" + k);
                  else n.delete("!" + k);
                  setPerms(n);
                }}
              >
                {l}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {filtersOn ? (
          <Button variant="ghost" onClick={clearFilters}>
            <FilterX /> Limpar
          </Button>
        ) : null}
      </div>

      {/* tabela */}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        <Card className="overflow-hidden">
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
              <tr className="h-9 [&>th]:font-medium">
                {th("name", "Nome", "pl-4")}
                {th("team", "Equipe")}
                {th("faltas", "Faltas", "text-center")}
                {th("vezes", "Serviu", "text-center")}
                {th("ultima_vez", "Última vez", "whitespace-nowrap")}
                <th className="px-2">Observação</th>
                {PERMS.map(([k, l]) => (
                  <th key={k} className="w-[70px] px-1 text-center">
                    {l}
                  </th>
                ))}
                <th className="w-[60px] px-1 text-center">Ativo</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} className={cn("h-9 border-t transition-colors hover:bg-muted/40", !v.active && "text-muted-foreground")}>
                  <td className="pl-4 font-medium whitespace-nowrap">
                    <button className="inline-flex items-center gap-2 hover:underline" onClick={() => setEdit(v)} title={v.gender}>
                      <i className={cn("size-2 shrink-0 rounded-full", v.gender === "Feminino" ? "bg-rose-500" : "bg-sky-600")} />
                      {v.name}
                    </button>
                  </td>
                  <td className="px-2 whitespace-nowrap">{teamLabel(v.team)}</td>
                  <td className="px-2 text-center tabular-nums">
                    {v.faltas ? <Badge variant="destructive">{v.faltas}</Badge> : <span className="text-muted-foreground/50">0</span>}
                  </td>
                  <td className="px-2 text-center tabular-nums">{v.vezes || <span className="text-muted-foreground/50">0</span>}</td>
                  <td className="px-2 tabular-nums">{br(v.ultima_vez) || <span className="text-muted-foreground/50">—</span>}</td>
                  <td className="max-w-[260px] px-2">
                    {v.observation ? (
                      <button
                        className="block w-full truncate text-left text-xs text-muted-foreground hover:text-foreground"
                        title={v.observation}
                        onClick={() => setEdit(v)}
                      >
                        {v.observation}
                      </button>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  {PERMS.map(([k]) => (
                    <td key={k} className="px-1 text-center">
                      <Checkbox
                        checked={v[k]}
                        onCheckedChange={(c) => quickSave(v, { [k]: !!c })}
                        aria-label={k}
                      />
                    </td>
                  ))}
                  <td className="px-1 text-center">
                    <Switch checked={v.active} onCheckedChange={(c) => quickSave(v, { active: c })} />
                  </td>
                  <td className="pr-2 text-right">
                    <Button variant="ghost" size="icon-xs" onClick={() => setEdit(v)}>
                      <Pencil />
                    </Button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={14} className="py-12 text-center text-muted-foreground">
                    Nenhum voluntário com esses filtros.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      <VolunteerSheet
        value={edit}
        teams={me.teams}
        onClose={() => setEdit(null)}
        onSaved={(saved) => {
          setEdit(null);
          merge(saved);
        }}
      />
    </div>
  );
}

function VolunteerSheet({
  value,
  teams,
  onClose,
  onSaved,
}: {
  value: Partial<Volunteer> | null;
  teams: string[];
  onClose: () => void;
  onSaved: (saved: SavedVolunteer) => void;
}) {
  const [f, setF] = useState<Partial<Volunteer>>(EMPTY);
  useEffect(() => {
    if (value) setF(value);
  }, [value]);
  const set = (patch: Partial<Volunteer>) => setF((x) => ({ ...x, ...patch }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const fields = Object.fromEntries(FIELDS.map((k) => [k, f[k]])) as Partial<VolunteerFields>;
      const saved = f.id ? await api.updateVolunteer(f.id, fields) : await api.createVolunteer(fields);
      toast.success("Cadastro salvo.");
      onSaved(saved);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <Sheet open={!!value} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={f.id ? "Editar voluntário" : "Novo voluntário"} description="Os dados valem para as próximas escalas.">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div className="space-y-1.5">
              <FieldLabel>Nome</FieldLabel>
              <Input autoFocus value={f.name ?? ""} onChange={(e) => set({ name: e.target.value })} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <FieldLabel>Gênero</FieldLabel>
                <Segmented
                  className="w-full [&>button]:flex-1"
                  value={(f.gender ?? "Feminino") as "Feminino" | "Masculino"}
                  onChange={(g) => set({ gender: g, ...(f.id ? {} : { can_bercario: g === "Feminino" }) })}
                  options={[
                    { value: "Feminino", label: "Feminino" },
                    { value: "Masculino", label: "Masculino" },
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel>Equipe</FieldLabel>
                <Select value={f.team ?? ""} onValueChange={(t) => set({ team: t })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Escolha" />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map((t) => (
                      <SelectItem key={t} value={t}>
                        {teamLabel(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Pode servir em</FieldLabel>
              <div className="divide-y rounded-lg border">
                {PERMS.map(([k, l]) => (
                  <Label key={k} className="h-10 justify-between px-3 font-normal">
                    {l}
                    <Switch checked={!!f[k]} onCheckedChange={(c) => set({ [k]: c })} />
                  </Label>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Observações</FieldLabel>
              <textarea
                value={f.observation ?? ""}
                onChange={(e) => set({ observation: e.target.value })}
                rows={3}
                maxLength={500}
                placeholder="Ex.: só pode até as 10h; prefere não ficar na cozinha; gestante…"
                className="flex w-full min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
              />
              <p className="text-xs text-muted-foreground">Aparece na presença e na lista de troca da escala.</p>
            </div>
            <Label className="h-10 justify-between rounded-lg border px-3 font-normal">
              Ativo (entra nas escalas)
              <Switch checked={!!f.active} onCheckedChange={(c) => set({ active: c })} />
            </Label>
          </div>
          <div className="flex justify-end gap-2 border-t px-5 py-3">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit">Salvar</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
