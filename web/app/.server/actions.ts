/** Lancer et arrêter une action en un clic (page de l'agent, page des actions). */
import { actionOpen } from "~/lib/actions";

import { addUserMessage, getAction, getActionRun, getAgent, requestActionStop, runnerActionRun, startActionRun } from "./db";
import type { Bindings } from "./env";
import { pushLive, pushToRunner } from "./hub";

/**
 * Commande : le lancement part au runner tout de suite s'il est connecté (sinon à sa synchro). Consigne : message du
 * propriétaire dans la conversation de l'action, que l'agent traite comme une discussion. Renvoie la conversation.
 */
export async function launchAction(env: Bindings, agentId: string, actionId: string): Promise<{ conversationId: string } | { error: string }> {
  const [agent, act] = await Promise.all([getAgent(env.DB, agentId), getAction(env.DB, actionId)]);
  if (!agent || act?.agentId !== agentId) return { error: "Cette action n'existe plus." };
  // Un clic de trop pendant qu'elle tourne : on montre le lancement en cours plutôt que d'en empiler un autre.
  if (act.command && act.last && actionOpen(act.last.status)) return { conversationId: act.last.conversationId };
  const run = await startActionRun(env.DB, act);
  if (act.command) {
    const created = await getActionRun(env.DB, run.id);
    if (created) await pushToRunner(env, agent.machine, { type: "action_run", ...runnerActionRun(created) });
  } else {
    const message = await addUserMessage(env.DB, agent.id, run.conversationId, act.prompt ?? act.name);
    await pushToRunner(env, agent.machine, { type: "user_message", id: message.mid, agentId: agent.id, conversationId: run.conversationId, text: message.text }, agent.id, {
      type: "message",
      conversationId: run.conversationId,
      message,
    });
  }
  // Les autres pages ouvertes de l'agent voient le lancement.
  await pushLive(env, agent.id, { type: "refresh" });
  return { conversationId: run.conversationId };
}

/** Arrêt demandé : annulé tout de suite s'il n'est pas encore pris, sinon le runner coupe la commande. */
export async function stopAction(env: Bindings, agentId: string, runId: string) {
  const run = await getActionRun(env.DB, runId);
  if (run?.agentId !== agentId || !actionOpen(run.status)) return;
  await requestActionStop(env.DB, run.id);
  const agent = await getAgent(env.DB, agentId);
  if (agent && run.status === "en_cours") await pushToRunner(env, agent.machine, { type: "action_stop", id: run.id });
  await pushLive(env, agentId, { type: "refresh" });
}
