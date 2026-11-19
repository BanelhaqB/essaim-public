/**
 * Ressources de la machine, envoyées à Essaim à chaque synchro (page « Réglages de la machine ») :
 * processeur (charge, occupation), mémoire, disque, et mémoire prise par chaque run en cours (Claude et ses outils).
 * Les fonctions d'analyse sont pures (testées dans test/resources.test.mjs) ; readResources fait les mesures.
 */
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Mémoire disponible sur macOS : os.freemem() n'y compte que les pages libres, pas le cache récupérable. */
export function parseVmStat(text) {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = (label) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  const free = pages("free") + pages("inactive") + pages("speculative");
  return free > 0 ? free * size : null;
}

/** Occupation du processeur (0..1) entre deux relevés de os.cpus(). */
export function cpuBusy(prev, next) {
  if (!prev || !next || prev.length !== next.length) return null;
  let idle = 0;
  let total = 0;
  next.forEach((cpu, i) => {
    const sum = (t) => t.user + t.nice + t.sys + t.idle + t.irq;
    total += sum(cpu.times) - sum(prev[i].times);
    idle += cpu.times.idle - prev[i].times.idle;
  });
  return total > 0 ? Math.min(1, Math.max(0, 1 - idle / total)) : null;
}

/** Mémoire résidente (octets) de chaque processus et de tous ses descendants, d'après `ps -axo pid=,ppid=,rss=`. */
export function treeRss(psText, pids) {
  const children = new Map();
  const rss = new Map();
  for (const line of psText.split("\n")) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    rss.set(pid, (kb || 0) * 1024);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return pids.map((root) => {
    if (!rss.has(root)) return null;
    let sum = 0;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      sum += rss.get(pid) ?? 0;
      stack.push(...(children.get(pid) ?? []));
    }
    return sum;
  });
}

let lastCpus = null;

/**
 * Relevé complet. `pids` : processus Claude des runs en cours. `dir` : dossier dont on mesure le disque.
 * Une mesure qui échoue vaut null : le reste part quand même.
 */
export async function readResources({ pids = [], dir = os.homedir() } = {}) {
  const cpus = os.cpus();
  const busy = cpuBusy(lastCpus, cpus);
  lastCpus = cpus;
  let memAvailable = os.freemem();
  if (process.platform === "darwin") {
    memAvailable = await run("vm_stat", [], { timeout: 5_000 }).then(({ stdout }) => parseVmStat(stdout) ?? memAvailable, () => memAvailable);
  }
  const disk = await statfs(dir).then(
    (s) => ({ diskTotal: s.blocks * s.bsize, diskFree: s.bavail * s.bsize }),
    () => ({ diskTotal: null, diskFree: null }),
  );
  const runsRss = pids.length
    ? await run("ps", ["-axo", "pid=,ppid=,rss="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }).then(
        ({ stdout }) => treeRss(stdout, pids).filter((n) => n != null),
        () => [],
      )
    : [];
  return {
    at: Date.now(),
    platform: process.platform,
    arch: process.arch,
    host: os.hostname(),
    cpuModel: cpus[0]?.model?.trim() ?? null,
    cpus: cpus.length,
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cpuBusy: busy == null ? null : Math.round(busy * 1000) / 1000,
    memTotal: os.totalmem(),
    memAvailable,
    ...disk,
    runsRss,
    uptime: Math.round(os.uptime()),
  };
}
