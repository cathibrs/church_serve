import * as React from "react";
import * as A from "@radix-ui/react-alert-dialog";
import { buttonVariants } from "./button";
import { cn } from "@/lib/utils";

export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Continuar",
  onConfirm,
  destructive,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  return (
    <A.Root open={open} onOpenChange={onOpenChange}>
      <A.Portal>
        <A.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <A.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <A.Title className="text-base font-semibold">{title}</A.Title>
          <A.Description className="mt-1.5 text-sm text-muted-foreground">{description}</A.Description>
          <div className="mt-5 flex justify-end gap-2">
            <A.Cancel className={buttonVariants({ variant: "outline", size: "sm" })}>Cancelar</A.Cancel>
            <A.Action className={cn(buttonVariants({ variant: destructive ? "destructive" : "default", size: "sm" }))} onClick={onConfirm}>
              {confirmLabel}
            </A.Action>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}
