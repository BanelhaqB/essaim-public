import { createAgent, slugify } from "~/.server/db";
import { SPECIALISTS } from "~/lib/agent-role";
import { DEFAULT_SETTINGS, type Agent, type Specialty } from "~/lib/types";

export interface ProjectRow {
  id: string;
  name: string;
  brief: string;
  repos: Array<{ id: string; repo: string }>;
  specialists: Array<{ id: string; name: string; specialty: Specialty; model: string }>;
}

export async function listProjects(db: D1Database): Promise<ProjectRow[]> {
  const [projects, repos, specialists] = await Promise.all([
    db.prepare("SELECT id, name, brief FROM projects ORDER BY name").all<{ id: string; name: string; brief: string }>(),
    db.prepare("SELECT id, repo, project_id FROM repos WHERE project_id IS NOT NULL ORDER BY repo").all<{ id: string; repo: string; project_id: string }>(),
    db.prepare("SELECT id, name, specialty, project_id, json_extract(settings, '$.model') AS model FROM agents WHERE project_id IS NOT NULL AND specialty IS NOT NULL ORDER BY name").all<{ id: string; name: string; specialty: Specialty; project_id: string; model: string | null }>(),
  ]);
  return projects.results.map((p) => ({
    ...p,
    repos: repos.results.filter((r) => r.project_id === p.id).map(({ id, repo }) => ({ id, repo })),
    specialists: specialists.results.filter((s) => s.project_id === p.id).map((s) => ({ id: s.id, name: s.name, specialty: s.specialty, model: s.model ?? "" })),
  }));
}

export async function getProject(db: D1Database, id: string) {
  return (await listProjects(db)).find((p) => p.id === id) ?? null;
}

export async function createProject(db: D1Database, name: string, brief = ""): Promise<string> {
  let id = slugify(name);
  for (let i = 2; await db.prepare("SELECT 1 FROM projects WHERE id = ?1").bind(id).first(); i++) id = `${slugify(name)}-${i}`;
  await db.prepare("INSERT INTO projects (id, name, brief) VALUES (?1, ?2, ?3)").bind(id, name, brief).run();
  return id;
}

export async function updateProject(db: D1Database, id: string, name: string, brief: string) {
  await db.prepare("UPDATE projects SET name = ?2, brief = ?3 WHERE id = ?1").bind(id, name, brief).run();
}

/** Les spécialistes d'un projet sont rattachés à tous ses repos (écriture, sans merge ni déploiement). */
async function linkSpecialist(db: D1Database, agentId: string, repoId: string) {
  const next = (await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM agent_repos WHERE agent_id = ?1").bind(agentId).first<number>("p")) ?? 0;
  await db.prepare("INSERT INTO agent_repos (agent_id, repo_id, merge, deploy, store, position) VALUES (?1, ?2, 0, 0, 0, ?3) ON CONFLICT DO NOTHING").bind(agentId, repoId, next).run();
}

/** Place un repo dans un projet (ou le sort de tout projet avec null) et aligne les liens des spécialistes. */
export async function setRepoProject(db: D1Database, repoId: string, projectId: string | null) {
  const before = await db.prepare("SELECT project_id FROM repos WHERE id = ?1").bind(repoId).first<string | null>("project_id");
  await db.prepare("UPDATE repos SET project_id = ?2 WHERE id = ?1").bind(repoId, projectId).run();
  if (before && before !== projectId) {
    // Les spécialistes de l'ancien projet quittent ce repo (ils gardent toujours au moins un autre repo du projet).
    await db
      .prepare(
        `DELETE FROM agent_repos WHERE repo_id = ?1 AND agent_id IN (SELECT id FROM agents WHERE project_id = ?2 AND specialty IS NOT NULL)
           AND (SELECT COUNT(*) FROM agent_repos x WHERE x.agent_id = agent_repos.agent_id) > 1`,
      )
      .bind(repoId, before)
      .run();
  }
  if (projectId) {
    const { results } = await db.prepare("SELECT id FROM agents WHERE project_id = ?1 AND specialty IS NOT NULL").bind(projectId).all<{ id: string }>();
    for (const a of results) await linkSpecialist(db, a.id, repoId);
  }
}

/** Crée le spécialiste d'un projet. Refusé (null) s'il existe déjà ou si le projet n'a encore aucun repo. */
export async function createSpecialist(db: D1Database, projectId: string, specialty: Specialty): Promise<string | null> {
  const project = await getProject(db, projectId);
  if (!project || project.repos.length === 0 || project.specialists.some((s) => s.specialty === specialty)) return null;
  const preset = SPECIALISTS[specialty];
  const name = `${preset.label} ${project.name}`.slice(0, 40);
  const id = await createAgent(db, {
    name,
    repo: project.repos[0].repo,
    machine: "mac",
    kind: "dev",
    hue: { po: 275, ux: 330, architect: 195 }[specialty],
    seed: name,
    settings: { ...DEFAULT_SETTINGS, merge: false, deploy: false, store: false, role: preset.role, model: preset.model, effort: preset.effort, instructions: preset.instructions },
    projectId,
    specialty,
    links: project.repos.map((r) => ({ repoId: r.id, access: "write" as const, merge: false, deploy: false, store: false })),
  });
  return id;
}

export async function deleteProject(db: D1Database, id: string, removeAgent: (agentId: string) => Promise<void>) {
  const project = await getProject(db, id);
  if (!project) return;
  for (const s of project.specialists) await removeAgent(s.id);
  await db.prepare("DELETE FROM projects WHERE id = ?1").bind(id).run();
}

export type ProjectAgent = Pick<Agent, "id" | "name" | "specialty">;
