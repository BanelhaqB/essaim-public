/**
 * État local du runner (runs en cours ou en attente, quota, derniers réglages reçus), dans un fichier JSON.
 * Le plan de contrôle garde l'historique ; ce fichier sert à reprendre les sessions Claude après un redémarrage
 * ou une coupure réseau.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const EMPTY = () => ({ runs: [], quota: {}, agents: [], focus: false, taskIssues: {} });

export function loadState(file) {
  if (!existsSync(file)) return EMPTY();
  try {
    return { ...EMPTY(), ...JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    console.error(`État illisible (${file}), on repart de zéro :`, error.message);
    return EMPTY();
  }
}

export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Au démarrage : un run resté « running » a été coupé par l'arrêt du runner, il est à reprendre. */
export function recoverRuns(state) {
  for (const run of state.runs) {
    if (run.status === "running") Object.assign(run, { status: "interrupted", reason: "restart" });
  }
  return state;
}
