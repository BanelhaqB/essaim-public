import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent, tasksForAgent } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { getRepo } from "~/.server/repos";
import { handleEvents } from "~/.server/runner-api";
import { formatEvent } from "~/.server/telegram";
import { parseRepo, repoName, usualOwner } from "~/lib/new-project";
import { DEFAULT_SETTINGS } from "~/lib/types";
import { action, loader } from "~/routes/repo-new";

import { env as cfEnv } from "./cloudflare-workers";
import { createTestD1 } from "./sqlite-d1";

let env: Bindings;

beforeEach(async () => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" } as Bindings;
  Object.assign(cfEnv, env);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, result: {} })));
  await createAgent(env.DB, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
});
afterEach(() => vi.unstubAllGlobals());

/** Appelle l'action de /repos/nouveau avec ces champs ; renvoie la redirection ou les erreurs. */
async function submit(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const res = await action({ request: new Request("https://e/repos/nouveau", { method: "POST", body }) } as never);
  if (res instanceof Response) return { location: res.headers.get("Location") };
  return { errors: (res as { data: { errors: Record<string, string> } }).data.errors };
}

describe("ajouter un repo", () => {
  it("lit le repo collé et propose un nom et un propriétaire", () => {
    expect(parseRepo("https://github.com/octo/lumen.git")).toBe("octo/lumen");
    expect(parseRepo(" octo/mon-projet/ ")).toBe("octo/mon-projet");
    expect(parseRepo("mon-projet")).toBeNull();
    expect(repoName("Salon Suivi Été")).toBe("salon-suivi-ete");
    expect(repoName("!!")).toBe("nouveau-projet");
    expect(usualOwner(["octo/a", "autre/b", "octo/c"])).toBe("octo");
    expect(usualOwner([])).toBe("");
  });

  it("le formulaire propose le propriétaire habituel et la liste des agents", async () => {
    expect(await loader()).toEqual({ owner: "octo", agents: [{ id: "lumen", name: "Lumen" }] });
  });

  it("refuse un repo déjà connu et un format invalide", async () => {
    expect((await submit({ repo: "octo/lumen" })).errors?.repo).toMatch(/déjà dans Essaim/);
    expect((await submit({ repo: "nimporte quoi" })).errors?.repo).toMatch(/propriétaire\/nom/);
  });

  it("exige une description et un agent pour un nouveau projet", async () => {
    const { errors } = await submit({ repo: "octo/atelier", fresh: "on", description: "trop court" });
    expect(errors?.description).toMatch(/Décris le projet/);
    expect(errors?.agent).toMatch(/Choisis l'agent/);
    expect(await getRepo(env.DB, "octo-atelier")).toBeNull();
  });

  it("crée le repo avec sa demande de création, son brief et la tâche « Initialiser le projet » prête chez l'agent", async () => {
    const description = "Une appli de réservation pour un salon de coiffure, avec rappels SMS.";
    const { location } = await submit({ repo: "octo/atelier", fresh: "on", description, agent: "lumen" });
    expect(location).toBe("/repos/octo-atelier");
    expect(await getRepo(env.DB, "octo-atelier")).toMatchObject({ repo: "octo/atelier", brief: description, createMode: "private" });
    const tasks = (await tasksForAgent(env.DB, "lumen")).filter((t) => t.repoId === "octo-atelier");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Initialiser le projet", status: "prete" });
    expect(tasks[0].body).toContain(description);
  });

  it("un repo existant ne demande ni description ni création ni agent", async () => {
    const { location } = await submit({ repo: "https://github.com/octo/vitrine" });
    expect(location).toBe("/repos/octo-vitrine");
    expect(await getRepo(env.DB, "octo-vitrine")).toMatchObject({ brief: "", createMode: null });
  });

  it("repo public sur demande", async () => {
    await submit({ repo: "octo/vitrine", fresh: "on", public: "on", description: "Le site vitrine de l'atelier, une page.", agent: "lumen" });
    expect((await getRepo(env.DB, "octo-vitrine"))?.createMode).toBe("public");
  });

  it("le runner annonce le repo créé : la demande de création est retirée", async () => {
    await submit({ repo: "octo/atelier", fresh: "on", description: "Une appli de réservation pour un salon de coiffure.", agent: "lumen" });
    await handleEvents(env, { machine: "mac", events: [{ agentId: "lumen", repoId: "octo-atelier", kind: "repo_created", text: "octo/atelier" }] }, () => {});
    expect((await getRepo(env.DB, "octo-atelier"))?.createMode).toBeNull();
    expect(formatEvent({ agentId: "lumen", kind: "repo_created", text: "octo/atelier" }, null)).toContain("a créé le repo");
    expect(formatEvent({ agentId: "lumen", kind: "repo_ready", text: "octo/atelier" }, null)).toBeNull();
  });
});
