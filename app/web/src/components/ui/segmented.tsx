import { useId } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/** Controle segmentado com indicador animado (estilo Skiper UI). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("inline-flex h-9 items-center rounded-md border border-input bg-muted/60 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "relative h-full rounded-[5px] px-2.5 text-[13px] font-medium transition-colors",
            value === o.value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={id}
              className="absolute inset-0 rounded-[5px] bg-background shadow-xs ring-1 ring-black/5"
              transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
            />
          )}
          <span className="relative z-10 flex items-center gap-1">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
