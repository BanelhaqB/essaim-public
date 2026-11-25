/** Lecture et écriture de la base D1 (migrations/). */
import type { MachineResources } from "~/lib/machine";
import { normalizeActions, type ActionInput } from "~/lib/actions";
import { MAX_WINDOW_MS, progressSince, type Progress } from "~/lib/progress";
import { attachLinks, ensureRepoRow, setAgentRepos, updateLinkMemory, updateRepoBrief, type LinkInput } from "./repos";
import { DEFAULT_SETTINGS, type ActionRun, type ActionRunStatus, type Agent, type AgentAction, type AgentSettings, type LogEvent, type Quota, type Conversation, type Message, type MessageRole, type Run, type Service, type ServiceDetail, type ServiceReported, type Task, type TaskStatus, type Usage } from "~/lib/types";

const now = () => new Date().toISOString();
const parse = <T>(json: unknown, fallback: T): T => {
  if (typeof json !== "string" || !json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

type AgentRow = {
  id: string;
  name: string;
  seed: string;
  hue: number;
  kind: string;
  project_id: string | null;
  specialty: string | null;
  repo: string;
  machine: string;
  paused: number;
  priority: number;
  settings: string;
  status: string;
  status_detail: string | null;
  status_at: string | null;
  telegram_topic: number | null;
  brief: string | null;
  memory: string | null;
  memory_at: string | null;
};

const toAgent = (r: AgentRow): Omit<Agent, "repos"> => ({
  id: r.id,
  name: r.name,
  seed: r.seed,
  hue: r.hue,
  kind: r.kind as Agent["kind"],
  projectId: r.project_id,
  specialty: (r.specialty as Agent["specialty"]) ?? null,
  repo: r.repo,
  machine: r.machine as Agent["machine"],
  paused: Boolean(r.paused),
  priority: r.priority,
  settings: { ...DEFAULT_SETTINGS, ...parse<AgentSettings>(r.settings, {}) },
  status: r.status as Agent["status"],
  statusDetail: parse(r.status_detail, {}),
  statusAt: r.status_at,
  telegramTopic: r.telegram_topic,
  brief: r.brief ?? "",
  memory: r.memory ?? "",
  memoryAt: r.memory_at,
});

export async function listAgents(db: D1Database): Promise<Agent[]> {
  const { results } = await db.prepare("SELECT * FROM agents ORDER BY priority, created_at").all<AgentRow>();
  return attachLinks(db, results.map(toAgent));
}

export async function getAgent(db: D1Database, id: string): Promise<Agent | null> {
  const row = await db.prepare("SELECT * FROM agents WHERE id = ?1").bind(id).first<AgentRow>();
  return row ? (await attachLinks(db, [toAgent(row)]))[0] : null;
}

export function slugify(name: string) {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "agent"
  );
}

export interface NewAgent {
  name: string;
  repo: string;
  machine: Agent["machine"];
  kind: Agent["kind"];
  hue: number;
  seed: string;
  settings: AgentSettings;
  /** Brief de départ (description d'un nouveau projet). */
  brief?: string;
  /** Spécialiste d'un projet : rattaché au projet, avec une seule mémoire pour tout le projet. */
  projectId?: string;
  specialty?: Agent["specialty"];
  /** Tous les repos de l'agent (le premier est le principal). Par défaut : `repo`, avec les droits de `settings`. */
  links?: LinkInput[];
}

export async function createAgent(db: D1Database, input: NewAgent): Promise<string> {
  let id = slugify(input.name);
  for (let i = 2; await getAgent(db, id); i++) id = `${slugify(input.name)}-${i}`;
  const last = await db.prepare("SELECT COALESCE(MAX(priority), -1) AS p FROM agents").first<number>("p");
  await db
    .prepare("INSERT INTO agents (id, name, seed, hue, kind, repo, machine, priority, settings, brief, project_id, specialty) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
    .bind(id, input.name, input.seed, input.hue, input.kind, input.repo, input.machine, (last ?? -1) + 1, JSON.stringify(input.settings), input.brief ?? "", input.projectId ?? null, input.specialty ?? null)
    .run();
  const repoId = await ensureRepoRow(db, input.repo, { createMode: input.settings.createRepo });
  if (input.brief) await db.prepare("UPDATE repos SET brief = ?2 WHERE id = ?1 AND brief = ''").bind(repoId, input.brief).run();
  const s = input.settings;
  await setAgentRepos(db, id, input.links?.length ? input.links : [{ repoId, merge: s.merge, deploy: s.deploy, store: s.store }]);
  return id;
}

export async function setPaused(db: D1Database, id: string, paused: boolean) {
  await db.prepare("UPDATE agents SET paused = ?2 WHERE id = ?1").bind(id, paused ? 1 : 0).run();
}

export async function updateSettings(db: D1Database, id: string, settings: AgentSettings) {
  await db.prepare("UPDATE agents SET settings = ?2 WHERE id = ?1").bind(id, JSON.stringify(settings)).run();
}

export async function setMachine(db: D1Database, id: string, machine: Agent["machine"]) {
  await db.prepare("UPDATE agents SET machine = ?2 WHERE id = ?1").bind(id, machine).run();
}

export async function setHue(db: D1Database, id: string, hue: number) {
  await db.prepare("UPDATE agents SET hue = ?2 WHERE id = ?1").bind(id, hue).run();
}

export async function setTelegramTopic(db: D1Database, id: string, topic: number | null) {
  await db.prepare("UPDATE agents SET telegram_topic = ?2 WHERE id = ?1").bind(id, topic).run();
}

export async function deleteAgent(db: D1Database, id: string) {
  await db.batch([db.prepare("DELETE FROM agent_repos WHERE agent_id = ?1").bind(id), db.prepare("UPDATE agent_repos SET handoff_to = NULL WHERE handoff_to = ?1").bind(id), db.prepare("DELETE FROM events WHERE agent_id = ?1").bind(id), db.prepare("DELETE FROM runs WHERE agent_id = ?1").bind(id), db.prepare("DELETE FROM agents WHERE id = ?1").bind(id)]);
}

/**
 * Range les agents dans l'ordre donné (le premier passe en P1). Les agents absents de la liste (supprimés entre-temps,
 * ou d'un autre type) gardent leur ordre relatif, après ; les identifiants inconnus sont ignorés.
 */
export async function reorderAgents(db: D1Database, ids: string[]) {
  const agents = await listAgents(db);
  const known = new Set(agents.map((a) => a.id));
  const head = [...new Set(ids)].filter((id) => known.has(id));
  const order = [...head, ...agents.map((a) => a.id).filter((id) => !head.includes(id))];
  await db.batch(order.map((id, k) => db.prepare("UPDATE agents SET priority = ?2 WHERE id = ?1").bind(id, k)));
}

/* ---------- Réglages globaux ---------- */

export async function getFocus(db: D1Database) {
  return (await db.prepare("SELECT value FROM settings WHERE key = 'focus'").first<string>("value")) === "1";
}
export async function setFocus(db: D1Database, on: boolean) {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('focus', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(on ? "1" : "0").run();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  return db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<string>("value");
}
export async function setSetting(db: D1Database, key: string, value: string) {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/* ---------- Machines et quota ---------- */

export interface MachineInfo {
  name: string;
  lastSeen: string;
  version: string | null;
  /** Places appliquées par le runner à sa dernière synchro. */
  capacity: number | null;
  /** CAPACITY du runner (null : pas de runner d'agents, un serveur qui n'a que le veilleur). */
  baseCapacity: number | null;
  /** Réglage fait dans Essaim, s'il n'a pas expiré. */
  override: { capacity: number; until: string | null } | null;
  /** Places en vigueur : le réglage d'Essaim dès qu'il est fait, sinon ce que le runner annonce. */
  places: number | null;
  resources: MachineResources | null;
  quota: Quota;
  online: boolean;
}

/** Une machine est en ligne si son runner s'est manifesté depuis moins de 90 s. */
export const ONLINE_MS = 90_000;

type MachineRow = {
  name: string;
  last_seen: string;
  version: string | null;
  capacity: number | null;
  base_capacity: number | null;
  capacity_override: number | null;
  capacity_until: string | null;
  resources: string | null;
  quota: string | null;
};

/** Le réglage de places d'une machine, s'il est encore en vigueur. */
export function activeOverride(r: Pick<MachineRow, "capacity_override" | "capacity_until">, at = Date.now()) {
  if (r.capacity_override == null) return null;
  if (r.capacity_until && Date.parse(r.capacity_until) <= at) return null;
  return { capacity: r.capacity_override, until: r.capacity_until };
}

function toMachine(r: MachineRow, at: number): MachineInfo {
  const override = activeOverride(r, at);
  return {
    name: r.name,
    lastSeen: r.last_seen,
    version: r.version,
    capacity: r.capacity,
    baseCapacity: r.base_capacity,
    override,
    places: override?.capacity ?? r.capacity,
    resources: parse<MachineResources | null>(r.resources, null),
    quota: parse<Quota>(r.quota, {}),
    online: at - Date.parse(r.last_seen) < ONLINE_MS,
  };
}

export async function listMachines(db: D1Database, at = Date.now()): Promise<MachineInfo[]> {
  const { results } = await db.prepare("SELECT * FROM machines ORDER BY name").all<MachineRow>();
  return results.map((r) => toMachine(r, at));
}

export async function getMachine(db: D1Database, name: string, at = Date.now()): Promise<MachineInfo | null> {
  const r = await db.prepare("SELECT * FROM machines WHERE name = ?1").bind(name).first<MachineRow>();
  return r ? toMachine(r, at) : null;
}

/** Places choisies dans Essaim (null : retour à CAPACITY). Le runner les applique à sa prochaine synchro. */
export async function setMachinePlaces(db: D1Database, name: string, capacity: number | null, until: string | null) {
  await db
    .prepare("UPDATE machines SET capacity_override = ?2, capacity_until = ?3 WHERE name = ?1")
    .bind(name, capacity, capacity == null ? null : until)
    .run();
}

/** Le quota de l'abonnement (le même pour toutes les machines) : la mesure la plus récente. */
export function latestQuota(machines: MachineInfo[]): Quota {
  return machines.map((m) => m.quota).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? {};
}

/* ---------- Runs et journal ---------- */

type RunRow = {
  id: string;
  agent_id: string;
  issue_number: number | null;
  issue_title: string | null;
  issue_url: string | null;
  status: Run["status"];
  reason: string | null;
  pr_url: string | null;
  summary: string | null;
  question: string | null;
  started_at: string | null;
  updated_at: string;
  ended_at: string | null;
};
const toRun = (r: RunRow): Run => ({
  id: r.id,
  agentId: r.agent_id,
  issueNumber: r.issue_number,
  issueTitle: r.issue_title,
  issueUrl: r.issue_url,
  status: r.status,
  reason: r.reason,
  prUrl: r.pr_url,
  summary: r.summary,
  question: r.question,
  startedAt: r.started_at,
  updatedAt: r.updated_at,
  endedAt: r.ended_at,
});

export async function runsForAgent(db: D1Database, agentId: string, limit = 20): Promise<Run[]> {
  const { results } = await db.prepare("SELECT * FROM runs WHERE agent_id = ?1 ORDER BY updated_at DESC LIMIT ?2").bind(agentId, limit).all<RunRow>();
  return results.map(toRun);
}

export async function openQuestions(db: D1Database): Promise<Run[]> {
  const { results } = await db.prepare("SELECT * FROM runs WHERE status = 'needs_human' ORDER BY updated_at DESC").all<RunRow>();
  return results.map(toRun);
}

export async function eventsForRun(db: D1Database, runId: string, limit = 200): Promise<LogEvent[]> {
  const { results } = await db
    .prepare("SELECT id, at, kind, level, text FROM (SELECT * FROM events WHERE run_id = ?1 ORDER BY id DESC LIMIT ?2) ORDER BY id")
    .bind(runId, limit)
    .all<LogEvent>();
  return results;
}

/** Ce que les runs ont produit depuis une date : tickets terminés, PR, questions. */
export async function nightSummary(db: D1Database, sinceIso: string) {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN pr_url IS NOT NULL THEN 1 ELSE 0 END) AS prs,
         SUM(CASE WHEN status = 'needs_human' THEN 1 ELSE 0 END) AS questions
       FROM runs WHERE updated_at >= ?1`,
    )
    .bind(sinceIso)
    .first<{ done: number | null; prs: number | null; questions: number | null }>();
  return { done: row?.done ?? 0, prs: row?.prs ?? 0, questions: row?.questions ?? 0 };
}

export { now as isoNow };

/* ---------- Tâches ---------- */

type TaskRow = {
  id: string;
  agent_id: string | null;
  repo_id: string | null;
  parent_id: string | null;
  title: string;
  body: string;
  status: TaskStatus;
  position: number;
  source: string | null;
  source_label: string | null;
  issue_number: number | null;
  issue_url: string | null;
  run_id: string | null;
  pr_url: string | null;
  summary: string | null;
  question: string | null;
  reply: string | null;
  created_at: string;
  updated_at: string;
};
const toTask = (r: TaskRow): Task => ({
  id: r.id,
  agentId: r.agent_id,
  repoId: r.repo_id,
  parentId: r.parent_id,
  title: r.title,
  body: r.body,
  status: r.status,
  position: r.position,
  source: r.source,
  sourceLabel: r.source_label,
  issueNumber: r.issue_number,
  issueUrl: r.issue_url,
  runId: r.run_id,
  prUrl: r.pr_url,
  summary: r.summary,
  question: r.question,
  reply: r.reply,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Ordre d'affichage : en cours (puis en pause), questions, file (par position), brouillons, puis terminées et abandonnées. */
const TASK_ORDER = `CASE status WHEN 'en_cours' THEN 0 WHEN 'en_pause' THEN 0.5 WHEN 'question' THEN 1 WHEN 'prete' THEN 2 WHEN 'brouillon' THEN 3 ELSE 4 END, position, created_at DESC`;

export async function tasksForAgent(db: D1Database, agentId: string, { closedLimit = 30 } = {}): Promise<Task[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM tasks WHERE agent_id = ?1 AND status NOT IN ('terminee', 'abandonnee')
         UNION ALL SELECT * FROM (SELECT * FROM tasks WHERE agent_id = ?1 AND status IN ('terminee', 'abandonnee') ORDER BY updated_at DESC LIMIT ?2)
       ) ORDER BY ${TASK_ORDER}`,
    )
    .bind(agentId, closedLimit)
    .all<TaskRow>();
  return results.map(toTask);
}

export async function inboxTasks(db: D1Database): Promise<Task[]> {
  const { results } = await db.prepare("SELECT * FROM tasks WHERE agent_id IS NULL AND status NOT IN ('terminee', 'abandonnee') ORDER BY created_at").all<TaskRow>();
  return results.map(toTask);
}

export async function getTask(db: D1Database, id: string): Promise<Task | null> {
  const row = await db.prepare("SELECT * FROM tasks WHERE id = ?1").bind(id).first<TaskRow>();
  return row ? toTask(row) : null;
}

export async function openQuestionTasks(db: D1Database): Promise<Task[]> {
  const { results } = await db.prepare("SELECT * FROM tasks WHERE status = 'question' ORDER BY updated_at DESC").all<TaskRow>();
  return results.map(toTask);
}

/** Nombre de tâches par agent et par statut (cartes de l'accueil). */
export async function taskCounts(db: D1Database): Promise<Record<string, Partial<Record<TaskStatus, number>>>> {
  const { results } = await db
    .prepare("SELECT agent_id, status, COUNT(*) AS n FROM tasks WHERE agent_id IS NOT NULL AND status NOT IN ('terminee', 'abandonnee') GROUP BY agent_id, status")
    .all<{ agent_id: string; status: TaskStatus; n: number }>();
  const out: Record<string, Partial<Record<TaskStatus, number>>> = {};
  for (const r of results) (out[r.agent_id] ??= {})[r.status] = r.n;
  return out;
}

/**
 * Jauge de progression de chaque agent (lib/progress.ts). Seules les tâches sans étapes comptent : une tâche découpée
 * est en cours tant que ses étapes avancent, la compter en plus ferait double emploi. Les brouillons ne repoussent
 * pas le début de la fenêtre : un vieux brouillon oublié ne doit pas gonfler le compte des tâches faites.
 */
export async function agentProgress(db: D1Database, nowMs = Date.now()): Promise<Record<string, Progress>> {
  const leaf = "NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)";
  const [open, done] = await Promise.all([
    db
      .prepare(
        `SELECT agent_id, SUM(status = 'prete') AS queued, SUM(status IN ('en_cours', 'en_pause', 'question')) AS active,
           SUM(status = 'brouillon') AS drafts, MIN(CASE WHEN status <> 'brouillon' THEN created_at END) AS oldest
         FROM tasks t WHERE agent_id IS NOT NULL AND status IN ('brouillon', 'prete', 'en_cours', 'en_pause', 'question') AND ${leaf}
         GROUP BY agent_id`,
      )
      .all<{ agent_id: string; queued: number; active: number; drafts: number; oldest: string | null }>(),
    db
      .prepare(`SELECT agent_id, updated_at FROM tasks t WHERE agent_id IS NOT NULL AND status = 'terminee' AND updated_at >= ?1 AND ${leaf}`)
      .bind(new Date(nowMs - MAX_WINDOW_MS).toISOString())
      .all<{ agent_id: string; updated_at: string }>(),
  ]);
  const out: Record<string, Progress> = {};
  const get = (id: string) => (out[id] ??= { done: 0, active: 0, queued: 0, drafts: 0, since: progressSince(nowMs, null) });
  for (const r of open.results) out[r.agent_id] = { done: 0, active: r.active, queued: r.queued, drafts: r.drafts, since: progressSince(nowMs, r.oldest) };
  for (const r of done.results) {
    const p = get(r.agent_id);
    if (r.updated_at >= p.since) p.done++;
  }
  return out;
}

async function endOfQueue(db: D1Database, agentId: string | null) {
  const max = await db.prepare("SELECT MAX(position) AS p FROM tasks WHERE agent_id IS ?1").bind(agentId).first<number | null>("p");
  return (max ?? 0) + 1;
}

export async function createTask(db: D1Database, input: { agentId: string | null; repoId?: string | null; title: string; body?: string; status?: "brouillon" | "prete"; source?: string; parentId?: string }) {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO tasks (id, agent_id, parent_id, title, body, status, position, source, repo_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, (SELECT repo_id FROM agent_repos WHERE agent_id = ?2 ORDER BY position LIMIT 1)))`,
    )
    .bind(id, input.agentId, input.parentId ?? null, input.title, input.body ?? "", input.status ?? "brouillon", await endOfQueue(db, input.agentId), input.source ?? null, input.repoId ?? null)
    .run();
  return id;
}

/** Modifie le texte d'une tâche ; son issue sera mise à jour par le runner. */
export async function updateTaskText(db: D1Database, id: string, title: string, body: string) {
  await db
    .prepare("UPDATE tasks SET title = ?2, body = ?3, gh_dirty = CASE WHEN issue_number IS NULL THEN 0 ELSE 1 END, updated_at = ?4 WHERE id = ?1")
    .bind(id, title, body, now())
    .run();
}

/**
 * Change le statut à la main : brouillon ↔ prete (la tâche va en fin de file) ou abandonnee.
 * Une tâche en cours ou en question ne se remet pas en brouillon (l'agent y travaille).
 */
export async function setTaskRepo(db: D1Database, id: string, repoId: string) {
  await db
    .prepare("UPDATE tasks SET repo_id = ?2, updated_at = ?3 WHERE id = ?1 AND issue_number IS NULL AND ?2 IN (SELECT repo_id FROM agent_repos WHERE agent_id = tasks.agent_id)")
    .bind(id, repoId, now())
    .run();
}

export async function setTaskStatus(db: D1Database, id: string, status: "brouillon" | "prete" | "abandonnee") {
  const task = await getTask(db, id);
  if (!task) return;
  if (status !== "abandonnee" && !["brouillon", "prete"].includes(task.status)) return;
  const position = status === "prete" && task.status !== "prete" ? await endOfQueue(db, task.agentId) : task.position;
  await db
    .prepare("UPDATE tasks SET status = ?2, position = ?3, gh_dirty = CASE WHEN issue_number IS NULL THEN 0 ELSE 1 END, updated_at = ?4 WHERE id = ?1")
    .bind(id, status, position, now())
    .run();
}

/**
 * Pause d'une tâche en cours (son run s'arrête sur la machine et attend), ou reprise. Une tâche découpée n'a pas de
 * run à elle (ses étapes en ont) : elle ne se met pas en pause. Renvoie vrai si le statut a changé.
 */
export async function holdTask(db: D1Database, id: string, hold: boolean) {
  const [from, to] = hold ? ["en_cours", "en_pause"] : ["en_pause", "en_cours"];
  const res = await db
    .prepare(
      `UPDATE tasks SET status = ?3, updated_at = ?4 WHERE id = ?1 AND status = ?2 AND run_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id)`,
    )
    .bind(id, from, to, now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Abandon d'une tâche (et de ses étapes pas finies, pour une tâche découpée). Renvoie les tâches abandonnées : celles
 * qui ont un run sont arrêtées par le runner. Une tâche terminée ne s'abandonne plus.
 */
export async function abandonTask(db: D1Database, id: string) {
  const { results } = await db
    .prepare("SELECT id FROM tasks WHERE (id = ?1 OR parent_id = ?1) AND status NOT IN ('terminee', 'abandonnee')")
    .bind(id)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  if (!ids.length) return [];
  await db
    .prepare(
      "UPDATE tasks SET status = 'abandonnee', gh_dirty = CASE WHEN issue_number IS NULL THEN 0 ELSE 1 END, updated_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))",
    )
    .bind(JSON.stringify(ids), now())
    .run();
  return ids;
}

/**
 * Reprise d'une tâche abandonnée : elle repasse en tête de la file de son agent (le runner rouvre son issue et repart
 * de ce qui est déjà poussé sur sa branche). Une tâche découpée repasse en cours et ses étapes abandonnées reviennent
 * en tête de file, dans leur ordre ; une étape reprise rouvre sa tâche mère si elle était close. Renvoie vrai si la
 * tâche a été reprise.
 */
export async function reopenTask(db: D1Database, id: string) {
  const task = await getTask(db, id);
  if (!task?.agentId || task.status !== "abandonnee") return false;
  const { results: steps } = await db.prepare("SELECT id, status FROM tasks WHERE parent_id = ?1 ORDER BY position, created_at").bind(id).all<{ id: string; status: string }>();
  const queued = steps.length ? steps.filter((s) => s.status === "abandonnee").map((s) => s.id) : [id];
  // Une tâche découpée dont toutes les étapes sont faites n'a plus rien à reprendre.
  if (!queued.length) return false;
  const head = await db.prepare("SELECT MIN(position) AS p FROM tasks WHERE agent_id = ?1 AND status = 'prete'").bind(task.agentId).first<number | null>("p");
  const first = (head ?? 1) - queued.length;
  const dirty = "gh_dirty = CASE WHEN issue_number IS NULL THEN 0 ELSE 1 END";
  const at = now();
  const statements = queued.map((t, i) =>
    db.prepare(`UPDATE tasks SET status = 'prete', position = ?2, question = NULL, reply = NULL, ${dirty}, updated_at = ?3 WHERE id = ?1`).bind(t, first + i, at),
  );
  if (steps.length) statements.push(db.prepare(`UPDATE tasks SET status = 'en_cours', ${dirty}, updated_at = ?2 WHERE id = ?1`).bind(id, at));
  if (task.parentId) {
    statements.push(
      db.prepare(`UPDATE tasks SET status = 'en_cours', ${dirty}, updated_at = ?2 WHERE id = ?1 AND status IN ('abandonnee', 'terminee')`).bind(task.parentId, at),
    );
  }
  await db.batch(statements);
  return true;
}

export async function assignTask(db: D1Database, id: string, agentId: string) {
  await db.prepare("UPDATE tasks SET agent_id = ?2, position = ?3, updated_at = ?4, repo_id = CASE WHEN repo_id IN (SELECT repo_id FROM agent_repos WHERE agent_id = ?2) THEN repo_id ELSE (SELECT repo_id FROM agent_repos WHERE agent_id = ?2 ORDER BY position LIMIT 1) END WHERE id = ?1 AND issue_number IS NULL").bind(id, agentId, await endOfQueue(db, agentId), now()).run();
}

export async function deleteTask(db: D1Database, id: string) {
  await db.prepare("DELETE FROM tasks WHERE id = ?1 AND status = 'brouillon' AND issue_number IS NULL").bind(id).run();
}

/** Réordonne la file d'un agent : `ids` est la nouvelle suite des tâches prêtes. */
export async function reorderQueue(db: D1Database, agentId: string, ids: string[]) {
  await db.batch(ids.map((id, i) => db.prepare("UPDATE tasks SET position = ?3 WHERE id = ?1 AND agent_id = ?2").bind(id, agentId, i + 1)));
}

/** Monte (-1) ou descend (+1) une tâche prête dans la file. */
export async function moveTask(db: D1Database, id: string, direction: -1 | 1) {
  const task = await getTask(db, id);
  if (!task?.agentId || task.status !== "prete") return;
  const { results } = await db.prepare("SELECT id FROM tasks WHERE agent_id = ?1 AND status = 'prete' ORDER BY position, created_at").bind(task.agentId).all<{ id: string }>();
  const ids = results.map((r) => r.id);
  const i = ids.indexOf(id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await reorderQueue(db, task.agentId, ids);
}

/** Réponse écrite dans Essaim à la question d'une tâche : le runner la transmet à l'agent. */
export async function answerTask(db: D1Database, id: string, reply: string) {
  await db.prepare("UPDATE tasks SET reply = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'question'").bind(id, reply, now()).run();
}

/* ---------- Conversations et messages ---------- */

export async function listConversations(db: D1Database, agentId: string, limit = 30): Promise<Conversation[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.agent_id, c.task_id, COALESCE(t.title, c.title) AS title, t.status AS task_status, c.updated_at,
         (SELECT ar.status FROM action_runs ar WHERE ar.conversation_id = c.id ORDER BY ar.requested_at DESC LIMIT 1) AS action_status
       FROM conversations c LEFT JOIN tasks t ON t.id = c.task_id
       WHERE c.agent_id = ?1 ORDER BY c.updated_at DESC LIMIT ?2`,
    )
    .bind(agentId, limit)
    .all<{ id: string; agent_id: string; task_id: string | null; title: string; task_status: TaskStatus | null; action_status: ActionRunStatus | null; updated_at: string }>();
  return results.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    taskId: r.task_id,
    title: r.title,
    taskStatus: r.task_status,
    actionStatus: r.action_status,
    updatedAt: r.updated_at,
  }));
}

export async function createConversation(db: D1Database, agentId: string, title: string) {
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO conversations (id, agent_id, title) VALUES (?1, ?2, ?3)").bind(id, agentId, title).run();
  return id;
}

/** La conversation d'une tâche, créée quand l'agent la commence. */
export function taskConversationStatement(db: D1Database, taskId: string, agentId: string, title: string, at: string) {
  return db
    .prepare("INSERT INTO conversations (id, agent_id, task_id, title, updated_at) VALUES (?1, ?2, ?1, ?3, ?4) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at")
    .bind(taskId, agentId, title, at);
}

/**
 * La question de l'agent, versée dans la conversation de sa tâche : elle reste dans le fil après la reprise (la tâche,
 * elle, l'oublie). La tâche se trouve par son identifiant, ou par son issue pour les runs d'avant les tâches.
 */
export function taskQuestionStatements(db: D1Database, q: { taskId: string; agentId: string; issueNumber: number; text: string; mid: string; at: string }) {
  const where = "t.id = ?1 OR (t.agent_id = ?2 AND t.issue_number = ?3)";
  return [
    db
      .prepare(
        `INSERT INTO messages (conversation_id, agent_id, role, level, text, mid, at)
         SELECT c.id, c.agent_id, 'agent', 'question', ?4, ?5, ?6 FROM conversations c JOIN tasks t ON t.id = c.task_id WHERE ${where} LIMIT 1
         ON CONFLICT (mid) WHERE mid IS NOT NULL DO NOTHING`,
      )
      .bind(q.taskId, q.agentId, q.issueNumber, q.text, q.mid, q.at),
    db.prepare(`UPDATE conversations SET updated_at = ?4 WHERE task_id IN (SELECT t.id FROM tasks t WHERE ${where})`).bind(q.taskId, q.agentId, q.issueNumber, q.at),
  ];
}

type MessageRow = { id: number; conversation_id: string; role: MessageRole; level: string | null; text: string; mid: string | null; at: string };
const toMessage = (r: MessageRow): Message => ({ id: r.id, conversationId: r.conversation_id, role: r.role, level: r.level, text: r.text, mid: r.mid, at: r.at });

export async function messagesFor(db: D1Database, conversationId: string, limit = 300): Promise<Message[]> {
  const { results } = await db
    .prepare("SELECT * FROM (SELECT id, conversation_id, role, level, text, mid, at FROM messages WHERE conversation_id = ?1 ORDER BY id DESC LIMIT ?2) ORDER BY id")
    .bind(conversationId, limit)
    .all<MessageRow>();
  return results.map(toMessage);
}

/** Message du propriétaire : gardé en attente (delivered = 0) jusqu'à ce que le runner le reçoive. */
export async function addUserMessage(db: D1Database, agentId: string, conversationId: string, text: string, delivered = false): Promise<Message> {
  const mid = crypto.randomUUID();
  const at = now();
  const row = await db
    .prepare("INSERT INTO messages (conversation_id, agent_id, role, text, mid, delivered, at) VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?6) RETURNING id")
    .bind(conversationId, agentId, text, mid, delivered ? 1 : 0, at)
    .first<{ id: number }>();
  await db.prepare("UPDATE conversations SET updated_at = ?2 WHERE id = ?1").bind(conversationId, at).run();
  return { id: row?.id ?? mid, conversationId, role: "user", level: null, text, mid, at };
}

export async function pendingMessages(db: D1Database, agentIds: string[]) {
  if (!agentIds.length) return [];
  const { results } = await db
    .prepare("SELECT id, agent_id, conversation_id, text, mid FROM messages WHERE delivered = 0 AND agent_id IN (SELECT value FROM json_each(?1)) ORDER BY id LIMIT 50")
    .bind(JSON.stringify(agentIds))
    .all<{ id: number; agent_id: string; conversation_id: string; text: string; mid: string }>();
  return results.map((r) => ({ id: r.mid, agentId: r.agent_id, conversationId: r.conversation_id, text: r.text }));
}

export async function markDelivered(db: D1Database, mids: string[]) {
  if (!mids.length) return;
  await db.prepare("UPDATE messages SET delivered = 1 WHERE mid IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(mids.slice(0, 200))).run();
}

/* ---------- Mémoire et consommation ---------- */

/** Brief du repo principal de l'agent (le brief est celui du repo : il est partagé par son équipe). */
export async function updateBrief(db: D1Database, agentId: string, brief: string) {
  const repoId = await db.prepare("SELECT repo_id FROM agent_repos WHERE agent_id = ?1 ORDER BY position LIMIT 1").bind(agentId).first<string>("repo_id");
  if (repoId) await updateRepoBrief(db, repoId, brief);
}

/** Mémoire de l'agent sur un repo (son repo principal par défaut). */
export async function updateMemory(db: D1Database, agentId: string, memory: string, repoId?: string) {
  const id = repoId ?? (await db.prepare("SELECT repo_id FROM agent_repos WHERE agent_id = ?1 ORDER BY position LIMIT 1").bind(agentId).first<string>("repo_id"));
  if (id) await updateLinkMemory(db, agentId, id, memory, now());
}

/** Les tâches terminées d'un agent, les plus récentes d'abord : le journal que l'agent peut consulter. */
export async function journalFor(db: D1Database, agentId: string, limit = 40) {
  const { results } = await db
    .prepare("SELECT title, issue_number, summary, updated_at FROM tasks WHERE agent_id = ?1 AND status = 'terminee' AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT ?2")
    .bind(agentId, limit)
    .all<{ title: string; issue_number: number | null; summary: string; updated_at: string }>();
  return results.map((r) => ({ title: r.title, issueNumber: r.issue_number, summary: r.summary, at: r.updated_at }));
}

const USAGE_SUM = "SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(output) AS output, COUNT(*) AS sessions";
type UsageRow = { input: number | null; cache_read: number | null; cache_write: number | null; output: number | null; sessions: number };
const toUsage = (r?: UsageRow | null): Usage => ({ input: r?.input ?? 0, cacheRead: r?.cache_read ?? 0, cacheWrite: r?.cache_write ?? 0, output: r?.output ?? 0, sessions: r?.sessions ?? 0 });

export async function agentUsage(db: D1Database, agentId: string, sinceIso: string) {
  return toUsage(await db.prepare(`SELECT ${USAGE_SUM} FROM usage WHERE agent_id = ?1 AND at >= ?2`).bind(agentId, sinceIso).first<UsageRow>());
}

export async function taskUsage(db: D1Database, taskId: string) {
  return toUsage(await db.prepare(`SELECT ${USAGE_SUM} FROM usage WHERE task_id = ?1`).bind(taskId).first<UsageRow>());
}

/** Les sous-tâches d'une tâche découpée par l'agent, dans l'ordre. */
export async function subtasks(db: D1Database, parentId: string): Promise<Task[]> {
  const { results } = await db.prepare("SELECT * FROM tasks WHERE parent_id = ?1 ORDER BY position, created_at").bind(parentId).all<TaskRow>();
  return results.map(toTask);
}

// Services des machines (app/.server/services.ts pour la synchro du veilleur).

type ServiceRow = {
  id: string;
  machine: string;
  grp: string;
  name: string;
  description: string;
  pausable: number;
  position: number;
  paused: number;
  paused_at: string | null;
  status: string;
  detail: string;
  status_at: string | null;
  version: string | null;
};

const toService = (r: ServiceRow): Service => {
  return {
    id: r.id,
    machine: r.machine as Service["machine"],
    group: r.grp,
    name: r.name,
    description: r.description,
    pausable: Boolean(r.pausable),
    position: r.position,
    paused: Boolean(r.paused),
    pausedAt: r.paused_at,
    status: r.status as ServiceReported,
    detail: parse<ServiceDetail>(r.detail, {}),
    statusAt: r.status_at,
    version: r.version,
  };
};

export async function listServices(db: D1Database): Promise<Service[]> {
  const { results } = await db.prepare("SELECT * FROM services ORDER BY machine, position, name").all<ServiceRow>();
  return results.map(toService);
}

export async function getService(db: D1Database, id: string): Promise<Service | null> {
  const row = await db.prepare("SELECT * FROM services WHERE id = ?1").bind(id).first<ServiceRow>();
  return row ? toService(row) : null;
}

/** Met en pause (ou relance) un service, ou tous les services pausables d'un groupe. Renvoie le nombre touché. */
export async function setServicePaused(db: D1Database, target: { id?: string; group?: string }, paused: boolean) {
  const where = target.id ? "id = ?3" : "grp = ?3";
  const res = await db
    .prepare(`UPDATE services SET paused = ?1, paused_at = CASE WHEN ?1 = 1 THEN COALESCE(paused_at, ?2) ELSE NULL END WHERE ${where} AND pausable = 1 AND paused != ?1`)
    .bind(paused ? 1 : 0, new Date().toISOString(), target.id ?? target.group ?? "")
    .run();
  return res.meta.changes ?? 0;
}

/* ---------- Actions en un clic ---------- */

type ActionRow = {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  command: string | null;
  prompt: string | null;
  confirm: number;
  timeout_minutes: number | null;
  position: number;
  last_id: string | null;
  last_status: ActionRunStatus | null;
  last_conversation: string | null;
  last_at: string | null;
};

const toAction = (r: ActionRow): AgentAction => ({
  id: r.id,
  agentId: r.agent_id,
  name: r.name,
  description: r.description,
  command: r.command,
  prompt: r.prompt,
  confirm: Boolean(r.confirm),
  timeoutMinutes: r.timeout_minutes,
  position: r.position,
  last: r.last_id && r.last_status && r.last_conversation ? { id: r.last_id, status: r.last_status, conversationId: r.last_conversation, at: r.last_at ?? "" } : null,
});

const ACTION_SELECT = `SELECT a.*, l.id AS last_id, l.status AS last_status, l.conversation_id AS last_conversation, COALESCE(l.ended_at, l.started_at, l.requested_at) AS last_at
  FROM actions a LEFT JOIN action_runs l ON l.id = (SELECT id FROM action_runs WHERE action_id = a.id ORDER BY requested_at DESC LIMIT 1)`;

export async function listActions(db: D1Database, agentId: string): Promise<AgentAction[]> {
  const { results } = await db.prepare(`${ACTION_SELECT} WHERE a.agent_id = ?1 ORDER BY a.position, a.created_at`).bind(agentId).all<ActionRow>();
  return results.map(toAction);
}

/** Les actions de plusieurs agents (synchro du runner), par agent. */
export async function actionsByAgent(db: D1Database, agentIds: string[]) {
  const out: Record<string, AgentAction[]> = {};
  if (!agentIds.length) return out;
  const { results } = await db
    .prepare(`${ACTION_SELECT} WHERE a.agent_id IN (SELECT value FROM json_each(?1)) ORDER BY a.position, a.created_at`)
    .bind(JSON.stringify(agentIds))
    .all<ActionRow>();
  for (const r of results) (out[r.agent_id] ??= []).push(toAction(r));
  return out;
}

export async function getAction(db: D1Database, id: string): Promise<AgentAction | null> {
  const r = await db.prepare(`${ACTION_SELECT} WHERE a.id = ?1`).bind(id).first<ActionRow>();
  return r ? toAction(r) : null;
}

/** Crée une action (à la fin de la liste) ou modifie celle de cet identifiant. Renvoie son identifiant. */
export async function saveAction(db: D1Database, agentId: string, a: ActionInput, id?: string) {
  const at = now();
  if (id) {
    await db
      .prepare("UPDATE actions SET name = ?3, description = ?4, command = ?5, prompt = ?6, confirm = ?7, timeout_minutes = ?8, updated_at = ?9 WHERE id = ?1 AND agent_id = ?2")
      .bind(id, agentId, a.name, a.description, a.command, a.prompt, a.confirm ? 1 : 0, a.timeoutMinutes, at)
      .run();
    return id;
  }
  const newId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO actions (id, agent_id, name, description, command, prompt, confirm, timeout_minutes, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT COALESCE(MAX(position), 0) + 1 FROM actions WHERE agent_id = ?2), ?9, ?9)`,
    )
    .bind(newId, agentId, a.name, a.description, a.command, a.prompt, a.confirm ? 1 : 0, a.timeoutMinutes, at)
    .run();
  return newId;
}

export async function deleteAction(db: D1Database, agentId: string, id: string) {
  await db.prepare("DELETE FROM actions WHERE id = ?1 AND agent_id = ?2").bind(id, agentId).run();
}

/** Déplace une action d'un cran (échange de position avec sa voisine). */
export async function moveAction(db: D1Database, agentId: string, id: string, direction: -1 | 1) {
  const list = await listActions(db, agentId);
  const i = list.findIndex((a) => a.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await db.batch(list.map((a, k) => db.prepare("UPDATE actions SET position = ?2 WHERE id = ?1").bind(a.id, k + 1)));
}

/**
 * Liste d'ACTIONS.json renvoyée par le runner après une session de l'agent : elle remplace celle d'Essaim. Une action
 * se retrouve par son identifiant, sinon par son nom (elle garde alors son historique) ; celles qui manquent sont retirées.
 */
export function replaceActionsStatements(db: D1Database, agentId: string, existing: AgentAction[], raw: unknown, at = now()) {
  const list = normalizeActions(raw);
  const kept = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  list.forEach((a, i) => {
    const found =
      existing.find((e) => a.id && e.id === a.id && !kept.has(e.id)) ?? existing.find((e) => e.name.toLowerCase() === a.name.toLowerCase() && !kept.has(e.id));
    const id = found?.id ?? crypto.randomUUID();
    kept.add(id);
    statements.push(
      db
        .prepare(
          `INSERT INTO actions (id, agent_id, name, description, command, prompt, confirm, timeout_minutes, position, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, command = excluded.command, prompt = excluded.prompt,
             confirm = excluded.confirm, timeout_minutes = excluded.timeout_minutes, position = excluded.position, updated_at = excluded.updated_at`,
        )
        .bind(id, agentId, a.name, a.description, a.command, a.prompt, a.confirm ? 1 : 0, a.timeoutMinutes, i + 1, at),
    );
  });
  for (const e of existing) if (!kept.has(e.id)) statements.push(db.prepare("DELETE FROM actions WHERE id = ?1").bind(e.id));
  return statements;
}

type ActionRunRow = {
  id: string;
  action_id: string | null;
  agent_id: string;
  conversation_id: string;
  name: string;
  command: string | null;
  timeout_minutes: number | null;
  status: ActionRunStatus;
  stop: number;
  exit_code: number | null;
  requested_at: string;
  started_at: string | null;
  ended_at: string | null;
};

const toActionRun = (r: ActionRunRow): ActionRun => ({
  id: r.id,
  actionId: r.action_id,
  agentId: r.agent_id,
  conversationId: r.conversation_id,
  name: r.name,
  command: r.command,
  timeoutMinutes: r.timeout_minutes,
  status: r.status,
  stop: Boolean(r.stop),
  exitCode: r.exit_code,
  requestedAt: r.requested_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

/**
 * Lance une action : une conversation s'ouvre à son nom. Commande → lancement « demandé » que le runner prend (en direct
 * ou à sa synchro). Consigne → message du propriétaire dans cette conversation : l'agent la traite comme une discussion.
 */
export async function startActionRun(db: D1Database, action: AgentAction) {
  const at = now();
  const id = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO conversations (id, agent_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)").bind(conversationId, action.agentId, `▶ ${action.name}`, at),
    db
      .prepare(
        "INSERT INTO action_runs (id, action_id, agent_id, conversation_id, name, command, timeout_minutes, status, requested_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      )
      .bind(id, action.id, action.agentId, conversationId, action.name, action.command, action.timeoutMinutes, action.command ? "demandee" : "discussion", at),
  ]);
  return { id, conversationId };
}

export async function getActionRun(db: D1Database, id: string): Promise<ActionRun | null> {
  const r = await db.prepare("SELECT * FROM action_runs WHERE id = ?1").bind(id).first<ActionRunRow>();
  return r ? toActionRun(r) : null;
}

/** Le dernier lancement ouvert dans cette conversation. */
export async function actionRunForConversation(db: D1Database, conversationId: string): Promise<ActionRun | null> {
  const r = await db.prepare("SELECT * FROM action_runs WHERE conversation_id = ?1 ORDER BY requested_at DESC LIMIT 1").bind(conversationId).first<ActionRunRow>();
  return r ? toActionRun(r) : null;
}

/** Arrêt demandé dans Essaim : un lancement pas encore pris est annulé tout de suite, sinon le runner l'arrête. */
export async function requestActionStop(db: D1Database, id: string) {
  const at = now();
  await db.batch([
    db.prepare("UPDATE action_runs SET status = 'arretee', ended_at = ?2 WHERE id = ?1 AND status = 'demandee'").bind(id, at),
    db.prepare("UPDATE action_runs SET stop = 1 WHERE id = ?1 AND status = 'en_cours'").bind(id),
  ]);
}

/** Pour le runner : lancements demandés, et ceux en cours dont l'arrêt est demandé. */
export async function pendingActionRuns(db: D1Database, agentIds: string[]) {
  if (!agentIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT * FROM action_runs WHERE agent_id IN (SELECT value FROM json_each(?1))
         AND (status = 'demandee' OR (status = 'en_cours' AND stop = 1)) ORDER BY requested_at LIMIT 50`,
    )
    .bind(JSON.stringify(agentIds))
    .all<ActionRunRow>();
  return results.map((r) => runnerActionRun(toActionRun(r)));
}

/** Ce que le runner reçoit d'un lancement (synchro ou direct). */
export function runnerActionRun(run: ActionRun) {
  return { id: run.id, agentId: run.agentId, conversationId: run.conversationId, name: run.name, command: run.command, timeoutMinutes: run.timeoutMinutes, stop: run.stop };
}
