import { beforeEach, describe, expect, it, vi } from "vitest";

import { addUserMessage, createAgent, createConversation, createTask, listConversations, messagesFor } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { handleEvents, handleSync } from "~/.server/runner-api";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { createTestD1 } from "./sqlite-d1";

let env: Bindings;
const noWait = () => {};

beforeEach(async () => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } as Bindings;
  vi.stubGlobal("fetch", async () => new Response("{}"));
  await createAgent(env.DB, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
});

describe("conversations", () => {
  it("un message du propriétaire attend le runner jusqu'à son accusé de réception", async () => {
    const conv = await createConversation(env.DB, "lumen", "Questions sur le PDF");
    const m = await addUserMessage(env.DB, "lumen", conv, "Où est généré le PDF ?");
    expect((await handleSync(env, { machine: "mac", agents: [] })).messages).toEqual([{ id: m.mid, agentId: "lumen", conversationId: conv, text: "Où est généré le PDF ?" }]);
    await handleEvents(env, { events: [{ kind: "msg_ack", ids: [m.mid!], text: "" }] }, noWait);
    expect((await handleSync(env, { machine: "mac", agents: [] })).messages).toEqual([]);
  });

  it("le fil de l'agent est gardé une seule fois, même reçu deux fois", async () => {
    const conv = await createConversation(env.DB, "lumen", "Libre");
    const msg = { agentId: "lumen", conversationId: conv, kind: "msg", role: "agent", text: "C'est dans pdf.ts", mid: "m1" };
    await handleEvents(env, { events: [msg, { ...msg }, { ...msg, role: "tool", level: "run", text: "$ rg pdf", mid: "m2" }] }, noWait);
    expect((await messagesFor(env.DB, conv)).map((m) => [m.role, m.text])).toEqual([
      ["agent", "C'est dans pdf.ts"],
      ["tool", "$ rg pdf"],
    ]);
  });

  it("une tâche commencée a sa conversation, avec le statut de la tâche", async () => {
    const id = await createTask(env.DB, { agentId: "lumen", title: "Export PDF", status: "prete" });
    await handleEvents(env, { events: [{ agentId: "lumen", runId: "r", taskId: id, kind: "started", text: "#3 Export PDF", run: { id: "r", taskId: id, issueTitle: "Export PDF", status: "running" } as never }] }, noWait);
    const [conv] = await listConversations(env.DB, "lumen");
    expect(conv).toMatchObject({ id, taskId: id, title: "Export PDF", taskStatus: "en_cours" });
  });
});
