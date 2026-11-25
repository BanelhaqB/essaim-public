/**
 * Un agent peut travailler sur plusieurs repos, avec des droits, un brief et une mémoire propres à chacun.
 * Essaim envoie un lien par repo (`agent.repos`) ; `forRepo` en tire la vue de l'agent sur ce repo, que le reste du
 * runner (prompts, mémoire, git) lit comme avant : `repo`, `brief`, `memory` et `settings` y sont ceux du repo.
 */

/** Le lien d'un agent à un repo : celui demandé, sinon le principal (le premier). Undefined si l'agent n'a pas de lien. */
export function linkFor(agent, repoId) {
  const links = agent?.repos ?? [];
  return links.find((l) => l.id === repoId) ?? links[0];
}

/** Le brief que lit l'agent : celui du projet (s'il y en a un) puis celui du repo. */
function briefOf(link) {
  const project = link.project?.brief?.trim();
  const repo = link.brief?.trim() ?? "";
  if (!project) return repo;
  return `Projet « ${link.project.name} » :\n${project}${repo ? `\n\nRepo ${link.repo} :\n${repo}` : ""}`;
}

/** La vue de l'agent sur un repo. Sans lien (ancien Essaim), l'agent tel quel. */
export function forRepo(agent, repoId) {
  const link = linkFor(agent, repoId);
  if (!agent || !link) return agent;
  // Un spécialiste a une seule mémoire pour tout son projet (un dossier) ; un agent commun, une par repo.
  const specialist = Boolean(agent.specialty);
  return {
    ...agent,
    repo: link.repo,
    repoId: link.id,
    // Dossier de mémoire : vide pour le repo principal (dossier historique de l'agent).
    memoryKey: specialist || agent.repos[0]?.id === link.id ? "" : link.id,
    brief: briefOf(link),
    memory: specialist ? (agent.memory ?? "") : (link.memory ?? ""),
    memoryAt: specialist ? agent.memoryAt : link.memoryAt,
    project: link.project ?? undefined,
    settings: {
      ...agent.settings,
      specialty: agent.specialty ?? undefined,
      specialists: link.project?.specialists ?? [],
      merge: link.merge,
      deploy: link.deploy,
      store: link.store,
      access: link.access,
      handoffTo: link.handoffTo,
      maxRounds: link.maxRounds,
      createRepo: link.createRepo,
    },
  };
}

/** Le repo d'une tâche de la file : le sien, sinon le principal de l'agent. */
export const taskRepoId = (agent, task) => linkFor(agent, task?.repoId)?.id;
