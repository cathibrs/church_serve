/**
 * O sistema em si (menu e telas). Este arquivo vira um pacote separado, que o navegador
 * só pede depois que a API validou a sessão e o acesso (ver App.tsx).
 */
import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Toaster } from "sonner";
import type { Me } from "@/lib/api";
import { AppSidebar, type Page } from "@/components/AppSidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EscalaPage } from "@/pages/Escala";
import { VoluntariosPage } from "@/pages/Voluntarios";
import { HistoricoPage } from "@/pages/Historico";
import { AcessosPage } from "@/pages/Acessos";
import { ChangePassword } from "@/components/ChangePassword";

export default function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const isAdmin = me.role === "admin";
  const [page, setPage] = useState<Page>(() => {
    const h = location.hash.slice(1);
    if (h === "voluntarios" || h === "historico") return h;
    return h === "acessos" && isAdmin ? h : "escala";
  });
  const [goto, setGoto] = useState<{ date: string; team: string } | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
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

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-full">
        <AppSidebar
          page={page}
          onPage={setPage}
          onSignOut={onSignOut}
          onChangePassword={() => setChangingPassword(true)}
          userEmail={me.email}
          isAdmin={isAdmin}
          collapsed={collapsed}
          onToggle={toggleSidebar}
        />
        <main className="min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
              className="h-full"
            >
              {page === "escala" && <EscalaPage me={me} goto={goto} onGotoDone={() => setGoto(null)} />}
              {page === "voluntarios" && <VoluntariosPage me={me} />}
              {page === "historico" && (
                <HistoricoPage
                  me={me}
                  onOpen={(date, team) => {
                    setGoto({ date, team });
                    setPage("escala");
                  }}
                />
              )}
              {page === "acessos" && isAdmin && <AcessosPage me={me} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <ChangePassword open={changingPassword} onOpenChange={setChangingPassword} />
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: "text-[13px]" }} />
    </TooltipProvider>
  );
}
