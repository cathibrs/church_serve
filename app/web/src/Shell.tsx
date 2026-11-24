/**
 * O sistema em si (menu e telas). Cada tela tem o seu endereço (ver lib/screens.ts) e só
 * aparece com os dados já carregados: ao navegar, a tela atual continua no lugar, com uma
 * barra de progresso no topo, até a próxima estar completa.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast, Toaster } from "sonner";
import type { Me } from "@/lib/api";
import { ADMIN_PAGES, href, load, parse, type Route, type Screen } from "@/lib/screens";
import { AppSidebar, MobileNav } from "@/components/AppSidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EscalaPage } from "@/pages/Escala";
import { VoluntariosPage } from "@/pages/Voluntarios";
import { HistoricoPage } from "@/pages/Historico";
import { AcessosPage } from "@/pages/Acessos";
import { AtividadePage } from "@/pages/Atividade";
import { ChangePassword } from "@/components/ChangePassword";
import { useTheme } from "@/lib/theme";

/** Como o endereço do navegador acompanha a troca de tela. */
type Mode = "push" | "replace" | "pop";

export default function Shell({ me, first, onSignOut }: { me: Me; first: Screen; onSignOut: () => void }) {
  const isAdmin = me.role === "admin";
  /** Tela no ar e um número que muda a cada carga (as telas com edição recomeçam dos dados novos). */
  const [shown, setShown] = useState({ screen: first, stamp: 0 });
  const [loading, setLoading] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [theme, toggleTheme] = useTheme();
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

  const current = useRef(first.route);
  current.current = shown.screen.route;
  const latest = useRef(0); // só a navegação mais recente troca a tela

  /** Busca os dados da tela e só então a mostra. */
  const open = useCallback(
    async (wanted: Route, mode: Mode = "push") => {
      const route: Route = ADMIN_PAGES.includes(wanted.page) && !isAdmin ? { page: "escala" } : wanted;
      const turn = ++latest.current;
      setLoading(true);
      try {
        const screen = await load(route);
        if (turn !== latest.current) return;
        if (mode === "push" && href(route) !== location.pathname) history.pushState(null, "", href(route) + location.search);
        if (mode === "replace") history.replaceState(null, "", href(route) + location.search + location.hash);
        setShown((s) => ({ screen, stamp: s.stamp + 1 }));
      } catch (e) {
        if (turn !== latest.current) return;
        toast.error(e instanceof Error ? e.message : String(e));
        // voltar/avançar já mudou o endereço: devolve o da tela que continua no ar
        if (mode === "pop") history.replaceState(null, "", href(current.current) + location.search);
      } finally {
        if (turn === latest.current) setLoading(false);
      }
    },
    [isAdmin],
  );

  useEffect(() => {
    // o endereço passa a ser o da tela que abriu (ex.: "/" vira "/escala")
    if (href(first.route) !== location.pathname) {
      const keep = location.hash.startsWith("#pick=") ? location.hash : "";
      history.replaceState(null, "", href(first.route) + location.search + keep);
    }
    const back = () => open(parse(), "pop");
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
    // `first` é só a tela inicial
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reload = useCallback(() => open(current.current, "replace"), [open]);
  const { screen, stamp } = shown;
  const openPasswordChange = useCallback(() => setChangingPassword(true), []);
  const menu = {
    page: screen.page,
    onOpen: open,
    onSignOut,
    onChangePassword: openPasswordChange,
    theme,
    onToggleTheme: toggleTheme,
    userEmail: me.email,
    isAdmin,
  };

  return (
    <TooltipProvider delayDuration={250}>
      {/* Tela larga: barra lateral ao lado. Tela estreita: barra no topo, com o menu numa gaveta. */}
      <div className="flex h-full flex-col lg:flex-row">
        <MobileNav {...menu} />
        <AppSidebar {...menu} collapsed={collapsed} onToggle={toggleSidebar} />
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {loading && <div className="loading-bar no-print absolute inset-x-0 top-0 z-50 h-0.5 bg-primary" role="progressbar" />}
          {/* A tela nova entra na hora em que os dados chegam: sem animação de saída segurando a troca. */}
          <motion.div
            key={screen.page}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.12 }}
            className="h-full"
          >
              {screen.page === "escala" && (
                <EscalaPage key={stamp} me={me} route={screen.route} sheet={screen.data} onOpen={open} />
              )}
              {screen.page === "voluntarios" && (
                <VoluntariosPage key={stamp} me={me} volunteers={screen.data} onReload={reload} />
              )}
              {screen.page === "historico" && (
                <HistoricoPage me={me} team={screen.route.team} data={screen.data} onOpen={open} />
              )}
              {screen.page === "acessos" && <AcessosPage key={stamp} me={me} users={screen.data} />}
              {screen.page === "atividade" && <AtividadePage key={stamp} me={me} page={screen.data} />}
          </motion.div>
        </main>
      </div>
      <ChangePassword open={changingPassword} onOpenChange={setChangingPassword} />
      <Toaster theme={theme} position="bottom-right" richColors closeButton toastOptions={{ className: "text-sm" }} />
    </TooltipProvider>
  );
}
