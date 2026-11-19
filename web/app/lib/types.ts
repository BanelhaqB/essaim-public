/** Types partagés entre le serveur et l'interface. */

export type AgentKind = "dev" | "svc";
export type Machine = "mac" | "nuc";
/** État rapporté par le runner (runner/src/scheduler.mjs → agentStatus). */
export type AgentStatus = "working" | "starting" | "waiting" | "retry" | "update" | "quota" | "paused" | "yield" | "idle" | "offline";

export interface AgentSettings {
  /** Merger seul quand la CI est verte. */
  merge?: boolean;
  /** Déployer sur Cloudflare quand le ticket le demande. */
  deploy?: boolean;
  /** Publier sur les stores quand le ticket le demande. */
  store?: boolean;
  /** Temps max par ticket, en minutes ; absent ou 0 : aucune limite. */
  maxMinutes?: number;
  /** Alerte (sans arrêt) quand aucun jalon n'est franchi depuis ce temps ; 0 : jamais. 180 par défaut. */
  stallMinutes?: number;
  /** S'efface quand « Je travaille » est actif (oui par défaut). */
  yieldOnFocus?: boolean;
  model?: string;
  effort?: string;
  /** Nouveau projet : le runner crée ce repo GitHub s'il n'existe pas encore (retiré une fois créé). */
  createRepo?: "private" | "public";
}

export interface StatusDetail {
  runId?: string;
  issueNumber?: number;
  issueTitle?: string;
  waitingHuman?: number[];
  ready?: number;
  /** État « retry » : heure du prochain essai (ms). */
  retryAt?: number;
}

export interface Agent {
  id: string;
  name: string;
  seed: string;
  hue: number;
  kind: AgentKind;
  repo: string;
  machine: Machine;
  paused: boolean;
  priority: number;
  settings: AgentSettings;
  status: AgentStatus;
  statusDetail: StatusDetail;
  statusAt: string | null;
  telegramTopic: number | null;
  /** Ce qu'est le projet, ses objectifs et ses règles : écrit par le propriétaire. */
  brief: string;
  /** État courant compact du projet, tenu par l'agent en fin de tâche. */
  memory: string;
  memoryAt: string | null;
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  sessions: number;
}

export interface Quota {
  status?: string;
  fiveHour?: number;
  sevenDay?: number;
  /** Secondes epoch (format de Claude Code). */
  resetsAt?: number;
  /** Millisecondes epoch : rien ne démarre avant. */
  blockedUntil?: number;
  updatedAt?: number;
}

export interface Run {
  id: string;
  agentId: string;
  issueNumber: number | null;
  issueTitle: string | null;
  issueUrl: string | null;
  status: "running" | "interrupted" | "needs_human" | "done" | "failed";
  reason: string | null;
  prUrl: string | null;
  summary: string | null;
  question: string | null;
  startedAt: string | null;
  updatedAt: string;
  endedAt: string | null;
}

export interface LogEvent {
  id: number;
  at: string;
  kind: string;
  level: string | null;
  text: string;
}

/**
 * Cycle d'une tâche : brouillon → prete (file de l'agent) → en_cours → question → terminee | abandonnee.
 * en_pause : arrêtée à ta demande pendant qu'elle était en cours, reprend là où elle en était.
 */
export type TaskStatus = "brouillon" | "prete" | "en_cours" | "en_pause" | "question" | "terminee" | "abandonnee";

export interface Task {
  id: string;
  agentId: string | null;
  parentId: string | null;
  title: string;
  body: string;
  status: TaskStatus;
  position: number;
  source: string | null;
  sourceLabel: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
  runId: string | null;
  prUrl: string | null;
  summary: string | null;
  question: string | null;
  reply: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  agentId: string;
  taskId: string | null;
  title: string;
  /** Statut de la tâche, pour une conversation de tâche. */
  taskStatus: TaskStatus | null;
  /** Statut du lancement, pour la conversation d'une action en un clic. */
  actionStatus: ActionRunStatus | null;
  updatedAt: string;
}

/** Lancement d'une action : demandé dans Essaim, pris par le runner, puis réussi, en échec ou arrêté ; « discussion » pour une consigne. */
export type ActionRunStatus = "demandee" | "en_cours" | "reussie" | "echouee" | "arretee" | "discussion";

/** Action en un clic d'un agent (lib/actions.ts). */
export interface AgentAction {
  id: string;
  agentId: string;
  name: string;
  description: string;
  /** Commande shell lancée par le runner dans le repo à jour ; si absente, `prompt` est envoyé à l'agent. */
  command: string | null;
  prompt: string | null;
  confirm: boolean;
  timeoutMinutes: number | null;
  position: number;
  /** Dernier lancement. */
  last: { id: string; status: ActionRunStatus; conversationId: string; at: string } | null;
}

export interface ActionRun {
  id: string;
  actionId: string | null;
  agentId: string;
  conversationId: string;
  name: string;
  command: string | null;
  timeoutMinutes: number | null;
  status: ActionRunStatus;
  stop: boolean;
  exitCode: number | null;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export type MessageRole = "user" | "agent" | "tool" | "system";

export interface Message {
  id: number | string;
  conversationId: string;
  role: MessageRole;
  level: string | null;
  text: string;
  mid: string | null;
  at: string;
}

/** Ce que le hub pousse au navigateur sur la page d'un agent. */
export type LiveEvent =
  | { type: "message"; conversationId: string; message: Message }
  | { type: "delta"; conversationId: string; text: string }
  | { type: "status"; conversationId: string; state: "working" | "idle" }
  | { type: "refresh" };

export const DEFAULT_SETTINGS: AgentSettings = { merge: true, deploy: true, store: false, stallMinutes: 180, yieldOnFocus: true };

/** État constaté d'un service par le veilleur de sa machine (runner/src/services.mjs). */
export type ServiceReported = "working" | "active" | "paused" | "disabled" | "down" | "unknown";
/** État affiché : la pause demandée qui n'est pas encore appliquée, et le veilleur muet, en plus. */
export type ServiceStatus = ServiceReported | "pausing" | "resuming" | "offline";

export interface ServiceFact {
  label: string;
  value: string;
  /** Date ISO affichée après la valeur (« depuis … », « dernier passage … »). */
  at?: string;
  atLabel?: string;
  tone?: "warn" | "err";
}

export interface ServiceJob {
  name: string;
  cron?: string;
  enabled: boolean;
  running: boolean;
  lastStatus: string | null;
  lastAt: string | null;
  durationMs: number | null;
}

export interface ServiceDetail {
  summary?: string;
  /** En service depuis (ISO). */
  since?: string | null;
  facts?: ServiceFact[];
  counts?: Array<{ label: string; value: number; tone?: "warn" | "err" }>;
  jobs?: ServiceJob[];
  /** Pause ou reprise demandée qui attend (un job en cours). */
  pending?: string;
  error?: string;
}

export interface Service {
  id: string;
  machine: Machine;
  group: string;
  name: string;
  description: string;
  pausable: boolean;
  position: number;
  paused: boolean;
  pausedAt: string | null;
  status: ServiceReported;
  detail: ServiceDetail;
  statusAt: string | null;
  version: string | null;
}
