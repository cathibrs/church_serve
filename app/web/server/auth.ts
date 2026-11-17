/**
 * Login por pessoa (Neon Auth).
 *
 * O navegador manda `Authorization: Bearer <JWT>`. Aqui o token é conferido com as
 * chaves públicas do Neon Auth e o acesso só é liberado se o e-mail da conta estiver
 * verificado e constar na tabela app_users, que diz se a pessoa é admin ou coordenador
 * e, para coordenador, de quais equipes.
 *
 * A liberação é feita aqui, e não na tela, porque o endereço do Neon Auth aceita
 * cadastros de qualquer pessoa: criar uma conta não dá acesso aos dados.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getAccess, type Role, type Sql } from "./db.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Toda recusa de acesso responde 401, com o motivo no campo `code`:
 *   unauthenticated  sem token ou token vencido (o navegador tenta renovar e pede login)
 *   unverified       conta com e-mail ainda não confirmado
 *   forbidden        e-mail sem acesso liberado (ou ação só de admin)
 * Não se usa 403: no `netlify dev`, uma resposta 403 ou 404 faz o emulador repetir o pedido
 * em caminhos alternativos (/api/x.html) e a mensagem original se perde. O 404 fica só para
 * o que não existe (rota, voluntário, e-mail), onde nada foi gravado e repetir não faz mal.
 */
export const denied = (code: "unauthenticated" | "unverified" | "forbidden", message: string) =>
  new HttpError(401, message, code);

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  /** equipes de um coordenador (vazio para admin, que vê todas) */
  teams: string[];
}

type Verifier = (token: string) => Promise<JWTPayload>;

let verifier: Verifier | null = null;

function defaultVerifier(): Verifier {
  if (verifier) return verifier;
  const baseUrl = process.env.NEON_AUTH_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new HttpError(500, "Login não configurado: falta a variável NEON_AUTH_BASE_URL.");
  // As chaves públicas ficam em um endereço fixo a partir do endereço do login.
  const jwksUrl = process.env.NEON_AUTH_JWKS_URL?.trim() || `${baseUrl}/.well-known/jwks.json`;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  const issuer = new URL(baseUrl).origin;
  verifier = async (token) => (await jwtVerify(token, jwks, { issuer })).payload;
  return verifier;
}

interface Account {
  email: string;
  verified: boolean;
}

const accounts = new Map<string, { at: number; account: Account | null }>();
const ACCOUNT_TTL_MS = 60_000;

/** Conta no banco do Neon Auth (schema neon_auth), quando o token não traz o e-mail. */
async function accountFromDb(sql: Sql, userId: string): Promise<Account | null> {
  const hit = accounts.get(userId);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.account;
  const rows = await sql`SELECT to_jsonb(u) AS u FROM neon_auth."user" u WHERE u.id::text = ${userId}`;
  const u = rows[0]?.u as Record<string, unknown> | undefined;
  const account = u?.email
    ? { email: String(u.email), verified: (u.emailVerified ?? u.email_verified) === true }
    : null;
  accounts.set(userId, { at: Date.now(), account });
  return account;
}

export interface AuthOptions {
  /** Só para testes: troca a conferência do token. */
  verify?: Verifier;
}

export async function authenticate(request: Request, sql: Sql, opts: AuthOptions = {}): Promise<AuthUser> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) throw denied("unauthenticated", "Faça login para continuar.");
  const verify = opts.verify ?? defaultVerifier();
  let payload: JWTPayload;
  try {
    payload = await verify(header.slice(7).trim());
  } catch {
    throw denied("unauthenticated", "Sessão expirada. Faça login de novo.");
  }
  if (!payload.sub) throw denied("unauthenticated", "Sessão inválida. Faça login de novo.");

  let account: Account | null =
    typeof payload.email === "string" && typeof payload.emailVerified === "boolean"
      ? { email: payload.email, verified: payload.emailVerified }
      : null;
  account ??= await accountFromDb(sql, payload.sub);
  if (!account) throw denied("unauthenticated", "Conta não encontrada. Faça login de novo.");

  const email = account.email.trim().toLowerCase();
  if (!account.verified) throw denied("unverified", "Confirme seu e-mail para entrar.");
  const access = await getAccess(sql, email);
  if (!access) {
    throw denied("forbidden", `O e-mail ${email} não tem acesso à escala. Peça a liberação a um administrador.`);
  }
  if (access.role !== "admin" && !access.teams.length) {
    throw denied("forbidden", `O e-mail ${email} ainda não tem equipe definida. Peça a um administrador.`);
  }
  return { id: payload.sub, email, ...access };
}
