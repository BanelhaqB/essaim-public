import assert from "node:assert/strict";
import { test } from "node:test";

import { agentStates, agentStatus, blockedUntil, effectiveCapacity, MAX_CAPACITY, plan, startFailure } from "../src/scheduler.mjs";

const NOW = 1_000_000;
const agents = [
  { id: "lumen", priority: 1 },
  { id: "mr", priority: 0 },
  { id: "ong", priority: 2 },
];
const base = { agents, runs: [], quota: {}, capacity: 2, focus: false, now: NOW };

test("donne un ticket aux agents libres par ordre de priorité, dans la limite de la capacité", () => {
  const d = plan(base);
  assert.deepEqual(d.start.map((s) => s.agentId), ["mr", "lumen"]);
  assert.deepEqual(d.interrupt, []);
});

test("un run interrompu passe avant un nouveau ticket, et un agent occupé ne prend rien", () => {
  const runs = [
    { id: "r1", agentId: "mr", status: "running" },
    { id: "r2", agentId: "lumen", status: "interrupted", reason: "quota" },
  ];
  const d = plan({ ...base, runs });
  assert.deepEqual(d.resume, [{ runId: "r2", reason: "quota" }]);
  assert.deepEqual(d.start, []);
});

test("rien ne démarre tant que le quota est bloqué", () => {
  const d = plan({ ...base, quota: { blockedUntil: NOW + 1000 }, runs: [{ id: "r", agentId: "mr", status: "interrupted", reason: "quota" }] });
  assert.deepEqual(d, { interrupt: [], resume: [], start: [] });
});

test("reprend après la réinitialisation", () => {
  const d = plan({ ...base, quota: { blockedUntil: NOW - 1 }, runs: [{ id: "r", agentId: "mr", status: "interrupted", reason: "quota" }] });
  assert.deepEqual(d.resume, [{ runId: "r", reason: "quota" }]);
});

test("pause et mode « Je travaille » arrêtent les runs ; un agent qui ne s'efface pas continue", () => {
  const list = [
    { id: "a", paused: true },
    { id: "b" },
    { id: "c", settings: { yieldOnFocus: false } },
  ];
  const runs = ["a", "b", "c"].map((id) => ({ id: `r-${id}`, agentId: id, status: "running" }));
  const d = plan({ ...base, agents: list, runs, focus: true, capacity: 3 });
  assert.deepEqual(d.interrupt, [
    { runId: "r-a", reason: "pause" },
    { runId: "r-b", reason: "focus" },
  ]);
});

test("une question posée ne bloque pas l'agent ; la réponse fait reprendre le ticket en premier", () => {
  const runs = [{ id: "q", agentId: "mr", status: "needs_human" }];
  assert.deepEqual(plan({ ...base, runs, capacity: 1 }).start, [{ agentId: "mr" }]);
  const d = plan({ ...base, runs, capacity: 1, replies: { q: "version neutre" } });
  assert.deepEqual(d.resume, [{ runId: "q", reason: "reply", reply: "version neutre" }]);
  assert.deepEqual(d.start, []);
});

test("un agent sans ticket prêt et un essai différé ne prennent pas de place", () => {
  const runs = [{ id: "x", agentId: "lumen", status: "interrupted", reason: "crash", retryAfter: NOW + 10 }];
  const d = plan({ ...base, runs, readyCount: { mr: 0 } });
  assert.deepEqual(d.start, [{ agentId: "ong" }]);
  assert.deepEqual(d.resume, []);
});

test("état affiché", () => {
  const ctx = { runs: [{ id: "r", agentId: "mr", status: "interrupted" }], quota: { blockedUntil: NOW + 5 }, focus: false, now: NOW };
  assert.equal(agentStatus({ id: "mr" }, ctx), "quota");
  assert.equal(agentStatus({ id: "mr", paused: true }, ctx), "paused");
  assert.equal(agentStatus({ id: "mr" }, { ...ctx, focus: true }), "yield");
  assert.equal(agentStatus({ id: "lumen" }, ctx), "idle");
  assert.equal(agentStatus({ id: "lumen" }, { ...ctx, quota: {}, readyCount: { lumen: 2 } }), "waiting");
  assert.equal(agentStatus({ id: "mr" }, { ...ctx, runs: [{ id: "r", agentId: "mr", status: "running" }] }), "working");
});

test("fin de blocage : heure annoncée + 1 min, sinon 30 min", () => {
  assert.equal(blockedUntil(2000, 1_000_000), 2_060_000);
  assert.equal(blockedUntil(undefined, 1_000_000), 1_000_000 + 30 * 60_000);
});

test("une prise de ticket ratée est réessayée plus tard, de plus en plus tard, et ne prévient qu'une fois par erreur", () => {
  const first = startFailure(undefined, "Repo absent", NOW);
  assert.deepEqual(first, { until: NOW + 60_000, delay: 60_000, message: "Repo absent", notify: true });
  const again = startFailure(first, "Repo absent", NOW);
  assert.equal(again.delay, 120_000);
  assert.equal(again.notify, false);
  assert.equal(startFailure(again, "gh déconnecté", NOW).notify, true);
  let f = first;
  for (let i = 0; i < 20; i++) f = startFailure(f, "Repo absent", NOW);
  assert.equal(f.delay, 30 * 60_000);

  const blocked = plan({ ...base, startFailures: { mr: first } });
  assert.deepEqual(blocked.start, [{ agentId: "lumen" }, { agentId: "ong" }]);
  const later = plan({ ...base, now: first.until, startFailures: { mr: first } });
  assert.deepEqual(later.start, [{ agentId: "mr" }, { agentId: "lumen" }]);
});

test("places : le réglage d'Essaim prime sur CAPACITY tant qu'il n'a pas expiré", () => {
  assert.equal(effectiveCapacity(2, null, NOW), 2);
  assert.equal(effectiveCapacity(2, { capacity: 5 }, NOW), 5);
  assert.equal(effectiveCapacity(2, { capacity: 5, until: NOW + 1 }, NOW), 5);
  assert.equal(effectiveCapacity(2, { capacity: 5, until: NOW }, NOW), 2);
  assert.equal(effectiveCapacity(2, { capacity: 0 }, NOW), 2);
  assert.equal(effectiveCapacity(2, { capacity: 2.5 }, NOW), 2);
  assert.equal(effectiveCapacity(2, { capacity: 99 }, NOW), MAX_CAPACITY);
});

test("places réduites sous les runs en cours : aucun arrêt, aucun nouveau ticket", () => {
  const runs = [
    { id: "r1", agentId: "mr", status: "running" },
    { id: "r2", agentId: "lumen", status: "running" },
  ];
  const d = plan({ ...base, runs, capacity: 1 });
  assert.deepEqual(d, { interrupt: [], resume: [], start: [] });
});

test("une tâche mise en pause dans Essaim arrête son run, qui ne reprend pas ; l'agent passe à la suite", () => {
  const runs = [
    { id: "r1", agentId: "mr", taskId: "t1", status: "running" },
    { id: "r2", agentId: "lumen", taskId: "t2", status: "interrupted", reason: "hold" },
  ];
  const d = plan({ ...base, runs, held: ["t1", "t2"] });
  assert.deepEqual(d.interrupt, [{ runId: "r1", reason: "hold" }]);
  assert.deepEqual(d.resume, []);
  assert.deepEqual(d.start.map((s) => s.agentId), ["mr", "lumen"]);
});

test("reprise dans Essaim : le run arrêté par la pause reprend avant un nouveau ticket", () => {
  const runs = [{ id: "r2", agentId: "lumen", taskId: "t2", status: "interrupted", reason: "hold" }];
  const d = plan({ ...base, runs, held: [] });
  assert.deepEqual(d.resume, [{ runId: "r2", reason: "hold" }]);
  assert.deepEqual(d.start.map((s) => s.agentId), ["mr"]);
});

test("un agent dont la seule tâche est en pause est au repos", () => {
  const runs = [{ id: "r2", agentId: "lumen", taskId: "t2", status: "interrupted", reason: "hold" }];
  const ctx = { runs, quota: {}, focus: false, now: NOW, readyCount: { lumen: 0 } };
  assert.equal(agentStatus(agents[0], { ...ctx, held: ["t2"] }), "idle");
  assert.equal(agentStatus(agents[0], ctx), "waiting");
});

test("« Attend une place » seulement quand la machine est pleine", () => {
  const ready = { mr: 1, lumen: 1, ong: 1 };
  const states = agentStates({ ...base, capacity: 1, readyCount: ready });
  assert.equal(states.get("mr").status, "starting");
  assert.equal(states.get("lumen").status, "waiting");
  // Deux places : lumen part aussi à ce tour.
  assert.equal(agentStates({ ...base, readyCount: ready }).get("lumen").status, "starting");
});

test("essai différé après un échec : « nouvel essai », pas « attend une place »", () => {
  const failures = { mr: { until: NOW + 60_000 } };
  const states = agentStates({ ...base, readyCount: { mr: 1, lumen: 0, ong: 0 }, startFailures: failures });
  assert.deepEqual(states.get("mr"), { status: "retry", retryAt: NOW + 60_000 });
  const runs = [{ id: "x", agentId: "lumen", status: "interrupted", reason: "crash", retryAfter: NOW + 10 }];
  assert.deepEqual(agentStates({ ...base, runs, readyCount: { mr: 0, ong: 0 } }).get("lumen"), { status: "retry", retryAt: NOW + 10 });
  // Une réponse reçue passe outre l'échec de prise d'un nouveau ticket.
  const asked = [{ id: "q", agentId: "mr", status: "needs_human" }];
  assert.equal(agentStates({ ...base, runs: asked, replies: { q: "oui" }, startFailures: failures }).get("mr").status, "starting");
});

test("redémarrage de mise à jour en attente : l'agent l'affiche au lieu d'attendre une place", () => {
  const states = agentStates({ ...base, readyCount: { mr: 1, lumen: 0, ong: 0 } }, { updating: true });
  assert.equal(states.get("mr").status, "update");
  assert.equal(states.get("lumen").status, "idle");
});
