/**
 * Contas de login criadas pelo administrador.
 *
 * Quando o admin libera um e-mail, o sistema cria a conta no Neon Auth com uma senha
 * aleatória e a mostra uma única vez ao admin, que repassa à pessoa. A senha não é
 * guardada pelo sistema; quem quiser troca depois, em "Alterar senha".
 *
 * A conta é criada pelo mesmo endereço público de cadastro que o navegador usaria; em
 * seguida o e-mail é marcado como confirmado direto no banco (o admin responde por ele)
 * e a sessão aberta pelo cadastro é apagada.
 */
import { HttpError } from "./auth.ts";
import type { Sql } from "./db.ts";

export interface Accounts {
  /** Cria a conta já confirmada. Devolve false se já existia conta com esse e-mail. */
  create(sql: Sql, account: { email: string; name: string; password: string }, origin: string): Promise<boolean>;
  /** Apaga a conta de login e as sessões dela. O acesso (app_users) não é mexido. */
  remove(sql: Sql, email: string): Promise<void>;
}

// sem 0/o, 1/l/i: fáceis de confundir ao ditar ou copiar à mão
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Senha aleatória no formato xxxx-xxxx-xxxx (12 caracteres sorteados, cerca de 59 bits). */
export function generatePassword(): string {
  const pick = () => {
    // sorteio sem viés: descarta os valores acima do último múltiplo do tamanho do alfabeto
    const limit = 256 - (256 % ALPHABET.length);
    for (;;) {
      const [byte] = crypto.getRandomValues(new Uint8Array(1));
      if (byte < limit) return ALPHABET[byte % ALPHABET.length];
    }
  };
  const group = () => Array.from({ length: 4 }, pick).join("");
  return `${group()}-${group()}-${group()}`;
}

export const neonAccounts: Accounts = {
  async create(sql, { email, name, password }, origin) {
    const base = process.env.NEON_AUTH_BASE_URL?.trim().replace(/\/+$/, "");
    if (!base) throw new HttpError(500, "Login não configurado: falta a variável NEON_AUTH_BASE_URL.");
    let response: Response;
    try {
      response = await fetch(`${base}/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, name, password }),
      });
    } catch {
      throw new HttpError(502, "Não foi possível falar com o serviço de login. Tente de novo em instantes.");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      if (body.code?.startsWith("USER_ALREADY_EXISTS")) return false;
      throw new HttpError(502, `O serviço de login recusou a criação da conta: ${body.message ?? response.status}.`);
    }
    await sql.transaction([
      sql`UPDATE neon_auth."user" SET "emailVerified" = true WHERE lower(email) = ${email}`,
      sql`DELETE FROM neon_auth.session
          WHERE "userId" IN (SELECT id FROM neon_auth."user" WHERE lower(email) = ${email})`,
    ]);
    return true;
  },

  async remove(sql, email) {
    // sessões, senha e vínculos saem junto (as tabelas do Neon Auth apagam em cascata)
    await sql`DELETE FROM neon_auth."user" WHERE lower(email) = ${email}`;
  },
};
