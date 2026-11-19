/**
 * Machines : places (runs simultanés) et ressources relevées par le runner (runner/src/resources.mjs).
 * Partagé entre le serveur (synchro, action de la page) et l'interface (curseur, jauges).
 */

/** Plafond des places, le même que le runner (runner/src/scheduler.mjs, MAX_CAPACITY). */
export const MAX_CAPACITY = 16;

export interface MachineResources {
  at?: number;
  platform?: string;
  arch?: string;
  host?: string;
  cpuModel?: string | null;
  cpus?: number;
  load?: number[];
  cpuBusy?: number | null;
  memTotal?: number;
  memAvailable?: number | null;
  diskTotal?: number | null;
  diskFree?: number | null;
  /** Mémoire de chaque run en cours (Claude et tout ce qu'il a lancé), en octets. */
  runsRss?: number[];
  uptime?: number;
  /** Runs de tickets et discussions en cours (ajoutés par la synchro). */
  running?: number;
  chats?: number;
}

export const machineLabel = (name: string) => (name === "mac" ? "Mac" : name === "nuc" ? "Serveur" : name);

/** Durées proposées pour un réglage ponctuel ; 0 = jusqu'à nouvel ordre. */
export const DURATIONS = [
  { value: 2, label: "2 h" },
  { value: 8, label: "8 h" },
  { value: 24, label: "24 h" },
  { value: 0, label: "Sans limite" },
] as const;
export const DEFAULT_DURATION = 8;

/** Nombre de places saisi : entier entre 1 et MAX_CAPACITY, sinon null. */
export function parseCapacity(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_CAPACITY ? n : null;
}

/** Échéance d'un réglage (ISO) d'après la durée choisie en heures ; null = sans limite. */
export function untilFor(hours: unknown, now = Date.now()): string | null {
  const h = Number(hours);
  if (!DURATIONS.some((d) => d.value === h) || h === 0) return null;
  return new Date(now + h * 3_600_000).toISOString();
}

const GIB = 1024 ** 3;
/** Mémoire supposée d'un run tant qu'aucun n'a été mesuré (Claude, ses outils, un build ou un serveur de dev). */
export const DEFAULT_RUN_BYTES = 1.5 * GIB;

/**
 * Places conseillées d'après les ressources : la mémoire libre (en gardant de quoi travailler à côté)
 * divisée par la mémoire d'un run (mesurée en moyenne, sinon DEFAULT_RUN_BYTES), plus les runs en cours,
 * et pas plus d'un run pour deux cœurs (builds et tests sont gourmands).
 */
export function suggestCapacity(r: MachineResources | null | undefined) {
  if (!r?.memTotal || !r.cpus) return null;
  const measured = (r.runsRss ?? []).filter((n) => n > 0);
  const perRun = Math.max(0.5 * GIB, measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : DEFAULT_RUN_BYTES);
  const reserve = Math.max(2 * GIB, r.memTotal * 0.15);
  const available = r.memAvailable ?? r.memTotal * 0.5;
  const byMemory = measured.length + Math.floor(Math.max(0, available - reserve) / perRun);
  const byCpu = Math.max(1, Math.floor(r.cpus / 2));
  const value = Math.min(MAX_CAPACITY, Math.max(1, Math.min(byMemory, byCpu)));
  return { value, perRun, measured: measured.length > 0, limit: byMemory < byCpu ? ("memoire" as const) : ("processeur" as const) };
}

export function fmtBytes(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= GIB) return `${(n / GIB).toLocaleString("fr-FR", { maximumFractionDigits: n >= 100 * GIB ? 0 : 1 })} Go`;
  return `${Math.round(n / 1024 ** 2).toLocaleString("fr-FR")} Mo`;
}

export function fmtUptime(s: number | null | undefined) {
  if (!s) return "";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  return d ? `${d} j ${h} h` : `${h} h ${Math.floor((s % 3_600) / 60)} min`;
}

const parisDay = (t: number) => new Date(t).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });

/** Échéance à venir : « 18:30 », « demain 08:00 » ou « 20 nov. 08:00 » (heure de Paris). */
export function fmtUntil(iso: string, now = Date.now()) {
  const t = Date.parse(iso);
  const time = new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  if (parisDay(t) === parisDay(now)) return time;
  if (parisDay(t) === parisDay(now + 86_400_000)) return `demain ${time}`;
  return `${new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" })} ${time}`;
}
