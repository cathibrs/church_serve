import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { api, type AccessList, type AccessUser, type Role } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Confirm } from "@/components/ui/alert-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ROLE_LABEL: Record<Role, string> = { admin: "Administrador", member: "Membro" };

function RoleSelect({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)} disabled={disabled}>
      <SelectTrigger className="w-[160px]" aria-label="Papel">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">{ROLE_LABEL.member}</SelectItem>
        <SelectItem value="admin">{ROLE_LABEL.admin}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function AccountStatus({ user }: { user: AccessUser }) {
  if (!user.has_account) return <Badge variant="outline">Ainda não criou a conta</Badge>;
  if (!user.verified) return <Badge variant="warning">E-mail não confirmado</Badge>;
  return <Badge variant="success">Conta ativa</Badge>;
}

/** Tela do administrador: quem pode entrar no sistema e com qual papel. */
export function AcessosPage() {
  const [list, setList] = useState<AccessList | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<AccessUser | null>(null);

  useEffect(() => {
    api.users().then(setList).catch((e) => toast.error(e.message));
  }, []);

  async function run(action: () => Promise<AccessList>, done: string) {
    setBusy(true);
    try {
      setList(await action());
      toast.success(done);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    run(() => api.saveUser(address, role), `${address} liberado.`).then(() => setEmail(""));
  };

  const admins = list?.users.filter((u) => u.role === "admin").length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background/85 px-5 py-2.5 backdrop-blur">
        <div className="mr-auto">
          <h1 className="text-[15px] leading-tight font-semibold">Acessos</h1>
          <p className="text-xs text-muted-foreground">
            {list ? `${list.users.length} e-mail(s) liberado(s) · ${admins} administrador(es)` : "Carregando…"}
          </p>
        </div>
      </header>

      <form onSubmit={add} className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="E-mail a liberar"
          aria-label="E-mail a liberar"
          className="w-72"
        />
        <RoleSelect value={role} onChange={setRole} />
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <UserPlus />} Liberar acesso
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          A pessoa cria a própria conta no site com esse e-mail e confirma pelo código recebido. Membros usam a
          escala; administradores também gerenciam esta lista.
        </p>
      </form>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead className="bg-muted/80 text-left text-xs text-muted-foreground">
              <tr className="h-9 [&>th]:font-medium">
                <th className="pl-4">E-mail</th>
                <th className="px-2">Nome</th>
                <th className="px-2">Situação da conta</th>
                <th className="px-2">Papel</th>
                <th className="px-2">Liberado por</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {list?.users.map((u) => {
                const self = u.email === list.me;
                const lastAdmin = u.role === "admin" && admins <= 1;
                const locked = self || lastAdmin;
                const why = self
                  ? "Você não pode mudar nem remover o seu próprio acesso."
                  : "O sistema precisa de pelo menos um administrador.";
                return (
                  <tr key={u.email} className="h-11 border-t transition-colors hover:bg-muted/40">
                    <td className="max-w-[320px] truncate pl-4 font-medium" title={u.email}>
                      {u.email}
                      {self && <span className="ml-2 text-xs font-normal text-muted-foreground">(você)</span>}
                    </td>
                    <td className="px-2 whitespace-nowrap">{u.name ?? "—"}</td>
                    <td className="px-2">
                      <AccountStatus user={u} />
                    </td>
                    <td className="px-2">
                      {locked ? (
                        <Tooltip content={why}>
                          <span className="inline-flex items-center gap-1.5">
                            <ShieldCheck className="size-4 text-muted-foreground" /> {ROLE_LABEL[u.role]}
                          </span>
                        </Tooltip>
                      ) : (
                        <RoleSelect
                          value={u.role}
                          disabled={busy}
                          onChange={(next) =>
                            run(() => api.saveUser(u.email, next), `${u.email} agora é ${ROLE_LABEL[next].toLowerCase()}.`)
                          }
                        />
                      )}
                    </td>
                    <td className="max-w-[220px] truncate px-2 text-xs text-muted-foreground" title={u.created_by ?? undefined}>
                      {u.created_at.slice(0, 10).split("-").reverse().join("/")} · {u.created_by ?? "—"}
                    </td>
                    <td className="pr-3 text-right">
                      {!locked && (
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
          run(() => api.removeUser(target.email), `Acesso de ${target.email} removido.`);
        }}
      />
    </div>
  );
}
