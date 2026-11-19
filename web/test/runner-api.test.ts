import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent, getAgent, getFocus, getSetting, listMachines, openQuestions, runsForAgent, setPaused, setSetting } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { authorizedRunner, checkMachines, handleEvents, handleSync } from "~/.server/runner-api";
import { formatEvent, handleUpdate } from "~/.server/telegram";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { createTestD1 } from "./sqlite-d1";

let env: Bindings;
let sent: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(async () => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100" } as Bindings;
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init.body));
    sent.push({ method, body });
    const result = method === "createForumTopic" ? { message_thread_id: 42 } : {};
    return new Response(JSON.stringify({ ok: true, result }));
  });
  await createAgent(env.DB, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
  await createAgent(env.DB, { name: "Prospection", repo: "octo/hub-prospection", machine: "nuc", kind: "dev", hue: 20, seed: "p", settings: DEFAULT_SETTINGS });
});
afterEach(() => vi.unstubAllGlobals());

const flush = async (promises: Promise<unknown>[]) => {
  await Promise.all(promises);
};

describe("runner", () => {
  it("vérifie le jeton en temps constant et refuse un jeton trop court", () => {
    const token = "x".repeat(40);
    expect(authorizedRunner(new Request("https://e", { headers: { Authorization: `Bearer ${token}` } }), token)).toBe(true);
    expect(authorizedRunner(new Request("https://e", { headers: { Authorization: "Bearer nope" } }), token)).toBe(false);
    expect(authorizedRunner(new Request("https://e", { headers: { Authorization: "Bearer court" } }), "court")).toBe(false);
  });

  it("sync : enregistre la machine et l'état des agents, renvoie seulement les agents de la machine", async () => {
    await setPaused(env.DB, "lumen", true);
    const res = await handleSync(env, {
      machine: "mac",
      version: "0.1.0",
      capacity: 2,
      quota: { fiveHour: 0.4 },
      agents: [{ id: "lumen", status: "working", issueNumber: 57, issueTitle: "Export PDF" }],
    });
    expect(res.agents.map((a) => a.id)).toEqual(["lumen"]);
    expect(res.agents[0]).toMatchObject({ paused: true, repo: "octo/lumen" });
    expect(res.focus).toBe(false);
    const agent = await getAgent(env.DB, "lumen");
    expect(agent).toMatchObject({ status: "working", statusDetail: { issueNumber: 57 } });
    const [mac] = await listMachines(env.DB);
    expect(mac).toMatchObject({ name: "mac", online: true, quota: { fiveHour: 0.4 } });
  });

  it("events : suit le run, garde la question et notifie dans le sujet de l'agent", async () => {
    const waits: Promise<unknown>[] = [];
    const run = { id: "r1", agentId: "lumen", issueNumber: 57, issueTitle: "Export PDF", issueUrl: "https://github.com/x/y/issues/57", startedAt: "2026-11-16T22:00:00Z" };
    await handleEvents(
      env,
      {
        events: [
          { agentId: "lumen", runId: "r1", kind: "started", text: "#57", run: { ...run, status: "running" } as never },
          { agentId: "lumen", runId: "r1", kind: "log", level: "run", text: "$ npm test" },
          { agentId: "lumen", runId: "r1", kind: "needs_human", text: "Logo ou version neutre ?", run: { ...run, status: "needs_human" } as never },
        ],
      },
      (p) => waits.push(p),
    );
    await flush(waits);
    const [r] = await runsForAgent(env.DB, "lumen");
    expect(r).toMatchObject({ status: "needs_human", question: "Logo ou version neutre ?", issueNumber: 57 });
    expect((await openQuestions(env.DB)).length).toBe(1);
    // Un sujet créé pour l'agent, puis deux messages (début et question), pas pour la ligne de journal.
    expect(sent.map((s) => s.method)).toEqual(["createForumTopic", "sendMessage", "sendMessage"]);
    expect(sent[2].body).toMatchObject({ message_thread_id: 42 });
    expect(String(sent[2].body.text)).toContain("a besoin de toi");

    await handleEvents(env, { events: [{ agentId: "lumen", runId: "r1", kind: "done", text: "Fait", run: { ...run, status: "done", prUrl: "https://pr" } as never }] }, (p) => waits.push(p));
    await flush(waits);
    const [done] = await runsForAgent(env.DB, "lumen");
    expect(done).toMatchObject({ status: "done", question: null, prUrl: "https://pr" });
    expect(done.endedAt).not.toBeNull();
  });

  it("prévient une seule fois quand une machine ne répond plus, puis quand elle revient", async () => {
    await handleSync(env, { machine: "mac", agents: [] });
    await checkMachines(env, Date.now() + 11 * 60_000);
    await checkMachines(env, Date.now() + 12 * 60_000);
    expect(sent.filter((s) => String(s.body.text).includes("ne répond plus"))).toHaveLength(1);
    await handleSync(env, { machine: "mac", agents: [] });
    expect(String(sent.at(-1)?.body.text)).toContain("répond de nouveau");
  });
});

describe("telegram", () => {
  it("sans groupe configuré, retient le groupe qui écrit au bot, puis l'utilise une fois choisi", async () => {
    env.TELEGRAM_CHAT_ID = "";
    await handleUpdate(env, { message: { text: "/etat", chat: { id: -1009, type: "supergroup", title: "Agents" } } });
    expect(sent).toHaveLength(0);
    expect(JSON.parse(String(await getSetting(env.DB, "telegram_candidate")))).toEqual({ id: -1009, title: "Agents", type: "supergroup" });
    await setSetting(env.DB, "telegram_chat", "-1009");
    await handleUpdate(env, { message: { text: "/etat", chat: { id: -1009, type: "supergroup" } } });
    expect(sent.at(-1)?.body).toMatchObject({ chat_id: "-1009" });
  });

  it("n'envoie rien pour le journal ni pour une reprise après quota", () => {
    expect(formatEvent({ kind: "log", text: "x" }, null)).toBeNull();
    expect(formatEvent({ kind: "resumed", reason: "quota", text: "" }, null)).toBeNull();
    expect(formatEvent({ kind: "quota_hit", text: "Limite <atteinte>" }, null)).toBe("🌙 Limite &lt;atteinte&gt;");
  });

  it("commandes : pause dans le sujet de l'agent, mode « Je travaille », état", async () => {
    await env.DB.prepare("UPDATE agents SET telegram_topic = 42 WHERE id = 'lumen'").run();
    const msg = (text: string, thread?: number) => ({ message: { text, chat: { id: -100 }, message_thread_id: thread } });
    await handleUpdate(env, msg("/pause", 42));
    expect((await getAgent(env.DB, "lumen"))?.paused).toBe(true);
    await handleUpdate(env, msg("/reprise lumen"));
    expect((await getAgent(env.DB, "lumen"))?.paused).toBe(false);
    await handleUpdate(env, msg("/travail"));
    expect(await getFocus(env.DB)).toBe(true);
    await handleUpdate(env, msg("/etat"));
    expect(String(sent.at(-1)?.body.text)).toContain("<b>Lumen</b>");
    // Un autre groupe est ignoré.
    const before = sent.length;
    await handleUpdate(env, { message: { text: "/travail", chat: { id: 1 } } });
    expect(sent.length).toBe(before);
  });
});

describe("création d'un agent", () => {
  it("ouvre son sujet avec un message d'accueil", async () => {
    const { welcomeAgent } = await import("~/.server/telegram");
    const agent = (await getAgent(env.DB, "lumen"))!;
    await welcomeAgent(env, agent);
    expect(sent.map((s) => s.method)).toEqual(["createForumTopic", "sendMessage"]);
    expect(sent[0].body).toMatchObject({ chat_id: "-100", name: "Lumen" });
    expect(sent[1].body).toMatchObject({ message_thread_id: 42 });
    expect(String(sent[1].body.text)).toContain("octo/lumen");
    expect((await getAgent(env.DB, "lumen"))?.telegramTopic).toBe(42);
  });
});
