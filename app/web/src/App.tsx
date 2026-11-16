import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Toaster, toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api, ApiError, type InitData } from "@/lib/api";
import { authClient, authConfigured, clearToken, signOut } from "@/lib/auth";
import { AppSidebar, type Page } from "@/components/AppSidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { EscalaPage } from "@/pages/Escala";
import { VoluntariosPage } from "@/pages/Voluntarios";
import { HistoricoPage } from "@/pages/Historico";
import { AccessNotice, LoginPage } from "@/pages/Login";

const toaster = <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: "text-[13px]" }} />;

const Loading = () => (
  <div className="flex h-full items-center justify-center text-muted-foreground">
    <Loader2 className="mr-2 size-4 animate-spin" /> Carregando…
  </div>
);

/** Porta de entrada: só mostra o sistema para quem está logado com e-mail confirmado. */
export default function App() {
  const session = authClient.useSession();
  const user = session.data?.user;

  if (!authConfigured)
    return (
      <AccessNotice title="Login não configurado">
        Falta a variável <code>VITE_NEON_AUTH_URL</code> na publicação do site. Veja o arquivo README em app/web.
      </AccessNotice>
    );
  if (session.isPending) return <Loading />;
  if (!user) return <LoginPage />;
  if (!user.emailVerified) return <LoginPage unverifiedEmail={user.email} onVerified={() => session.refetch()} />;
  return <Shell key={user.id} email={user.email} />;
}

function Shell({ email }: { email: string }) {
  const [init, setInit] = useState<InitData | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<Page>(() => {
    const h = location.hash.slice(1);
    return h === "voluntarios" || h === "historico" ? h : "escala";
  });
  const [goto, setGoto] = useState<{ date: string; team: string } | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      if (location.search.includes("menu=recolhido")) return true;
      return localStorage.getItem("sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(
    () =>
      setCollapsed((c) => {
        try {
          localStorage.setItem("sidebar-collapsed", c ? "0" : "1");
        } catch {
          /* sem armazenamento local */
        }
        return !c;
      }),
    [],
  );

  useEffect(() => {
    let alive = true;
    setFailed(null);
    api
      .init()
      .then((d) => alive && setInit(d))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.denied) setDenied(e.message);
        else if (e instanceof ApiError && e.status === 401) signOut().catch(() => {});
        else setFailed(e.message);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const leave = () => signOut().catch((e) => toast.error(e.message));

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

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-full">
        <AppSidebar
          page={page}
          onPage={setPage}
          onSignOut={leave}
          userEmail={email}
          collapsed={collapsed}
          onToggle={toggleSidebar}
        />
        <main className="min-w-0 flex-1 overflow-hidden">
          {!init ? (
            <Loading />
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={page}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16 }}
                className="h-full"
              >
                {page === "escala" && <EscalaPage init={init} goto={goto} onGotoDone={() => setGoto(null)} />}
                {page === "voluntarios" && <VoluntariosPage init={init} />}
                {page === "historico" && (
                  <HistoricoPage
                    init={init}
                    onOpen={(date, team) => {
                      setGoto({ date, team });
                      setPage("escala");
                    }}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
      </div>
      {toaster}
    </TooltipProvider>
  );
}
