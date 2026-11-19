import { env as cfEnv } from "cloudflare:workers";

/** En-tête interne qui porte l'email vérifié par workers/app.ts jusqu'aux loaders. */
export const USER_EMAIL_HEADER = "X-User-Email";

export interface Bindings {
  ENVIRONMENT: "development" | "production";
  DB: D1Database;
  /** Hub temps réel (app/.server/hub.ts) : une seule instance, nommée « hub ». */
  HUB: DurableObjectNamespace;
  /** URL publique de l'interface, pour les liens dans Telegram. */
  PUBLIC_URL?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Jeton partagé avec les runners (runner.env → RUNNER_TOKEN), 32 caractères au moins. */
  RUNNER_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  /** Groupe à sujets, identifiant -100… */
  TELEGRAM_CHAT_ID?: string;
  /** Reçu dans l'en-tête X-Telegram-Bot-Api-Secret-Token de chaque appel du webhook. */
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export function serverEnv(): Bindings {
  return cfEnv as unknown as Bindings;
}
