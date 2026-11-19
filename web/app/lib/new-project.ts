/** Création d'un agent : repo existant, ou nouveau projet dont l'agent crée lui-même le repo. */

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** « propriétaire/nom » depuis ce qui a été collé (URL GitHub, .git) ; null si le format ne va pas. */
export function parseRepo(raw: unknown): string | null {
  const repo = String(raw ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  return REPO.test(repo) ? repo : null;
}

/** Nom de repo proposé pour un nouveau projet, d'après le nom de l'agent. */
export function repoName(name: string) {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "nouveau-projet"
  );
}

/** Le propriétaire le plus fréquent parmi les repos des agents : la proposition pour un nouveau repo. */
export function usualOwner(repos: string[]) {
  const count = new Map<string, number>();
  for (const r of repos) {
    const owner = r.split("/")[0];
    if (owner) count.set(owner, (count.get(owner) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

export const MIN_DESCRIPTION = 20;

/** Première tâche d'un nouveau projet : poser les fondations à partir de la description. */
export function initTask(repo: string, description: string) {
  return {
    title: "Initialiser le projet",
    body: `Nouveau projet dans le repo ${repo}, créé pour lui (au départ, un simple README).

Description du propriétaire :

${description.trim()}

À faire :
- choisir une stack simple et adaptée, la justifier en une ou deux phrases dans le résumé ;
- poser le squelette du projet (structure, dépendances, scripts de test, de typage et de build qui passent) ;
- écrire un README (ce qu'est le projet, comment le lancer) et un CLAUDE.md (conventions, commandes) ;
- si la description laisse un choix produit lourd ouvert, prendre l'option raisonnable et la noter, ou découper en étapes si le projet est gros.`,
  };
}
