import type { Agent, AgentStatus, Service, ServiceStatus } from "./types";

export const STATUS: Record<AgentStatus, { label: string; color: string; mode: "busy" | "awake" | "sleep" | "error" }> = {
  working: { label: "Au travail", color: "var(--ok)", mode: "busy" },
  starting: { label: "Démarre", color: "var(--ok)", mode: "busy" },
  waiting: { label: "Attend une place", color: "var(--wait)", mode: "awake" },
  retry: { label: "Nouvel essai bientôt", color: "var(--quota)", mode: "awake" },
  update: { label: "Attend la mise à jour", color: "var(--pause)", mode: "sleep" },
  quota: { label: "Attend la réinitialisation", color: "var(--quota)", mode: "sleep" },
  paused: { label: "En pause", color: "var(--pause)", mode: "sleep" },
  yield: { label: "Te laisse la place", color: "var(--pause)", mode: "sleep" },
  idle: { label: "File vide", color: "var(--fg-2)", mode: "awake" },
  offline: { label: "Machine hors ligne", color: "var(--err)", mode: "sleep" },
};

export const fmtTime = (iso: string | number | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }) : "";

export function fmtWhen(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((now - d.getTime()) / 86_400_000);
  const time = fmtTime(iso);
  if (days < 1 && new Date(now).getDate() === d.getDate()) return `aujourd'hui ${time}`;
  if (days < 2) return `hier ${time}`;
  return `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" })} ${time}`;
}

/** État affiché : la pause demandée s'applique tout de suite, et une machine hors ligne prime sur le reste. */
export function displayStatus(agent: Agent, online: Record<string, boolean>): AgentStatus {
  if (agent.paused) return "paused";
  if (!online[agent.machine]) return "offline";
  return agent.status;
}

/** Un service dont le veilleur s'est tu depuis ce temps est affiché hors ligne (il relève toutes les 30 s). */
export const SERVICE_STALE_MS = 3 * 60_000;

export const SERVICE_STATUS: Record<ServiceStatus, { label: string; color: string }> = {
  working: { label: "Au travail", color: "var(--ok)" },
  active: { label: "En service", color: "var(--ok)" },
  paused: { label: "En pause", color: "var(--pause)" },
  pausing: { label: "Pause en cours", color: "var(--wait)" },
  resuming: { label: "Reprise en cours", color: "var(--wait)" },
  disabled: { label: "Désactivé sur la machine", color: "var(--fg-2)" },
  down: { label: "En panne", color: "var(--err)" },
  unknown: { label: "État inconnu", color: "var(--quota)" },
  offline: { label: "Plus de nouvelles", color: "var(--err)" },
};

/** État affiché d'un service : veilleur muet d'abord, puis la pause demandée qui n'est pas encore appliquée. */
export function serviceStatus(service: Service, now = Date.now()): ServiceStatus {
  if (!service.statusAt || now - Date.parse(service.statusAt) > SERVICE_STALE_MS) return "offline";
  if (service.pausable && service.paused && service.status !== "paused") return "pausing";
  if (service.pausable && !service.paused && service.status === "paused") return "resuming";
  return service.status;
}
