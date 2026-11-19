/**
 * API des runners (runner/src/control.mjs) : POST /api/runner/sync et POST /api/runner/events.
 * Authentification : Authorization: Bearer RUNNER_TOKEN.
 *
 * La synchro renvoie, pour chaque agent de la machine, sa file de tâches prêtes (dans l'ordre choisi dans Essaim),
 * les opérations GitHub à faire (créer ou mettre à jour l'issue miroir d'une tâche) et les réponses écrites dans Essaim.
 */
import { actionsByAgent, activeOverride, getFocus, listActions, pendingActionRuns, replaceActionsStatements, journalFor, listAgents, markDelivered, pendingMessages, taskConversationStatement, taskQuestionStatements } from "./db";
import { pushLive } from "./hub";
import type { Bindings } from "./env";
import { machineLabel, type MachineResources } from "~/lib/machine";
import { notifyEvent, send, type RunnerEvent } from "./telegram";

const MAX_TEXT = 2000;
/** Lignes de journal gardées au total (les plus anciennes sont effacées). */
const KEEP_LOGS = 20_000;
const RUN_STATUSES = new Set(["running", "interrupted", "needs_human", "done", "failed"]);

export function authorizedRunner(request: Request, token?: string) {
  if (!token || token.length < 32) return false;
  const given = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${token}`;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

interface SyncBody {
  machine: string;
  version?: string;
  capacity?: number;
  baseCapacity?: number;
  running?: number;
  chats?: number;
  resources?: MachineResources | null;
  quota?: Record<string, unknown>;
  /** Lancements d'actions qui tournent sur la machine (runner récent ; absent : rien à vérifier). */
  actionRuns?: string[];
  agents?: Array<{ id: string; status: string; runId?: string; issueNumber?: number; issueTitle?: string; waitingHuman?: number[]; ready?: number; retryAt?: number }>;
}

export async function handleSync(env: Bindings, body: SyncBody) {
  const machine = String(body.machine || "").slice(0, 20);
  if (!machine) throw new Response("machine manquante", { status: 400 });
  const at = new Date().toISOString();
  const previous = await env.DB.prepare("SELECT offline_notified, capacity_override, capacity_until FROM machines WHERE name = ?1")
    .bind(machine)
    .first<{ offline_notified: number; capacity_override: number | null; capacity_until: string | null }>();
  const override = previous ? activeOverride(previous) : null;
  const expired = previous?.capacity_override != null && !override;
  const statements = [
    env.DB.prepare(
      `INSERT INTO machines (name, last_seen, version, capacity, base_capacity, resources, quota, offline_notified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
       ON CONFLICT (name) DO UPDATE SET last_seen = excluded.last_seen, version = excluded.version, capacity = excluded.capacity,
         base_capacity = excluded.base_capacity, resources = COALESCE(excluded.resources, machines.resources), quota = excluded.quota, offline_notified = 0`,
    ).bind(machine, at, body.version ?? null, body.capacity ?? null, body.baseCapacity ?? body.capacity ?? null, resourcesJson(body), JSON.stringify(body.quota ?? {})),
  ];
  // Réglage ponctuel arrivé à échéance : on l'efface, le runner revient à CAPACITY.
  if (expired) statements.push(env.DB.prepare("UPDATE machines SET capacity_override = NULL, capacity_until = NULL WHERE name = ?1").bind(machine));
  for (const a of body.agents ?? []) {
    const { id, status, ...detail } = a;
    statements.push(
      env.DB.prepare("UPDATE agents SET status = ?2, status_detail = ?3, status_at = ?4 WHERE id = ?1 AND machine = ?5").bind(id, String(status), JSON.stringify(detail), at, machine),
    );
  }
  await env.DB.batch(statements);
  await closeLostActionRuns(env, machine, body.actionRuns, at);
  if (expired) await send(env, `⏱️ ${machineLabel(machine)} : le réglage de places a expiré, retour à ${body.baseCapacity ?? body.capacity ?? "?"} place(s).`);
  if (previous?.offline_notified === 1) await send(env, `☀️ ${machine === "mac" ? "Le Mac" : `La machine ${machine}`} répond de nouveau.`);

  const agents = (await listAgents(env.DB)).filter((a) => a.machine === machine);
  const ids = agents.map((a) => a.id);
  const tasks = ids.length
    ? (
        await env.DB.prepare(
          `SELECT id, agent_id, parent_id, title, body, status, issue_number, issue_url, gh_dirty, reply,
             (SELECT p.issue_number FROM tasks p WHERE p.id = tasks.parent_id) AS parent_issue FROM tasks
           WHERE agent_id IN (SELECT value FROM json_each(?1))
             AND (status = 'prete' OR gh_dirty = 1 OR (status = 'question' AND reply IS NOT NULL))
           ORDER BY position, created_at`,
        )
          .bind(JSON.stringify(ids))
          .all<TaskSyncRow>()
      ).results
    : [];
  const brief = (t: TaskSyncRow) => ({ id: t.id, title: t.title, body: t.body, issueNumber: t.issue_number, issueUrl: t.issue_url, parentIssueNumber: t.parent_issue });
  const journals = Object.fromEntries(await Promise.all(agents.map(async (a) => [a.id, await journalFor(env.DB, a.id, 30)] as const)));
  const actions = await actionsByAgent(env.DB, ids);
  // Tâches mises en pause : le runner arrête leur run et ne le reprend pas (liste complète à chaque synchro).
  const held = ids.length
    ? (
        await env.DB.prepare("SELECT id FROM tasks WHERE status = 'en_pause' AND agent_id IN (SELECT value FROM json_each(?1))")
          .bind(JSON.stringify(ids))
          .all<{ id: string }>()
      ).results.map((r) => r.id)
    : [];
  return {
    focus: await getFocus(env.DB),
    capacityOverride: override ? { capacity: override.capacity, until: override.until ? Date.parse(override.until) : null } : null,
    agents: agents.map(({ id, name, repo, machine: m, kind, paused, priority, settings, brief: b, memory, memoryAt }) => ({
      id,
      name,
      repo,
      machine: m,
      kind,
      paused,
      priority,
      settings,
      brief: b,
      memory,
      memoryAt,
      journal: journals[id],
      // ACTIONS.json de l'agent (sans l'historique des lancements).
      actions: (actions[id] ?? []).map(({ id: actionId, name: n, description, command, prompt, confirm, timeoutMinutes }) => ({
        id: actionId,
        name: n,
        description,
        ...(command ? { command } : { prompt }),
        ...(confirm ? { confirm } : {}),
        ...(timeoutMinutes ? { timeoutMinutes } : {}),
      })),
      queue: tasks.filter((t) => t.agent_id === id && t.status === "prete").map(brief),
    })),
    github: tasks
      .filter((t) => (t.status === "prete" && t.issue_number == null) || (t.gh_dirty === 1 && t.issue_number != null))
      .map((t) => ({ ...brief(t), agentId: t.agent_id, status: t.status, action: t.issue_number == null ? "create" : "update" })),
    abandoned: (
      await env.DB.prepare(
        "SELECT id FROM tasks WHERE status = 'abandonnee' AND run_id IS NOT NULL AND agent_id IN (SELECT value FROM json_each(?1)) AND updated_at > ?2",
      )
        .bind(JSON.stringify(ids), new Date(Date.now() - 7 * 86_400_000).toISOString())
        .all<{ id: string }>()
    ).results.map((r) => r.id),
    held,
    messages: await pendingMessages(env.DB, ids),
    actionRuns: await pendingActionRuns(env.DB, ids),
    replies: tasks.filter((t) => t.status === "question" && t.reply != null).map((t) => ({ taskId: t.id, agentId: t.agent_id, issueNumber: t.issue_number, reply: t.reply })),
  };
}

/** Ressources relevées par le runner, avec ses runs en cours ; JSON borné (null : rien de reçu, on garde l'ancien relevé). */
function resourcesJson(body: SyncBody) {
  const r = body.resources;
  if (!r || typeof r !== "object") return null;
  const json = JSON.stringify({ ...r, runsRss: Array.isArray(r.runsRss) ? r.runsRss.slice(0, 32) : [], running: body.running ?? null, chats: body.chats ?? null });
  return json.length <= 4000 ? json : null;
}

type TaskSyncRow = {
  id: string;
  parent_id: string | null;
  parent_issue: number | null;
  agent_id: string;
  title: string;
  body: string;
  status: string;
  issue_number: number | null;
  issue_url: string | null;
  gh_dirty: number;
  reply: string | null;
};

/** La tâche d'un événement : par son identifiant, ou par son issue pour les runs d'avant les tâches. */
function taskStatement(env: Bindings, e: RunnerEvent & { taskId?: string }, sql: string, ...values: unknown[]) {
  const n = values.length;
  return env.DB.prepare(`${sql} WHERE (id = ?${n + 1} OR (agent_id = ?${n + 2} AND issue_number = ?${n + 3}))`).bind(
    ...values,
    e.taskId ?? e.run?.taskId ?? "",
    e.agentId ?? "",
    e.run?.issueNumber ?? -1,
  );
}

/** Ce que change un événement du runner sur la tâche concernée. */
function taskUpdate(env: Bindings, e: RunnerEvent & { taskId?: string; issueNumber?: number; issueUrl?: string }, at: string) {
  const run = e.run as { id?: string; prUrl?: string; summary?: string } | undefined;
  switch (e.kind) {
    case "task_issue":
      return env.DB.prepare("UPDATE tasks SET issue_number = ?2, issue_url = ?3, gh_dirty = 0 WHERE id = ?1").bind(e.taskId ?? "", e.issueNumber ?? null, e.issueUrl ?? null);
    case "task_synced":
      return env.DB.prepare("UPDATE tasks SET gh_dirty = 0 WHERE id = ?1").bind(e.taskId ?? "");
    case "started":
      return taskStatement(env, e, "UPDATE tasks SET status = 'en_cours', run_id = ?1, question = NULL, reply = NULL, updated_at = ?2", run?.id ?? null, at);
    case "resumed":
      return taskStatement(env, e, "UPDATE tasks SET status = 'en_cours', question = NULL, reply = NULL, updated_at = ?1", at);
    case "needs_human":
      return taskStatement(env, e, "UPDATE tasks SET status = 'question', question = ?1, reply = NULL, pr_url = COALESCE(?2, pr_url), updated_at = ?3", String(e.text).slice(0, MAX_TEXT), run?.prUrl ?? null, at);
    case "done":
      return taskStatement(env, e, "UPDATE tasks SET status = 'terminee', summary = ?1, pr_url = COALESCE(?2, pr_url), question = NULL, reply = NULL, updated_at = ?3", String(e.text).slice(0, MAX_TEXT), run?.prUrl ?? null, at);
    default:
      return null;
  }
}

export async function handleEvents(env: Bindings, body: { machine?: string; events?: RunnerEvent[] }, waitUntil: (p: Promise<unknown>) => void) {
  const events = (body.events ?? []).slice(0, 200);
  const statements: D1PreparedStatement[] = [];
  const notify: RunnerEvent[] = [];
  const refresh = new Set<string>();
  const acked: string[] = [];
  for (const e of events) {
    const at = e.at ?? new Date().toISOString();
    // Fil de conversation : rangé dans messages, pas dans le journal.
    if (e.kind === "msg" && e.agentId && e.conversationId) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO messages (conversation_id, agent_id, role, level, text, mid, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING",
        ).bind(e.conversationId, e.agentId, String(e.role ?? "agent").slice(0, 10), e.level ?? null, String(e.text ?? "").slice(0, 20_000), e.mid ?? null, at),
        env.DB.prepare("UPDATE conversations SET updated_at = ?2 WHERE id = ?1").bind(e.conversationId, at),
      );
      continue;
    }
    if (e.kind === "memory" && e.agentId) {
      statements.push(env.DB.prepare("UPDATE agents SET memory = ?2, memory_at = ?3 WHERE id = ?1").bind(e.agentId, String(e.text ?? "").slice(0, 60_000), at));
      continue;
    }
    if (e.kind === "usage" && e.agentId && e.usage) {
      const u = e.usage;
      statements.push(
        env.DB.prepare("INSERT INTO usage (agent_id, task_id, conversation_id, at, input, cache_read, cache_write, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(
          e.agentId,
          e.taskId ?? null,
          e.conversationId ?? null,
          at,
          u.input ?? 0,
          u.cacheRead ?? 0,
          u.cacheWrite ?? 0,
          u.output ?? 0,
        ),
      );
      continue;
    }
    if (e.kind === "split" && e.agentId && e.taskId && Array.isArray(e.steps)) {
      statements.push(...(await splitStatements(env, e.agentId, e.taskId, e.steps, at)));
      if (e.runId) statements.push(env.DB.prepare("UPDATE runs SET status = 'done', summary = ?2, updated_at = ?3, ended_at = ?3 WHERE id = ?1").bind(e.runId, `Découpée : ${e.text}`, at));
      refresh.add(e.agentId);
      notify.push(e);
      continue;
    }
    // ACTIONS.json modifié par l'agent : sa liste remplace celle d'Essaim.
    if (e.kind === "actions" && e.agentId) {
      statements.push(...replaceActionsStatements(env.DB, e.agentId, await listActions(env.DB, e.agentId), e.actions, at));
      refresh.add(e.agentId);
      continue;
    }
    if (e.kind === "action_started" && e.actionRunId) {
      statements.push(env.DB.prepare("UPDATE action_runs SET status = 'en_cours', started_at = ?2 WHERE id = ?1 AND status = 'demandee'").bind(e.actionRunId, at));
      if (e.agentId) refresh.add(e.agentId);
      continue;
    }
    if (e.kind === "action_ended" && e.actionRunId) {
      const status = ["reussie", "echouee", "arretee"].includes(String(e.status)) ? String(e.status) : "echouee";
      statements.push(
        env.DB.prepare("UPDATE action_runs SET status = ?2, exit_code = ?3, ended_at = ?4, started_at = COALESCE(started_at, ?4) WHERE id = ?1").bind(
          e.actionRunId,
          status,
          Number.isInteger(e.exitCode) ? e.exitCode : null,
          at,
        ),
      );
      if (e.agentId) refresh.add(e.agentId);
      notify.push({ ...e, status });
      continue;
    }
    if (e.kind === "msg_ack") {
      acked.push(...(e.ids ?? []).map(String));
      continue;
    }
    if (e.kind === "conversation" && e.agentId && e.conversationId && e.sessionId) {
      statements.push(env.DB.prepare("UPDATE conversations SET session_id = ?2 WHERE id = ?1 AND agent_id = ?3").bind(e.conversationId, e.sessionId, e.agentId));
      continue;
    }
    // Repo du nouveau projet créé par le runner : on ne le lui redemande plus.
    if ((e.kind === "repo_created" || e.kind === "repo_ready") && e.agentId) {
      statements.push(env.DB.prepare("UPDATE agents SET settings = json_remove(settings, '$.createRepo') WHERE id = ?1").bind(e.agentId));
    }
    statements.push(
      env.DB.prepare("INSERT INTO events (agent_id, run_id, at, kind, level, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(
        e.agentId ?? null,
        e.runId ?? null,
        at,
        String(e.kind).slice(0, 30),
        e.level ?? null,
        String(e.text ?? "").slice(0, MAX_TEXT),
      ),
    );
    const run = e.run as (RunnerEvent["run"] & { id?: string; status?: string; reason?: string; sessionId?: string; startedAt?: string }) | undefined;
    if (run?.id && e.agentId && run.status && RUN_STATUSES.has(run.status)) {
      const ended = run.status === "done" || run.status === "failed" ? at : null;
      const question = e.kind === "needs_human" ? String(e.text).slice(0, MAX_TEXT) : null;
      statements.push(
        env.DB.prepare(
          `INSERT INTO runs (id, agent_id, issue_number, issue_title, issue_url, status, reason, session_id, pr_url, summary, question, started_at, updated_at, ended_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status, reason = excluded.reason, session_id = COALESCE(excluded.session_id, runs.session_id),
             pr_url = COALESCE(excluded.pr_url, runs.pr_url), summary = COALESCE(excluded.summary, runs.summary),
             question = CASE WHEN excluded.status = 'needs_human' THEN COALESCE(excluded.question, runs.question) ELSE NULL END,
             updated_at = excluded.updated_at, ended_at = excluded.ended_at`,
        ).bind(
          run.id,
          e.agentId,
          run.issueNumber ?? null,
          run.issueTitle ?? null,
          run.issueUrl ?? null,
          run.status,
          run.reason ?? null,
          run.sessionId ?? null,
          run.prUrl ?? null,
          run.summary ?? null,
          question,
          run.startedAt ?? at,
          at,
          ended,
        ),
      );
    }
    const task = taskUpdate(env, e, at);
    if (task) statements.push(task);
    const taskId = e.taskId ?? e.run?.taskId;
    if (e.kind === "started" && taskId && e.agentId) statements.push(taskConversationStatement(env.DB, taskId, e.agentId, String(e.run?.issueTitle ?? e.text).slice(0, 200), at));
    if (e.kind === "needs_human" && e.agentId) {
      const text = String(e.text ?? "").slice(0, MAX_TEXT);
      statements.push(...taskQuestionStatements(env.DB, { taskId: taskId ?? "", agentId: e.agentId, issueNumber: e.run?.issueNumber ?? -1, text, mid: `q:${e.runId ?? taskId}:${at}`, at }));
    }
    if (e.agentId && e.kind !== "log") refresh.add(e.agentId);
    if (e.kind !== "log" && !e.kind.startsWith("task_")) notify.push(e);
  }
  if (statements.length) await env.DB.batch(statements);
  if (acked.length) await markDelivered(env.DB, acked);
  // Une tâche découpée se termine avec sa dernière étape.
  for (const e of events.filter((x) => x.kind === "done")) await closeParent(env, e.taskId ?? e.run?.taskId);
  if (Math.random() < 0.05) {
    await env.DB.prepare("DELETE FROM events WHERE kind = 'log' AND id <= (SELECT MAX(id) - ?1 FROM events)").bind(KEEP_LOGS).run();
  }
  waitUntil(
    (async () => {
      // Les pages ouvertes de ces agents se rechargent (statut, file, questions).
      for (const agentId of refresh) await pushLive(env, agentId, { type: "refresh" });
      for (const e of notify) await notifyEvent(env, e).catch((error) => console.error("Notification :", error));
    })(),
  );
  return { stored: events.length };
}

/**
 * Lancements « en cours » que le runner ne fait plus tourner (redémarrage, état perdu) : en échec. On laisse 2 min
 * au runner pour envoyer la fin d'un lancement qui vient de se terminer (son événement corrige alors le statut).
 */
async function closeLostActionRuns(env: Bindings, machine: string, running: string[] | undefined, at: string) {
  if (!Array.isArray(running)) return;
  const limit = new Date(Date.parse(at) - 2 * 60_000).toISOString();
  await env.DB.prepare(
    `UPDATE action_runs SET status = 'echouee', ended_at = ?3 WHERE status = 'en_cours' AND started_at < ?4
       AND id NOT IN (SELECT value FROM json_each(?2)) AND agent_id IN (SELECT id FROM agents WHERE machine = ?1)`,
  )
    .bind(machine, JSON.stringify(running.map(String).slice(0, 100)), at, limit)
    .run();
}

/** Cron : prévenir une fois quand une machine ne répond plus depuis 10 minutes. */
export async function checkMachines(env: Bindings, at = Date.now()) {
  const limit = new Date(at - 10 * 60_000).toISOString();
  const { results } = await env.DB.prepare("SELECT name, last_seen FROM machines WHERE last_seen < ?1 AND offline_notified = 0").bind(limit).all<{ name: string; last_seen: string }>();
  for (const m of results) {
    const since = new Date(m.last_seen).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
    await send(env, `💤 ${m.name === "mac" ? "Le Mac" : `La machine ${m.name}`} ne répond plus depuis ${since}. Ses agents sont à l'arrêt (veille, réseau ou runner coupé).`);
    await env.DB.prepare("UPDATE machines SET offline_notified = 1 WHERE name = ?1").bind(m.name).run();
  }
}

/**
 * Import de tâches (runner/scripts/import-project.mjs) : brouillons du Project 4, déposés dans la boîte de réception,
 * ou directement chez l'agent dont le nom correspond au champ « Projet ». Un élément déjà importé est ignoré.
 */
export async function handleImport(env: Bindings, body: { tasks?: Array<{ ref: string; title: string; body?: string; label?: string }> }) {
  const agents = await listAgents(env.DB);
  const norm = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  let imported = 0;
  for (const t of (body.tasks ?? []).slice(0, 500)) {
    if (!t.ref || !t.title) continue;
    const agent = t.label ? agents.find((a) => norm(a.name) === norm(t.label!) || norm(a.repo.split("/")[1] ?? "") === norm(t.label!)) : undefined;
    const position = (await env.DB.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE agent_id IS ?1").bind(agent?.id ?? null).first<number>("p")) ?? 1;
    const res = await env.DB.prepare(
      `INSERT INTO tasks (id, agent_id, title, body, status, position, source, source_ref, source_label) VALUES (?1, ?2, ?3, ?4, 'brouillon', ?5, 'project4', ?6, ?7)
       ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
    )
      .bind(crypto.randomUUID(), agent?.id ?? null, String(t.title).slice(0, 200), String(t.body ?? "").slice(0, 60_000), position, String(t.ref), t.label ?? null)
      .run();
    imported += res.meta.changes ?? 0;
  }
  return { imported };
}

/**
 * Découpage d'une tâche par l'agent : ses étapes deviennent des sous-tâches prêtes, en tête de file et dans l'ordre ;
 * la tâche d'origine reste « en cours » jusqu'à la fin de la dernière.
 */
async function splitStatements(env: Bindings, agentId: string, taskId: string, steps: Array<{ title?: string; body?: string }>, at: string) {
  const first = (await env.DB.prepare("SELECT MIN(position) AS p FROM tasks WHERE agent_id = ?1 AND status = 'prete'").bind(agentId).first<number | null>("p")) ?? 1;
  const valid = steps.filter((s) => s.title?.trim()).slice(0, 12);
  return [
    ...valid.map((s, i) =>
      env.DB.prepare("INSERT INTO tasks (id, agent_id, parent_id, title, body, status, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'prete', ?6, ?7, ?7)").bind(
        crypto.randomUUID(),
        agentId,
        taskId,
        String(s.title).trim().slice(0, 200),
        String(s.body ?? "").slice(0, 20_000),
        first - valid.length + i,
        at,
      ),
    ),
    env.DB.prepare("UPDATE tasks SET status = 'en_cours', summary = ?2, question = NULL, updated_at = ?3 WHERE id = ?1").bind(taskId, `Découpée en ${valid.length} étapes.`, at),
  ];
}

async function closeParent(env: Bindings, taskId?: string) {
  if (!taskId) return;
  const parent = await env.DB.prepare("SELECT parent_id FROM tasks WHERE id = ?1").bind(taskId).first<string | null>("parent_id");
  if (!parent) return;
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?1 AND status NOT IN ('terminee', 'abandonnee')").bind(parent).first<number>("n");
  if (left === 0) {
    await env.DB.prepare("UPDATE tasks SET status = 'terminee', summary = 'Toutes les étapes sont terminées.', updated_at = ?2 WHERE id = ?1 AND status IN ('en_cours', 'en_pause')")
      .bind(parent, new Date().toISOString())
      .run();
  }
}
