/**
 * Jauge de progression d'un agent : tâches faites, en cours, en file et brouillons (encore à détailler).
 * « Faites » compte depuis le début de la file actuelle (la plus ancienne tâche encore ouverte), pour que la jauge
 * avance au fil d'une série au lieu de retomber chaque matin ; au moins 24 h (file vide : ce qui a été fait hier
 * reste visible) et au plus 7 jours (une vieille tâche en pause ne gonfle pas le compte indéfiniment).
 */

export interface Progress {
  /** Tâches terminées depuis `since`. */
  done: number;
  /** Tâches commencées : en cours, en pause ou en question. */
  active: number;
  /** Tâches prêtes qui attendent leur tour. */
  queued: number;
  /** Brouillons : ce qu'il reste à détailler avant d'entrer dans la file. */
  drafts: number;
  /** Début de la fenêtre des tâches faites (ISO). */
  since: string;
}

export const MIN_WINDOW_MS = 24 * 3600_000;
export const MAX_WINDOW_MS = 7 * 24 * 3600_000;

/** Début de la fenêtre des tâches faites, d'après la création de la plus ancienne tâche encore ouverte. */
export function progressSince(now: number, oldestOpen: string | null): string {
  const oldest = oldestOpen ? Date.parse(oldestOpen) : NaN;
  const start = Number.isFinite(oldest) ? Math.min(now - MIN_WINDOW_MS, oldest) : now - MIN_WINDOW_MS;
  return new Date(Math.max(now - MAX_WINDOW_MS, start)).toISOString();
}

/** Largeurs (en %) des parts de la jauge, dans l'ordre : faites, en cours, en file, brouillons. */
export function gaugeParts(p: Pick<Progress, "done" | "active" | "queued" | "drafts">) {
  const total = p.done + p.active + p.queued + p.drafts;
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  return { total, done: pct(p.done), active: pct(p.active), queued: pct(p.queued), drafts: pct(p.drafts) };
}

/** « depuis hier 14:05 », « depuis lundi 9:30 » : début de la fenêtre, pour l'infobulle. */
export function fmtSince(sinceIso: string, now: number): string {
  const d = new Date(sinceIso);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  const day = (t: number) => new Date(t).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
  if (day(d.getTime()) === day(now)) return `depuis ${time}`;
  if (day(d.getTime()) === day(now - 24 * 3600_000)) return `depuis hier ${time}`;
  return `depuis ${d.toLocaleDateString("fr-FR", { weekday: "long", timeZone: "Europe/Paris" })} ${time}`;
}
