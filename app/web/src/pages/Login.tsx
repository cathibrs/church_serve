import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  authCall,
  authClient,
  AuthFailure,
  clearToken,
  noteCodeSent,
  sendVerificationCode,
  signOut,
  type AuthResult,
} from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Step = "entrar" | "criar" | "codigo" | "esqueci" | "nova-senha";

const signIn = (email: string, password: string) =>
  authClient.signIn.email({ email, password }) as Promise<AuthResult<unknown>>;

const TITLES: Record<Step, [string, string]> = {
  entrar: ["Entrar", "Use o e-mail liberado pela liderança."],
  criar: ["Criar conta", "Só e-mails liberados pela liderança conseguem acessar a escala."],
  codigo: ["Confirme seu e-mail", "Digite o código de 6 números que enviamos."],
  esqueci: ["Recuperar senha", "Enviaremos um código para o seu e-mail."],
  "nova-senha": ["Nova senha", "Digite o código recebido e escolha a nova senha."],
};

/**
 * Telas de acesso. `unverifiedEmail`: há sessão aberta, mas o e-mail ainda não foi
 * confirmado (nesse caso a tela já abre pedindo o código).
 */
export function LoginPage({ unverifiedEmail, onVerified }: { unverifiedEmail?: string; onVerified?: () => void }) {
  const [step, setStep] = useState<Step>(unverifiedEmail ? "codigo" : "entrar");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(unverifiedEmail ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const go = (next: Step, message = "") => {
    setStep(next);
    setError("");
    setNote(message);
    setCode("");
  };

  // sessão aberta sem e-mail confirmado: manda o código ao abrir
  useEffect(() => {
    if (unverifiedEmail) sendVerificationCode(unverifiedEmail).catch((e) => setError(e.message));
  }, [unverifiedEmail]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const address = email.trim().toLowerCase();

  const submit: Record<Step, () => Promise<void>> = {
    entrar: async () => {
      try {
        await authCall(() => signIn(address, password)); // a sessão muda e o App troca de tela
      } catch (e) {
        if (!(e instanceof AuthFailure) || e.code !== "EMAIL_NOT_VERIFIED") throw e;
        await sendVerificationCode(address);
        go("codigo");
      }
    },
    criar: async () => {
      if (password.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");
      const data = await authCall<{ token?: string | null }>(
        () =>
          authClient.signUp.email({ email: address, password, name: name.trim() || address }) as Promise<
            AuthResult<{ token?: string | null }>
          >,
      );
      // sem sessão: o servidor exige a confirmação e já mandou o código
      if (data?.token) await sendVerificationCode(address);
      else noteCodeSent(address);
      go("codigo");
    },
    codigo: async () => {
      await authCall(() => authClient.emailOtp.verifyEmail({ email: address, otp: code.trim() }));
      clearToken();
      if (unverifiedEmail) {
        onVerified?.();
        return;
      }
      // conta recém-criada: entra direto com a senha que acabou de ser digitada
      if (password) {
        try {
          await authCall(() => signIn(address, password));
          return;
        } catch {
          /* cai no aviso abaixo */
        }
      }
      go("entrar", "E-mail confirmado. Agora é só entrar.");
    },
    esqueci: async () => {
      await authCall(() => authClient.emailOtp.requestPasswordReset({ email: address }));
      setPassword("");
      go("nova-senha");
    },
    "nova-senha": async () => {
      if (password.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");
      await authCall(() => authClient.emailOtp.resetPassword({ email: address, otp: code.trim(), password }));
      setPassword("");
      go("entrar", "Senha alterada. Entre com a nova senha.");
    },
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    run(submit[step]);
  };

  const [title, hint] = TITLES[step];
  const emailField = (
    <Field label="E-mail" id="email">
      <Input
        id="email"
        type="email"
        autoComplete="email"
        required
        autoFocus={step !== "codigo" && step !== "nova-senha"}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
    </Field>
  );
  const passwordField = (label: string, isNew: boolean) => (
    <Field label={label} id="password">
      <Input
        id="password"
        type="password"
        autoComplete={isNew ? "new-password" : "current-password"}
        required
        minLength={isNew ? 8 : undefined}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
    </Field>
  );
  const codeField = (
    <Field label="Código" id="code">
      <Input
        id="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{4,8}"
        maxLength={8}
        required
        autoFocus
        className="text-center text-lg tracking-[0.4em] tabular-nums"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
      />
    </Field>
  );

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-sidebar p-4">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex flex-col items-center">
          <img src="./logo.png" alt="Lagoinha Jundiaí" className="w-36 mix-blend-screen select-none" draggable={false} />
          <div className="mt-1 text-[11px] font-semibold tracking-[0.22em] text-white/70 uppercase">
            Escala de voluntários
          </div>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border bg-card p-6 text-card-foreground shadow-lg">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {step === "codigo" || step === "nova-senha" ? `${hint} Destino: ${address}.` : hint}
            </p>
          </div>

          {note && <p className="rounded-md bg-success-soft px-3 py-2 text-[13px] text-emerald-800">{note}</p>}

          {step === "criar" && (
            <Field label="Seu nome" id="name">
              <Input id="name" autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          {(step === "entrar" || step === "criar" || step === "esqueci") && emailField}
          {(step === "codigo" || step === "nova-senha") && codeField}
          {step === "entrar" && passwordField("Senha", false)}
          {step === "criar" && passwordField("Senha (mínimo de 8 caracteres)", true)}
          {step === "nova-senha" && passwordField("Nova senha (mínimo de 8 caracteres)", true)}

          {error && (
            <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-[13px] text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {step === "entrar" && "Entrar"}
            {step === "criar" && "Criar conta"}
            {step === "codigo" && "Confirmar e-mail"}
            {step === "esqueci" && "Enviar código"}
            {step === "nova-senha" && "Salvar nova senha"}
          </Button>

          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-[13px]">
            {step === "entrar" && (
              <>
                <LinkButton onClick={() => go("criar")}>Criar conta</LinkButton>
                <LinkButton onClick={() => go("esqueci")}>Esqueci a senha</LinkButton>
              </>
            )}
            {(step === "criar" || step === "esqueci") && (
              <LinkButton onClick={() => go("entrar")}>Já tenho conta</LinkButton>
            )}
            {step === "codigo" && (
              <>
                <LinkButton
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await sendVerificationCode(address, true);
                      setNote("Enviamos um novo código. Use sempre o e-mail mais recente.");
                    })
                  }
                >
                  Reenviar código
                </LinkButton>
                <LinkButton onClick={() => (unverifiedEmail ? signOut().catch(() => {}) : go("entrar"))}>Usar outro e-mail</LinkButton>
              </>
            )}
            {step === "nova-senha" && <LinkButton onClick={() => go("esqueci")}>Pedir outro código</LinkButton>}
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function LinkButton({ children, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="rounded text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50"
      {...props}
    >
      {children}
    </button>
  );
}

/** Tela cheia com a marca, para avisos de acesso (sem permissão, login não configurado). */
export function AccessNotice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-sidebar p-4">
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border bg-card p-6 text-card-foreground shadow-lg">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <div className="text-[13px] leading-relaxed text-muted-foreground">{children}</div>
        {action}
      </div>
    </div>
  );
}
