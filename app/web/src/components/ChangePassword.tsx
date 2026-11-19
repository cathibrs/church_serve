import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { authCall, authClient, type AuthResult } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Troca opcional da senha por quem está logado (a senha inicial é a que o admin recebeu). */
export function ChangePassword({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = (value: boolean) => {
    if (!value) {
      setCurrent("");
      setNext("");
      setError("");
    }
    onOpenChange(value);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setError("A nova senha precisa ter pelo menos 8 caracteres.");
    if (next === current) return setError("A nova senha é igual à atual.");
    setBusy(true);
    setError("");
    try {
      await authCall(
        () =>
          authClient.changePassword({
            currentPassword: current,
            newPassword: next,
            revokeOtherSessions: true, // encerra a conta em outros aparelhos
          }) as Promise<AuthResult<unknown>>,
      );
      toast.success("Senha alterada.");
      close(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Alterar senha"
      description="Opcional: você pode continuar usando a senha que recebeu."
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="senha-atual">Senha atual</Label>
          <Input
            id="senha-atual"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="senha-nova">Nova senha (mínimo de 8 caracteres)</Label>
          <Input
            id="senha-nova"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Salvar nova senha
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
