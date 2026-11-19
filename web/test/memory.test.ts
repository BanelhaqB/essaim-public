import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentUsage, createAgent, createTask, getAgent, getTask, subtasks, taskUsage, updateBrief } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { handleEvents, handleSync } from "~/.server/runner-api";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { createTestD1 } from "./sqlite-d1";

let env: Bindings;
const noWait = () => {};
const ev = (events: object[]) => handleEvents(env, { events: events as never }, noWait);

beforeEach(async () => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } as Bindings;
  vi.stubGlobal("fetch", async () => new Response("{}"));
  await createAgent(env.DB, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
});

describe("mémoire et découpage", () => {
  it("le brief et la mémoire partent avec la synchro ; la mémoire revient de l'agent", async () => {
    await updateBrief(env.DB, "lumen", "App de suivi");
    await ev([{ agentId: "lumen", kind: "memory", text: "Monorepo Angular + Worker." }]);
    const [a] = (await handleSync(env, { machine: "mac", agents: [] })).agents;
    expect(a).toMatchObject({ brief: "App de suivi", memory: "Monorepo Angular + Worker." });
    expect((await getAgent(env.DB, "lumen"))?.memoryAt).not.toBeNull();
  });

  it("une tâche découpée : étapes en tête de file, rattachées à l'issue parente, parent terminé avec la dernière", async () => {
    const other = await createTask(env.DB, { agentId: "lumen", title: "Autre", status: "prete" });
    const big = await createTask(env.DB, { agentId: "lumen", title: "Toute l'app", status: "prete" });
    await env.DB.prepare("UPDATE tasks SET issue_number = 12 WHERE id = ?1").bind(big).run();
    await ev([{ agentId: "lumen", runId: "r", taskId: big, kind: "split", text: "2 étapes", steps: [{ title: "Écrans", body: "a" }, { title: "Store", body: "b" }] }]);
    const res = await handleSync(env, { machine: "mac", agents: [] });
    expect(res.agents[0].queue.map((t) => t.title)).toEqual(["Écrans", "Store", "Autre"]);
    expect(res.github.filter((g) => g.parentIssueNumber === 12).map((g) => g.title)).toEqual(["Écrans", "Store"]);
    const steps = await subtasks(env.DB, big);
    expect((await getTask(env.DB, big))?.status).toBe("en_cours");
    for (const st of steps) await ev([{ agentId: "lumen", runId: st.id, taskId: st.id, kind: "done", text: "ok", run: { id: st.id, status: "done" } }]);
    expect((await getTask(env.DB, big))?.status).toBe("terminee");
    expect((await getTask(env.DB, other))?.status).toBe("prete");
  });

  it("la consommation est comptée par tâche et par agent", async () => {
    const t = await createTask(env.DB, { agentId: "lumen", title: "X", status: "prete" });
    await ev([
      { agentId: "lumen", taskId: t, kind: "usage", text: "", usage: { input: 10, cacheRead: 9000, cacheWrite: 500, output: 300 } },
      { agentId: "lumen", conversationId: "c", kind: "usage", text: "", usage: { input: 5, cacheRead: 1000, cacheWrite: 0, output: 50 } },
    ]);
    expect(await taskUsage(env.DB, t)).toEqual({ input: 10, cacheRead: 9000, cacheWrite: 500, output: 300, sessions: 1 });
    expect((await agentUsage(env.DB, "lumen", "2000-01-01")).cacheRead).toBe(10_000);
  });
});
