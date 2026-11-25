/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

const MIGRATIONS = path.join(import.meta.dirname, "..", "migrations");
const apply = (db: DatabaseSync, file: string) => db.exec(readFileSync(path.join(MIGRATIONS, file), "utf8"));

/** La base de production avant 0008 : des agents (dont deux sur le même repo) avec brief, mémoire, réglages et tâches. */
it("0008 reprend l'existant : un repo par repo, un lien par agent, les tâches rattachées", () => {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f < "0008").sort()) apply(db, f);
  const agent = db.prepare("INSERT INTO agents (id, name, seed, hue, repo, priority, settings, brief, memory, memory_at) VALUES (?, ?, 's', 1, ?, ?, ?, ?, ?, ?)");
  agent.run("lumen", "Lumen", "Octo/Lumen", 0, JSON.stringify({ merge: false, deploy: true, store: true }), "App de suivi", "Monorepo", "2026-01-01T00:00:00Z");
  agent.run("relecteur", "Relecteur", "octo/lumen", 1, JSON.stringify({ merge: true, createRepo: "public" }), "", "", null);
  agent.run("vitrine", "Vitrine", "octo/vitrine", 2, "{}", "", "", null);
  db.prepare("INSERT INTO tasks (id, agent_id, title, status, issue_number) VALUES ('t1', 'lumen', 'T', 'prete', 7)").run();
  db.prepare("INSERT INTO tasks (id, agent_id, title, status) VALUES ('t2', NULL, 'Boîte', 'brouillon')").run();

  apply(db, "0008_repos.sql");

  const repos = db.prepare("SELECT id, repo, brief, create_mode FROM repos ORDER BY id").all();
  expect(repos).toEqual([
    { id: "octo-lumen", repo: "Octo/Lumen", brief: "App de suivi", create_mode: "public" },
    { id: "octo-vitrine", repo: "octo/vitrine", brief: "", create_mode: null },
  ]);
  const links = db.prepare("SELECT agent_id, repo_id, merge, deploy, store, memory FROM agent_repos ORDER BY agent_id").all();
  expect(links).toEqual([
    { agent_id: "lumen", repo_id: "octo-lumen", merge: 0, deploy: 1, store: 1, memory: "Monorepo" },
    { agent_id: "relecteur", repo_id: "octo-lumen", merge: 1, deploy: 1, store: 0, memory: "" },
    { agent_id: "vitrine", repo_id: "octo-vitrine", merge: 1, deploy: 1, store: 0, memory: "" },
  ]);
  expect(db.prepare("SELECT id, repo_id FROM tasks ORDER BY id").all()).toEqual([
    { id: "t1", repo_id: "octo-lumen" },
    { id: "t2", repo_id: null },
  ]);
  // La même issue #7 peut maintenant exister sur deux repos d'un même agent.
  db.prepare("INSERT INTO tasks (id, agent_id, repo_id, title, status, issue_number) VALUES ('t3', 'lumen', 'octo-vitrine', 'Autre', 'prete', 7)").run();
  expect(() => db.prepare("INSERT INTO tasks (id, agent_id, repo_id, title, status, issue_number) VALUES ('t4', 'lumen', 'octo-vitrine', 'Doublon', 'prete', 7)").run()).toThrow();
});
