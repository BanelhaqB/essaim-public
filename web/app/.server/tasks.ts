/** Pause, reprise, abandon et reprise après abandon d'une tâche commencée (page de l'agent, page de la tâche). */
import { abandonTask, getAgent, getTask, holdTask, reopenTask } from "./db";
import type { Bindings } from "./env";
import { pushLive, pushToRunner } from "./hub";

/**
 * Pause : le runner arrête la session tout de suite s'il est connecté (sinon à sa synchro) et garde le run, qui ne
 * reprend pas tant que la tâche est en pause ; l'agent passe à la suite de sa file. Reprise : le run repart dès
 * qu'une place se libère, là où il s'était arrêté.
 */
export async function pauseTask(env: Bindings, agentId: string, taskId: string, hold: boolean) {
  const task = await getTask(env.DB, taskId);
  if (task?.agentId !== agentId) return;
  if (!(await holdTask(env.DB, taskId, hold))) return;
  const agent = await getAgent(env.DB, agentId);
  if (agent) await pushToRunner(env, agent.machine, { type: "task_hold", taskId, hold });
  await pushLive(env, agentId, { type: "refresh" });
}

/** Abandon : la tâche (et ses étapes pas finies) est close, le runner arrête son run et retire son worktree. */
export async function dropTask(env: Bindings, agentId: string, taskId: string) {
  const task = await getTask(env.DB, taskId);
  if (task?.agentId !== agentId) return;
  const ids = await abandonTask(env.DB, taskId);
  const agent = await getAgent(env.DB, agentId);
  if (agent) for (const id of ids) await pushToRunner(env, agent.machine, { type: "task_abandon", taskId: id });
  await pushLive(env, agentId, { type: "refresh" });
}

/** Reprise d'une tâche abandonnée : elle repart en tête de file ; le runner se synchronise tout de suite pour la prendre. */
export async function reopenDropped(env: Bindings, agentId: string, taskId: string) {
  const task = await getTask(env.DB, taskId);
  if (task?.agentId !== agentId) return;
  if (!(await reopenTask(env.DB, taskId))) return;
  const agent = await getAgent(env.DB, agentId);
  if (agent) await pushToRunner(env, agent.machine, { type: "sync" });
  await pushLive(env, agentId, { type: "refresh" });
}
