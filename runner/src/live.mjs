/**
 * Lien temps réel avec Essaim : une WebSocket sortante vers le hub (/api/runner/ws), reconnectée toute seule.
 * Elle porte le fil en direct vers les pages ouvertes et reçoit les messages que le propriétaire écrit à un agent.
 * Si elle est coupée, rien n'est perdu : les messages en attente arrivent aussi par la synchro (toutes les 20 s).
 */
const PING_MS = 30_000;

export function createLive({ url, token, machine, onMessage, log = console.log, WebSocketImpl = globalThis.WebSocket }) {
  const target = new URL("/api/runner/ws", url);
  target.protocol = target.protocol === "http:" ? "ws:" : "wss:";
  target.searchParams.set("machine", machine);
  let ws = null;
  let retry = 1_000;
  let ping = null;
  let closed = false;

  function connect() {
    if (closed || !WebSocketImpl) return;
    // L'en-tête Authorization est accepté par la WebSocket de Node (undici).
    ws = new WebSocketImpl(target, { headers: { authorization: `Bearer ${token}` } });
    ws.addEventListener("open", () => {
      retry = 1_000;
      log("Lien temps réel ouvert.");
      ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), PING_MS);
    });
    ws.addEventListener("message", (event) => {
      if (event.data === "pong") return;
      try {
        onMessage(JSON.parse(String(event.data)));
      } catch (error) {
        log("Message du hub illisible :", error.message);
      }
    });
    ws.addEventListener("close", () => {
      clearInterval(ping);
      ws = null;
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 60_000);
    });
    ws.addEventListener("error", () => {});
  }

  connect();
  return {
    /** Envoie au hub si le lien est ouvert ; sinon le direct est simplement perdu (l'historique passe par les événements). */
    send(payload) {
      if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
    },
    get open() {
      return ws?.readyState === 1;
    },
    close() {
      closed = true;
      clearInterval(ping);
      ws?.close();
    },
  };
}
