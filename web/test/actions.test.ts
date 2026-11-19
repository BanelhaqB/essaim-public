import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent, getActionRun, listActions, listConversations, messagesFor, pendingMessages, saveAction } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { handleEvents, handleSync } from "~/.server/runner-api";
import { formatEvent } from "~/.server/telegram";
import { fmtDuration, normalizeAction, normalizeActions } from "~/lib/actions";
import { DEFAULT_SETTINGS } from "~/lib/types";
import { action as actionsAction } from "~/routes/actions";
import { action as agentAction, loader as agentLoader } from "~/routes/agent";

import { env as cfEnv } from "./cloudflare-workers";
import { createTestD1 } from "./sqlite-d1";

let env: Bindings;
let sent: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(async () => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100", PUBLIC_URL: "https://essaim.test" } as Bindings;
  Object.assign(cfEnv, env);
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 42 } }));
  });
  await createAgent(env.DB, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
});
afterEach(() => vi.unstubAllGlobals());

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return body;
};
const onAgent = (fields: Record<string, string>) =>
  agentAction({ request: new Request("https://e/agents/lumen", { method: "POST", body: form(fields) }), params: { id: "lumen" } } as never) as Promise<Record<string, string> | null>;
const onActions = (fields: Record<string, string>) =>
  actionsAction({ request: new Request("https://e/agents/lumen/actions", { method: "POST", body: form(fields) }), params: { id: "lumen" } } as never);
const events = (list: Array<Record<string, unknown>>) => handleEvents(env, { machine: "mac", events: list as never }, () => {});

const command = { name: "Générer l'APK", description: "Build release", command: "./gradlew assembleRelease", prompt: null, confirm: false, timeoutMinutes: 30 };

describe("validation", () => {
  it("garde une action nommée avec une commande ou une consigne, bornée", () => {
    expect(normalizeAction({ name: " Installer ", command: " make ", prompt: "ignorée", confirm: "on", timeoutMinutes: "999" })).toEqual({
      name: "Installer",
      description: "",
      command: "make",
      prompt: null,
      confirm: true,
      timeoutMinutes: 240,
    });
    expect(normalizeAction({ name: "Rien" })).toBeNull();
    expect(normalizeAction({ command: "make" })).toBeNull();
    expect(normalizeActions([{ name: "A", prompt: "x" }, { name: "a", prompt: "doublon" }, null]).map((a) => a.name)).toEqual(["A"]);
    expect(fmtDuration(42_000)).toBe("42 s");
    expect(fmtDuration(185_000)).toBe("3 min 05 s");
    expect(fmtDuration(4_320_000)).toBe("1 h 12 min");
  });
});

describe("ACTIONS.json de l'agent", () => {
  it("remplace la liste d'Essaim : retrouvée par identifiant puis par nom, les absentes retirées", async () => {
    await events([
      {
        kind: "actions",
        agentId: "lumen",
        text: "",
        actions: [
          { name: "Installer sur l'iPhone", command: "make ios-install", confirm: false },
          { name: "Publier", prompt: "Publie la dernière version sur les stores", confirm: true },
        ],
      },
    ]);
    const first = await listActions(env.DB, "lumen");
    expect(first.map((a) => [a.name, a.command, a.prompt, a.confirm, a.position])).toEqual([
      ["Installer sur l'iPhone", "make ios-install", null, false, 1],
      ["Publier", null, "Publie la dernière version sur les stores", true, 2],
    ]);
    const [install, publish] = first;

    // L'agent renomme l'une (même id), réécrit l'autre sans id (même nom), en ajoute une, et l'ordre change.
    await events([
      {
        kind: "actions",
        agentId: "lumen",
        text: "",
        actions: [
          { name: "Publier", prompt: "Publie sur les deux stores" },
          { id: install.id, name: "Installer sur mon iPhone", command: "make ios-install DEVICE=iphone" },
          { name: "Générer l'APK", command: "./gradlew assembleRelease", timeoutMinutes: 20 },
        ],
      },
    ]);
    const second = await listActions(env.DB, "lumen");
    expect(second.map((a) => a.name)).toEqual(["Publier", "Installer sur mon iPhone", "Générer l'APK"]);
    expect(second[0].id).toBe(publish.id);
    expect(second[1].id).toBe(install.id);
    expect(second[2].timeoutMinutes).toBe(20);

    // La synchro les renvoie au format d'ACTIONS.json.
    const res = await handleSync(env, { machine: "mac", agents: [] });
    expect(res.agents[0].actions).toEqual([
      { id: publish.id, name: "Publier", description: "", prompt: "Publie sur les deux stores" },
      { id: install.id, name: "Installer sur mon iPhone", description: "", command: "make ios-install DEVICE=iphone" },
      { id: second[2].id, name: "Générer l'APK", description: "", command: "./gradlew assembleRelease", timeoutMinutes: 20 },
    ]);

    await events([{ kind: "actions", agentId: "lumen", text: "", actions: [] }]);
    expect(await listActions(env.DB, "lumen")).toEqual([]);
  });
});

describe("lancement d'une commande", () => {
  it("demandé dans Essaim, pris par le runner, terminé avec une notification", async () => {
    const id = await saveAction(env.DB, "lumen", command);
    const res = await onAgent({ intent: "action-run", actionId: id });
    const conversationId = res!.conversationId;
    expect(conversationId).toBeTruthy();

    // Un second clic pendant qu'elle attend : même lancement.
    expect((await onAgent({ intent: "action-run", actionId: id }))!.conversationId).toBe(conversationId);
    const [conv] = await listConversations(env.DB, "lumen");
    expect(conv).toMatchObject({ id: conversationId, title: "▶ Générer l'APK", actionStatus: "demandee" });

    const sync = await handleSync(env, { machine: "mac", agents: [] });
    expect(sync.actionRuns).toEqual([
      { id: expect.any(String), agentId: "lumen", conversationId, name: "Générer l'APK", command: "./gradlew assembleRelease", timeoutMinutes: 30, stop: false },
    ]);
    const runId = sync.actionRuns[0].id;

    // On n'écrit pas à l'agent pendant que la commande tourne.
    await events([{ kind: "action_started", agentId: "lumen", actionRunId: runId, conversationId, text: "" }]);
    expect(await getActionRun(env.DB, runId)).toMatchObject({ status: "en_cours" });
    expect(await onAgent({ intent: "send", conversationId, text: "alors ?" })).toMatchObject({ error: expect.stringContaining("tourne encore") });
    expect((await handleSync(env, { machine: "mac", agents: [], actionRuns: [runId] })).actionRuns).toEqual([]);

    // Sortie et fin.
    await events([
      { kind: "msg", agentId: "lumen", conversationId, role: "tool", level: "output", text: "BUILD SUCCESSFUL\n", mid: "o1" },
      { kind: "action_ended", agentId: "lumen", actionRunId: runId, conversationId, status: "reussie", exitCode: 0, text: "« Générer l'APK » terminée en 2 min 05 s." },
    ]);
    expect(await getActionRun(env.DB, runId)).toMatchObject({ status: "reussie", exitCode: 0, endedAt: expect.any(String) });
    expect((await messagesFor(env.DB, conversationId)).map((m) => m.level)).toEqual(["output"]);
    const [action] = await listActions(env.DB, "lumen");
    expect(action.last).toMatchObject({ id: runId, status: "reussie", conversationId });
    await vi.waitFor(() => expect(sent.some((m) => String(m.body.text).includes("terminée en 2 min 05 s"))).toBe(true));

    // La page de l'agent ouvre la conversation avec son lancement.
    const page = await agentLoader({ request: new Request(`https://e/agents/lumen?c=${conversationId}`), params: { id: "lumen" } } as never);
    expect(page.actionRun).toMatchObject({ id: runId, status: "reussie" });
    expect(page.actions).toHaveLength(1);

    // Ensuite, on peut en parler à l'agent dans cette conversation.
    expect(await onAgent({ intent: "send", conversationId, text: "Pourquoi 2 min ?" })).toMatchObject({ conversationId });
  });

  it("message Telegram d'un échec : la fin de la sortie et le lien vers la conversation", () => {
    const agent = { id: "lumen", name: "Lumen" } as never;
    const text = formatEvent(
      { kind: "action_ended", agentId: "lumen", conversationId: "c1", status: "echouee", text: "« APK » en échec (code 1) après 3 s.", detail: "FAILURE: <Gradle>" },
      agent,
      "https://essaim.test",
    );
    expect(text).toContain("❌ <b>Lumen</b> · « APK » en échec (code 1) après 3 s.");
    expect(text).toContain("<code>FAILURE: &lt;Gradle&gt;</code>");
    expect(text).toContain('href="https://essaim.test/agents/lumen?c=c1"');
  });

  it("arrêt : annulé s'il n'est pas pris, sinon transmis au runner", async () => {
    const id = await saveAction(env.DB, "lumen", command);
    const first = await onAgent({ intent: "action-run", actionId: id });
    const [{ id: runId }] = (await handleSync(env, { machine: "mac", agents: [] })).actionRuns;
    await onAgent({ intent: "action-stop", runId });
    expect(await getActionRun(env.DB, runId)).toMatchObject({ status: "arretee" });
    expect((await handleSync(env, { machine: "mac", agents: [] })).actionRuns).toEqual([]);

    const second = await onAgent({ intent: "action-run", actionId: id });
    expect(second!.conversationId).not.toBe(first!.conversationId);
    const [{ id: run2 }] = (await handleSync(env, { machine: "mac", agents: [] })).actionRuns;
    await events([{ kind: "action_started", agentId: "lumen", actionRunId: run2, text: "" }]);
    await onAgent({ intent: "action-stop", runId: run2 });
    expect((await handleSync(env, { machine: "mac", agents: [], actionRuns: [run2] })).actionRuns).toMatchObject([{ id: run2, stop: true }]);
  });

  it("un lancement que le runner ne fait plus tourner passe en échec", async () => {
    const id = await saveAction(env.DB, "lumen", command);
    await onAgent({ intent: "action-run", actionId: id });
    const [{ id: runId }] = (await handleSync(env, { machine: "mac", agents: [] })).actionRuns;
    await events([{ kind: "action_started", agentId: "lumen", actionRunId: runId, text: "", at: new Date(Date.now() - 5 * 60_000).toISOString() }]);
    // Ancien runner (sans la liste) : rien n'est touché.
    await handleSync(env, { machine: "mac", agents: [] });
    expect(await getActionRun(env.DB, runId)).toMatchObject({ status: "en_cours" });
    await handleSync(env, { machine: "mac", agents: [], actionRuns: [] });
    expect(await getActionRun(env.DB, runId)).toMatchObject({ status: "echouee" });
  });
});

describe("consigne", () => {
  it("s'ouvre en discussion : la consigne part au runner comme un message du propriétaire", async () => {
    const id = await saveAction(env.DB, "lumen", { ...command, name: "Publier", command: null, prompt: "Publie la dernière version" });
    const { conversationId } = (await onAgent({ intent: "action-run", actionId: id }))!;
    expect(await pendingMessages(env.DB, ["lumen"])).toEqual([{ id: expect.any(String), agentId: "lumen", conversationId, text: "Publie la dernière version" }]);
    expect((await handleSync(env, { machine: "mac", agents: [] })).actionRuns).toEqual([]);
    const [conv] = await listConversations(env.DB, "lumen");
    expect(conv.actionStatus).toBe("discussion");
    // Une consigne peut se relancer tout de suite (chaque clic ouvre sa discussion).
    expect((await onAgent({ intent: "action-run", actionId: id }))!.conversationId).not.toBe(conversationId);
  });
});

describe("page des actions", () => {
  it("crée, modifie, range, lance et supprime", async () => {
    expect(await onActions({ intent: "save", name: "", kind: "command", body: "make" })).toMatchObject({ data: { error: expect.any(String) } });
    await onActions({ intent: "save", name: "Installer", kind: "command", body: "make install", timeoutMinutes: "15", confirm: "on" });
    await onActions({ intent: "save", name: "Résumer", kind: "prompt", body: "Résume les derniers changements" });
    let [install, recap] = await listActions(env.DB, "lumen");
    expect(install).toMatchObject({ name: "Installer", command: "make install", prompt: null, confirm: true, timeoutMinutes: 15 });
    expect(recap).toMatchObject({ command: null, prompt: "Résume les derniers changements", confirm: false });

    await onActions({ intent: "save", id: install.id, name: "Installer sur l'iPhone", kind: "command", body: "make ios" });
    await onActions({ intent: "down", id: install.id });
    [recap, install] = await listActions(env.DB, "lumen");
    expect(install).toMatchObject({ name: "Installer sur l'iPhone", command: "make ios", confirm: false, timeoutMinutes: null });
    expect(recap.name).toBe("Résumer");

    const launched = await onActions({ intent: "run", id: install.id });
    expect(launched).toBeInstanceOf(Response);
    expect((launched as Response).headers.get("Location")).toMatch(/^\/agents\/lumen\?c=/);

    await onActions({ intent: "delete", id: install.id });
    expect((await listActions(env.DB, "lumen")).map((a) => a.name)).toEqual(["Résumer"]);
    // L'historique du lancement reste (sa conversation).
    expect((await listConversations(env.DB, "lumen")).map((c) => c.title)).toContain("▶ Installer sur l'iPhone");
  });
});
