import { pushToRunner } from "~/.server/hub";
import { listMachines } from "~/.server/db";
import { serverEnv } from "~/.server/env";

/** Attente max de la synchro des runners joints : au-delà, la page se recharge quand même (le sondage prendra le relais). */
const WAIT_MS = 6_000;

/**
 * Bouton « Actualiser » de la barre du haut : demande à chaque runner connecté une synchro immédiate (il retente aussi
 * ses essais différés), attend qu'elle arrive, puis la page recharge ses données (revalidation après l'action).
 */
export async function action() {
  const env = serverEnv();
  const asked = new Date().toISOString();
  const machines = await listMachines(env.DB);
  const reached: string[] = [];
  for (const m of machines) if (await pushToRunner(env, m.name, { type: "sync" })) reached.push(m.name);
  const deadline = Date.now() + WAIT_MS;
  while (reached.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const fresh = await listMachines(env.DB);
    if (reached.every((name) => (fresh.find((m) => m.name === name)?.lastSeen ?? "") > asked)) break;
  }
  return Response.json({ reached }, { headers: { "Cache-Control": "no-store" } });
}
