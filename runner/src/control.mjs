/**
 * Client du plan de contrôle (le Worker Cloudflare) : synchronisation de l'état et envoi des événements.
 * Le runner reste autonome si le Worker est injoignable : les événements attendent (500 au plus).
 */
const MAX_BUFFER = 500;

export function createControl({ url, token, accessId, accessSecret, machine, fetchImpl = fetch }) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (accessId && accessSecret) Object.assign(headers, { "CF-Access-Client-Id": accessId, "CF-Access-Client-Secret": accessSecret });
  let buffer = [];
  let flushing = false;

  async function post(path, body) {
    const res = await fetchImpl(new URL(path, url), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${path} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  return {
    /** Envoie l'état de la machine, reçoit ses agents et le mode « Je travaille ». */
    sync: (body) => post("/api/runner/sync", { machine, ...body }),

    /** Veilleur des services : envoie leur état, reçoit la pause demandée pour chacun. */
    services: (body) => post("/api/runner/services", { machine, ...body }),

    event(event) {
      buffer.push({ at: new Date().toISOString(), ...event });
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
    },

    async flush() {
      if (flushing || !buffer.length) return;
      flushing = true;
      const batch = buffer.slice(0, 100);
      try {
        await post("/api/runner/events", { machine, events: batch });
        buffer = buffer.slice(batch.length);
      } catch (error) {
        console.error("Événements non envoyés :", error.message);
      } finally {
        flushing = false;
      }
    },
  };
}
