/**
 * Login por pessoa (Neon Auth).
 *
 * O navegador manda `Authorization: Bearer <JWT>`. Aqui o token é conferido com as
 * chaves públicas do Neon Auth e o acesso só é liberado se o e-mail da conta estiver
 * verificado e constar em ALLOWED_EMAILS.
 *
 * A liberação é feita aqui, e não na tela, porque o endereço do Neon Auth aceita
 * cadastros de qualquer pessoa: criar uma conta não dá acesso aos dados.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Sql } from "./db.ts";

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
 *   forbidden        e-mail fora de ALLOWED_EMAILS
 * Não se usa 403: no `netlify dev`, uma resposta 403 ou 404 faz o emulador repetir o pedido
 * em caminhos alternativos (/api/x.html) e a mensagem original se perde.
 */
const denied = (code: "unauthenticated" | "unverified" | "forbidden", message: string) =>
  new HttpError(401, message, code);

export interface AuthUser {
  id: string;
  email: string;
}

type Verifier = (token: string) => Promise<JWTPayload>;

let verifier: Verifier | null = null;

function defaultVerifier(): Verifier {
  if (verifier) return verifier;
  const jwksUrl = process.env.NEON_AUTH_JWKS_URL;
  const baseUrl = process.env.NEON_AUTH_BASE_URL;
  if (!jwksUrl || !baseUrl) {
    throw new HttpError(500, "Login não configurado: faltam NEON_AUTH_JWKS_URL e NEON_AUTH_BASE_URL.");
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  const issuer = new URL(baseUrl).origin;
  verifier = async (token) => (await jwtVerify(token, jwks, { issuer })).payload;
  return verifier;
}

/** E-mails com acesso (ALLOWED_EMAILS, separados por vírgula, espaço ou quebra de linha). */
export function allowedEmails(raw: string | undefined = process.env.ALLOWED_EMAILS): Set<string> {
  return new Set((raw ?? "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
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
  allowed?: Set<string>;
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
  const allowed = opts.allowed ?? allowedEmails();
  if (!allowed.has(email)) {
    throw denied("forbidden", `O e-mail ${email} não tem acesso à escala. Peça a liberação à liderança.`);
  }
  return { id: payload.sub, email };
}
