import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Eye,
  FilterX,
  ListFilter,
  Loader2,
  Lock,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Users,
} from "lucide-react";
import {
  api,
  canEditVolunteers,
  isEventTeam,
  type Me,
  type SavedVolunteer,
  type Volunteer,
  type VolunteerFields,
  type VolunteerNote,
} from "@/lib/api";
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

/** Equipes em que se cadastra gente: Eventos fica de fora, porque junta todos os voluntários. */
const volunteerTeams = (me: Me) => me.teams.filter((t) => !isEventTeam(t));

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
        (!nq ||
          normalize(v.name).includes(nq) ||
          normalize(v.observation ?? "").includes(nq) ||
          normalize(v.ultima_nota ?? "").includes(nq)) &&
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

  /** O admin pode travar o cadastro para coordenadores: aí a tela só mostra (e aceita observações). */
  const editable = canEditVolunteers(me);

  /** Atualiza na lista o número de observações e a mais recente, depois de escrever ou apagar. */
  const noteCount = (id: number, notes: VolunteerNote[]) =>
    setList((l) => l.map((x) => (x.id === id ? { ...x, notas: notes.length, ultima_nota: notes[0]?.body ?? null } : x)));

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
      <header className="flex flex-wrap items-center gap-2 border-b bg-background/85 px-3 py-2.5 backdrop-blur md:px-5">
        <div className="mr-auto">
          <h1 className="text-lg leading-tight font-semibold">Voluntários</h1>
          <p className="text-xs text-muted-foreground">
            {stats.total} ativos · {stats.f} mulheres · {stats.m} homens ·{" "}
            <b className="font-medium text-foreground">{rows.length} na lista</b>
          </p>
          <p className="text-xs text-muted-foreground">
            Toque no nome para ver e editar o cadastro. As caixinhas e a chave "Ativo" salvam na hora; "Ativo" desligado = a pessoa não entra nas próximas escalas.
          </p>
        </div>
        {editable && (
          <Button onClick={() => setEdit({ ...EMPTY, team: team !== "all" ? team : (volunteerTeams(me)[0] ?? "") })}>
            <Plus /> Novo voluntário
          </Button>
        )}
      </header>
      {!editable && (
        <p className="flex items-center gap-2 border-b bg-warning-soft px-3 py-2 text-sm md:px-5">
          <Lock className="size-4 shrink-0" />
          O administrador travou o cadastro: você pode ver os dados e escrever observações, mas não alterar.
        </p>
      )}

      {/* filtros — no celular: busca e "Filtros" em cima; equipe e os dois seletores numa faixa de arrastar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5 md:px-5">
        <div className="relative max-md:min-w-0 max-md:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome ou observação" className="pl-8 md:w-56" />
        </div>
        {/* a partir de `md` este grupo some (`contents`) e os três voltam a ser itens da barra */}
        <div className="flex items-center gap-2 max-md:order-1 max-md:basis-full max-md:overflow-x-auto max-md:[scrollbar-width:none] md:contents max-md:[&::-webkit-scrollbar]:hidden">
          <Select value={team} onValueChange={setTeam}>
            <SelectTrigger className="w-[190px] max-md:shrink-0">
              <Users className="size-4 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as equipes</SelectItem>
              {volunteerTeams(me).map((t) => (
                <SelectItem key={t} value={t}>
                  {teamLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Segmented
            className="max-md:shrink-0"
            value={gender}
            onChange={setGender}
            options={[
              { value: "all", label: "Todos" },
              { value: "Feminino", label: "Mulheres" },
              { value: "Masculino", label: "Homens" },
            ]}
          />
          <Segmented
            className="max-md:shrink-0"
            value={status}
            onChange={setStatus}
            options={[
              { value: "active", label: "Ativos" },
              { value: "inactive", label: "Inativos" },
              { value: "all", label: "Todos" },
            ]}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <ListFilter /> Filtros
              {perms.size + (withAbs ? 1 : 0) > 0 && (
                <Badge className="ml-0.5 h-5 min-w-5 rounded-full px-1">{perms.size + (withAbs ? 1 : 0)}</Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuCheckboxItem checked={withAbs} onCheckedChange={(c) => setWithAbs(!!c)}>
              Mostrar só quem tem faltas
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Mostrar só quem pode servir em</DropdownMenuLabel>
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
            <DropdownMenuLabel>Mostrar só quem não pode servir em</DropdownMenuLabel>
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
            <FilterX /> Limpar filtros
          </Button>
        ) : null}
      </div>

      {/* celular: lista compacta, e o resto do cadastro abre ao tocar · telas maiores: tabela completa */}
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 md:px-5">
        <Card className="overflow-hidden md:overflow-x-auto">
          <ul className="divide-y md:hidden">
            {rows.map((v) => (
              <li key={v.id} className={cn("flex items-center gap-3 px-3", !v.active && "text-muted-foreground")}>
                <button className="min-w-0 flex-1 py-2.5 text-left" onClick={() => setEdit(v)}>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <i className={cn("size-2 shrink-0 rounded-full", v.gender === "Feminino" ? "bg-rose-500" : "bg-sky-600")} />
                    <span className="truncate">{v.name}</span>
                    {v.observation && <StickyNote className="size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Tem recado" />}
                    {!!v.notas && (
                      <span className="flex shrink-0 items-center gap-0.5 text-xs font-normal text-muted-foreground">
                        <MessageSquareText className="size-3" aria-label="Observações" /> {v.notas}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 pl-4 text-xs text-muted-foreground">
                    <span className="truncate">{teamLabel(v.team)}</span>
                    {v.faltas > 0 && (
                      <Badge variant="destructive" className="shrink-0">
                        {v.faltas} falta{v.faltas > 1 ? "s" : ""}
                      </Badge>
                    )}
                  </span>
                </button>
                {/* o rótulo em volta aumenta a área de toque da chave */}
                <label className="-mr-2.5 flex cursor-pointer items-center p-2.5">
                  <Switch
                    checked={v.active}
                    disabled={!editable}
                    onCheckedChange={(c) => quickSave(v, { active: c })}
                    aria-label={`${v.name}: ativo`}
                  />
                </label>
              </li>
            ))}
            {!rows.length && <li className="py-12 text-center text-muted-foreground">Nenhum voluntário com esses filtros.</li>}
          </ul>
          <table className="w-full border-collapse text-sm max-md:hidden">
            <thead className="sticky top-0 z-10 bg-muted/80 text-left text-xs text-muted-foreground backdrop-blur">
              {/* o grupo deixa claro o que as caixinhas querem dizer */}
              <tr className="h-7">
                <th colSpan={2} />
                <th colSpan={3} className="border-x border-b px-1 text-center font-semibold text-foreground">
                  No histórico
                </th>
                <th />
                <th colSpan={PERMS.length} className="border-x border-b px-1 text-center font-semibold text-foreground">
                  Pode servir em
                </th>
                <th colSpan={2} />
              </tr>
              <tr className="h-9 [&>th]:font-medium">
                {th("name", "Nome", "pl-4")}
                {th("team", "Equipe")}
                {th("faltas", "Faltas", "text-center")}
                {th("vezes", "Serviu (vezes)", "text-center whitespace-nowrap")}
                {th("ultima_vez", "Última vez", "whitespace-nowrap")}
                <th className="px-2">Recado e observações</th>
                {PERMS.map(([k, l]) => (
                  <th key={k} className="w-[64px] px-1 text-center">
                    {l}
                  </th>
                ))}
                <th className="w-[60px] px-1 text-center">Ativo</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} className={cn("h-11 border-t transition-colors hover:bg-muted/40", !v.active && "text-muted-foreground")}>
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
                  <td className="max-w-[240px] min-w-[140px] px-2 py-1">
                    {v.observation || v.notas ? (
                      <button
                        className="w-full text-left text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setEdit(v)}
                      >
                        {v.observation && (
                          <span className="line-clamp-2">
                            <StickyNote className="mr-1 inline size-3 align-[-1px] text-amber-600 dark:text-amber-400" />
                            {v.observation}
                          </span>
                        )}
                        {!!v.notas && (
                          <span className="line-clamp-1" title={v.ultima_nota ?? undefined}>
                            <MessageSquareText className="mr-1 inline size-3 align-[-1px]" />
                            {v.notas} obs. · {v.ultima_nota}
                          </span>
                        )}
                      </button>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  {PERMS.map(([k]) => (
                    <td key={k} className="px-1 text-center">
                      <Checkbox
                        checked={v[k]}
                        disabled={!editable}
                        onCheckedChange={(c) => quickSave(v, { [k]: !!c })}
                        aria-label={`${v.name} pode servir em ${PERMS.find(([p]) => p === k)?.[1]}`}
                      />
                    </td>
                  ))}
                  <td className="px-1 text-center">
                    <Switch
                      checked={v.active}
                      disabled={!editable}
                      onCheckedChange={(c) => quickSave(v, { active: c })}
                      aria-label={`${v.name}: ativo`}
                    />
                  </td>
                  <td className="pr-2 text-right">
                    <Button variant="outline" size="xs" onClick={() => setEdit(v)}>
                      {editable ? (
                        <>
                          <Pencil /> Editar
                        </>
                      ) : (
                        <>
                          <Eye /> Ver
                        </>
                      )}
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
        me={me}
        editable={editable}
        onNotes={noteCount}
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
  me,
  editable,
  onNotes,
  onClose,
  onSaved,
}: {
  value: Partial<Volunteer> | null;
  me: Me;
  /** false: o admin travou o cadastro; os campos só aparecem, mas observações continuam liberadas */
  editable: boolean;
  onNotes: (id: number, notes: VolunteerNote[]) => void;
  onClose: () => void;
  onSaved: (saved: SavedVolunteer) => void;
}) {
  const teams = volunteerTeams(me);
  const [f, setF] = useState<Partial<Volunteer>>(EMPTY);
  useEffect(() => {
    if (value) setF(value);
  }, [value]);
  const set = (patch: Partial<Volunteer>) => setF((x) => ({ ...x, ...patch }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editable) return;
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
      <SheetContent
        title={!f.id ? "Novo voluntário" : editable ? "Editar voluntário" : (f.name ?? "Voluntário")}
        description={editable ? "Os dados valem para as próximas escalas." : "Cadastro travado pelo administrador: só observações."}
      >
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {/* cadastro travado: o fieldset desliga todos os campos de uma vez */}
            <fieldset disabled={!editable} className="min-w-0 space-y-4 disabled:opacity-80">
            <div className="space-y-1.5">
              <FieldLabel>Nome</FieldLabel>
              <Input autoFocus value={f.name ?? ""} onChange={(e) => set({ name: e.target.value })} required />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
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
              <FieldLabel>Recado para a escala</FieldLabel>
              <textarea
                value={f.observation ?? ""}
                onChange={(e) => set({ observation: e.target.value })}
                rows={3}
                maxLength={500}
                placeholder="Ex.: só pode até as 10h; prefere não ficar na cozinha; gestante…"
                className={TEXTAREA}
              />
              <p className="text-xs text-muted-foreground">
                Fica fixo e aparece na presença e na lista de troca da escala. Para registrar algo com data, use as
                observações abaixo.
              </p>
            </div>
            <Label className="h-10 justify-between rounded-lg border px-3 font-normal">
              Ativo (entra nas escalas)
              <Switch checked={!!f.active} onCheckedChange={(c) => set({ active: c })} />
            </Label>
            </fieldset>
            {f.id ? (
              <NotesPanel key={f.id} volunteerId={f.id} me={me} onChange={(notes) => onNotes(f.id!, notes)} />
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                Depois de salvar o cadastro, você pode registrar observações com data sobre a pessoa.
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t px-5 py-3">
            <Button type="button" variant="outline" onClick={onClose}>
              {editable ? "Cancelar" : "Fechar"}
            </Button>
            {editable && <Button type="submit">Salvar</Button>}
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

const TEXTAREA =
  "flex w-full min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60";

/** "AAAA-MM-DD HH:MM:SS" -> "dd/mm/aaaa às HH:MM" */
const when = (stamp: string) => `${br(stamp.slice(0, 10))} às ${stamp.slice(11, 16)}`;

/**
 * Observações datadas sobre a pessoa: quem escreveu e quando. Ficam guardadas (não somem ao
 * escrever outra) e cada uma pode ser apagada por quem escreveu ou por um administrador.
 * Valem mesmo com o cadastro travado: escrever não muda a escala.
 */
function NotesPanel({
  volunteerId,
  me,
  onChange,
}: {
  volunteerId: number;
  me: Me;
  onChange: (notes: VolunteerNote[]) => void;
}) {
  const [notes, setNotes] = useState<VolunteerNote[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .notes(volunteerId)
      .then((list) => alive && setNotes(list))
      .catch((e) => {
        if (!alive) return;
        setNotes([]);
        toast.error((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [volunteerId]);

  const update = (next: VolunteerNote[]) => {
    setNotes(next);
    onChange(next);
  };

  const add = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const note = await api.addNote(volunteerId, body);
      update([note, ...(notes ?? [])]);
      setText("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setConfirming(null);
    setBusy(true);
    try {
      await api.removeNote(volunteerId, id);
      update((notes ?? []).filter((n) => n.id !== id));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 border-t pt-4" aria-label="Observações">
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel>Observações</FieldLabel>
        {notes && notes.length > 0 && <span className="text-xs text-muted-foreground">{notes.length} registrada(s)</span>}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            add();
          }
        }}
        rows={2}
        maxLength={1000}
        placeholder="Ex.: avisou que viaja em janeiro; chegou atrasada no culto de domingo; conversamos sobre…"
        className={TEXTAREA}
        aria-label="Nova observação"
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Fica registrada com data e o seu nome.</p>
        <Button type="button" size="sm" variant="outline" disabled={!text.trim() || busy} onClick={add}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />} Registrar
        </Button>
      </div>

      {notes === null ? (
        <p className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Carregando observações…
        </p>
      ) : notes.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">Nenhuma observação registrada ainda.</p>
      ) : (
        <ol className="space-y-2">
          {notes.map((n) => {
            const canRemove = n.author === me.email || me.role === "admin";
            return (
              <li key={n.id} className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-sm whitespace-pre-wrap break-words">{n.body}</p>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate" title={n.author}>
                    {n.author === me.email ? "Você" : (n.author_name ?? n.author)} · {when(n.created_at)}
                  </span>
                  {canRemove &&
                    (confirming === n.id ? (
                      <span className="flex shrink-0 items-center gap-1">
                        Apagar?
                        <Button type="button" size="xs" variant="destructive" disabled={busy} onClick={() => remove(n.id)}>
                          Sim
                        </Button>
                        <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(null)}>
                          Não
                        </Button>
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label="Apagar observação"
                        onClick={() => setConfirming(n.id)}
                      >
                        <Trash2 /> Apagar
                      </Button>
                    ))}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
