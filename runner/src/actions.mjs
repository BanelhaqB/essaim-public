/**
 * Actions en un clic : la liste ACTIONS.json tenue par l'agent (dans le dossier de sa mémoire) et l'exécution d'une
 * commande lancée depuis Essaim (shell de la machine, sortie relayée par morceaux, durée max, arrêt).
 * La validation suit celle d'Essaim (web/app/lib/actions.ts).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ACTIONS_FILE = "ACTIONS.json";
export const DEFAULT_TIMEOUT = 60;
const MAX_TIMEOUT = 240;
const MAX_ACTIONS = 30;

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Une action valide (nom + commande ou consigne), dans l'ordre des clés d'ACTIONS.json ; null sinon. */
export function normalizeAction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = text(raw.name, 80).replace(/\s+/g, " ");
  const command = text(raw.command, 4000);
  const prompt = command ? "" : text(raw.prompt, 8000);
  if (!name || (!command && !prompt)) return null;
  const minutes = Math.round(Number(raw.timeoutMinutes));
  const id = text(raw.id, 64);
  return {
    ...(id ? { id } : {}),
    name,
    description: text(raw.description, 300),
    ...(command ? { command } : { prompt }),
    ...(raw.confirm === true ? { confirm: true } : {}),
    ...(Number.isFinite(minutes) && minutes > 0 ? { timeoutMinutes: Math.min(minutes, MAX_TIMEOUT) } : {}),
  };
}

/** Tableau (ou { actions: [...] }) → actions valides, sans nom en double. */
export function normalizeActions(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.actions) ? raw.actions : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const a = normalizeAction(item);
    if (!a || seen.has(a.name.toLowerCase())) continue;
    seen.add(a.name.toLowerCase());
    out.push(a);
    if (out.length >= MAX_ACTIONS) break;
  }
  return out;
}

/** Contenu d'ACTIONS.json : lisible et stable (sert aussi à voir si l'agent l'a modifié). */
export const actionsText = (actions) => `${JSON.stringify(normalizeActions(actions ?? []), null, 2)}\n`;

export function writeActions(dir, actions) {
  const content = actionsText(actions);
  writeFileSync(path.join(dir, ACTIONS_FILE), content);
  return content;
}

/**
 * ACTIONS.json après une session, s'il diffère de ce qui avait été écrit avant (`base`) : { actions, content }.
 * Fichier illisible : { error }. Inchangé ou absent : null.
 */
export function changedActions(dir, base) {
  const file = path.join(dir, ACTIONS_FILE);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  if (raw === base) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `${ACTIONS_FILE} n'est pas du JSON valide (${error.message}).` };
  }
  const actions = normalizeActions(parsed);
  const content = actionsText(actions);
  return content === base ? null : { actions, content };
}

/* ---------------- Exécution ---------------- */

/** Sortie lisible : sans codes de couleur ; une ligne réécrite par \r (barre de progression) garde sa dernière version. */
export function cleanOutput(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r", line.length - 2) + 1).replace(/\r$/, "") : line))
    .join("\n");
}

/**
 * Regroupe la sortie en morceaux (un toutes les `flushMs`) pour ne pas noyer Essaim : `onChunk(text, store)`, avec
 * store = false une fois `maxStored` caractères gardés (la suite ne passe plus qu'en direct). `tail()` : la fin.
 */
export function createOutput({ flushMs = 1500, maxStored = 120_000, tailSize = 12_000, onChunk }) {
  let pending = "";
  let stored = 0;
  let tail = "";
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const chunk = cleanOutput(pending);
    pending = "";
    const store = stored < maxStored;
    if (store) stored += chunk.length;
    onChunk(chunk.length > 20_000 ? `…\n${chunk.slice(-20_000)}` : chunk, store);
  };
  return {
    write(data) {
      const s = String(data);
      pending += s;
      tail = (tail + s).slice(-tailSize);
      if (!timer) timer = setTimeout(flush, flushMs);
    },
    flush,
    /** Une partie de la sortie n'a pas été gardée dans Essaim. */
    get truncated() {
      return stored >= maxStored;
    },
    tail: () => cleanOutput(tail),
  };
}

/** Shell des actions : $SHELL (zsh sur Mac), sinon Git Bash sous Windows (ESSAIM_SHELL pour en imposer un autre). */
export function defaultShell(env = process.env, platform = process.platform) {
  if (env.ESSAIM_SHELL) return env.ESSAIM_SHELL;
  if (platform !== "win32") return env.SHELL || "/bin/zsh";
  const bases = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")].filter(Boolean);
  for (const base of bases) {
    const candidate = path.join(base, "Git", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "bash";
}

/**
 * Lance `command` dans un shell de connexion (PATH de l'utilisateur : Homebrew, nvm…), dans son propre groupe de
 * processus pour pouvoir tout arrêter. Fin : { code, signal, reason } avec reason = "timeout" | "stop" | undefined.
 */
export function runCommand({ command, cwd, env, timeoutMs, onData, shell = defaultShell() }) {
  const win = process.platform === "win32";
  const child = spawn(shell, ["-lc", command], { cwd, env, detached: !win, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let reason;
  const kill = (why) => {
    if (reason || child.exitCode != null) return;
    reason = why;
    const group = (sig) => {
      if (win) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
        return;
      }
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* déjà fini */
      }
    };
    group("SIGTERM");
    // Windows : un second passage attrape les processus lancés pendant le premier.
    if (win) setTimeout(() => group("SIGKILL"), 1_000).unref();
    else setTimeout(() => child.exitCode == null && group("SIGKILL"), 5_000).unref();
  };
  const timer = timeoutMs ? setTimeout(() => kill("timeout"), timeoutMs) : null;
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      onData(`\n${error.message}\n`);
      resolve({ code: 127, signal: null, reason });
    });
    let settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, signal, reason });
    };
    child.on("close", settle);
    // Windows : un processus orphelin peut garder les tuyaux ouverts bien après la fin du shell.
    if (win) child.on("exit", (code, signal) => setTimeout(() => settle(code, signal), 2_000).unref());
  });
  return { child, stop: () => kill("stop"), done };
}

/** Environnement d'une commande : celui du runner sans ses secrets, avec son Node en dernier recours dans le PATH. */
export function commandEnv(base, extra = {}) {
  const env = { ...base, ...extra };
  for (const k of ["RUNNER_TOKEN", "CF_ACCESS_CLIENT_SECRET", "CF_ACCESS_CLIENT_ID", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete env[k];
  env.PATH = [env.PATH, path.dirname(process.execPath)].filter(Boolean).join(path.delimiter);
  return env;
}

/** Durée lisible : « 42 s », « 3 min 05 s », « 1 h 12 min ». */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Phrase de fin d'un lancement, et son statut pour Essaim. */
export function actionOutcome(name, { code, signal, reason }, ms, timeoutMinutes) {
  const took = fmtDuration(ms);
  if (reason === "stop") return { status: "arretee", text: `« ${name} » arrêtée après ${took}.` };
  if (reason === "timeout") return { status: "echouee", text: `« ${name} » coupée : durée max dépassée (${timeoutMinutes} min).` };
  if (code === 0) return { status: "reussie", text: `« ${name} » terminée en ${took}.` };
  return { status: "echouee", text: `« ${name} » en échec (${code != null ? `code ${code}` : `signal ${signal}`}) après ${took}.` };
}
