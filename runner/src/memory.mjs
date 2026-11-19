/**
 * Mémoire d'un agent sur la machine : ~/.essaim/agents/<id>/ avec BRIEF.md (écrit par le propriétaire),
 * MEMOIRE.md (tenu par l'agent), JOURNAL.md (un résumé par tâche terminée) et ACTIONS.json (ses actions en un clic).
 * Essaim garde la version de référence : le runner écrit ces fichiers avant une session et renvoie MEMOIRE.md et
 * ACTIONS.json s'ils ont changé après.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { writeActions } from "./actions.mjs";

export const memoryDir = (home, agentId) => path.join(home, "agents", agentId);

/** Écrit les fichiers de mémoire d'après la dernière synchro. Renvoie le dossier. `keepActions` : ne pas toucher à ACTIONS.json. */
export function writeMemory(home, agent, { keepActions = false } = {}) {
  const dir = memoryDir(home, agent.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "BRIEF.md"), `${agent.brief?.trim() || "(pas encore de brief)"}\n`);
  writeFileSync(path.join(dir, "MEMOIRE.md"), `${agent.memory?.trim() ?? ""}\n`);
  const journal = (agent.journal ?? [])
    .map((j) => `## ${j.at?.slice(0, 10) ?? ""} · ${j.issueNumber ? `#${j.issueNumber} ` : ""}${j.title}\n${j.summary.trim()}`)
    .join("\n\n");
  writeFileSync(path.join(dir, "JOURNAL.md"), `# Journal des tâches terminées (les plus récentes d'abord)\n\n${journal || "(aucune)"}\n`);
  if (!keepActions) writeActions(dir, agent.actions);
  return dir;
}

/** MEMOIRE.md après une session, s'il diffère de la version connue d'Essaim ; sinon null. */
export function changedMemory(home, agent) {
  const file = path.join(memoryDir(home, agent.id), "MEMOIRE.md");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trim();
  return text && text !== (agent.memory ?? "").trim() ? text : null;
}
