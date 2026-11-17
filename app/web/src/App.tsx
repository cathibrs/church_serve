import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, ApiError, type Me } from "@/lib/api";
import { forget, parse, prefetch, type Screen } from "@/lib/screens";
import { authClient, authConfigured, clearToken, signOut } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { AccessNotice, LoginPage } from "@/pages/Login";

// O sistema (menu e telas) fica em um pacote separado: só quem tem sessão o baixa.
const loadShell = () => import("./Shell");
const Shell = lazy(loadShell);

const Loading = () => (
  <div className="flex h-full items-center justify-center text-muted-foreground">
    <Loader2 className="mr-2 size-4 animate-spin" /> Carregando…
  </div>
);

/** Porta de entrada: sem sessão com e-mail confirmado, só existe a tela de login. */
export default function App({ serverDown = false }: { serverDown?: boolean }) {
  const session = authClient.useSession();
  const user = session.data?.user;
  /** Motivo mostrado no login quando a API recusa uma sessão que o navegador achava válida. */
  const [notice, setNotice] = useState("");

  if (serverDown)
    return (
      <AccessNotice
        title="Não foi possível falar com o servidor"
        action={<Button onClick={() => location.reload()}>Tentar de novo</Button>}
      >
        Verifique a conexão e recarregue a página.
      </AccessNotice>
    );
  if (!authConfigured)
    return (
      <AccessNotice title="Login não configurado">
        Falta a variável <code>NEON_AUTH_BASE_URL</code> no servidor. No Netlify, cadastre-a em Project
        configuration &gt; Environment variables e publique o site de novo.
      </AccessNotice>
    );
  if (session.isPending) return <Loading />;
  if (!user) return <LoginPage notice={notice} />;
  if (!user.emailVerified) return <LoginPage unverifiedEmail={user.email} onVerified={() => session.refetch()} />;
  return (
    <Gate
      key={user.id}
      onReady={() => setNotice("")}
      onRejected={(reason) => {
        setNotice(`O servidor não aceitou a sua sessão (${reason}). Entre de novo.`);
        signOut().catch(() => {});
      }}
    />
  );
}

/**
 * Valida na API antes de mostrar qualquer coisa: /api/me confere o token, o e-mail
 * confirmado e o acesso liberado.
 *
 * Para a primeira tela já aparecer completa, três coisas são pedidas ao mesmo tempo: a
 * validação, os dados da tela do endereço aberto e o pacote do sistema. Até tudo chegar só
 * aparece "Carregando"; os dados só são entregues pela API a quem ela valida.
 */
function Gate({ onReady, onRejected }: { onReady: () => void; onRejected: (reason: string) => void }) {
  const [ready, setReady] = useState<{ me: Me; first: Screen } | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(null);
    if (attempt === 0) forget(); // nada de dados adiantados por outra conta
    const route = parse();
    const wanted = prefetch(route);
    wanted.catch(() => {}); // o erro é tratado abaixo, depois da validação
    loadShell().catch(() => {}); // se falhar aqui, o Suspense tenta de novo e mostra o erro
    api
      .me()
      .then(async (me) => {
        // endereço que a pessoa não pode abrir (ou que não existe mais) cai na escala
        const first = await wanted.catch(() => prefetch({ page: "escala" }));
        if (!alive) return;
        setReady({ me, first: first.page === "acessos" && me.role !== "admin" ? await prefetch({ page: "escala" }) : first });
        onReady();
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.denied) setDenied(e.message);
        else if (e instanceof ApiError && e.status === 401) onRejected(e.message.replace(/\.$/, ""));
        else setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // onReady e onRejected mudam a cada desenho do App; a validação roda uma vez por tentativa.
  }, [attempt]);

  const leave = () => {
    signOut().catch(() => location.reload());
  };

  if (denied)
    return (
      <AccessNotice
        title="Sem acesso"
        action={
          <Button variant="outline" onClick={leave}>
            Sair e usar outra conta
          </Button>
        }
      >
        {denied}
      </AccessNotice>
    );
  if (failed)
    return (
      <AccessNotice
        title="Não foi possível abrir a escala"
        action={
          <Button
            onClick={() => {
              clearToken();
              setAttempt((n) => n + 1);
            }}
          >
            Tentar de novo
          </Button>
        }
      >
        {failed}
      </AccessNotice>
    );
  if (!ready) return <Loading />;
  return (
    <Suspense fallback={<Loading />}>
      <Shell me={ready.me} first={ready.first} onSignOut={leave} />
    </Suspense>
  );
}
