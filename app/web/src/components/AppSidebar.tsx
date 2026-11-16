import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CalendarRange, History, LogOut, PanelLeftClose, PanelLeftOpen, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "./ui/tooltip";

export type Page = "escala" | "voluntarios" | "historico";

const NAV: { id: Page; label: string; icon: React.ElementType; hint: string }[] = [
  { id: "escala", label: "Escala", icon: CalendarRange, hint: "Mapa e ficha do culto" },
  { id: "voluntarios", label: "Voluntários", icon: Users, hint: "Cadastro e permissões" },
  { id: "historico", label: "Histórico e faltas", icon: History, hint: "Rotatividade e ausências" },
];

const OPEN_W = 236;
const CLOSED_W = 68;

export function AppSidebar({
  page,
  onPage,
  onSignOut,
  userEmail,
  collapsed,
  onToggle,
}: {
  page: Page;
  onPage: (p: Page) => void;
  onSignOut: () => void;
  userEmail: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  // Ctrl+B recolhe/expande (mesmo atalho do shadcn sidebar)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onToggle]);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? CLOSED_W : OPEN_W }}
      transition={{ type: "spring", bounce: 0, duration: 0.3 }}
      className="no-print relative flex shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground"
    >
      {/* logo */}
      <div className={cn("flex flex-col items-center", collapsed ? "px-2 pt-4 pb-3" : "px-4 pt-5 pb-4")}>
        <AnimatePresence mode="wait" initial={false}>
          {collapsed ? (
            <motion.img
              key="mark"
              src="./logo-mark.png"
              alt="Lagoinha Jundiaí"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="size-10 mix-blend-screen select-none"
              draggable={false}
            />
          ) : (
            <motion.div
              key="full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center"
            >
              <img src="./logo.png" alt="Lagoinha Jundiaí" className="w-[136px] mix-blend-screen select-none" draggable={false} />
              <div className="mt-1 text-[11px] font-semibold tracking-[0.22em] whitespace-nowrap text-white/70 uppercase">
                Escala de voluntários
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="mx-3 h-px bg-sidebar-border" />

      {/* navegação */}
      <nav className={cn("flex flex-col gap-1", collapsed ? "p-2" : "p-3")}>
        {NAV.map((n) => {
          const on = page === n.id;
          const Icon = n.icon;
          const btn = (
            <button
              key={n.id}
              onClick={() => onPage(n.id)}
              aria-label={n.label}
              className={cn(
                "group relative flex items-center rounded-lg text-left transition-colors",
                collapsed ? "size-12 justify-center" : "gap-3 px-3 py-2.5",
                on ? "text-black" : "text-white/85 hover:bg-sidebar-accent hover:text-white",
              )}
            >
              {on && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-lg bg-white"
                  transition={{ type: "spring", bounce: 0.18, duration: 0.45 }}
                />
              )}
              <Icon className="relative z-10 size-5 shrink-0" strokeWidth={on ? 2.25 : 1.85} />
              {!collapsed && (
                <span className="relative z-10 min-w-0">
                  <span className="block text-sm leading-tight font-semibold whitespace-nowrap">{n.label}</span>
                  <span className={cn("block truncate text-xs leading-tight", on ? "text-black/65" : "text-white/60")}>
                    {n.hint}
                  </span>
                </span>
              )}
            </button>
          );
          return collapsed ? (
            <Tooltip key={n.id} content={n.label} side="right">
              {btn}
            </Tooltip>
          ) : (
            btn
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* rodapé */}
      <div className={cn("flex flex-col gap-1", collapsed ? "items-center p-2" : "p-3")}>
        <SideAction
          collapsed={collapsed}
          icon={collapsed ? PanelLeftOpen : PanelLeftClose}
          label={collapsed ? "Expandir menu" : "Recolher menu"}
          hint="Ctrl+B"
          onClick={onToggle}
        />
        <SideAction collapsed={collapsed} icon={LogOut} label="Sair" onClick={onSignOut} />
        {!collapsed && (
          <div className="mt-1 px-3 text-[11px] text-white/45">
            <div className="truncate" title={userEmail}>
              {userEmail}
            </div>
            Lagoinha Jundiaí · v3.0
          </div>
        )}
      </div>
    </motion.aside>
  );
}

function SideAction({
  collapsed,
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  collapsed: boolean;
  icon: React.ElementType;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  const btn = (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex items-center rounded-lg text-[13px] text-white/80 transition-colors hover:bg-sidebar-accent hover:text-white",
        collapsed ? "size-11 justify-center" : "w-full gap-3 px-3 py-2",
      )}
    >
      <Icon className="size-[18px] shrink-0" />
      {!collapsed && (
        <>
          <span className="whitespace-nowrap">{label}</span>
          {hint && <kbd className="ml-auto rounded border border-white/20 px-1.5 text-[11px] text-white/55">{hint}</kbd>}
        </>
      )}
    </button>
  );
  return collapsed ? (
    <Tooltip content={hint ? `${label} (${hint})` : label === "Sair" ? "Sair da conta" : label} side="right">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}
