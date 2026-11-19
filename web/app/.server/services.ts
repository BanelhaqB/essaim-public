/**
 * Services des machines (un serveur) : POST /api/runner/services, appelé par le veilleur (runner/src/services-main.mjs)
 * toutes les 30 s. Il déclare ses services et leur état ; la réponse lui dit lesquels mettre en pause.
 * Essaim garde la volonté (`paused`), le veilleur l'applique sur la machine.
 */
import type { ServiceDetail, ServiceReported } from "~/lib/types";

import { listServices, setServicePaused } from "./db";
import type { Bindings } from "./env";
import { esc, send } from "./telegram";

const REPORTED = new Set<ServiceReported>(["working", "active", "paused", "disabled", "down", "unknown"]);
const MAX_DETAIL = 16_000;
const MAX_SERVICES = 50;

interface ServicesBody {
  machine?: string;
  version?: string;
  services?: Array<{ id?: string; group?: string; name?: string; description?: string; pausable?: boolean; position?: number; status?: string; detail?: unknown }>;
}

/** Le détail tel que rapporté, borné : au-delà de la limite, seuls le résumé, la pause en attente et l'erreur restent. */
function boundedDetail(detail: unknown) {
  const d = (detail && typeof detail === "object" ? detail : {}) as ServiceDetail;
  const json = JSON.stringify(d);
  if (json.length <= MAX_DETAIL) return json;
  const cut = (v?: string) => (v ? String(v).slice(0, 500) : undefined);
  return JSON.stringify({ summary: cut(d.summary), pending: cut(d.pending), error: cut(d.error) });
}

export async function handleServicesSync(env: Bindings, body: ServicesBody) {
  const machine = String(body.machine || "").slice(0, 20);
  if (!/^[a-z0-9-]{1,20}$/.test(machine)) throw new Response("machine manquante", { status: 400 });
  const at = new Date().toISOString();
  const reported = (Array.isArray(body.services) ? body.services : [])
    .filter((s) => typeof s.id === "string" && /^[a-z0-9-]{1,60}$/.test(s.id))
    .slice(0, MAX_SERVICES);
  const before = new Map((await listServices(env.DB)).filter((s) => s.machine === machine).map((s) => [s.id, s]));
  const previous = await env.DB.prepare("SELECT offline_notified FROM machines WHERE name = ?1").bind(machine).first<number>("offline_notified");

  const statements = [
    // Le veilleur fait vivre la machine comme le runner : le cron prévient si elle se tait.
    env.DB.prepare(
      `INSERT INTO machines (name, last_seen, version, offline_notified) VALUES (?1, ?2, ?3, 0)
       ON CONFLICT (name) DO UPDATE SET last_seen = excluded.last_seen, version = COALESCE(machines.version, excluded.version), offline_notified = 0`,
    ).bind(machine, at, body.version ? String(body.version).slice(0, 40) : null),
  ];
  for (const s of reported) {
    const status = REPORTED.has(s.status as ServiceReported) ? (s.status as ServiceReported) : "unknown";
    const pausable = s.pausable !== false;
    statements.push(
      // Un nouveau service déjà en pause sur la machine (coupé à la main) le reste : Essaim ne le relance pas.
      env.DB.prepare(
        `INSERT INTO services (id, machine, grp, name, description, pausable, position, paused, paused_at, status, detail, status_at, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CASE WHEN ?8 = 1 THEN ?12 END, ?9, ?10, ?12, ?11)
         ON CONFLICT (id) DO UPDATE SET machine = excluded.machine, grp = excluded.grp, name = excluded.name, description = excluded.description,
           pausable = excluded.pausable, position = excluded.position, status = excluded.status, detail = excluded.detail,
           status_at = excluded.status_at, version = excluded.version,
           paused = CASE WHEN excluded.pausable = 1 THEN services.paused ELSE 0 END`,
      ).bind(
        s.id!,
        machine,
        String(s.group ?? "").slice(0, 80),
        String(s.name || s.id).slice(0, 120),
        String(s.description ?? "").slice(0, 1000),
        pausable ? 1 : 0,
        Number.isFinite(s.position) ? Number(s.position) : 0,
        pausable && status === "paused" ? 1 : 0,
        status,
        boundedDetail(s.detail),
        body.version ? String(body.version).slice(0, 40) : null,
        at,
      ),
    );
  }
  // Un service retiré de la configuration de la machine disparaît d'Essaim.
  if (Array.isArray(body.services)) {
    statements.push(env.DB.prepare("DELETE FROM services WHERE machine = ?1 AND id NOT IN (SELECT value FROM json_each(?2))").bind(machine, JSON.stringify(reported.map((s) => s.id))));
  }
  await env.DB.batch(statements);

  if (previous === 1) await send(env, `☀️ La machine ${machine} répond de nouveau.`);
  // Prévenir quand un service tombe ou repart (pas au premier relevé).
  for (const s of reported) {
    const was = before.get(s.id!);
    if (!was) continue;
    const name = `<b>${esc(String(s.name || s.id))}</b>${s.group ? ` (${esc(String(s.group))})` : ""}`;
    const summary = (s.detail as ServiceDetail | undefined)?.summary;
    if (s.status === "down" && was.status !== "down") await send(env, `🔴 ${name} est tombé${summary ? ` : ${esc(summary)}` : "."}`);
    else if (was.status === "down" && s.status !== "down" && REPORTED.has(s.status as ServiceReported)) await send(env, `🟢 ${name} est reparti.`);
  }

  const { results } = await env.DB.prepare("SELECT id, paused FROM services WHERE machine = ?1").bind(machine).all<{ id: string; paused: number }>();
  return { services: results.map((r) => ({ id: r.id, paused: Boolean(r.paused) })) };
}


/** Formulaire de pause des pages de services : intent pause | resume, et id (un service) ou group (tout le groupe). */
export async function servicePauseAction(db: D1Database, form: FormData) {
  const intent = form.get("intent");
  if (intent !== "pause" && intent !== "resume") return null;
  const id = String(form.get("id") ?? "");
  const group = String(form.get("group") ?? "");
  if (!id && !group) return null;
  await setServicePaused(db, id ? { id } : { group }, intent === "pause");
  return null;
}
