/**
 * Veilleur des services d'une machine (un serveur) : relève leur état et applique la pause décidée dans Essaim.
 *
 * Trois sortes de services, décrites dans un fichier JSON (runner/services.example.json) :
 * - `hub-agent` : un des agents d'un « hub », un processus (unité systemd) qui fait tourner plusieurs agents planifiés
 *   et expose `GET <statusUrl>` → { jobs: [{ name, cron, enabled, running, lastRun }], …compteurs }. Les agents ne se
 *   coupent que par une variable lue au démarrage (`flag`, ex. SOURCING_ENABLED). La pause pose donc un drop-in
 *   systemd qui force la variable à false (l'environnement du processus prime sur `node --env-file`, le .env n'est
 *   jamais touché), puis redémarre le hub, seulement quand aucun de ses jobs ne tourne.
 * - `systemd` : des unités qu'on arrête et désactive (`disable --now`) pour la pause, pour qu'elle tienne au redémarrage.
 * - `http` : un service qu'on ne fait que surveiller (pas de pause).
 *
 * Les effets (systemctl, fichiers, réseau) sont injectés pour les tests.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const isHubAgent = (s) => s.type === "hub-agent";
const DROP_IN = "essaim-pause.conf";
const UNIT_PROPS = "Id,ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,NRestarts,MemoryCurrent,LastTriggerUSec";

/** États rapportés à Essaim. */
export const STATUS = {
  working: "working", // un job est en cours
  active: "active", // en service, attend son prochain créneau
  paused: "paused",
  disabled: "disabled", // coupé hors d'Essaim (configuration du service)
  down: "down", // arrêté, en échec ou injoignable
  unknown: "unknown",
};

/** Lit les blocs `clé=valeur` de `systemctl show` (un bloc par unité, séparés par une ligne vide). */
export function parseShow(text) {
  const units = {};
  for (const block of text.split(/\n\s*\n/)) {
    const props = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    if (props.Id) units[props.Id] = props;
  }
  return units;
}

/** `--timestamp=unix` donne « @1728737698 » ; vide ou « n/a » quand l'unité n'a jamais démarré. */
export function unixToIso(value) {
  const m = /^@(\d+)/.exec(value ?? "");
  return m && m[1] !== "0" ? new Date(Number(m[1]) * 1000).toISOString() : null;
}

const isUp = (u) => u?.ActiveState === "active";
const isTimer = (id) => id.endsWith(".timer");

/** Contenu du drop-in pour ces variables à couper ; vide : pas de drop-in. */
export function dropInContent(flags) {
  if (!flags.length) return "";
  return [
    "# Géré par Essaim (veilleur des services) : agents mis en pause. Ne pas modifier à la main.",
    "[Service]",
    ...[...flags].sort().map((f) => `Environment="${f}=false"`),
    "",
  ].join("\n");
}

/** Variables coupées par un drop-in existant. */
export function flagsIn(content) {
  return [...String(content).matchAll(/^Environment="?([A-Z0-9_]+)=false"?$/gm)].map((m) => m[1]);
}

const PROSPECT_LABELS = {
  nouveau: "Nouveaux",
  contacte: "Contactés",
  en_discussion: "En discussion",
  interesse: "Intéressés",
  converti: "Convertis",
  non_interesse: "Pas intéressés",
  injoignable: "Injoignables",
  stop: "STOP",
};

export function createServices({
  config,
  sh = async (cmd, args) => (await run(cmd, args, { timeout: 60_000 })).stdout,
  fetchImpl = fetch,
  fs = { readFile, writeFile, rm, mkdir },
  unitDir = "/etc/systemd/system",
  log = console,
}) {
  const services = config.services ?? [];
  /** Dernier état demandé par Essaim : id → en pause. */
  let desired = {};
  /** Pourquoi une pause ou une reprise attend encore : id → texte. */
  const pending = {};
  const errors = {};

  const dropInPath = (unit) => path.join(unitDir, `${unit}.d`, DROP_IN);
  const readDropIn = (unit) => fs.readFile(dropInPath(unit), "utf8").catch(() => "");

  async function units() {
    const ids = [...new Set(services.flatMap((s) => (isHubAgent(s) ? [s.unit] : (s.units ?? []))))];
    if (!ids.length) return {};
    try {
      return parseShow(await sh("systemctl", ["show", "--timestamp=unix", "-p", UNIT_PROPS, ...ids]));
    } catch (error) {
      log.error("systemctl show :", error.message);
      return {};
    }
  }

  async function getJson(url) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return { body: await res.json().catch(() => ({})) };
    } catch (error) {
      return { error: error.name === "TimeoutError" ? "ne répond pas" : error.message };
    }
  }

  /** Les réponses des URL d'état, une fois chacune par relevé. */
  async function probes() {
    const urls = [...new Set(services.flatMap((s) => [s.statusUrl, s.healthUrl, s.url].filter(Boolean)))];
    return Object.fromEntries(await Promise.all(urls.map(async (u) => [u, await getJson(u)])));
  }

  function unitFacts(list, state) {
    return list.map((id) => {
      const u = state[id];
      if (!u) return { label: id, value: "inconnue", tone: "err" };
      const since = unixToIso(u.ActiveEnterTimestamp);
      const last = unixToIso(u.LastTriggerUSec);
      const value = `${u.ActiveState} (${u.SubState})`;
      // Un minuteur se juge à son dernier passage, un service à l'heure où il a démarré.
      if (isTimer(id)) return { label: id, value, at: last ?? undefined, atLabel: "dernier passage", tone: isUp(u) ? undefined : "err" };
      return { label: id, value, at: isUp(u) && since ? since : undefined, atLabel: "depuis", tone: isUp(u) ? undefined : "err" };
    });
  }

  function hubAgentReport(s, state, probe, dropIns) {
    const unit = state[s.unit];
    const status = probe[s.statusUrl] ?? {};
    const hub = status.body ?? {};
    const jobs = (hub.jobs ?? []).filter((j) => (s.jobs ?? []).includes(j.name));
    const main = jobs.find((j) => j.name === s.jobs?.[0]);
    const applied = flagsIn(dropIns[s.unit] ?? "").includes(s.flag);
    const detail = {
      summary: "",
      since: unixToIso(unit?.ActiveEnterTimestamp),
      jobs: jobs.map((j) => ({
        name: j.name,
        cron: j.cron,
        enabled: Boolean(j.enabled),
        running: Boolean(j.running),
        lastStatus: j.lastRun?.status ?? null,
        lastAt: j.lastRun?.finishedAt ?? null,
        durationMs: j.lastRun?.durationMs ?? null,
      })),
      facts: [],
      counts: [],
    };
    let st;
    if (!isUp(unit)) {
      st = STATUS.down;
      detail.summary = unit ? `Le hub est arrêté (${unit.ActiveState}).` : "Le hub est introuvable sur la machine.";
    } else if (applied) {
      st = STATUS.paused;
      detail.summary = `En pause : ${s.flag}=false.`;
    } else if (status.error) {
      st = STATUS.unknown;
      detail.summary = `L'état du hub ne répond pas : ${status.error}.`;
    } else if (main && !main.enabled) {
      st = STATUS.disabled;
      detail.summary = "Désactivé par la configuration du hub (variable, clé ou contexte manquant).";
    } else if (jobs.some((j) => j.running)) {
      st = STATUS.working;
      detail.summary = `Au travail : ${jobs.filter((j) => j.running).map((j) => j.name).join(", ")}.`;
    } else {
      st = STATUS.active;
      detail.summary = main?.lastRun ? `Dernier passage ${main.lastRun.status === "ok" ? "réussi" : "en échec"}.` : "En service.";
    }
    for (const what of s.show ?? []) {
      if (what === "prospects" && hub.prospects) {
        detail.counts.push({ label: "Prospects", value: hub.prospects.total ?? 0 });
        for (const [k, v] of Object.entries(hub.prospects)) if (k !== "total" && v) detail.counts.push({ label: PROSPECT_LABELS[k] ?? k, value: v });
      }
      if (what === "handoffs" && hub.handoffs) detail.counts.push({ label: "Questions pour toi", value: hub.handoffs.pending ?? 0, tone: hub.handoffs.pending ? "warn" : undefined });
      if (what === "quota" && hub.claude?.windows) {
        const w = hub.claude.windows;
        if (w.five_hour) detail.facts.push({ label: "Quota Claude (5 h)", value: `${w.five_hour.percent} %` });
        if (w.seven_day) detail.facts.push({ label: "Quota Claude (7 jours)", value: `${w.seven_day.percent} %` });
      }
      if (what === "sms" && hub.sms) detail.facts.push({ label: "Passerelle SMS", value: hub.sms.gateway ? `branchée (SIM ${hub.sms.sim ?? "?"})` : "absente", tone: hub.sms.gateway ? undefined : "err" });
    }
    detail.facts.push({ label: "Mise en pause", value: `${s.flag}=false, puis redémarrage du hub` });
    return { status: st, detail };
  }

  function systemdReport(s, state, probe) {
    const list = s.units ?? [];
    const detail = { summary: "", facts: unitFacts(list, state), counts: [] };
    const first = state[list[0]];
    const down = list.filter((id) => !isUp(state[id]));
    let st;
    if (s.pausable !== false && first?.UnitFileState === "disabled" && down.length === list.length) {
      st = STATUS.paused;
      detail.summary = "En pause : unités arrêtées et désactivées.";
    } else if (down.length) {
      st = STATUS.down;
      detail.summary = `Arrêté : ${down.join(", ")}.`;
    } else {
      st = STATUS.active;
      detail.summary = "En service.";
      detail.since = unixToIso(first?.ActiveEnterTimestamp);
    }
    if (s.healthUrl && st !== STATUS.paused) {
      const h = probe[s.healthUrl] ?? {};
      if (h.error) {
        if (st === STATUS.active) st = STATUS.down;
        detail.summary = `Ne répond pas à ${s.healthUrl} : ${h.error}.`;
      } else if (h.body?.repo?.commit) {
        detail.facts.push({ label: "Code lu", value: `${String(h.body.repo.commit).slice(0, 7)}${h.body.repo.date ? ` · ${h.body.repo.date}` : ""}` });
      }
    }
    return { status: st, detail };
  }

  function httpReport(s, probe) {
    const h = probe[s.url] ?? {};
    return h.error
      ? { status: STATUS.down, detail: { summary: `Ne répond pas : ${h.error}.`, facts: [{ label: "Adresse", value: s.url }], counts: [] } }
      : { status: STATUS.active, detail: { summary: "Répond.", facts: [{ label: "Adresse", value: s.url }], counts: [] } };
  }

  return {
    /** Relève l'état de chaque service, au format attendu par /api/runner/services. */
    async collect() {
      const [state, probe] = await Promise.all([units(), probes()]);
      const hubUnits = [...new Set(services.filter(isHubAgent).map((s) => s.unit))];
      const dropIns = Object.fromEntries(await Promise.all(hubUnits.map(async (u) => [u, await readDropIn(u)])));
      return services.map((s, position) => {
        const r = isHubAgent(s) ? hubAgentReport(s, state, probe, dropIns) : s.type === "systemd" ? systemdReport(s, state, probe) : httpReport(s, probe);
        if (pending[s.id]) r.detail.pending = pending[s.id];
        if (errors[s.id]) r.detail.error = errors[s.id];
        return {
          id: s.id,
          group: s.group ?? "",
          name: s.name ?? s.id,
          description: s.description ?? "",
          pausable: s.type !== "http" && s.pausable !== false,
          position,
          status: r.status,
          detail: r.detail,
        };
      });
    },

    /**
     * Applique l'état demandé dans Essaim. Un service qu'Essaim ne connaît pas encore garde son état actuel.
     * Renvoie true si quelque chose a changé (le relevé suivant est alors avancé).
     */
    async apply(next) {
      desired = { ...next };
      let changed = false;
      // Agents du hub : un drop-in par unité, qui réunit les variables de tous ses agents en pause.
      const byUnit = new Map();
      for (const s of services.filter(isHubAgent)) byUnit.set(s.unit, [...(byUnit.get(s.unit) ?? []), s]);
      for (const [unit, agents] of byUnit) {
        const current = await readDropIn(unit);
        const was = new Set(flagsIn(current));
        const flags = agents.filter((s) => (s.id in desired ? desired[s.id] : was.has(s.flag))).map((s) => s.flag);
        const content = dropInContent(flags);
        for (const s of agents) delete pending[s.id];
        if (content === current) continue;
        const moving = agents.filter((s) => flags.includes(s.flag) !== was.has(s.flag));
        // Redémarrer coupe les jobs en cours (SMS, synthèse…) : on attend qu'ils soient finis.
        const statusUrl = agents.find((s) => s.statusUrl)?.statusUrl;
        const running = statusUrl ? ((await getJson(statusUrl)).body?.jobs ?? []).filter((j) => j.running).map((j) => j.name) : [];
        if (running.length) {
          for (const s of moving) pending[s.id] = `${desired[s.id] ? "Pause" : "Reprise"} au prochain moment calme : ${running.join(", ")} en cours.`;
          continue;
        }
        try {
          if (content) {
            await fs.mkdir(path.dirname(dropInPath(unit)), { recursive: true });
            await fs.writeFile(dropInPath(unit), content);
          } else {
            await fs.rm(dropInPath(unit), { force: true });
          }
          await sh("systemctl", ["daemon-reload"]);
          await sh("systemctl", ["restart", unit]);
          for (const s of agents) delete errors[s.id];
          log.log(`${unit} redémarré, agents en pause : ${flags.join(", ") || "aucun"}`);
          changed = true;
        } catch (error) {
          for (const s of moving) errors[s.id] = `Échec : ${error.message}`.slice(0, 300);
          log.error(`${unit} :`, error.message);
        }
      }
      // Unités simples : arrêtées et désactivées pendant la pause.
      const state = await units();
      for (const s of services.filter((x) => x.type === "systemd" && x.pausable !== false && x.id in desired)) {
        const list = s.units ?? [];
        const paused = state[list[0]]?.UnitFileState === "disabled" && list.every((id) => !isUp(state[id]));
        if (paused === Boolean(desired[s.id])) continue;
        try {
          await sh("systemctl", [desired[s.id] ? "disable" : "enable", "--now", ...list]);
          delete errors[s.id];
          log.log(`${s.id} : ${desired[s.id] ? "mis en pause" : "relancé"}`);
          changed = true;
        } catch (error) {
          errors[s.id] = `Échec : ${error.message}`.slice(0, 300);
          log.error(`${s.id} :`, error.message);
        }
      }
      return changed;
    },
  };
}
