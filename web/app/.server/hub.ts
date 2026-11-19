/**
 * Hub temps réel (Durable Object, une seule instance « hub ») : il relie le runner de chaque machine, connecté en
 * WebSocket sortant, et les pages d'agent ouvertes dans le navigateur.
 *   runner  → hub : { type: "live", agentId, event }  fil en direct (texte de l'agent, outils, état), relayé aux pages
 *                   { type: "ack", ids }              messages du propriétaire bien reçus
 *   Worker  → hub : POST /push { agentId, live?, machine?, runner? }  (message envoyé depuis une page, rafraîchissement)
 *   hub → runner  : { type: "user_message", id, agentId, conversationId, text }
 * Les WebSockets hibernent : le hub ne coûte rien tant que personne ne parle.
 */
import { DurableObject } from "cloudflare:workers";

import { markDelivered } from "./db";
import type { Bindings } from "./env";

export class Hub extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    // Le runner envoie « ping » toutes les 30 s : réponse sans réveiller l'objet.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/push") {
      const body = (await request.json()) as { agentId?: string; live?: unknown; machine?: string; runner?: unknown };
      if (body.agentId && body.live) this.toBrowsers(body.agentId, body.live);
      const online = body.machine ? this.ctx.getWebSockets(`machine:${body.machine}`).length > 0 : false;
      if (body.machine && body.runner) this.send(`machine:${body.machine}`, body.runner);
      return Response.json({ online });
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket attendu.", { status: 426 });
    const tags =
      url.pathname === "/runner"
        ? ["runner", `machine:${url.searchParams.get("machine") ?? ""}`]
        : ["browser", `agent:${url.searchParams.get("agent") ?? ""}`];
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], tags);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    // Les pages ne font qu'écouter ; seul le runner parle au hub.
    if (!this.ctx.getTags(ws).includes("runner")) return;
    let msg: { type?: string; agentId?: string; event?: unknown; ids?: string[] };
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    if (msg.type === "live" && msg.agentId && msg.event) this.toBrowsers(msg.agentId, msg.event);
    if (msg.type === "ack" && Array.isArray(msg.ids)) await markDelivered(this.env.DB, msg.ids.map(String));
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "fermé");
    } catch {
      /* déjà fermé */
    }
  }

  private toBrowsers(agentId: string, event: unknown) {
    this.send(`agent:${agentId}`, event);
  }

  private send(tag: string, payload: unknown) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(text);
      } catch {
        /* page fermée entre-temps */
      }
    }
  }
}

const stub = (env: Bindings) => env.HUB.get(env.HUB.idFromName("hub"));

/** Pousse un événement aux pages ouvertes d'un agent. */
export async function pushLive(env: Bindings, agentId: string, live: unknown) {
  try {
    await stub(env).fetch("https://hub/push", { method: "POST", body: JSON.stringify({ agentId, live }) });
  } catch (error) {
    console.error("Hub :", error);
  }
}

/** Remet un message au runner d'une machine (s'il est connecté) et le montre aux pages ouvertes. Renvoie true si le runner l'a reçu en direct. */
export async function pushToRunner(env: Bindings, machine: string, runner: unknown, agentId?: string, live?: unknown) {
  try {
    const res = await stub(env).fetch("https://hub/push", { method: "POST", body: JSON.stringify({ machine, runner, agentId, live }) });
    return Boolean(((await res.json()) as { online?: boolean }).online);
  } catch (error) {
    console.error("Hub :", error);
    return false;
  }
}

/** Ouvre une WebSocket vers le hub (runner ou page d'agent). */
export function connectHub(env: Bindings, request: Request, path: "/runner" | "/browser", param: string) {
  const target = new URL(`https://hub${path}`);
  target.searchParams.set(path === "/runner" ? "machine" : "agent", param);
  return stub(env).fetch(new Request(target, request));
}
