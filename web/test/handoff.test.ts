import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgent, createTask, getAgent, tasksForAgent } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { addLink, deleteRepoRow, ensureRepoRow, removeLink, setAgentRepos, updateRepoBrief } from "~/.server/repos";
import { handleEvents, handleSync } from "~/.server/runner-api";
import { readLink } from "~/lib/agent-form";
import { applyRoleSettings } from "~/lib/agent-role";
import { baseTitle, formatRef, parseRef, planHandoff, type TeamAgent } from "~/lib/handoff";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { env as cfEnv } from "./cloudflare-workers";
import { createTestD1 } from "./sqlite-d1";

const agent = (id: string, settings: TeamAgent["settings"] = {}, repo = "o/r"): TeamAgent => ({ id, name: id.toUpperCase(), repo, settings });
const PR = "https://github.com/o/r/pull/1";

describe("planHandoff", () => {
  const dev = agent("dev", { handoffTo: "rev" });
  const rev = agent("rev", { role: "reviewer" });
  const team = [dev, rev, agent("other", {}, "x/y")];

  it("l'auteur qui termine une PR la passe au relecteur", () => {
    const plan = planHandoff({ agent: dev, task: { id: "t1", title: "Ajouter X", prUrl: PR }, summary: "Fait", team });
    expect(plan).toMatchObject({ create: { agentId: "rev", title: "Relecture · Ajouter X", kind: "fwd", round: 0 } });
    expect(plan && "create" in plan && plan.create.body).toContain(PR);
  });

  it("sans PR et sans verdict, il n'y a rien à relire", () => {
    expect(planHandoff({ agent: dev, task: { id: "t1", title: "Ajouter X" }, summary: "", team })).toBeNull();
  });

  it("sans relais réglé, ou vers un autre repo, rien ne part", () => {
    expect(planHandoff({ agent: rev, task: { id: "t1", title: "T", prUrl: PR }, summary: "", team })).toBeNull();
    expect(planHandoff({ agent: { ...dev, settings: { handoffTo: "other" } }, task: { id: "t1", title: "T", prUrl: PR }, summary: "", team })).toBeNull();
  });

  it("des corrections demandées reviennent à l'auteur d'origine, puis la boucle s'arrête à la limite", () => {
    const fwd = { id: "t2", title: "Relecture · Ajouter X", prUrl: PR, source: "handoff", sourceRef: formatRef({ from: "t1", to: "rev", origin: "dev", round: 0, kind: "fwd" }) };
    const back = planHandoff({ agent: rev, task: fwd, summary: "Manque un test", verdict: "changes_requested", team });
    expect(back).toMatchObject({ create: { agentId: "dev", title: "Corriger · Ajouter X", kind: "fix", round: 1 } });

    const last = { ...fwd, sourceRef: formatRef({ from: "t9", to: "rev", origin: "dev", round: 3, kind: "fwd" }) };
    const stop = planHandoff({ agent: rev, task: last, summary: "Encore", verdict: "changes_requested", team });
    expect(stop).toMatchObject({ stop: expect.stringContaining("3 allers-retours") });
  });

  it("une approbation passe à l'étape suivante seulement si elle est réglée", () => {
    const chain = [dev, agent("rev", { role: "reviewer", handoffTo: "qa" }), agent("qa", { role: "testeur" })];
    const task = { id: "t2", title: "Relecture · X", source: "handoff", sourceRef: formatRef({ from: "t1", to: "rev", origin: "dev", round: 0, kind: "fwd" }) };
    expect(planHandoff({ agent: chain[1], task, summary: "OK", verdict: "approved", team: chain })).toMatchObject({ create: { agentId: "qa", title: "Tests · X" } });
    expect(planHandoff({ agent: rev, task, summary: "OK", verdict: "approved", team })).toBeNull();
  });

  it("la référence se relit et les préfixes se retirent", () => {
    expect(parseRef(formatRef({ from: "a", to: "b", origin: "c", round: 2, kind: "fix" }))).toEqual({ from: "a", to: "b", origin: "c", round: 2, kind: "fix" });
    expect(parseRef("n'importe quoi")).toBeNull();
    expect(baseTitle("Corriger · Relecture · X")).toBe("Relecture · X");
  });
});

describe("droits par repo", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  it("readLink n'accepte qu'un coéquipier connu, borne les tours et lit les droits", () => {
    const l = readLink(form({ "p:merge": "on", "p:access": "read", "p:handoffTo": "rev", "p:maxRounds": "99" }), "p:", "o-r", ["rev"]);
    expect(l).toEqual({ repoId: "o-r", access: "read", merge: true, deploy: false, store: false, handoffTo: "rev", maxRounds: 10 });
    expect(readLink(form({ "p:handoffTo": "inconnu" }), "p:", "o-r", ["rev"]).handoffTo).toBeNull();
  });

  it("applyRoleSettings retire un champ vidé et ignore une valeur invalide", () => {
    const s = applyRoleSettings({ role: "dev" }, form({ model: "haiku", effort: "nope" }));
    expect(s).toMatchObject({ model: "haiku" });
    expect(s.role).toBeUndefined();
    expect(s.effort).toBeUndefined();
  });
});

describe("relais de bout en bout", () => {
  let env: Bindings;
  beforeEach(async () => {
    env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100", PUBLIC_URL: "https://essaim.test" } as Bindings;
    Object.assign(cfEnv, env);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, result: { message_thread_id: 42 } })));
    const base = { repo: "o/r", machine: "mac" as const, kind: "dev" as const, hue: 10, seed: "n" };
    await createAgent(env.DB, { ...base, name: "Dev", settings: { ...DEFAULT_SETTINGS, role: "dev" } });
    await createAgent(env.DB, { ...base, name: "Rev", settings: { ...DEFAULT_SETTINGS, role: "reviewer" } });
    // Le relais est un réglage du lien agent × repo.
    await setAgentRepos(env.DB, "dev", [{ repoId: "o-r", handoffTo: "rev", maxRounds: 2 }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  const done = (agentId: string, taskId: string, extra: Record<string, unknown> = {}) =>
    handleEvents(env, { machine: "mac", events: [{ kind: "done", agentId, taskId, text: "Résumé", run: { taskId, issueNumber: 1, prUrl: PR }, ...extra }] as never }, () => {});

  it("dev → relecture → corrections → relecture, sans doublon", async () => {
    const t1 = await createTask(env.DB, { agentId: "dev", title: "Ajouter X", status: "prete" });
    await done("dev", t1);
    await done("dev", t1); // événement rejoué : pas de seconde tâche
    let rev = await tasksForAgent(env.DB, "rev");
    expect(rev.map((t) => [t.title, t.status])).toEqual([["Relecture · Ajouter X", "prete"]]);
    const first = rev[0];

    await done("rev", first.id, { verdict: "changes_requested", text: "Manque un test" });
    let dev = await tasksForAgent(env.DB, "dev");
    const fix = dev.find((t) => t.title === "Corriger · Ajouter X");
    expect(fix?.status).toBe("prete");
    expect(fix?.body).toContain("Manque un test");

    // L'auteur corrige : la PR repart en relecture.
    await done("dev", fix!.id);
    rev = await tasksForAgent(env.DB, "rev");
    expect(rev).toHaveLength(2);
    const second = rev.find((t) => t.id !== first.id)!;

    // 2e demande de corrections (limite 2) : encore autorisée, la 3e s'arrête.
    await done("rev", second.id, { verdict: "changes_requested", text: "Encore" });
    dev = await tasksForAgent(env.DB, "dev");
    expect(dev.filter((t) => t.title === "Corriger · Ajouter X")).toHaveLength(2);
  });
});

describe("un agent sur plusieurs repos", () => {
  let env: Bindings;
  beforeEach(async () => {
    env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100", PUBLIC_URL: "https://essaim.test" } as Bindings;
    Object.assign(cfEnv, env);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, result: { message_thread_id: 42 } })));
    const base = { machine: "mac" as const, kind: "dev" as const, hue: 10, seed: "n" };
    await createAgent(env.DB, { ...base, repo: "o/a", name: "Dev", settings: { ...DEFAULT_SETTINGS } });
    await createAgent(env.DB, { ...base, repo: "o/b", name: "Rev", settings: { ...DEFAULT_SETTINGS } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("chaque repo a son brief, sa mémoire et ses droits ; la synchro les envoie tous", async () => {
    await ensureRepoRow(env.DB, "o/b");
    await setAgentRepos(env.DB, "dev", [{ repoId: "o-a", merge: true }, { repoId: "o-b", merge: false, access: "read" }]);
    await updateRepoBrief(env.DB, "o-b", "Projet B");
    const [dev] = (await handleSync(env, { machine: "mac", agents: [] })).agents.filter((a) => a.id === "dev");
    expect(dev.repos.map((r) => [r.id, r.merge, r.access])).toEqual([["o-a", true, "write"], ["o-b", false, "read"]]);
    expect(dev.repos[1].brief).toBe("Projet B");
    expect(dev.repo).toBe("o/a");
  });

  it("la tâche garde son repo, et le relais reste dans l'équipe de ce repo", async () => {
    await setAgentRepos(env.DB, "dev", [{ repoId: "o-a" }, { repoId: "o-b", handoffTo: "rev" }]);
    const t = await createTask(env.DB, { agentId: "dev", repoId: "o-b", title: "Sur B", status: "prete" });
    expect((await tasksForAgent(env.DB, "dev"))[0].repoId).toBe("o-b");
    await handleEvents(env, { machine: "mac", events: [{ kind: "done", agentId: "dev", taskId: t, text: "ok", run: { taskId: t, prUrl: PR } }] as never }, () => {});
    const rev = await tasksForAgent(env.DB, "rev");
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ title: "Suite · Sur B", repoId: "o-b" });
    // Sur le repo A, personne ne reçoit rien : le relais est un droit du repo B.
    const a = await createTask(env.DB, { agentId: "dev", repoId: "o-a", title: "Sur A", status: "prete" });
    await handleEvents(env, { machine: "mac", events: [{ kind: "done", agentId: "dev", taskId: a, text: "ok", run: { taskId: a, prUrl: PR } }] as never }, () => {});
    expect(await tasksForAgent(env.DB, "rev")).toHaveLength(1);
  });

  it("un agent ne peut pas quitter son dernier repo, ni un repo être supprimé avec une équipe", async () => {
    expect(await removeLink(env.DB, "dev", "o-a")).toBe(false);
    expect(await deleteRepoRow(env.DB, "o-a")).toBe(false);
    await addLink(env.DB, "dev", "o-b");
    expect(await removeLink(env.DB, "dev", "o-a")).toBe(true);
    expect((await getAgent(env.DB, "dev"))?.repo).toBe("o/b");
    expect(await deleteRepoRow(env.DB, "o-a")).toBe(true);
  });
});
