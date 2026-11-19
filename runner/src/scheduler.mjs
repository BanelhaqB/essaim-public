/**
 * Décisions du runner à chaque tour, sans effet de bord (testé dans test/scheduler.test.mjs).
 *
 * Un run est un ticket en cours de traitement par un agent :
 *   running      Claude travaille dessus
 *   interrupted  arrêté (quota, pause, mode « Je travaille », redémarrage, erreur) : à reprendre en priorité
 *                (sauf si sa tâche est mise en pause dans Essaim : elle attend qu'on la reprenne, l'agent passe à la suite)
 *   needs_human  question posée sur l'issue : attend une réponse, l'agent passe au ticket suivant
 * Un agent n'a qu'un run actif (running ou interrupted) à la fois ; il peut avoir plusieurs tickets en attente de réponse.
 */

/** L'agent laisse la place quand « Je travaille » est actif (oui par défaut). */
export const yieldsOnFocus = (agent) => agent.settings?.yieldOnFocus !== false;

const isBlocked = (agent, focus) => Boolean(agent.paused) || (focus && yieldsOnFocus(agent));

/** La tâche d'un run (les runs d'avant les tâches ont l'identifiant de leur tâche). */
export const taskOf = (run) => run.taskId ?? run.id;
/** Run dont la tâche est mise en pause dans Essaim. `held` : identifiants de ces tâches. */
const isHeld = (run, held) => Boolean(held?.length) && held.includes(taskOf(run));

/** Plafond des places d'une machine, quel que soit le réglage reçu. */
export const MAX_CAPACITY = 16;

/**
 * Places effectives : le réglage ponctuel d'Essaim (page de la machine) s'il est valide et pas expiré,
 * sinon CAPACITY. `override` = { capacity, until? } (until en ms ; absent = jusqu'à nouvel ordre).
 */
export function effectiveCapacity(base, override, now) {
  const n = Number(override?.capacity);
  if (!Number.isInteger(n) || n < 1) return base;
  if (override.until && now >= override.until) return base;
  return Math.min(n, MAX_CAPACITY);
}

/**
 * @param {object} p
 * @param {Array<{id: string, paused?: boolean, priority?: number, settings?: object}>} p.agents  agents de cette machine
 * @param {Array<{id: string, agentId: string, status: string, reason?: string, retryAfter?: number}>} p.runs
 * @param {{blockedUntil?: number}} p.quota
 * @param {number} p.capacity  runs simultanés sur cette machine
 * @param {boolean} p.focus    mode « Je travaille »
 * @param {number} p.now
 * @param {Record<string, number>} p.readyCount  tickets prêts vus au dernier passage (absent = inconnu)
 * @param {Record<string, string>} p.replies     runId → réponse trouvée sur l'issue
 * @param {Record<string, {until: number}>} p.startFailures  agentId → dernier échec de prise de ticket (essai différé)
 * @param {string[]} p.held  tâches mises en pause dans Essaim : leur run s'arrête et ne reprend pas
 */
export function plan({ agents, runs, quota, capacity, focus, now, readyCount = {}, replies = {}, startFailures = {}, held = [] }) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const interrupt = [];
  for (const run of runs.filter((r) => r.status === "running")) {
    const agent = byId.get(run.agentId);
    if (!agent) interrupt.push({ runId: run.id, reason: "removed" });
    else if (isHeld(run, held)) interrupt.push({ runId: run.id, reason: "hold" });
    else if (agent.paused) interrupt.push({ runId: run.id, reason: "pause" });
    else if (focus && yieldsOnFocus(agent)) interrupt.push({ runId: run.id, reason: "focus" });
  }
  const stopping = new Set(interrupt.map((i) => i.runId));
  const running = runs.filter((r) => r.status === "running" && !stopping.has(r.id));
  const busyAgents = new Set(running.map((r) => r.agentId));

  const resume = [];
  const start = [];
  const quotaBlocked = Boolean(quota?.blockedUntil && now < quota.blockedUntil);
  let free = capacity - running.length;

  if (!quotaBlocked) {
    const ordered = [...agents].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const agent of ordered) {
      if (free <= 0) break;
      if (isBlocked(agent, focus) || busyAgents.has(agent.id)) continue;
      // Une tâche en pause ne compte plus : l'agent peut prendre la suivante.
      const own = runs.filter((r) => r.agentId === agent.id && !isHeld(r, held));
      const interrupted = own.find((r) => r.status === "interrupted");
      if (interrupted) {
        if (interrupted.retryAfter && now < interrupted.retryAfter) continue;
        resume.push({ runId: interrupted.id, reason: interrupted.reason ?? "restart" });
        free--;
        continue;
      }
      const answered = own.find((r) => r.status === "needs_human" && replies[r.id] != null);
      if (answered) {
        resume.push({ runId: answered.id, reason: "reply", reply: replies[answered.id] });
        free--;
        continue;
      }
      if ((readyCount[agent.id] ?? 1) > 0 && !(now < (startFailures[agent.id]?.until ?? 0))) {
        start.push({ agentId: agent.id });
        free--;
      }
    }
  }
  return { interrupt, resume, start };
}

/**
 * L'état affiché d'un agent : working, paused, yield (te laisse la place), quota (attend la réinitialisation),
 * update (le runner attend de redémarrer pour une mise à jour), starting (une place est libre, il part à ce tour),
 * retry (nouvel essai différé après un échec, à `retryAt`), waiting (a du travail mais la machine est pleine)
 * ou idle (rien à faire).
 * Sans `starting` (agents choisis par le plan de ce tour), tout agent qui a du travail est réputé attendre une place.
 * @returns {string}
 */
export function agentStatus(agent, ctx) {
  return agentState(agent, ctx).status;
}

/** Comme agentStatus, avec l'heure du prochain essai (ms) quand l'agent attend après un échec. */
export function agentState(agent, { runs, quota, focus, now, readyCount = {}, replies = {}, held = [], startFailures = {}, starting, updating = false }) {
  if (agent.paused) return { status: "paused" };
  if (runs.some((r) => r.agentId === agent.id && r.status === "running")) return { status: "working" };
  const own = runs.filter((r) => r.agentId === agent.id && !isHeld(r, held));
  const interrupted = own.find((r) => r.status === "interrupted");
  const answered = own.some((r) => r.status === "needs_human" && replies[r.id] != null);
  const ready = (readyCount[agent.id] ?? 0) > 0;
  if (!interrupted && !answered && !ready) return { status: "idle" };
  if (focus && yieldsOnFocus(agent)) return { status: "yield" };
  if (quota?.blockedUntil && now < quota.blockedUntil) return { status: "quota" };
  if (updating) return { status: "update" };
  // Mêmes règles que plan() : une reprise différée bloque l'agent, un échec de prise ne bloque que les nouveaux tickets.
  const retryAt = interrupted ? (interrupted.retryAfter ?? 0) : answered ? 0 : (startFailures[agent.id]?.until ?? 0);
  if (retryAt > now) return { status: "retry", retryAt };
  if (starting?.has(agent.id)) return { status: "starting" };
  return { status: "waiting" };
}

/**
 * États de tous les agents d'après le plan de ce tour : « Attend une place » seulement si la machine est vraiment
 * pleine (avant, un agent en essai différé ou bloqué par une mise à jour l'affichait aussi, places libres).
 * @returns {Map<string, {status: string, retryAt?: number}>}
 */
export function agentStates(p, { updating = false } = {}) {
  const decision = plan(p);
  const byRun = new Map(p.runs.map((r) => [r.id, r.agentId]));
  const starting = new Set([...decision.start.map((s) => s.agentId), ...decision.resume.map((r) => byRun.get(r.runId))]);
  return new Map(p.agents.map((a) => [a.id, agentState(a, { ...p, starting, updating })]));
}

/**
 * Prise de ticket ratée (repo absent, gh déconnecté…) : on réessaie de plus en plus tard (1 min, 2, 4… 30 min au plus)
 * et on ne prévient le propriétaire que si l'erreur change, au lieu de le relancer à chaque tour.
 * @param {{delay: number, message: string} | undefined} prev  échec précédent de cet agent
 * @returns {{until: number, delay: number, message: string, notify: boolean}}
 */
export function startFailure(prev, message, now) {
  const delay = prev ? Math.min(prev.delay * 2, 30 * 60_000) : 60_000;
  return { until: now + delay, delay, message, notify: prev?.message !== message };
}

/** Fin de blocage du quota : l'heure de réinitialisation annoncée + 1 min de marge, ou 30 min sans information. */
export function blockedUntil(resetsAtSec, now) {
  if (resetsAtSec && resetsAtSec * 1000 > now) return resetsAtSec * 1000 + 60_000;
  return now + 30 * 60_000;
}
