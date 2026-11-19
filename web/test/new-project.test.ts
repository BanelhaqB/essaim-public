import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent, getAgent, tasksForAgent } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { handleEvents } from "~/.server/runner-api";
import { formatEvent } from "~/.server/telegram";
import { parseRepo, repoName, usualOwner } from "~/lib/new-project";
import { DEFAULT_SETTINGS } from "~/lib/types";
import { action, loader } from "~/routes/agent-new";

import { env as cfEnv } from "./cloudflare-workers";
import { createTestD1 } from "./sqlite-d1";

let env: Bindings;

beforeEach(() => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" } as Bindings;
  Object.assign(cfEnv, env);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, result: {} })));
});
afterEach(() => vi.unstubAllGlobals());

/** Appelle l'action de /agents/nouveau avec ces champs ; renvoie la redirection ou les erreurs. */
async function submit(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const res = await action({ request: new Request("https://e/agents/nouveau", { method: "POST", body }) } as never);
  if (res instanceof Response) return { location: res.headers.get("Location") };
  return { errors: (res as { data: { errors: Record<string, string> } }).data.errors };
}

describe("nouvel agent sans repo", () => {
  it("lit le repo collé et propose un nom et un propriétaire", () => {
    expect(parseRepo("https://github.com/octo/lumen.git")).toBe("octo/lumen");
    expect(parseRepo(" octo/mon-projet/ ")).toBe("octo/mon-projet");
    expect(parseRepo("mon-projet")).toBeNull();
    expect(repoName("Salon Suivi Été")).toBe("salon-suivi-ete");
    expect(repoName("!!")).toBe("nouveau-projet");
    expect(usualOwner(["octo/a", "autre/b", "octo/c"])).toBe("octo");
    expect(usualOwner([])).toBe("");
  });

  it("le formulaire propose le propriétaire habituel", async () => {
    await createAgent(env.DB, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
    expect(await loader()).toEqual({ owner: "octo" });
  });

  it("exige une description pour un nouveau projet", async () => {
    const { errors } = await submit({ name: "Atelier", repo: "octo/atelier", fresh: "on", description: "trop court" });
    expect(errors?.description).toMatch(/Décris le projet/);
    expect(await getAgent(env.DB, "atelier")).toBeNull();
  });

  it("crée l'agent avec la demande de repo, le brief et la tâche « Initialiser le projet » prête", async () => {
    const description = "Une appli de réservation pour un salon de coiffure, avec rappels SMS.";
    const { location } = await submit({ name: "Atelier", repo: "octo/atelier", fresh: "on", description, merge: "on" });
    expect(location).toBe("/agents/atelier");
    const agent = await getAgent(env.DB, "atelier");
    expect(agent).toMatchObject({ repo: "octo/atelier", brief: description, settings: { createRepo: "private", merge: true } });
    const tasks = await tasksForAgent(env.DB, "atelier");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Initialiser le projet", status: "prete" });
    expect(tasks[0].body).toContain(description);
  });

  it("un repo existant ne demande ni description ni création", async () => {
    const { location } = await submit({ name: "Lumen", repo: "https://github.com/octo/lumen" });
    expect(location).toBe("/agents/lumen");
    const agent = await getAgent(env.DB, "lumen");
    expect(agent?.settings.createRepo).toBeUndefined();
    expect(agent?.brief).toBe("");
    expect(await tasksForAgent(env.DB, "lumen")).toHaveLength(0);
  });

  it("repo public sur demande", async () => {
    await submit({ name: "Vitrine", repo: "octo/vitrine", fresh: "on", public: "on", description: "Le site vitrine de l'atelier, une page." });
    expect((await getAgent(env.DB, "vitrine"))?.settings.createRepo).toBe("public");
  });

  it("le runner annonce le repo créé : la demande est retirée, les autres réglages restent", async () => {
    await createAgent(env.DB, { name: "Atelier", repo: "octo/atelier", machine: "mac", kind: "dev", hue: 1, seed: "a", settings: { ...DEFAULT_SETTINGS, merge: true, createRepo: "private" } });
    await handleEvents(env, { machine: "mac", events: [{ agentId: "atelier", kind: "repo_created", text: "octo/atelier" }] }, () => {});
    expect((await getAgent(env.DB, "atelier"))?.settings).toMatchObject({ merge: true });
    expect((await getAgent(env.DB, "atelier"))?.settings.createRepo).toBeUndefined();
    const agent = await getAgent(env.DB, "atelier");
    expect(formatEvent({ agentId: "atelier", kind: "repo_created", text: "octo/atelier" }, agent)).toContain("a créé le repo");
    expect(formatEvent({ agentId: "atelier", kind: "repo_ready", text: "octo/atelier" }, agent)).toBeNull();
  });
});
