/**
 * Connexion Claude : détecter qu'elle a expiré (les runs échouent) ou qu'elle va expirer (`claude auth status`),
 * pour prévenir avant que les agents ne s'arrêtent.
 */
import { execFile } from "node:child_process";

const AUTH_TEXT = /not logged in|please run .{0,20}login|invalid (api key|authentication|credentials)|authentication[_ ](error|failed)|oauth token.{0,30}(expired|revoked)|(sign-in|login|session|token) (has )?expired|failed to authenticate|\b401\b.{0,40}(unauthorized|authenticat)/i;

/** La session s'est-elle arrêtée parce que la connexion Claude est expirée ou absente ? */
export function hitAuthError(result, stderr = "") {
  return Boolean((result?.isError && AUTH_TEXT.test(result.text ?? "")) || (!result?.structured && AUTH_TEXT.test(stderr)));
}

const RENEW = "Lance `claude auth login` sur la machine du runner (ou `claude setup-token` pour une connexion longue durée sans interaction).";

/**
 * Ce qu'il faut annoncer d'après `claude auth status` : connexion perdue, ou expiration dans moins de `warnDays` jours.
 * @returns {{kind: "auth_expired" | "auth_expiring", text: string} | null}
 */
export function authAlert(status, now = Date.now(), warnDays = 3) {
  if (!status) return null;
  if (status.loggedIn === false) return { kind: "auth_expired", text: `Connexion Claude perdue : les agents ne peuvent plus travailler. ${RENEW}` };
  const at = Date.parse(status.loginExpiresAt ?? "");
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  if (left <= 0) return { kind: "auth_expired", text: `Connexion Claude expirée. ${RENEW}` };
  if (left <= warnDays * 86_400_000) {
    const when = new Date(at).toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    return { kind: "auth_expiring", text: `La connexion Claude expire ${when}. ${RENEW}` };
  }
  return null;
}

/** `claude auth status` en JSON ; null si la commande échoue (on ne conclut rien). */
export function readAuthStatus(bin, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    execFile(bin, ["auth", "status"], { timeout: timeoutMs, windowsHide: true, shell: process.platform === "win32" }, (error, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}
