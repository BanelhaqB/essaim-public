#!/usr/bin/env node
/**
 * Import unique des brouillons « À faire » d'un GitHub Project dans Essaim.
 * Chaque brouillon devient une tâche en brouillon : chez l'agent dont le nom correspond au champ « Projet »,
 * sinon dans la boîte de réception (/boite) pour être attribué à la main. Relancer ne crée pas de doublon.
 *
 * Usage : node --env-file=$HOME/.essaim/runner.env scripts/import-project.mjs <numéro du project> <propriétaire>
 */
import { execFileSync } from "node:child_process";

const [number, owner] = process.argv.slice(2);
if (!number || !owner) {
  console.error("Usage : scripts/import-project.mjs <numéro du project> <propriétaire> (ex. 4 mon-compte).");
  process.exit(1);
}
const { CONTROL_URL, RUNNER_TOKEN } = process.env;
if (!CONTROL_URL || !RUNNER_TOKEN) {
  console.error("CONTROL_URL et RUNNER_TOKEN sont requis (lance avec --env-file=$HOME/.essaim/runner.env).");
  process.exit(1);
}

const out = execFileSync("gh", ["project", "item-list", number, "--owner", owner, "--format", "json", "--limit", "500"], { maxBuffer: 32 * 1024 * 1024 });
const items = JSON.parse(out).items ?? [];
const drafts = items.filter((i) => i.content?.type === "DraftIssue" && (i.status ?? "") === "À faire");
const tasks = drafts.map((i) => ({ ref: i.id, title: i.title ?? i.content.title, body: i.content.body ?? "", label: i.projet ?? null }));

const res = await fetch(new URL("/api/runner/import", CONTROL_URL), {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${RUNNER_TOKEN}` },
  body: JSON.stringify({ tasks }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Import refusé (HTTP ${res.status}) :`, body.error ?? body);
  process.exit(1);
}
console.log(`${drafts.length} brouillon(s) « À faire » lus, ${body.imported} nouvelle(s) tâche(s) dans Essaim.`);
