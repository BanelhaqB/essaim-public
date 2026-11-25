import { answerTask, getAgent, listAgents } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { pushLive } from "~/.server/hub";
import { notifyEvent, type RunnerEvent } from "~/.server/telegram";
import { SPECIALISTS } from "~/lib/agent-role";
import { HANDOFF_SOURCE, planHandoff, type TeamAgent } from "~/lib/handoff";
import type { Specialty } from "~/lib/types";

export const EXPERT_SOURCE = "expert";
const isSpecialty = (v: unknown): v is Specialty => v === "po" || v === "ux" || v === "architect";

type TaskRow = { repo_id: string | null; id: string; title: string; pr_url: string | null; issue_number: number | null; source: string | null; source_ref: string | null };

/**
 * Une tâche vient de se terminer : si l'agent a un coéquipier à qui passer la main (ou s'il doit corriger après une
 * relecture), la tâche suivante est créée, prête, dans la file du bon agent. Idempotent : un événement reçu deux fois
 * ne crée qu'une tâche (index unique sur `source_ref`).
 */
export async function relay(env: Bindings, e: RunnerEvent & { verdict?: string }) {
  if (e.kind !== "done" || !e.agentId) return;
  const agent = await getAgent(env.DB, e.agentId);
  if (!agent) return;
  const taskId = e.taskId ?? e.run?.taskId ?? "";
  const task = await env.DB
    .prepare("SELECT repo_id, id, title, pr_url, issue_number, source, source_ref FROM tasks WHERE id = ?1 OR (agent_id = ?2 AND issue_number = ?3) LIMIT 1")
    .bind(taskId, e.agentId, e.run?.issueNumber ?? -1)
    .first<TaskRow>();
  if (!task) return;
  // Une consultation terminée : la réponse du spécialiste revient dans la tâche qui attendait.
  if (task.source === EXPERT_SOURCE) return deliverExpertReply(env, agent, task, String(e.text ?? ""));
  // L'équipe est celle du repo de la tâche : chaque agent y a son propre relais et ses propres allers-retours.
  const repoId = task.repo_id ?? agent.repos[0]?.repoId;
  if (!repoId) return;
  const team: TeamAgent[] = (await listAgents(env.DB)).flatMap((a) => {
    const link = a.repos.find((l) => l.repoId === repoId);
    return link ? [{ id: a.id, name: a.name, repo: repoId, settings: { role: a.settings.role, handoffTo: link.handoffTo ?? undefined, maxRounds: link.maxRounds ?? undefined } }] : [];
  });
  const self = team.find((a) => a.id === agent.id);
  if (!self) return;
  const plan = planHandoff({
    agent: self,
    task: { id: task.id, title: task.title, prUrl: task.pr_url ?? e.run?.prUrl, issueNumber: task.issue_number, source: task.source, sourceRef: task.source_ref },
    summary: String(e.text ?? ""),
    verdict: e.verdict,
    team,
  });
  if (!plan) return;
  const at = new Date().toISOString();
  if ("stop" in plan) {
    await env.DB.prepare("INSERT INTO events (agent_id, at, kind, level, text) VALUES (?1, ?2, 'handoff_stopped', 'warn', ?3)").bind(agent.id, at, plan.stop).run();
    await notifyEvent(env, { kind: "handoff_stopped", agentId: agent.id, text: plan.stop }).catch((error) => console.error("Notification :", error));
    return;
  }
  const h = plan.create;
  const max = await env.DB.prepare("SELECT MAX(position) AS p FROM tasks WHERE agent_id IS ?1").bind(h.agentId).first<number | null>("p");
  const res = await env.DB
    .prepare(
      `INSERT INTO tasks (id, agent_id, title, body, status, position, source, source_ref, pr_url, repo_id)
       VALUES (?1, ?2, ?3, ?4, 'prete', ?5, ?6, ?7, ?8, ?9) ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
    )
    .bind(crypto.randomUUID(), h.agentId, h.title.slice(0, 200), h.body, (max ?? 0) + 1, HANDOFF_SOURCE, h.sourceRef, task.pr_url ?? e.run?.prUrl ?? null, repoId)
    .run();
  if (!res.meta?.changes) return;
  const target = team.find((a) => a.id === h.agentId);
  const text = h.kind === "fix" ? `${target?.name ?? h.agentId} corrige : ${h.title.replace(/^Corriger · /, "")}` : `passe la main à ${target?.name ?? h.agentId} : ${h.title}`;
  await env.DB.prepare("INSERT INTO events (agent_id, at, kind, text) VALUES (?1, ?2, 'handoff', ?3)").bind(agent.id, at, text).run();
  await pushLive(env, h.agentId, { type: "refresh" });
  await pushLive(env, agent.id, { type: "refresh" });
  await notifyEvent(env, { kind: "handoff", agentId: agent.id, text, status: h.kind }).catch((error) => console.error("Notification :", error));
}

async function deliverExpertReply(env: Bindings, specialist: { id: string; name: string; specialty: Specialty | null }, task: TaskRow, summary: string) {
  const originId = String(task.source_ref ?? "").split(":")[0];
  if (!originId) return;
  const label = specialist.specialty ? SPECIALISTS[specialist.specialty].label : "spécialiste";
  const origin = await env.DB.prepare("SELECT agent_id FROM tasks WHERE id = ?1 AND status = 'question'").bind(originId).first<string>("agent_id");
  if (!origin) return;
  await answerTask(env.DB, originId, `Réponse de ${specialist.name} (${label}) :\n\n${summary}`);
  const text = `${specialist.name} a répondu à la question de ${origin}.`;
  await env.DB.prepare("INSERT INTO events (agent_id, at, kind, text) VALUES (?1, ?2, 'expert_replied', ?3)").bind(specialist.id, new Date().toISOString(), text).run();
  await pushLive(env, origin, { type: "refresh" });
  await notifyEvent(env, { kind: "expert_replied", agentId: specialist.id, text }).catch((error) => console.error("Notification :", error));
}

/**
 * Un agent demande l'avis d'un spécialiste du projet (po, ux, architect) : une tâche est créée chez ce spécialiste ;
 * sa réponse revient dans la tâche en attente (voir deliverExpertReply). Sans spécialiste, la question va au propriétaire.
 */
export async function routeExpert(env: Bindings, e: RunnerEvent) {
  if (e.kind !== "needs_expert" || !e.agentId) return;
  const asker = await getAgent(env.DB, e.agentId);
  if (!asker) return;
  const taskId = e.taskId ?? e.run?.taskId ?? "";
  const task = await env.DB
    .prepare("SELECT id, repo_id, title, body, issue_number, pr_url FROM tasks WHERE id = ?1 OR (agent_id = ?2 AND issue_number = ?3) LIMIT 1")
    .bind(taskId, e.agentId, e.run?.issueNumber ?? -1)
    .first<{ id: string; repo_id: string | null; title: string; body: string; issue_number: number | null; pr_url: string | null }>();
  if (!task) return;
  const repoId = task.repo_id ?? asker.repos[0]?.repoId;
  const project = asker.repos.find((l) => l.repoId === repoId)?.project;
  const expert = isSpecialty(e.expert) ? e.expert : null;
  const target = expert ? project?.specialists.find((s) => s.specialty === expert) : undefined;
  if (!expert || !target || target.id === asker.id) {
    // Pas de spécialiste pour ça : c'est au propriétaire de répondre (la tâche est déjà en question).
    await notifyEvent(env, { ...e, kind: "needs_human" }).catch((error) => console.error("Notification :", error));
    return;
  }
  const specialist = await getAgent(env.DB, target.id);
  const link = specialist?.repos.find((l) => l.repoId === repoId) ?? specialist?.repos[0];
  if (!specialist || !link) return;
  const label = SPECIALISTS[expert].label;
  const at = e.at ?? new Date().toISOString();
  const max = await env.DB.prepare("SELECT MAX(position) AS p FROM tasks WHERE agent_id IS ?1").bind(specialist.id).first<number | null>("p");
  const body = `**${asker.name}** te consulte (${label}) sur « ${task.title} »${task.issue_number ? ` (#${task.issue_number})` : ""}.${task.pr_url ? `\n\nPR : ${task.pr_url}` : ""}\n\nQuestion :\n\n${e.text}\n\nRéponds par une décision claire dans ton résumé : il est transmis tel quel à ${asker.name}, qui reprend sa tâche avec.`;
  const res = await env.DB
    .prepare(
      `INSERT INTO tasks (id, agent_id, title, body, status, position, source, source_ref, repo_id)
       VALUES (?1, ?2, ?3, ?4, 'prete', ?5, ?6, ?7, ?8) ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
    )
    .bind(crypto.randomUUID(), specialist.id, `Question · ${task.title}`.slice(0, 200), body, (max ?? 0) + 1, EXPERT_SOURCE, `${task.id}:${expert}:${at.slice(-12)}`, link.repoId)
    .run();
  if (!res.meta?.changes) return;
  const text = `${asker.name} consulte ${specialist.name} (${label}) : ${String(e.text).slice(0, 300)}`;
  await env.DB.prepare("INSERT INTO events (agent_id, at, kind, text) VALUES (?1, ?2, 'expert_asked', ?3)").bind(asker.id, at, text).run();
  await pushLive(env, specialist.id, { type: "refresh" });
  await pushLive(env, asker.id, { type: "refresh" });
  await notifyEvent(env, { kind: "expert_asked", agentId: asker.id, text }).catch((error) => console.error("Notification :", error));
}
