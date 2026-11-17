/** Login por pessoa (Neon Auth). A API confere o token e a lista de acessos liberados. */
import { createAuthClient } from "@neon/auth";
import { BetterAuthReactAdapter } from "@neon/auth/react/adapters";

export interface AuthResult<T> {
  data: T | null;
  error: { code?: string; message?: string; status?: number } | null;
}

/**
 * Métodos do plugin de código por e-mail, que o @neon/auth já traz ligado.
 * São declarados aqui porque os tipos do pacote os perdem: ele instala duas versões de
 * @better-fetch/fetch (1.3.2 e 1.3.3) e o TypeScript deixa de reconhecer os plugins.
 * Endpoints: /email-otp/send-verification-otp, /email-otp/verify-email,
 * /email-otp/request-password-reset e /email-otp/reset-password.
 */
interface PluginMethods {
  emailOtp: {
    sendVerificationOtp(body: {
      email: string;
      type: "email-verification" | "sign-in" | "forget-password";
    }): Promise<AuthResult<unknown>>;
    verifyEmail(body: { email: string; otp: string }): Promise<AuthResult<unknown>>;
    requestPasswordReset(body: { email: string }): Promise<AuthResult<unknown>>;
    resetPassword(body: { email: string; otp: string; password: string }): Promise<AuthResult<unknown>>;
  };
}

const makeClient = (url: string) => createAuthClient(url, { adapter: BetterAuthReactAdapter() });

type AuthClient = ReturnType<typeof makeClient> & PluginMethods;

/** Cliente do login. Só existe depois de initAuth(), chamado em main.tsx antes de desenhar a tela. */
export let authClient: AuthClient;

/** Falso quando o servidor não tem a variável NEON_AUTH_BASE_URL. */
export let authConfigured = false;

/**
 * Cria o cliente com o endereço que a API informa em /api/config (variável NEON_AUTH_BASE_URL
 * do servidor). O endereço não é embutido no site durante o build.
 */
export function initAuth(url: string | null) {
  authConfigured = Boolean(url);
  authUrl = (url || `${location.origin}/login-nao-configurado`).replace(/\/+$/, "");
  authClient = makeClient(authUrl) as AuthClient;
}

let authUrl = "";

// ---------------------------------------------------------------- token para a API

let cached: { token: string; expiresAt: number } | null = null;
let pending: Promise<string | null> | null = null;

function expiryOf(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

const isJwt = (value: unknown): value is string => typeof value === "string" && value.split(".").length === 3;

/**
 * Busca o JWT da sessão.
 *
 * O caminho certo nesta biblioteca é getSession(): ela troca `session.token` pelo JWT que o
 * servidor manda junto. NÃO usar authClient.token(): a biblioteca trata /token como "consultar
 * sessão" e, quando já tem a sessão em memória, devolve { session, user } sem o campo token
 * (era o que fazia o login voltar para a tela de entrada).
 *
 * `fresh` manda o cabeçalho X-Force-Fetch, que faz a biblioteca ignorar a sessão em memória.
 */
async function fetchJwt(fresh: boolean): Promise<string | null> {
  const { data } = await authClient.getSession(
    fresh ? { fetchOptions: { headers: { "X-Force-Fetch": "true" } } } : undefined,
  );
  if (!data?.session) return null;
  if (isJwt(data.session.token)) return data.session.token;
  // Reserva: pede o JWT direto ao servidor de login, sem passar pela biblioteca.
  const r = await fetch(`${authUrl}/token`, { credentials: "include" });
  const body = r.ok ? ((await r.json()) as { token?: unknown }) : null;
  return isJwt(body?.token) ? body.token : null;
}

/**
 * Token de acesso da sessão atual (vale 15 minutos; é renovado 1 minuto antes de vencer).
 * Devolve null se não houver sessão.
 */
export function getToken(force = false): Promise<string | null> {
  const valid = (t: typeof cached) => !!t && t.expiresAt - Date.now() > 60_000;
  if (!force && valid(cached)) return Promise.resolve(cached!.token);
  pending ??= (async () => {
    try {
      let token = await fetchJwt(force);
      // a sessão em memória pode trazer um JWT já vencido: nesse caso busca um novo
      if (!force && token && !valid({ token, expiresAt: expiryOf(token) })) token = await fetchJwt(true);
      cached = token ? { token, expiresAt: expiryOf(token) } : null;
      return token;
    } catch {
      cached = null;
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export function clearToken() {
  cached = null;
}

export async function signOut() {
  clearToken();
  await authClient.signOut();
}

// ---------------------------------------------------------------- código por e-mail

const lastSent = new Map<string, number>();

/** Envia o código de confirmação do e-mail (no máximo um a cada minuto, salvo `force`). */
export async function sendVerificationCode(email: string, force = false): Promise<void> {
  const key = email.trim().toLowerCase();
  if (!force && Date.now() - (lastSent.get(key) ?? 0) < 60_000) return;
  lastSent.set(key, Date.now());
  try {
    await authCall(() => authClient.emailOtp.sendVerificationOtp({ email: key, type: "email-verification" }));
  } catch (e) {
    lastSent.delete(key);
    throw e;
  }
}

// ---------------------------------------------------------------- mensagens

const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "E-mail ou senha incorretos.",
  INVALID_EMAIL: "E-mail inválido.",
  INVALID_PASSWORD: "Senha atual incorreta.",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "Esta conta não tem senha cadastrada.",
  USER_ALREADY_EXISTS: "Já existe uma conta com esse e-mail. Use Entrar.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Já existe uma conta com esse e-mail. Use Entrar.",
  USER_NOT_FOUND: "Não há conta com esse e-mail.",
  PASSWORD_TOO_SHORT: "A senha é curta demais (mínimo de 8 caracteres).",
  PASSWORD_TOO_LONG: "A senha é longa demais.",
  EMAIL_NOT_VERIFIED: "Confirme seu e-mail para entrar.",
  INVALID_OTP: "Código incorreto. Confira o e-mail mais recente.",
  OTP_EXPIRED: "O código venceu. Peça um novo.",
  TOO_MANY_ATTEMPTS: "Muitas tentativas. Peça um novo código.",
};

/** Falha de login já com a mensagem em português; `code` é o código original do Better Auth. */
export class AuthFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface RawAuthError {
  code?: string;
  message?: string;
  status?: number;
  /** resposta original do servidor (o cliente do Neon traduz o código de fora para outro padrão) */
  error?: { code?: string; message?: string; status?: number };
}

function failure(raw: RawAuthError | null | undefined): AuthFailure {
  const code = raw?.error?.code ?? raw?.code ?? "";
  const status = raw?.error?.status ?? raw?.status;
  const message =
    MESSAGES[code] ??
    (status === 429
      ? "Muitas tentativas em pouco tempo. Aguarde um minuto e tente de novo."
      : raw?.message || "Não foi possível concluir. Verifique a conexão e tente de novo.");
  return new AuthFailure(code, message);
}

/**
 * Executa uma chamada de login e devolve os dados. O cliente do Neon ora devolve
 * `{ error }`, ora lança o erro: aqui os dois casos viram um AuthFailure.
 */
export async function authCall<T>(call: () => Promise<AuthResult<T>>): Promise<T | null> {
  let result: AuthResult<T>;
  try {
    result = await call();
  } catch (e) {
    throw failure(e as RawAuthError);
  }
  if (result.error) throw failure(result.error);
  return result.data;
}
