/**
 * Le relais entre agents d'un même repo : quand un agent termine une tâche, la suite passe automatiquement à un
 * coéquipier (relecture, tests), et une demande de corrections revient à l'auteur. Logique pure, sans base de données.
 */

export const DEFAULT_MAX_ROUNDS = 3;
export const HANDOFF_SOURCE = "handoff";

export interface TeamAgent {
  id: string;
  name: string;
  repo: string;
  settings: { role?: string; handoffTo?: string; maxRounds?: number };
}

/** La chaîne dont fait partie une tâche, relue dans `source_ref` : tâche d'origine, destinataire, auteur initial, tour. */
export interface HandoffRef {
  from: string;
  to: string;
  origin: string;
  round: number;
  kind: "fwd" | "fix";
}

export const formatRef = (r: HandoffRef) => [r.from, r.to, r.origin, r.round, r.kind].join(":");

export function parseRef(ref: string | null | undefined): HandoffRef | null {
  const [from, to, origin, round, kind] = String(ref ?? "").split(":");
  if (!from || !to || !origin || !(kind === "fwd" || kind === "fix")) return null;
  const n = Number(round);
  return Number.isInteger(n) && n >= 0 ? { from, to, origin, round: n, kind } : null;
}

export interface FinishedTask {
  id: string;
  title: string;
  prUrl?: string | null;
  issueNumber?: number | null;
  source?: string | null;
  sourceRef?: string | null;
}

export interface NewHandoff {
  agentId: string;
  title: string;
  body: string;
  sourceRef: string;
  kind: "fwd" | "fix";
  round: number;
}

export type HandoffPlan = { create: NewHandoff } | { stop: string } | null;

const PREFIX = /^(Relecture|Tests|Suite|Corriger)\s·\s/;
export const baseTitle = (title: string) => title.replace(PREFIX, "");

function forwardPrefix(target: TeamAgent) {
  const role = (target.settings.role ?? "").toLowerCase();
  if (/review|relec/.test(role)) return "Relecture";
  if (/test|qa/.test(role)) return "Tests";
  return "Suite";
}

/**
 * Que faire quand `agent` termine `task` ?
 * - verdict « changes_requested » : retour à l'auteur initial, dans la limite des allers-retours ;
 * - sinon : on passe la main à `handoffTo` s'il est réglé (et, sans verdict, seulement s'il y a une PR à relire).
 * Renvoie null quand rien n'est à faire.
 */
export function planHandoff(input: { agent: TeamAgent; task: FinishedTask; summary: string; verdict?: string; team: TeamAgent[] }): HandoffPlan {
  const { agent, task, summary, verdict, team } = input;
  const byId = new Map(team.map((a) => [a.id, a]));
  const ref = task.source === HANDOFF_SOURCE ? parseRef(task.sourceRef) : null;
  const origin = ref?.origin ?? agent.id;
  const round = ref?.round ?? 0;
  const base = baseTitle(task.title);
  const pr = task.prUrl ? `\n\nPR : ${task.prUrl}` : "";
  const issue = task.issueNumber ? `\nIssue d'origine : #${task.issueNumber}` : "";

  if (verdict === "changes_requested") {
    const author = byId.get(origin);
    if (!author || author.id === agent.id || author.repo !== agent.repo) return null;
    const max = Math.max(1, author.settings.maxRounds ?? DEFAULT_MAX_ROUNDS);
    if (round + 1 > max) return { stop: `${agent.name} demande encore des corrections sur « ${base} » après ${max} allers-retours avec ${author.name}. Il faut trancher à la main.` };
    const next = round + 1;
    return {
      create: {
        agentId: author.id,
        title: `Corriger · ${base}`,
        body: `**${agent.name}** demande des corrections (tour ${next}/${max}).\n\n${summary}${pr}${issue}\n\nMets à jour la même branche et la même PR, sans en ouvrir une nouvelle. Rebase sur la branche par défaut si besoin et résous les conflits.`,
        sourceRef: formatRef({ from: task.id, to: author.id, origin, round: next, kind: "fix" }),
        kind: "fix",
        round: next,
      },
    };
  }

  const target = agent.settings.handoffTo ? byId.get(agent.settings.handoffTo) : undefined;
  if (!target || target.id === agent.id || target.repo !== agent.repo) return null;
  if (verdict !== "approved" && !task.prUrl) return null;
  const tag = forwardPrefix(target);
  return {
    create: {
      agentId: target.id,
      title: `${tag} · ${base}`,
      body: `**${agent.name}** a terminé « ${base} ».\n\n${summary}${pr}${issue}\n\nRends ton verdict à la fin : \`approved\` si tout est bon, \`changes_requested\` avec la liste précise de ce qui doit changer.`,
      sourceRef: formatRef({ from: task.id, to: target.id, origin, round, kind: "fwd" }),
      kind: "fwd",
      round,
    },
  };
}
