import * as React from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("flex items-center gap-2 text-sm leading-none font-medium select-none", className)} {...props} />;
}

export function FieldLabel({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("text-xs font-medium text-muted-foreground", className)} {...props} />;
}
