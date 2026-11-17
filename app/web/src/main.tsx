import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initAuth } from "./lib/auth";

const root = createRoot(document.getElementById("root")!);

async function start() {
  root.render(<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Carregando…</div>);
  // O endereço do login vem do servidor; sem resposta, o App mostra o aviso de falha.
  let serverDown = false;
  let authUrl: string | null = null;
  try {
    const r = await fetch("/api/config");
    if (!r.ok) throw new Error(String(r.status));
    authUrl = (await r.json()).auth_url ?? null;
  } catch {
    serverDown = true;
  }
  initAuth(authUrl);
  root.render(
    <StrictMode>
      <App serverDown={serverDown} />
    </StrictMode>,
  );
}

start();
