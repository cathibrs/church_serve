// A configuração do Neon fica em app/web/neon.ts (Postgres + Auth). Este arquivo só a repassa,
// para que os comandos "neon ..." funcionem também a partir da raiz do projeto.
export { default } from "./app/web/neon.ts";
