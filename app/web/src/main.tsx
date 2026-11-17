import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initAuth } from "./lib/auth";

const root = createRoot(document.getElementById("root")!);

/** Endereço do login que o servidor informa (variável NEON_AUTH_BASE_URL); não vai embutido no site. */
async function askLoginUrl(): Promise<string | null> {
  const r = await fetch("/api/config");
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()).auth_url ?? null;
}

// O endereço quase nunca muda, então o navegador o guarda entre as visitas.
const KEY = "login-url";
function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // sem armazenamento local
  }
}
function remember(url: string | null) {
  try {
    if (url) localStorage.setItem(KEY, url);
    else localStorage.removeItem(KEY);
  } catch {
    /* sem armazenamento local */
  }
}

function show(loginUrl: string | null, serverDown = false) {
  initAuth(loginUrl);
  root.render(
    <StrictMode>
      <App serverDown={serverDown} />
    </StrictMode>,
  );
}

async function start() {
  const known = remembered();
  if (known) {
    // Visita seguinte: abre na hora com o endereço guardado e confere com o servidor por trás.
    // Se ele mudou (ou deixou de existir), guarda o novo e recarrega.
    show(known);
    askLoginUrl()
      .then((url) => {
        if (url === known) return;
        remember(url);
        location.reload();
      })
      .catch(() => {}); // sem resposta: a própria tela avisa quando não consegue falar com a API
    return;
  }
  // Primeira visita: o endereço vem do servidor; sem resposta, o App mostra o aviso de falha.
  root.render(<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Carregando…</div>);
  try {
    const url = await askLoginUrl();
    remember(url);
    show(url);
  } catch {
    show(null, true);
  }
}

start();
