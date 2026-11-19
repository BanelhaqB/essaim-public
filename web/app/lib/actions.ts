/**
 * Actions en un clic d'un agent : validation (formulaire d'Essaim et ACTIONS.json écrit par l'agent) et libellés.
 * Une action est une commande shell (lancée par le runner dans une copie à jour du repo) ou une consigne donnée à
 * l'agent dans une nouvelle discussion. La même validation existe côté runner (runner/src/actions.mjs).
 */
import type { ActionRunStatus } from "./types";

export const MAX_ACTIONS = 30;
export const DEFAULT_TIMEOUT = 60;
export const MAX_TIMEOUT = 240;

export interface ActionInput {
  /** Identifiant connu (ACTIONS.json) : l'action est mise à jour au lieu d'être recréée. */
  id?: string;
  name: string;
  description: string;
  command: string | null;
  prompt: string | null;
  confirm: boolean;
  timeoutMinutes: number | null;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Une action valide (nom + commande ou consigne), bornée ; null sinon. */
export function normalizeAction(raw: unknown): ActionInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 80).replace(/\s+/g, " ");
  const command = text(r.command, 4000) || null;
  const prompt = command ? null : text(r.prompt, 8000) || null;
  if (!name || (!command && !prompt)) return null;
  const minutes = Math.round(Number(r.timeoutMinutes ?? r.timeout_minutes));
  const id = text(r.id, 64);
  return {
    ...(id ? { id } : {}),
    name,
    description: text(r.description, 300),
    command,
    prompt,
    confirm: r.confirm === true || r.confirm === "on" || r.confirm === 1,
    timeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, MAX_TIMEOUT) : null,
  };
}

/** La liste d'ACTIONS.json : tableau (ou { actions: [...] }), actions invalides écartées, noms en double fusionnés. */
export function normalizeActions(raw: unknown): ActionInput[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { actions?: unknown }).actions) ? (raw as { actions: unknown[] }).actions : [];
  const seen = new Set<string>();
  const out: ActionInput[] = [];
  for (const item of list) {
    const a = normalizeAction(item);
    if (!a || seen.has(a.name.toLowerCase())) continue;
    seen.add(a.name.toLowerCase());
    out.push(a);
    if (out.length >= MAX_ACTIONS) break;
  }
  return out;
}

export const ACTION_STATUS: Record<ActionRunStatus, { label: string; color: string; icon: string }> = {
  demandee: { label: "Lancement…", color: "var(--wait)", icon: "play" },
  en_cours: { label: "En cours", color: "var(--ok)", icon: "zap" },
  reussie: { label: "Réussie", color: "var(--ok)", icon: "check" },
  echouee: { label: "Échec", color: "var(--err)", icon: "alert" },
  arretee: { label: "Arrêtée", color: "var(--fg-3)", icon: "x" },
  discussion: { label: "Discussion", color: "var(--accent)", icon: "send" },
};

/** Le lancement tourne encore (ou attend le runner). */
export const actionOpen = (status: ActionRunStatus | null | undefined) => status === "demandee" || status === "en_cours";

/** Durée lisible : « 42 s », « 3 min 05 s », « 1 h 12 min ». */
export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
