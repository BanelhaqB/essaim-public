import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { memoryDir } from "../src/memory.mjs";
import { systemPrompt } from "../src/prompt.mjs";
import { forRepo, linkFor } from "../src/team.mjs";

const agent = {
  id: "dev",
  name: "Dev",
  repo: "o/a",
  settings: { model: "sonnet", merge: true, role: "dev" },
  repos: [
    { id: "o-a", repo: "o/a", brief: "Projet A", memory: "mémoire A", merge: true, deploy: true, store: false, access: "write", handoffTo: "rev" },
    { id: "o-b", repo: "o/b", brief: "Projet B", memory: "", merge: false, deploy: false, store: false, access: "read" },
  ],
};

test("la vue d'un agent sur un repo prend le brief, la mémoire et les droits de ce repo", () => {
  const b = forRepo(agent, "o-b");
  assert.equal(b.repo, "o/b");
  assert.equal(b.repoId, "o-b");
  assert.equal(b.brief, "Projet B");
  assert.deepEqual([b.settings.merge, b.settings.access, b.settings.model], [false, "read", "sonnet"]);
  // L'agent d'origine n'est pas modifié.
  assert.equal(agent.repo, "o/a");
  assert.equal(agent.settings.merge, true);
});

test("sans repo demandé ou inconnu, c'est le repo principal ; sans lien, l'agent tel quel", () => {
  assert.equal(forRepo(agent).repoId, "o-a");
  assert.equal(forRepo(agent, "inconnu").repo, "o/a");
  assert.equal(linkFor(agent, "o-b").repo, "o/b");
  const legacy = { id: "x", repo: "o/x", settings: {} };
  assert.equal(forRepo(legacy, "o-x"), legacy);
  assert.equal(forRepo(undefined), undefined);
});

test("la mémoire du repo principal garde le dossier historique, les autres ont le leur", () => {
  const home = path.join("h");
  assert.equal(forRepo(agent, "o-a").memoryKey, "");
  assert.equal(forRepo(agent, "o-b").memoryKey, "o-b");
  assert.equal(memoryDir(home, "dev", ""), path.join("h", "agents", "dev"));
  assert.equal(memoryDir(home, "dev", "o-b"), path.join("h", "agents", "dev", "repos", "o-b"));
  assert.equal(memoryDir(home, "dev"), path.join("h", "agents", "dev"));
});

test("le prompt reflète le repo : lecture seule, brief du repo, relais", () => {
  const onB = systemPrompt(forRepo(agent, "o-b"), "/m");
  assert.match(onB, /o\/b/);
  assert.match(onB, /LECTURE SEULE/);
  assert.match(onB, /Projet B/);
  const onA = systemPrompt(forRepo(agent, "o-a"), "/m");
  assert.doesNotMatch(onA, /LECTURE SEULE/);
  assert.match(onA, /Un coéquipier relit/);
});

const project = { id: "poker", name: "Poker Tracker", brief: "Suivi de parties.", specialists: [{ id: "poker-po", specialty: "po", name: "PO Poker" }, { id: "poker-arch", specialty: "architect", name: "Archi Poker" }] };
const inProject = {
  id: "dev",
  name: "Dev",
  settings: {},
  repos: [{ id: "o-api", repo: "o/api", brief: "API", memory: "mem api", merge: true, deploy: false, store: false, access: "write", project }],
};

test("un agent d'un projet lit le brief du projet puis celui du repo, et connaît les spécialistes", () => {
  const v = forRepo(inProject);
  assert.match(v.brief, /Projet « Poker Tracker »/);
  assert.match(v.brief, /Suivi de parties/);
  assert.match(v.brief, /Repo o\/api/);
  const p = systemPrompt(v, "/m");
  assert.match(p, /Spécialistes de ce projet/);
  assert.match(p, /po : PO Poker/);
  assert.match(p, /architect : Archi Poker/);
  assert.match(p, /needs_expert/);
});

test("un spécialiste a une seule mémoire pour tout le projet et ne se consulte pas lui-même", () => {
  const spec = { ...inProject, id: "poker-po", specialty: "po", memory: "décisions produit", repos: [...inProject.repos, { id: "o-web", repo: "o/web", brief: "", memory: "", merge: false, deploy: false, store: false, access: "write", project }] };
  const a = forRepo(spec, "o-api");
  const b = forRepo(spec, "o-web");
  assert.equal(a.memory, "décisions produit");
  assert.equal(b.memory, "décisions produit");
  assert.equal(b.memoryKey, "");
  assert.doesNotMatch(systemPrompt(a, "/m"), /Spécialistes de ce projet/);
});
