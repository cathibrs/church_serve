import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  CalendarRange,
  History,
  KeyRound,
  Lock,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Users,
  X,
} from "lucide-react";
import { href, prefetch, type Page, type Route } from "@/lib/screens";
import { cn } from "@/lib/utils";
import { Tooltip } from "./ui/tooltip";

const NAV: { id: Page; label: string; icon: React.ElementType; hint: string; adminOnly?: boolean }[] = [
  { id: "escala", label: "Escala", icon: CalendarRange, hint: "Mapa e ficha do culto" },
  { id: "voluntarios", label: "Voluntários", icon: Users, hint: "Cadastro e permissões" },
  { id: "historico", label: "Histórico e faltas", icon: History, hint: "Rotatividade e ausências" },
  { id: "acessos", label: "Acessos", icon: KeyRound, hint: "Quem pode entrar e regras", adminOnly: true },
  { id: "atividade", label: "Atividade", icon: ScrollText, hint: "Quem fez o quê", adminOnly: true },
];

const OPEN_W = 236;
const CLOSED_W = 68;
/** A partir desta largura o menu é a barra lateral; abaixo, a gaveta (o `lg` do Tailwind). */
const WIDE = "(min-width: 1024px)";

interface MenuProps {
  page: Page;
  onOpen: (route: Route) => void;
  onSignOut: () => void;
  onChangePassword: () => void;
  userEmail: string;
  isAdmin: boolean;
}

/** Barra lateral das telas largas (computador e tablet deitado). */
export function AppSidebar({
  collapsed,
  onToggle,
  ...menu
}: MenuProps & {
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
      className="no-print relative hidden shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground lg:flex"
    >
      <SidebarBody {...menu} collapsed={collapsed} onToggle={onToggle} activeId="nav-active" />
    </motion.aside>
  );
}

/** Menu das telas estreitas (celular e tablet em pé): barra no topo e o mesmo menu numa gaveta. */
export function MobileNav(menu: MenuProps) {
  const [open, setOpen] = useState(false);

  // a tela alargou (ex.: o tablet deitou): a barra lateral assume e a gaveta sai
  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const close = () => wide.matches && setOpen(false);
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);

  /** Fecha a gaveta e segue com a ação do item. */
  const then =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      setOpen(false);
      action(...args);
    };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <header className="no-print flex h-12 shrink-0 items-center gap-2 bg-sidebar px-1.5 text-sidebar-foreground lg:hidden">
        <Dialog.Trigger
          aria-label="Abrir menu"
          className="flex size-10 items-center justify-center rounded-lg text-white/85 transition-colors hover:bg-sidebar-accent hover:text-white"
        >
          <Menu className="size-5" />
        </Dialog.Trigger>
        <img src="/logo-mark.png" alt="Lagoinha Jundiaí" className="size-7 mix-blend-screen select-none" draggable={false} />
        <span className="truncate text-xs font-semibold tracking-[0.22em] text-white/70 uppercase">Escala de voluntários</span>
      </header>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 lg:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-[264px] max-w-[85vw] flex-col overflow-y-auto bg-sidebar text-sidebar-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left data-[state=open]:duration-300 data-[state=closed]:duration-200 lg:hidden"
        >
          <Dialog.Title className="sr-only">Menu</Dialog.Title>
          <Dialog.Close
            aria-label="Fechar menu"
            className="absolute top-2 right-2 flex size-9 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-sidebar-accent hover:text-white"
          >
            <X className="size-[18px]" />
          </Dialog.Close>
          <SidebarBody
            {...menu}
            onOpen={then(menu.onOpen)}
            onChangePassword={then(menu.onChangePassword)}
            onSignOut={then(menu.onSignOut)}
            collapsed={false}
            activeId="nav-active-drawer"
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** O conteúdo do menu: logo, telas e ações da conta. Serve à barra lateral e à gaveta. */
function SidebarBody({
  page,
  onOpen,
  onSignOut,
  onChangePassword,
  userEmail,
  isAdmin,
  collapsed,
  onToggle,
  activeId,
}: MenuProps & {
  collapsed: boolean;
  /** recolher/expandir; sem ela (na gaveta) o item não aparece */
  onToggle?: () => void;
  /** nome da animação do item ativo: um por menu, para um não animar em direção ao outro */
  activeId: string;
}) {
  return (
    <>
      {/* logo */}
      <div className={cn("flex flex-col items-center", collapsed ? "px-2 pt-4 pb-3" : "px-4 pt-5 pb-4")}>
        <AnimatePresence mode="wait" initial={false}>
          {collapsed ? (
            <motion.img
              key="mark"
              src="/logo-mark.png"
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
              <img src="/logo.png" alt="Lagoinha Jundiaí" className="w-[136px] mix-blend-screen select-none" draggable={false} />
              <div className="mt-1 text-xs font-semibold tracking-[0.22em] whitespace-nowrap text-white/70 uppercase">
                Escala de voluntários
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="mx-3 h-px bg-sidebar-border" />

      {/* navegação */}
      <nav className={cn("flex flex-col gap-1", collapsed ? "p-2" : "p-3")}>
        {NAV.filter((n) => isAdmin || !n.adminOnly).map((n) => {
          const on = page === n.id;
          const Icon = n.icon;
          const route: Route = { page: n.id };
          // link de verdade (abre em nova aba, copia o endereço); o clique comum troca a tela sem recarregar
          const btn = (
            <a
              key={n.id}
              href={href(route)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onOpen(route);
              }}
              // o mouse (ou o foco) chega antes do clique: os dados já vêm vindo
              onPointerEnter={() => on || prefetch(route).catch(() => {})}
              onFocus={() => on || prefetch(route).catch(() => {})}
              aria-label={n.label}
              aria-current={on ? "page" : undefined}
              className={cn(
                "group relative flex items-center rounded-lg text-left transition-colors",
                collapsed ? "size-12 justify-center" : "gap-3 px-3 py-2.5",
                on ? "text-black" : "text-white/85 hover:bg-sidebar-accent hover:text-white",
              )}
            >
              {on && (
                <motion.span
                  layoutId={activeId}
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
            </a>
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
        {onToggle && (
          <SideAction
            collapsed={collapsed}
            icon={collapsed ? PanelLeftOpen : PanelLeftClose}
            label={collapsed ? "Expandir menu" : "Recolher menu"}
            hint="Ctrl+B"
            onClick={onToggle}
          />
        )}
        <SideAction collapsed={collapsed} icon={Lock} label="Alterar senha" onClick={onChangePassword} />
        <SideAction collapsed={collapsed} icon={LogOut} label="Sair" onClick={onSignOut} />
        {!collapsed && (
          <div className="mt-1 px-3 text-xs text-white/45">
            <div className="truncate" title={userEmail}>
              {userEmail}
            </div>
            Lagoinha Jundiaí · v3.0
          </div>
        )}
      </div>
    </>
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
        "flex items-center rounded-lg text-sm text-white/80 transition-colors hover:bg-sidebar-accent hover:text-white",
        collapsed ? "size-11 justify-center" : "w-full gap-3 px-3 py-2",
      )}
    >
      <Icon className="size-[18px] shrink-0" />
      {!collapsed && (
        <>
          <span className="whitespace-nowrap">{label}</span>
          {hint && <kbd className="ml-auto rounded border border-white/20 px-1.5 text-xs text-white/55">{hint}</kbd>}
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
