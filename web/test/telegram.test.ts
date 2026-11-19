import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent, getAgent, getSetting, setSetting } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { parseTopicLink, resolveTopic, saveTopic, send, topicLink } from "~/.server/telegram";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { createTestD1 } from "./sqlite-d1";

describe("lien d'un sujet Telegram", () => {
  it("lit les formes que Telegram copie", () => {
    expect(parseTopicLink("https://t.me/c/1234567890/42")).toEqual({ ok: true, thread: 42, chat: "-1001234567890" });
    expect(parseTopicLink("t.me/c/1234567890/42/317")).toEqual({ ok: true, thread: 42, chat: "-1001234567890" });
    expect(parseTopicLink("https://t.me/c/1234567890/317?thread=42")).toEqual({ ok: true, thread: 42, chat: "-1001234567890" });
    expect(parseTopicLink("https://t.me/mon_groupe/42")).toEqual({ ok: true, thread: 42, chat: undefined });
    expect(parseTopicLink(" 42 ")).toEqual({ ok: true, thread: 42, chat: undefined });
    expect(parseTopicLink("")).toEqual({ ok: true, thread: null });
  });

  it("refuse le reste, et le sujet Général", () => {
    for (const bad of ["https://example.com/c/1/42", "https://t.me/c/abc/42", "https://t.me/c/123", "pas un lien", "0"]) {
      expect(parseTopicLink(bad).ok).toBe(false);
    }
    expect(parseTopicLink("https://t.me/c/1234567890/1")).toMatchObject({ ok: false, error: expect.stringContaining("Général") });
  });

  it("reconstruit le lien pour l'affichage", () => {
    expect(topicLink("-1001234567890", 42)).toBe("https://t.me/c/1234567890/42");
    expect(topicLink(null, 42)).toBe("42");
    expect(topicLink("-1001234567890", null)).toBe("");
  });
});

describe("sujet d'un agent", () => {
  let env: Bindings;
  let calls: Array<{ method: string; body: Record<string, unknown> }>;
  let refuseThreads = false;

  beforeEach(async () => {
    env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "t" } as Bindings;
    calls = [];
    refuseThreads = false;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const method = url.split("/").pop()!;
      const body = JSON.parse(String(init.body));
      calls.push({ method, body });
      if (refuseThreads && body.message_thread_id) return Response.json({ ok: false, description: "Bad Request: message thread not found" });
      return Response.json({ ok: true, result: method === "createForumTopic" ? { message_thread_id: 99 } : {} });
    });
    await createAgent(env.DB, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
  });

  it("sans groupe choisi, celui du lien le devient", async () => {
    const topic = await resolveTopic(env, "https://t.me/c/1234567890/42");
    expect(topic.ok).toBe(true);
    if (topic.ok) await saveTopic(env, "lumen", topic);
    expect(await getSetting(env.DB, "telegram_chat")).toBe("-1001234567890");
    expect((await getAgent(env.DB, "lumen"))?.telegramTopic).toBe(42);
  });

  it("refuse un sujet d'un autre groupe", async () => {
    await setSetting(env.DB, "telegram_chat", "-1009999");
    expect(await resolveTopic(env, "https://t.me/c/1234567890/42")).toMatchObject({ ok: false });
    expect(await resolveTopic(env, "https://t.me/c/9999/42")).toMatchObject({ ok: true, thread: 42 });
  });

  it("le message part dans le sujet donné, sans en créer", async () => {
    await setSetting(env.DB, "telegram_chat", "-1009999");
    await saveTopic(env, "lumen", { thread: 42 });
    await send(env, "Bonjour", await getAgent(env.DB, "lumen"));
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(calls[0].body).toMatchObject({ chat_id: "-1009999", message_thread_id: 42 });
  });

  it("sujet introuvable : le message part dans Général plutôt que de se perdre", async () => {
    await setSetting(env.DB, "telegram_chat", "-1009999");
    await saveTopic(env, "lumen", { thread: 42 });
    refuseThreads = true;
    await send(env, "Bonjour", await getAgent(env.DB, "lumen"));
    expect(calls.map((c) => c.body.message_thread_id)).toEqual([42, undefined]);
  });
});
