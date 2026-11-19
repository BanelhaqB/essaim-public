import assert from "node:assert/strict";
import { test } from "node:test";

import { newTicketPrompt, RESULT_SCHEMA, resumePrompt, systemPrompt } from "../src/prompt.mjs";

const issue = { number: 57, title: "Export PDF", url: "https://github.com/octo/lumen/issues/57", body: "Exporter le suivi." };
const git = { branch: "agent/57-export-pdf", defaultBranch: "main" };

const agent = { name: "Lumen", repo: "octo/lumen", settings: { merge: true, deploy: false, store: false }, brief: "App de suivi.", memory: "Monorepo Angular." };

test("les droits de l'agent, les garde-fous git et sa mémoire sont dans le prompt système", () => {
  const p = systemPrompt(agent, "/m");
  assert.match(p, /Merger seul quand la CI est verte : oui/);
  assert.match(p, /Déployer sur Cloudflare.*: non/);
  assert.match(p, /Ne pousse jamais directement sur la branche par défaut/);
  assert.match(p, /Closes #/);
  assert.match(p, /JALON:/);
  assert.match(p, /Aucune attribution à Claude/);
  assert.match(p, /App de suivi\./);
  assert.match(p, /Monorepo Angular\./);
  assert.match(p, /\/m\/MEMOIRE\.md/);
  assert.match(p, /explorateur/);
});

test("le prompt système ne dépend pas de la tâche : il reste en cache d'une tâche à l'autre", () => {
  assert.equal(systemPrompt(agent, "/m"), systemPrompt({ ...agent }, "/m"));
  assert.doesNotMatch(systemPrompt(agent, "/m"), /#57|agent\/57/);
});

test("premier message et reprises", () => {
  assert.match(newTicketPrompt(issue, git), /Exporter le suivi\./);
  assert.match(newTicketPrompt(issue, git), /agent\/57-export-pdf/);
  assert.match(newTicketPrompt(issue, git), /créée depuis/);
  // Tâche reprise après un abandon : la branche porte déjà du travail.
  assert.match(newTicketPrompt(issue, { ...git, existing: true }), /tâche reprise/);
  assert.match(resumePrompt("quota"), /limite d'usage/);
  assert.match(resumePrompt("reply", "Version neutre"), /Version neutre/);
  assert.match(resumePrompt("reply", ""), /remis le ticket en file/);
  assert.match(resumePrompt("restart"), /interrompue/);
});

test("schéma de la réponse finale", () => {
  assert.deepEqual(RESULT_SCHEMA.required, ["status", "summary"]);
  assert.deepEqual(RESULT_SCHEMA.properties.status.enum, ["done", "needs_human", "split"]);
});
