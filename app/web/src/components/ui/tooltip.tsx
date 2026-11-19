import * as React from "react";
import * as T from "@radix-ui/react-tooltip";

export const TooltipProvider = T.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
  tap = false,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /**
   * Também abre e fecha com o toque. Para quando a dica é o único lugar onde a informação
   * aparece: em tela sem mouse, a dica comum nunca abriria.
   */
  tap?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const wasOpen = React.useRef(false);

  // tocar fora fecha (no próprio alvo, quem decide é o clique, abaixo)
  React.useEffect(() => {
    if (!tap || !open) return;
    const close = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [tap, open]);

  if (!content) return <>{children}</>;
  // em tela estreita não há espaço ao lado do alvo: a dica lateral sairia da tela
  const narrow = tap && (side === "right" || side === "left") && window.matchMedia("(max-width: 767px)").matches;
  return (
    <T.Root {...(tap ? { open, onOpenChange: setOpen } : {})}>
      <T.Trigger
        asChild
        {...(tap
          ? {
              ref: trigger,
              // o Radix fecha a dica ao pressionar; guardamos como estava para o clique alternar
              onPointerDown: () => {
                wasOpen.current = open;
              },
              onClick: (e: React.MouseEvent) => {
                e.preventDefault(); // sem isto o Radix fecharia de novo logo depois
                setOpen(!wasOpen.current);
              },
            }
          : {})}
      >
        {children}
      </T.Trigger>
      <T.Portal>
        <T.Content
          side={narrow ? "top" : side}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-xs rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground shadow-md data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
