import type { Agent, AgentRepo, ProjectInfo, Repo } from "~/lib/types";

type RepoRow = { id: string; repo: string; brief: string; create_mode: string | null; project_id: string | null; created_at: string };
type LinkRow = {
  agent_id: string;
  repo_id: string;
  repo: string;
  brief: string;
  create_mode: string | null;
  project_id: string | null;
  project_name: string | null;
  project_brief: string | null;
  specialists: string | null;
  access: string;
  merge: number;
  deploy: number;
  store: number;
  handoff_to: string | null;
  max_rounds: number | null;
  memory: string;
  memory_at: string | null;
  position: number;
};

const mode = (v: string | null) => (v === "private" || v === "public" ? v : null);

const toRepo = (r: RepoRow): Repo => ({ id: r.id, repo: r.repo, brief: r.brief, createMode: mode(r.create_mode), projectId: r.project_id, createdAt: r.created_at });

const toLink = (r: LinkRow): AgentRepo => ({
  repoId: r.repo_id,
  repo: r.repo,
  brief: r.brief,
  project: r.project_id ? { id: r.project_id, name: r.project_name ?? "", brief: r.project_brief ?? "", specialists: parseSpecialists(r.specialists) } : null,
  createMode: mode(r.create_mode),
  access: r.access === "read" ? "read" : "write",
  merge: Boolean(r.merge),
  deploy: Boolean(r.deploy),
  store: Boolean(r.store),
  handoffTo: r.handoff_to,
  maxRounds: r.max_rounds,
  memory: r.memory,
  memoryAt: r.memory_at,
  position: r.position,
});

/** Identifiant d'un repo : `owner/name` en minuscules, sans `/`. */
export const repoSlug = (repo: string) => repo.trim().toLowerCase().replace(/\//g, "-");

function parseSpecialists(json: string | null): ProjectInfo["specialists"] {
  try {
    const list = JSON.parse(json ?? "[]") as ProjectInfo["specialists"];
    return Array.isArray(list) ? list.filter((s) => s?.specialty && s.id) : [];
  } catch {
    return [];
  }
}

const LINK_SQL = `SELECT l.*, r.repo, r.brief, r.create_mode, r.project_id, p.name AS project_name, p.brief AS project_brief,
    (SELECT json_group_array(json_object('id', s.id, 'specialty', s.specialty, 'name', s.name)) FROM agents s WHERE s.project_id = r.project_id AND s.specialty IS NOT NULL) AS specialists
  FROM agent_repos l JOIN repos r ON r.id = l.repo_id LEFT JOIN projects p ON p.id = r.project_id`;

export async function listRepos(db: D1Database): Promise<Repo[]> {
  const { results } = await db.prepare("SELECT * FROM repos ORDER BY repo").all<RepoRow>();
  return results.map(toRepo);
}

export async function getRepo(db: D1Database, id: string): Promise<Repo | null> {
  const row = await db.prepare("SELECT * FROM repos WHERE id = ?1").bind(id).first<RepoRow>();
  return row ? toRepo(row) : null;
}

/** Crée le repo s'il n'existe pas ; sinon renvoie celui qui existe (le mode de création n'est jamais écrasé). */
export async function ensureRepoRow(db: D1Database, repo: string, input: { brief?: string; createMode?: "private" | "public" | null } = {}): Promise<string> {
  const id = repoSlug(repo);
  await db
    .prepare("INSERT INTO repos (id, repo, brief, create_mode) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO NOTHING")
    .bind(id, repo.trim(), input.brief ?? "", input.createMode ?? null)
    .run();
  return id;
}

export async function updateRepoBrief(db: D1Database, repoId: string, brief: string) {
  await db.prepare("UPDATE repos SET brief = ?2 WHERE id = ?1").bind(repoId, brief).run();
}

/** Le repo GitHub existe (créé ou déjà là) : on n'en redemande plus la création. */
export async function clearCreateMode(db: D1Database, repoId: string) {
  await db.prepare("UPDATE repos SET create_mode = NULL WHERE id = ?1").bind(repoId).run();
}

/** Supprime un repo sans agent rattaché (les tâches qui y étaient perdent leur repo). */
export async function deleteRepoRow(db: D1Database, repoId: string): Promise<boolean> {
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM agent_repos WHERE repo_id = ?1").bind(repoId).first<number>("n")) ?? 0;
  if (n > 0) return false;
  await db.prepare("DELETE FROM repos WHERE id = ?1").bind(repoId).run();
  return true;
}

/** Liens d'un lot d'agents, regroupés par agent (le repo principal d'abord). */
export async function linksByAgent(db: D1Database, agentIds: string[]): Promise<Record<string, AgentRepo[]>> {
  const out: Record<string, AgentRepo[]> = Object.fromEntries(agentIds.map((id) => [id, []]));
  if (!agentIds.length) return out;
  const { results } = await db.prepare(`${LINK_SQL} WHERE l.agent_id IN (SELECT value FROM json_each(?1)) ORDER BY l.position, r.repo`).bind(JSON.stringify(agentIds)).all<LinkRow>();
  for (const r of results) out[r.agent_id]?.push(toLink(r));
  return out;
}

export async function attachLinks<T extends Omit<Agent, "repos">>(db: D1Database, agents: T[]): Promise<Array<T & { repos: AgentRepo[] }>> {
  const links = await linksByAgent(db, agents.map((a) => a.id));
  // Le brief et la mémoire « de l'agent » sont ceux de son repo principal (ancien format, lu par l'accueil et les tests).
  return agents.map((a) => {
    const repos = links[a.id] ?? [];
    const main = repos[0];
    // Un spécialiste garde une seule mémoire pour tout son projet (celle de sa fiche), pas une par repo.
    const own = (a as { specialty?: string | null }).specialty;
    return { ...a, repos, ...(main ? { brief: main.brief, ...(own ? {} : { memory: main.memory, memoryAt: main.memoryAt }) } : {}) };
  });
}

/** Les agents rattachés à un repo, avec leur lien. */
export async function teamOfRepo(db: D1Database, repoId: string): Promise<Array<{ agentId: string; link: AgentRepo }>> {
  const { results } = await db.prepare(`${LINK_SQL} WHERE l.repo_id = ?1 ORDER BY l.position, l.agent_id`).bind(repoId).all<LinkRow>();
  return results.map((r) => ({ agentId: r.agent_id, link: toLink(r) }));
}

export interface LinkInput {
  repoId: string;
  access?: "write" | "read";
  merge?: boolean;
  deploy?: boolean;
  store?: boolean;
  handoffTo?: string | null;
  maxRounds?: number | null;
}

/**
 * Remplace les repos d'un agent par `links` (le premier devient le principal). La mémoire d'un lien conservé est gardée ;
 * un lien retiré disparaît avec sa mémoire.
 */
export async function setAgentRepos(db: D1Database, agentId: string, links: LinkInput[]) {
  const keep = links.map((l) => l.repoId);
  const statements = [
    db.prepare("DELETE FROM agent_repos WHERE agent_id = ?1 AND repo_id NOT IN (SELECT value FROM json_each(?2))").bind(agentId, JSON.stringify(keep)),
    ...links.map((l, i) =>
      db
        .prepare(
          `INSERT INTO agent_repos (agent_id, repo_id, access, merge, deploy, store, handoff_to, max_rounds, position)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT (agent_id, repo_id) DO UPDATE SET access = excluded.access, merge = excluded.merge, deploy = excluded.deploy,
             store = excluded.store, handoff_to = excluded.handoff_to, max_rounds = excluded.max_rounds, position = excluded.position`,
        )
        .bind(agentId, l.repoId, l.access === "read" ? "read" : "write", l.merge ? 1 : 0, l.deploy ? 1 : 0, l.store ? 1 : 0, l.handoffTo || null, l.maxRounds ?? null, i),
    ),
  ];
  await db.batch(statements);
  await syncPrimaryRepos(db);
}

/** `agents.repo` (ancien format) suit le repo principal de chaque agent ; les tâches sans repo prennent celui de leur agent. */
export async function syncPrimaryRepos(db: D1Database) {
  await db.batch([
    db.prepare(
      `UPDATE agents SET repo = COALESCE(
         (SELECT r.repo FROM agent_repos l JOIN repos r ON r.id = l.repo_id WHERE l.agent_id = agents.id ORDER BY l.position, r.repo LIMIT 1), repo)`,
    ),
    db.prepare(
      `UPDATE tasks SET repo_id = (SELECT l.repo_id FROM agent_repos l WHERE l.agent_id = tasks.agent_id ORDER BY l.position LIMIT 1)
       WHERE repo_id IS NULL AND agent_id IS NOT NULL`,
    ),
  ]);
}

export async function updateLinkMemory(db: D1Database, agentId: string, repoId: string, memory: string, at: string) {
  await db.prepare("UPDATE agent_repos SET memory = ?3, memory_at = ?4 WHERE agent_id = ?1 AND repo_id = ?2").bind(agentId, repoId, memory, at).run();
}

/** Met à jour les droits d'un agent sur un seul repo, sans toucher à ses autres repos ni à sa mémoire. */
export async function updateLink(db: D1Database, agentId: string, l: LinkInput) {
  await db
    .prepare("UPDATE agent_repos SET access = ?3, merge = ?4, deploy = ?5, store = ?6, handoff_to = ?7, max_rounds = ?8 WHERE agent_id = ?1 AND repo_id = ?2")
    .bind(agentId, l.repoId, l.access === "read" ? "read" : "write", l.merge ? 1 : 0, l.deploy ? 1 : 0, l.store ? 1 : 0, l.handoffTo || null, l.maxRounds ?? null)
    .run();
}

/** Rattache un agent à un repo (à la fin de ses repos) avec les droits par défaut. Sans effet s'il l'est déjà. */
export async function addLink(db: D1Database, agentId: string, repoId: string) {
  const next = (await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM agent_repos WHERE agent_id = ?1").bind(agentId).first<number>("p")) ?? 0;
  await db.prepare("INSERT INTO agent_repos (agent_id, repo_id, position) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING").bind(agentId, repoId, next).run();
  await syncPrimaryRepos(db);
}

/** Retire un agent d'un repo. Refusé (false) si c'est son dernier : un agent travaille toujours quelque part. */
export async function removeLink(db: D1Database, agentId: string, repoId: string): Promise<boolean> {
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM agent_repos WHERE agent_id = ?1").bind(agentId).first<number>("n")) ?? 0;
  if (n <= 1) return false;
  await db.batch([
    db.prepare("DELETE FROM agent_repos WHERE agent_id = ?1 AND repo_id = ?2").bind(agentId, repoId),
    // Plus personne ne lui passe la main sur ce repo.
    db.prepare("UPDATE agent_repos SET handoff_to = NULL WHERE repo_id = ?2 AND handoff_to = ?1").bind(agentId, repoId),
  ]);
  await syncPrimaryRepos(db);
  return true;
}
