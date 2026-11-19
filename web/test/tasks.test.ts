import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerTask, createAgent, createTask, getTask, inboxTasks, messagesFor, moveTask, setTaskStatus, tasksForAgent, updateTaskText } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { handleEvents, handleImport, handleSync } from "~/.server/runner-api";
import { dropTask, pauseTask, reopenDropped } from "~/.server/tasks";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { createTestD1 } from "./sqlite-d1";

let env: Bindings;
const noWait = () => {};

beforeEach(async () => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" } as Bindings;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, result: {} })));
  await createAgent(env.DB, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
});
afterEach(() => vi.unstubAllGlobals());

const sync = () => handleSync(env, { machine: "mac", agents: [] });

describe("tâches", () => {
  it("la file de l'agent suit l'ordre choisi ; les brouillons n'y sont pas", async () => {
    const a = await createTask(env.DB, { agentId: "lumen", title: "A", status: "prete" });
    const b = await createTask(env.DB, { agentId: "lumen", title: "B", status: "prete" });
    await createTask(env.DB, { agentId: "lumen", title: "Brouillon" });
    expect((await sync()).agents[0].queue.map((t) => t.title)).toEqual(["A", "B"]);
    await moveTask(env.DB, b, -1);
    expect((await sync()).agents[0].queue.map((t) => t.id)).toEqual([b, a]);
  });

  it("une tâche prête sans issue est à créer sur GitHub ; une tâche modifiée est à recopier", async () => {
    const id = await createTask(env.DB, { agentId: "lumen", title: "Export PDF", body: "Détails", status: "prete" });
    let res = await sync();
    expect(res.github).toEqual([expect.objectContaining({ id, action: "create", title: "Export PDF", body: "Détails" })]);
    await handleEvents(env, { events: [{ agentId: "lumen", taskId: id, kind: "task_issue", text: "#9", issueNumber: 9, issueUrl: "https://gh/9" }] }, noWait);
    res = await sync();
    expect(res.github).toEqual([]);
    expect(res.agents[0].queue[0]).toMatchObject({ issueNumber: 9 });
    await updateTaskText(env.DB, id, "Export PDF v2", "Détails");
    expect((await sync()).github).toEqual([expect.objectContaining({ id, action: "update", issueNumber: 9 })]);
  });

  it("le cycle du runner : prise, question, réponse depuis Essaim, reprise, fin", async () => {
    const id = await createTask(env.DB, { agentId: "lumen", title: "Logo", status: "prete" });
    const run = { id: "r1", taskId: id, issueNumber: 3, status: "running" };
    const ev = (kind: string, text = "", extra = {}) => handleEvents(env, { events: [{ agentId: "lumen", runId: "r1", taskId: id, kind, text, run: { ...run, ...extra } as never }] }, noWait);
    await ev("started");
    expect((await getTask(env.DB, id))?.status).toBe("en_cours");
    expect((await sync()).agents[0].queue).toHaveLength(0);
    await ev("needs_human", "Couleur ?", { status: "needs_human" });
    expect(await getTask(env.DB, id)).toMatchObject({ status: "question", question: "Couleur ?" });
    await answerTask(env.DB, id, "Violet");
    expect((await sync()).replies).toEqual([{ taskId: id, agentId: "lumen", issueNumber: null, reply: "Violet" }]);
    await ev("resumed", "", { reason: "reply" });
    expect(await getTask(env.DB, id)).toMatchObject({ status: "en_cours", reply: null, question: null });
    await ev("done", "Logo livré", { status: "done", prUrl: "https://pr" });
    expect(await getTask(env.DB, id)).toMatchObject({ status: "terminee", summary: "Logo livré", prUrl: "https://pr" });
  });

  it("la question de l'agent entre dans la conversation de la tâche et y reste après la reprise", async () => {
    const id = await createTask(env.DB, { agentId: "lumen", title: "Logo", status: "prete" });
    const run = { id: "r1", taskId: id, issueNumber: 3, status: "running" };
    const ev = (kind: string, text = "", extra = {}, at?: string) =>
      handleEvents(env, { events: [{ agentId: "lumen", runId: "r1", taskId: id, kind, text, at, run: { ...run, ...extra } as never }] }, noWait);
    await ev("started");
    await ev("needs_human", "Logo ou version neutre ?", { status: "needs_human" }, "2026-11-16T10:00:00.000Z");
    // Même événement renvoyé par le runner : pas de doublon.
    await ev("needs_human", "Logo ou version neutre ?", { status: "needs_human" }, "2026-11-16T10:00:00.000Z");
    await ev("resumed", "", { reason: "reply" });
    const thread = await messagesFor(env.DB, id);
    expect(thread).toEqual([expect.objectContaining({ role: "agent", level: "question", text: "Logo ou version neutre ?" })]);
    // Sans conversation (tâche jamais commencée), rien n'est écrit.
    const other = await createTask(env.DB, { agentId: "lumen", title: "Autre", status: "prete" });
    await handleEvents(env, { events: [{ agentId: "lumen", runId: "r2", taskId: other, kind: "needs_human", text: "?", run: { id: "r2", status: "needs_human" } as never }] }, noWait);
    expect(await messagesFor(env.DB, other)).toEqual([]);
  });

  it("les runs d'avant les tâches retrouvent leur tâche par l'issue", async () => {
    const id = await createTask(env.DB, { agentId: "lumen", title: "Ancien", status: "prete" });
    await env.DB.prepare("UPDATE tasks SET issue_number = 4 WHERE id = ?1").bind(id).run();
    await handleEvents(env, { events: [{ agentId: "lumen", runId: "old", kind: "needs_human", text: "?", run: { id: "old", issueNumber: 4, status: "needs_human" } as never }] }, noWait);
    expect((await getTask(env.DB, id))?.status).toBe("question");
  });

  it("une tâche en cours ne se remet pas en brouillon ; l'abandon d'une tâche lancée est signalé au runner", async () => {
    const id = await createTask(env.DB, { agentId: "lumen", title: "X", status: "prete" });
    await handleEvents(env, { events: [{ agentId: "lumen", runId: "r", taskId: id, kind: "started", text: "", run: { id: "r", status: "running" } as never }] }, noWait);
    await setTaskStatus(env.DB, id, "brouillon");
    expect((await getTask(env.DB, id))?.status).toBe("en_cours");
    await setTaskStatus(env.DB, id, "abandonnee");
    expect((await sync()).abandoned).toEqual([id]);
    expect((await tasksForAgent(env.DB, "lumen")).map((t) => t.status)).toEqual(["abandonnee"]);
  });

  it("import du Project 4 : chez l'agent du même nom, sinon dans la boîte ; pas de doublon", async () => {
    const tasks = [
      { ref: "P1", title: "Flyer", body: "A5", label: "Lumen" },
      { ref: "P2", title: "Portfolio", label: "Perso / Admin" },
    ];
    expect(await handleImport(env, { tasks })).toEqual({ imported: 2 });
    expect(await handleImport(env, { tasks })).toEqual({ imported: 0 });
    expect((await tasksForAgent(env.DB, "lumen")).map((t) => [t.title, t.status])).toEqual([["Flyer", "brouillon"]]);
    expect((await inboxTasks(env.DB)).map((t) => [t.title, t.sourceLabel])).toEqual([["Portfolio", "Perso / Admin"]]);
  });
});

describe("pause et abandon d'une tâche commencée", () => {
  /** Hub factice : garde ce qui est poussé au runner. */
  const pushed: unknown[] = [];
  beforeEach(() => {
    pushed.length = 0;
    const stub = { fetch: async (_url: string, init: RequestInit) => (pushed.push(JSON.parse(String(init.body))), Response.json({ online: true })) };
    env.HUB = { idFromName: () => "hub", get: () => stub } as never;
  });
  const runnerPushes = () => pushed.flatMap((p) => ((p as { runner?: unknown }).runner ? [(p as { runner: unknown }).runner] : []));

  const start = async (title = "Logo") => {
    const id = await createTask(env.DB, { agentId: "lumen", title, status: "prete" });
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${id}`, taskId: id, kind: "started", text: "", run: { id: `r-${id}`, status: "running" } as never }] }, noWait);
    return id;
  };

  it("pause : la tâche passe en pause, le runner est prévenu et la synchro la liste ; reprise : retour en cours", async () => {
    const id = await start();
    await pauseTask(env, "lumen", id, true);
    expect((await getTask(env.DB, id))?.status).toBe("en_pause");
    expect(runnerPushes()).toEqual([{ type: "task_hold", taskId: id, hold: true }]);
    expect((await sync()).held).toEqual([id]);
    // Le run arrêté par la pause ne change pas le statut.
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${id}`, taskId: id, kind: "interrupted", text: "Mise en pause", run: { id: `r-${id}`, status: "interrupted" } as never }] }, noWait);
    expect((await getTask(env.DB, id))?.status).toBe("en_pause");
    await pauseTask(env, "lumen", id, false);
    expect((await getTask(env.DB, id))?.status).toBe("en_cours");
    expect((await sync()).held).toEqual([]);
  });

  it("seule une tâche en cours de cet agent se met en pause ; une tâche découpée non plus", async () => {
    const ready = await createTask(env.DB, { agentId: "lumen", title: "En file", status: "prete" });
    await pauseTask(env, "lumen", ready, true);
    expect((await getTask(env.DB, ready))?.status).toBe("prete");
    const id = await start();
    await pauseTask(env, "autre", id, true);
    expect((await getTask(env.DB, id))?.status).toBe("en_cours");
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${id}`, taskId: id, kind: "split", text: "2", steps: [{ title: "Un" }, { title: "Deux" }] }] }, noWait);
    await pauseTask(env, "lumen", id, true);
    expect((await getTask(env.DB, id))?.status).toBe("en_cours");
    expect(runnerPushes()).toEqual([]);
  });

  it("abandon d'une tâche en cours (ou en pause) : close, signalée au runner, l'issue sera fermée", async () => {
    const id = await start();
    await handleEvents(env, { events: [{ agentId: "lumen", taskId: id, kind: "task_issue", text: "#4", issueNumber: 4, issueUrl: "https://gh/4" }] }, noWait);
    await pauseTask(env, "lumen", id, true);
    await dropTask(env, "lumen", id);
    expect((await getTask(env.DB, id))?.status).toBe("abandonnee");
    expect(runnerPushes()).toContainEqual({ type: "task_abandon", taskId: id });
    const res = await sync();
    expect(res.abandoned).toEqual([id]);
    expect(res.held).toEqual([]);
    expect(res.github).toEqual([expect.objectContaining({ id, status: "abandonnee", action: "update" })]);
  });

  it("abandon d'une tâche découpée : ses étapes pas finies aussi ; une tâche terminée ne s'abandonne plus", async () => {
    const id = await start("Gros chantier");
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${id}`, taskId: id, kind: "split", text: "2", steps: [{ title: "Un" }, { title: "Deux" }] }] }, noWait);
    await dropTask(env, "lumen", id);
    const all = await tasksForAgent(env.DB, "lumen");
    expect(all.map((t) => t.status)).toEqual(["abandonnee", "abandonnee", "abandonnee"]);
    const done = await start("Fini");
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${done}`, taskId: done, kind: "done", text: "ok", run: { id: `r-${done}`, status: "done" } as never }] }, noWait);
    await dropTask(env, "lumen", done);
    expect((await getTask(env.DB, done))?.status).toBe("terminee");
  });

  it("reprise d'une tâche abandonnée : en tête de file, l'issue sera rouverte, le runner se synchronise", async () => {
    const other = await createTask(env.DB, { agentId: "lumen", title: "En file", status: "prete" });
    const id = await start();
    await handleEvents(env, { events: [{ agentId: "lumen", taskId: id, kind: "task_issue", text: "#4", issueNumber: 4, issueUrl: "https://gh/4" }] }, noWait);
    await dropTask(env, "lumen", id);
    await handleEvents(env, { events: [{ agentId: "lumen", taskId: id, kind: "task_synced", text: "#4" }] }, noWait);
    pushed.length = 0;
    await reopenDropped(env, "autre", id);
    expect((await getTask(env.DB, id))?.status).toBe("abandonnee");
    await reopenDropped(env, "lumen", id);
    expect((await getTask(env.DB, id))?.status).toBe("prete");
    expect(runnerPushes()).toEqual([{ type: "sync" }]);
    const res = await sync();
    expect(res.abandoned).toEqual([]);
    expect(res.agents[0].queue.map((t) => t.id)).toEqual([id, other]);
    expect(res.github).toContainEqual(expect.objectContaining({ id, status: "prete", action: "update", issueNumber: 4 }));
    // Une tâche qui n'est pas abandonnée ne se « reprend » pas.
    await reopenDropped(env, "lumen", other);
    expect((await getTask(env.DB, other))?.status).toBe("prete");
  });

  it("reprise d'une tâche découpée : elle repasse en cours, ses étapes abandonnées reviennent en file dans l'ordre", async () => {
    const id = await start("Gros chantier");
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${id}`, taskId: id, kind: "split", text: "3", steps: [{ title: "Un" }, { title: "Deux" }, { title: "Trois" }] }] }, noWait);
    const [one] = (await sync()).agents[0].queue;
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${one.id}`, taskId: one.id, kind: "started", text: "", run: { id: `r-${one.id}`, status: "running" } as never }] }, noWait);
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${one.id}`, taskId: one.id, kind: "done", text: "ok", run: { id: `r-${one.id}`, status: "done" } as never }] }, noWait);
    await dropTask(env, "lumen", id);
    await reopenDropped(env, "lumen", id);
    expect((await getTask(env.DB, id))?.status).toBe("en_cours");
    expect((await getTask(env.DB, one.id))?.status).toBe("terminee");
    expect((await sync()).agents[0].queue.map((t) => t.title)).toEqual(["Deux", "Trois"]);
  });

  it("reprise d'une étape abandonnée seule : sa tâche mère close est rouverte", async () => {
    const id = await start("Gros chantier");
    await handleEvents(env, { events: [{ agentId: "lumen", runId: `r-${id}`, taskId: id, kind: "split", text: "2", steps: [{ title: "Un" }, { title: "Deux" }] }] }, noWait);
    await dropTask(env, "lumen", id);
    const step = (await tasksForAgent(env.DB, "lumen")).find((t) => t.title === "Deux")!;
    await reopenDropped(env, "lumen", step.id);
    expect((await getTask(env.DB, step.id))?.status).toBe("prete");
    expect((await getTask(env.DB, id))?.status).toBe("en_cours");
    expect((await sync()).agents[0].queue.map((t) => t.title)).toEqual(["Deux"]);
  });
});
