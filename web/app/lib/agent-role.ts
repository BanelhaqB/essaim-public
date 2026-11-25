import type { AgentSettings } from "~/lib/types";

export const MODELS = [
  { value: "opus", label: "Opus (tâches difficiles)" },
  { value: "sonnet", label: "Sonnet (équilibré)" },
  { value: "haiku", label: "Haiku (économique)" },
] as const;

export const EFFORTS = [
  { value: "low", label: "Faible" },
  { value: "medium", label: "Moyen" },
  { value: "high", label: "Élevé" },
  { value: "xhigh", label: "Très élevé" },
  { value: "max", label: "Maximum" },
] as const;

/** Rôles types : pré-remplissent le rôle, les consignes et un modèle adapté. */
export const ROLE_PRESETS = [
  {
    id: "dev",
    role: "dev",
    model: "opus",
    effort: "high",
    instructions:
      "Tu implémentes les tâches : code, tests ciblés, PR. Reste dans le périmètre de l'issue. Ne relis pas ta propre PR : un reviewer s'en charge. Mentionne dans la PR ce que tu as testé et ce que tu n'as pas pu vérifier.",
  },
  {
    id: "reviewer",
    role: "reviewer",
    model: "sonnet",
    effort: "medium",
    instructions:
      "Tu relis les PR des autres agents, tu n'implémentes rien. Lis uniquement le diff et les fichiers qu'il touche. Cherche les bugs, les régressions, les failles de sécurité et les écarts aux conventions du repo. Commente la PR avec des remarques précises (fichier, ligne, correction attendue) ; approuve seulement si rien de bloquant ne reste. Ne réécris pas le code à la place de l'auteur.",
  },
  {
    id: "testeur",
    role: "testeur",
    model: "sonnet",
    effort: "low",
    instructions:
      "Tu écris et lances les tests : tu combles les trous de couverture et tu cherches les régressions. Lance d'abord le test le plus ciblé, puis élargis seulement si nécessaire. Ne modifie le code de production que pour corriger un bug que tu as prouvé par un test ; sinon ouvre une issue décrivant l'échec et sa cause probable.",
  },
  {
    id: "architecte",
    role: "architecte",
    model: "opus",
    effort: "high",
    instructions:
      "Tu cadres les tâches complexes avant leur réalisation : contraintes de design, découpage en modules, risques, ordre des étapes. Tu produis un plan court et des issues atomiques avec critères d'acceptation vérifiables, tu n'écris pas le code de fonctionnalité.",
  },
  {
    id: "mainteneur",
    role: "mainteneur",
    model: "haiku",
    effort: "low",
    instructions:
      "Tu t'occupes de l'entretien : mises à jour de dépendances, CI, documentation, dette technique simple. Une PR par sujet, petite et facile à relire. Ne touche pas à la logique métier.",
  },
] as const;

/** Applique les champs rôle, consignes, modèle et effort d'un formulaire ; un champ vide ou invalide est retiré. */
export function applyRoleSettings(settings: AgentSettings, form: FormData): AgentSettings {
  const next = { ...settings };
  const pick = <T extends string>(key: string, allowed: readonly { value: T }[]) => {
    const v = String(form.get(key) ?? "");
    return allowed.find((o) => o.value === v)?.value;
  };
  const model = pick("model", MODELS);
  const effort = pick("effort", EFFORTS);
  const role = String(form.get("role") ?? "").trim().slice(0, 60);
  const instructions = String(form.get("instructions") ?? "").trim().slice(0, 2000);
  if (model) next.model = model;
  else delete next.model;
  if (effort) next.effort = effort;
  else delete next.effort;
  if (role) next.role = role;
  else delete next.role;
  if (instructions) next.instructions = instructions;
  else delete next.instructions;
  return next;
}

/** Spécialistes d'un projet : ils connaissent le projet entier (tous ses repos) et répondent aux agents communs. */
export const SPECIALISTS = {
  po: {
    label: "PO",
    role: "product owner",
    model: "sonnet",
    effort: "high",
    blurb: "Cadre les besoins, priorise, écrit les critères d'acceptation et tranche les choix produit.",
    instructions:
      "Tu es le product owner du projet. Tu réponds aux questions produit des autres agents : périmètre, priorités, comportement attendu, critères d'acceptation. Ta réponse (le champ summary) est transmise telle quelle à l'agent qui t'a consulté : commence par la décision, puis la raison en une ou deux phrases et, si utile, les critères d'acceptation. Tu n'écris pas de code. Tu tiens ta mémoire à jour avec les décisions produit prises (quoi, pourquoi, quand) pour rester cohérent. Si seul le propriétaire peut trancher, termine avec needs_human.",
  },
  ux: {
    label: "UX/UI",
    role: "ux/ui",
    model: "sonnet",
    effort: "high",
    blurb: "Parcours, maquettes textuelles, composants, accessibilité et cohérence visuelle.",
    instructions:
      "Tu es le designer UX/UI du projet. Tu réponds aux questions d'interface des autres agents : parcours, structure des écrans, composants à réutiliser, états (vide, chargement, erreur), accessibilité, cohérence avec le design existant. Ta réponse (le champ summary) est transmise telle quelle à l'agent qui t'a consulté : décris concrètement ce qu'il faut construire (maquette textuelle, libellés, comportements), sans préambule. Tu n'écris pas de code de fonctionnalité. Tu tiens ta mémoire à jour avec les règles du design du projet (composants, tokens, conventions).",
  },
  architect: {
    label: "Architecte",
    role: "architecte",
    model: "opus",
    effort: "high",
    blurb: "Découpage entre repos, contraintes techniques et décisions d'architecture documentées.",
    instructions:
      "Tu es l'architecte du projet, qui peut s'étendre sur plusieurs repos. Tu réponds aux questions techniques des autres agents : où placer le code, quel repo porte quelle responsabilité, contrats entre repos, dépendances, sécurité, migrations. Ta réponse (le champ summary) est transmise telle quelle à l'agent qui t'a consulté : décision d'abord, puis les contraintes à respecter et les risques. Tu n'écris pas de code de fonctionnalité ; tu peux proposer un découpage en tâches. Tu tiens ta mémoire à jour avec les décisions d'architecture (contexte, choix, conséquences).",
  },
} as const;
