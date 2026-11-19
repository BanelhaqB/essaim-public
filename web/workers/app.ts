import { createRequestHandler } from "react-router";

import { verifyAccess } from "../app/.server/access";
import { USER_EMAIL_HEADER, type Bindings } from "../app/.server/env";
import { connectHub } from "../app/.server/hub";
import { authorizedRunner, checkMachines, handleEvents, handleImport, handleSync } from "../app/.server/runner-api";
import { handleServicesSync } from "../app/.server/services";
import { handleUpdate } from "../app/.server/telegram";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function api(request: Request, env: Bindings, ctx: ExecutionContext, pathname: string): Promise<Response> {
  if (pathname === "/api/telegram") {
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Accès refusé.", { status: 403 });
    const update = await request.json().catch(() => ({}));
    ctx.waitUntil(handleUpdate(env, update as Parameters<typeof handleUpdate>[1]).catch((e) => console.error("Webhook Telegram :", e)));
    return json({ ok: true });
  }
  if (!authorizedRunner(request, env.RUNNER_TOKEN)) return json({ error: "Jeton du runner invalide." }, 401);
  if (pathname === "/api/runner/ws") {
    const machine = new URL(request.url).searchParams.get("machine") ?? "";
    if (!/^[a-z0-9-]{1,20}$/.test(machine)) return json({ error: "machine invalide." }, 400);
    return connectHub(env, request, "/runner", machine);
  }
  if (request.method !== "POST") return json({ error: "POST attendu." }, 405);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "JSON attendu." }, 400);
  try {
    if (pathname === "/api/runner/sync") return json(await handleSync(env, body as Parameters<typeof handleSync>[1]));
    if (pathname === "/api/runner/events") return json(await handleEvents(env, body, (p) => ctx.waitUntil(p)));
    if (pathname === "/api/runner/services") return json(await handleServicesSync(env, body as Parameters<typeof handleServicesSync>[1]));
    if (pathname === "/api/runner/import") return json(await handleImport(env, body as Parameters<typeof handleImport>[1]));
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(pathname, error);
    return json({ error: "Erreur interne." }, 500);
  }
  return json({ error: "Inconnu." }, 404);
}

export default {
  async fetch(request, rawEnv, ctx) {
    const env = rawEnv as unknown as Bindings;
    const { pathname } = new URL(request.url);
    if (pathname === "/api/telegram" || pathname.startsWith("/api/runner/")) return api(request, env, ctx, pathname);

    let email: string | null;
    if (env.ENVIRONMENT === "development") {
      email = "dev@localhost";
    } else if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      // Jamais de repli silencieux en production : sans Access configuré, rien n'est servi.
      return new Response("Cloudflare Access n'est pas configuré.", { status: 503 });
    } else {
      email = await verifyAccess(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    }
    if (!email) return new Response("Accès refusé.", { status: 403 });

    // Fil en direct de la page d'un agent (derrière Access, comme le reste de l'interface).
    const live = pathname.match(/^\/ws\/agents\/([a-z0-9-]{1,60})$/);
    if (live) return connectHub(env, request, "/browser", live[1]);

    const headers = new Headers(request.headers);
    headers.set(USER_EMAIL_HEADER, email);
    return requestHandler(new Request(request, { headers }));
  },

  async scheduled(_controller, rawEnv) {
    await checkMachines(rawEnv as unknown as Bindings);
  },
} satisfies ExportedHandler<Env>;

export { Hub } from "../app/.server/hub";
