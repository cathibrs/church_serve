/**
 * Tema claro ou escuro. Sem escolha guardada, segue o do aparelho. A classe .dark vai no
 * <html>; o index.html já aplica a escolha antes de a página aparecer, para não piscar branco.
 */
import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null; // sem armazenamento local
  }
}

function system(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Tema em uso e a troca entre claro e escuro (a troca fica guardada neste navegador). */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());

  useEffect(() => apply(theme), [theme]);

  // sem escolha guardada, acompanha o aparelho quando ele muda (ex.: modo noturno automático)
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const follow = () => stored() || setTheme(system());
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  const toggle = () =>
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* sem armazenamento local */
      }
      return next;
    });

  return [theme, toggle];
}
