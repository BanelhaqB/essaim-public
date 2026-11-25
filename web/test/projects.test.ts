import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent, createTask, getAgent, getTask, tasksForAgent } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { createProject, createSpecialist, getProject, setRepoProject } from "~/.server/projects";
import { ensureRepoRow, setAgentRepos } from "~/.server/repos";
import { handleEvents, handleSync } from "~/.server/runner-api";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { env as cfEnv } from "./cloudflare-workers";
import { createTestD1 } from "./sqlite-d1";

let env: Bindings;
let project: string;

const events = (list: Array<Record<string, unknown>>) => handleEvents(env, { machine: "mac", events: list as never }, () => {});

beforeEach(async () => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100", PUBLIC_URL: "https://essaim.test" } as Bindings;
  Object.assign(cfEnv, env);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, result: { message_thread_id: 42 } })));
  const base = { machine: "mac" as const, kind: "dev" as const, hue: 10, seed: "n", settings: { ...DEFAULT_SETTINGS } };
  await createAgent(env.DB, { ...base, name: "Dev", repo: "o/api" });
  await ensureRepoRow(env.DB, "o/web");
  project = await createProject(env.DB, "Poker Tracker", "Suivi de parties.");
  await setRepoProject(env.DB, "o-api", project);
  await setRepoProject(env.DB, "o-web", project);
  await setAgentRepos(env.DB, "dev", [{ repoId: "o-api" }]);
});
afterEach(() => vi.unstubAllGlobals());

describe("spécialistes d'un projet", () => {
  it("un spécialiste est rattaché à tous les repos du projet, une seule fois, et suit les repos qui entrent ou sortent", async () => {
    const id = await createSpecialist(env.DB, project, "architect");
    expect(id).toBe("architecte-poker-tracker");
    expect(await createSpecialist(env.DB, project, "architect")).toBeNull();
    const a = await getAgent(env.DB, id!);
    expect(a).toMatchObject({ specialty: "architect", projectId: project, settings: { role: "architecte", model: "opus" } });
    expect(a?.repos.map((l) => [l.repoId, l.merge, l.deploy])).toEqual([["o-api", false, false], ["o-web", false, false]]);
    await setRepoProject(env.DB, "o-web", null);
    expect((await getAgent(env.DB, id!))?.repos.map((l) => l.repoId)).toEqual(["o-api"]);
    await setRepoProject(env.DB, "o-web", project);
    expect((await getAgent(env.DB, id!))?.repos.map((l) => l.repoId)).toEqual(["o-api", "o-web"]);
  });

  it("pas de spécialiste sans repo dans le projet", async () => {
    const empty = await createProject(env.DB, "Vide");
    expect(await createSpecialist(env.DB, empty, "po")).toBeNull();
  });

  it("la synchro donne à chaque agent le projet de son repo et ses spécialistes", async () => {
    await createSpecialist(env.DB, project, "po");
    const { agents } = await handleSync(env, { machine: "mac", agents: [] });
    const dev = agents.find((a) => a.id === "dev")!;
    expect(dev.repos[0].project).toMatchObject({ name: "Poker Tracker", brief: "Suivi de parties.", specialists: [{ specialty: "po", name: "PO Poker Tracker" }] });
    expect(agents.find((a) => a.id === "po-poker-tracker")).toMatchObject({ specialty: "po" });
  });

  it("la mémoire d'un spécialiste est unique pour le projet", async () => {
    const id = (await createSpecialist(env.DB, project, "po"))!;
    await events([{ agentId: id, repoId: "o-web", kind: "memory", text: "Décision : tout en euros." }]);
    expect((await getAgent(env.DB, id))?.memory).toBe("Décision : tout en euros.");
    const { agents } = await handleSync(env, { machine: "mac", agents: [] });
    expect(agents.find((a) => a.id === id)?.memory).toBe("Décision : tout en euros.");
  });
});

describe("consultation d'un spécialiste", () => {
  it("la question crée une tâche chez le spécialiste ; sa réponse revient dans la tâche en attente", async () => {
    const archi = (await createSpecialist(env.DB, project, "architect"))!;
    const t = await createTask(env.DB, { agentId: "dev", repoId: "o-api", title: "Ajouter les stats", status: "prete" });
    const asked = { agentId: "dev", taskId: t, kind: "needs_expert", expert: "architect", text: "Les stats vont dans l'API ou dans le web ?", at: "2026-11-25T10:00:00.000Z", run: { taskId: t, status: "needs_human" } };
    await events([asked]);
    await events([asked]); // événement rejoué : une seule tâche

    const theirs = await tasksForAgent(env.DB, archi);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ title: "Question · Ajouter les stats", status: "prete", repoId: "o-api" });
    expect(theirs[0].body).toContain("Les stats vont dans l'API ou dans le web ?");
    expect((await getTask(env.DB, t))?.status).toBe("question");

    await events([{ agentId: archi, taskId: theirs[0].id, kind: "done", text: "Dans l'API : le web ne fait qu'afficher.", run: { taskId: theirs[0].id } }]);
    const origin = await getTask(env.DB, t);
    expect(origin?.reply).toContain("Dans l'API : le web ne fait qu'afficher.");
    expect(origin?.reply).toContain("Architecte Poker Tracker");

    // Le runner reçoit la réponse à la synchro suivante et reprend la tâche.
    const { replies } = await handleSync(env, { machine: "mac", agents: [] });
    expect(replies).toEqual([expect.objectContaining({ taskId: t, agentId: "dev", reply: expect.stringContaining("Dans l'API") })]);
  });

  it("sans ce spécialiste dans le projet, aucune tâche : la question reste au propriétaire", async () => {
    const t = await createTask(env.DB, { agentId: "dev", repoId: "o-api", title: "Autre", status: "prete" });
    await events([{ agentId: "dev", taskId: t, kind: "needs_expert", expert: "ux", text: "Quelle couleur ?", at: "2026-11-25T10:00:00.000Z", run: { taskId: t } }]);
    expect((await getTask(env.DB, t))?.status).toBe("question");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE source = 'expert'").first<number>("n")).toBe(0);
  });
});
