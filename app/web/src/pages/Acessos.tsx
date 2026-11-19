import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Copy, KeyRound, Loader2, Pencil, Trash2, UserPlus, Users, X } from "lucide-react";
import { api, type AccessChange, type AccessUser, type Me, type Role } from "@/lib/api";
import { teamLabel } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Confirm } from "@/components/ui/alert-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ROLE_LABEL: Record<Role, string> = { admin: "Administrador", coordinator: "Coordenador" };

interface Draft {
  email: string;
  name: string;
  role: Role;
  teams: string[];
  /** true = alterando um acesso que já existe (o e-mail não muda) */
  editing: boolean;
}

/** Senha recém-criada para um e-mail. */
interface NewPassword {
  email: string;
  value: string;
}

/** Admins primeiro, depois por e-mail: a mesma ordem em que a API lista. */
const sorted = (users: AccessUser[]) =>
  [...users].sort(
    (a, b) => Number(b.role === "admin") - Number(a.role === "admin") || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0),
  );

const EMPTY: Draft = { email: "", name: "", role: "coordinator", teams: [], editing: false };

function AccountStatus({ user }: { user: AccessUser }) {
  if (!user.has_account) return <Badge variant="outline">Ainda não criou a conta</Badge>;
  if (!user.verified) return <Badge variant="warning">E-mail não confirmado</Badge>;
  return <Badge variant="success">Conta ativa</Badge>;
}

/** Escolha de uma ou mais equipes (as do coordenador). */
function TeamPicker({ all, value, onChange }: { all: string[]; value: string[]; onChange: (teams: string[]) => void }) {
  const label =
    value.length === 0 ? "Escolher equipes" : value.length === 1 ? teamLabel(value[0]) : `${value.length} equipes`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-between font-normal sm:w-[220px]" aria-label="Equipes">
          <span className="flex min-w-0 items-center gap-2">
            <Users className="size-4 shrink-0 text-muted-foreground" />
            <span className={value.length ? "truncate" : "truncate text-muted-foreground"}>{label}</span>
          </span>
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px]">
        {all.map((team) => (
          <DropdownMenuCheckboxItem
            key={team}
            checked={value.includes(team)}
            onSelect={(e) => e.preventDefault()} // mantém aberto para marcar várias
            onCheckedChange={(on) => onChange(on ? [...value, team].sort() : value.filter((t) => t !== team))}
          >
            {teamLabel(team)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Tela do administrador: quem pode entrar no sistema, com qual papel e em quais equipes. */
export function AcessosPage({ me, users }: { me: Me; users: AccessUser[] }) {
  const [list, setList] = useState<AccessUser[]>(users); // chega pronta: a tela nasce preenchida
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<AccessUser | null>(null);
  const [resetting, setResetting] = useState<AccessUser | null>(null);
  /** senha recém-criada, mostrada uma única vez */
  const [shown, setShown] = useState<NewPassword | null>(null);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Aplica na lista da tela o acesso que a API devolveu, sem pedir a lista inteira de novo. */
  const apply = (change: AccessChange, done: string) => {
    setList((l) => sorted([...l.filter((u) => u.email !== change.user.email), change.user]));
    if (change.password) setShown({ email: change.user.email, value: change.password });
    else toast.success(done);
  };

  const needsTeam = draft.role === "coordinator" && draft.teams.length === 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (needsTeam) {
      toast.error("Escolha pelo menos uma equipe para o coordenador.");
      return;
    }
    const address = draft.email.trim().toLowerCase();
    const done = draft.editing ? `Acesso de ${address} atualizado.` : `${address} liberado.`;
    const access = { role: draft.role, teams: draft.teams, name: draft.name.trim() || undefined };
    if (await run(async () => apply(await api.saveUser(address, access), done))) setDraft(EMPTY);
  };

  const admins = list.filter((u) => u.role === "admin").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background/85 px-3 py-2.5 backdrop-blur md:px-5">
        <div className="mr-auto">
          <h1 className="text-[15px] leading-tight font-semibold">Acessos</h1>
          <p className="text-xs text-muted-foreground">
            {`${list.length} e-mail(s) liberado(s) · ${admins} administrador(es)`}
          </p>
        </div>
      </header>

      {/* no celular cada campo ocupa a largura toda */}
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5 md:px-5">
        <Input
          type="email"
          required
          disabled={draft.editing}
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
          placeholder="E-mail a liberar"
          aria-label="E-mail a liberar"
          className="sm:w-64"
        />
        {!draft.editing && (
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Nome (opcional)"
            aria-label="Nome"
            maxLength={80}
            className="sm:w-48"
          />
        )}
        <Select value={draft.role} onValueChange={(v) => setDraft({ ...draft, role: v as Role })}>
          <SelectTrigger className="sm:w-[170px]" aria-label="Papel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="coordinator">{ROLE_LABEL.coordinator}</SelectItem>
            <SelectItem value="admin">{ROLE_LABEL.admin}</SelectItem>
          </SelectContent>
        </Select>
        {draft.role === "coordinator" && (
          <TeamPicker all={me.teams} value={draft.teams} onChange={(teams) => setDraft({ ...draft, teams })} />
        )}
        <Button type="submit" disabled={busy} className="max-sm:flex-1">
          {busy ? <Loader2 className="animate-spin" /> : draft.editing ? <Pencil /> : <UserPlus />}
          {draft.editing ? "Salvar alteração" : "Liberar acesso"}
        </Button>
        {draft.editing && (
          <Button type="button" variant="ghost" onClick={() => setDraft(EMPTY)}>
            <X /> Cancelar
          </Button>
        )}
        <p className="basis-full text-xs text-muted-foreground">
          {draft.editing
            ? `Alterando o acesso de ${draft.email}.`
            : "O sistema cria a conta com uma senha aleatória e mostra a senha para você repassar. A pessoa pode trocá-la depois, se quiser."}{" "}
          Coordenador vê e altera só as equipes escolhidas; administrador vê todas e gerencia esta lista.
        </p>
      </form>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 md:px-5">
        <Card className="overflow-x-auto">
          {/* no celular a tabela mantém uma largura legível e rola para o lado dentro do cartão */}
          <table className="w-full border-collapse text-[13px] max-md:min-w-[820px]">
            <thead className="bg-muted/80 text-left text-xs text-muted-foreground">
              <tr className="h-9 [&>th]:font-medium">
                <th className="pl-4">E-mail</th>
                <th className="px-2">Nome</th>
                <th className="px-2">Situação da conta</th>
                <th className="px-2">Papel</th>
                <th className="px-2">Equipes</th>
                <th className="px-2">Liberado em</th>
                <th className="w-32" />
              </tr>
            </thead>
            <tbody>
              {list.map((u) => {
                const self = u.email === me.email;
                const lastAdmin = u.role === "admin" && admins <= 1;
                const locked = self || lastAdmin;
                const why = self
                  ? "Você não pode mudar nem remover o seu próprio acesso."
                  : "O sistema precisa de pelo menos um administrador.";
                return (
                  <tr key={u.email} className="h-11 border-t transition-colors hover:bg-muted/40">
                    <td className="max-w-[300px] truncate pl-4 font-medium" title={u.email}>
                      {u.email}
                      {self && <span className="ml-2 text-xs font-normal text-muted-foreground">(você)</span>}
                    </td>
                    <td className="px-2 whitespace-nowrap">{u.name ?? "—"}</td>
                    <td className="px-2">
                      <AccountStatus user={u} />
                    </td>
                    <td className="px-2 whitespace-nowrap">{ROLE_LABEL[u.role]}</td>
                    <td className="px-2">
                      {u.role === "admin" ? (
                        <span className="text-muted-foreground">Todas</span>
                      ) : (
                        <span className="flex flex-wrap gap-1 py-1">
                          {u.teams.map((t) => (
                            <Badge key={t} variant="secondary">
                              {teamLabel(t)}
                            </Badge>
                          ))}
                          {u.teams.length === 0 && <Badge variant="destructive">Sem equipe</Badge>}
                        </span>
                      )}
                    </td>
                    <td
                      className="px-2 text-xs whitespace-nowrap text-muted-foreground"
                      title={u.created_by ? `Liberado por ${u.created_by}` : undefined}
                    >
                      {u.created_at.slice(0, 10).split("-").reverse().join("/")}
                    </td>
                    <td className="pr-3 text-right whitespace-nowrap">
                      {locked ? (
                        <Tooltip tap content={why}>
                          <span className="text-xs text-muted-foreground">fixo</span>
                        </Tooltip>
                      ) : (
                        <>
                          <Tooltip content="Alterar papel e equipes">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Alterar acesso de ${u.email}`}
                              disabled={busy}
                              onClick={() =>
                                setDraft({ email: u.email, name: u.name ?? "", role: u.role, teams: u.teams, editing: true })
                              }
                            >
                              <Pencil />
                            </Button>
                          </Tooltip>
                          <Tooltip content="Gerar nova senha">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Gerar nova senha para ${u.email}`}
                              disabled={busy}
                              onClick={() => setResetting(u)}
                            >
                              <KeyRound />
                            </Button>
                          </Tooltip>
                          <Tooltip content="Remover acesso">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remover acesso de ${u.email}`}
                              disabled={busy}
                              onClick={() => setRemoving(u)}
                            >
                              <Trash2 />
                            </Button>
                          </Tooltip>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      <Confirm
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remover acesso?"
        description={
          <>
            <b>{removing?.email}</b> deixa de entrar no sistema na hora. A conta de login dela não é apagada, e você
            pode liberar de novo quando quiser.
          </>
        }
        confirmLabel="Remover"
        destructive
        onConfirm={() => {
          const target = removing!;
          setRemoving(null);
          if (draft.editing && draft.email === target.email) setDraft(EMPTY);
          run(async () => {
            await api.removeUser(target.email);
            setList((l) => l.filter((u) => u.email !== target.email));
            toast.success(`Acesso de ${target.email} removido.`);
          });
        }}
      />

      <Confirm
        open={!!resetting}
        onOpenChange={(open) => !open && setResetting(null)}
        title="Gerar nova senha?"
        description={
          <>
            A senha atual de <b>{resetting?.email}</b> deixa de funcionar e a pessoa é desconectada. A nova senha
            aparece em seguida, para você repassar.
          </>
        }
        confirmLabel="Gerar nova senha"
        onConfirm={() => {
          const target = resetting!;
          setResetting(null);
          run(async () => apply(await api.newPassword(target.email), `Nova senha gerada para ${target.email}.`));
        }}
      />

      <PasswordDialog password={shown} onClose={() => setShown(null)} />
    </div>
  );
}

/** Mostra a senha recém-criada. Ela não fica guardada: fechou, não aparece de novo. */
function PasswordDialog({ password, onClose }: { password: NewPassword | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [password]);

  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password.value);
      setCopied(true);
    } catch {
      toast.error("Não foi possível copiar. Selecione a senha e copie manualmente.");
    }
  };

  return (
    <Dialog
      open={!!password}
      onOpenChange={(open) => !open && onClose()}
      title="Senha de acesso"
      description={
        <>
          Repasse esta senha para <b>{password?.email}</b>. Ela aparece só agora: o sistema não guarda a senha.
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <code
          data-testid="senha-gerada"
          className="min-w-0 flex-1 basis-48 rounded-md border bg-muted px-3 py-2 text-center font-mono text-lg tracking-wider break-all select-all"
        >
          {password?.value}
        </code>
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />} {copied ? "Copiada" : "Copiar"}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        A pessoa entra com o e-mail e esta senha. Se quiser, troca depois em "Alterar senha", no menu. Se a senha se
        perder, use "Gerar nova senha" na linha dela.
      </p>
      <div className="mt-4 flex justify-end">
        <Button type="button" onClick={onClose}>
          Já anotei
        </Button>
      </div>
    </Dialog>
  );
}
