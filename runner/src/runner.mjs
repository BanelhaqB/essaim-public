#!/usr/bin/env node
/**
 * Runner d’Essaim : fait travailler les agents d'une machine (un Mac, en général) sur leurs tickets.
 *
 * Toutes les POLL_MS, il :
 *   1. envoie l'état de la machine à Essaim et reçoit ses agents (repo, pause, priorité, droits), leur file de tâches
 *      dans l'ordre choisi, les réponses écrites dans Essaim, et les issues miroir à créer ou à mettre à jour ;
 *   2. cherche aussi les réponses aux questions postées en commentaire des issues ;
 *   3. arrête les runs des agents mis en pause (ou en mode « Je travaille »), reprend les runs interrompus,
 *      puis donne un nouveau ticket aux agents libres, dans l'ordre de priorité et dans la limite de CAPACITY ;
 *   4. quand la limite de l'abonnement tombe, attend sa réinitialisation et reprend les mêmes sessions Claude ;
 *   5. lance les actions en un clic demandées dans Essaim (commandes, hors des places des agents).
 * Variables : README.md (section Runner).
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authAlert, hitAuthError, readAuthStatus } from "./auth.mjs";
import { forRepo, linkFor } from "./team.mjs";
import { actionOutcome, actionsText, changedActions, commandEnv, createOutput, DEFAULT_TIMEOUT, runCommand } from "./actions.mjs";
import { runClaude, stopClaude } from "./claude.mjs";
import { createControl } from "./control.mjs";
import { createLive } from "./live.mjs";
import { comment, createIssue, ensureRepo, linkSubIssue, prepareActionDir, prepareWorktree, removeWorktree, replySince, repoDescription, setStage, updateIssue } from "./github.mjs";
import { changedMemory, memoryDir, writeMemory } from "./memory.mjs";
import { chatPrompt, newTicketPrompt, RESULT_SCHEMA, resumePrompt, SUBAGENTS, systemPrompt } from "./prompt.mjs";
import { readResources } from "./resources.mjs";
import { agentStates, blockedUntil, effectiveCapacity, plan, startFailure, taskOf } from "./scheduler.mjs";
import { hitUsageLimit } from "./stream.mjs";
import { loadState, recoverRuns, saveState } from "./state.mjs";
import { pullUpdate, readyToRestart } from "./update.mjs";

export const VERSION = "0.1.0";

const cfg = {
  controlUrl: process.env.CONTROL_URL,
  token: process.env.RUNNER_TOKEN,
  accessId: process.env.CF_ACCESS_CLIENT_ID,
  accessSecret: process.env.CF_ACCESS_CLIENT_SECRET,
  machine: process.env.MACHINE || "mac",
  capacity: Number(process.env.CAPACITY || 2),
  home: process.env.ESSAIM_HOME || path.join(homedir(), ".essaim"),
  bin: process.env.CLAUDE_BIN || "claude",
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  effort: process.env.CLAUDE_EFFORT || "high",
  pollMs: Number(process.env.POLL_MS || 20_000),
  replyCheckMs: Number(process.env.REPLY_CHECK_MS || 120_000),
  autoUpdate: process.env.AUTO_UPDATE !== "0",
  updateCheckMs: Number(process.env.UPDATE_CHECK_MS || 30 * 60_000),
};
if (!cfg.controlUrl || !cfg.token || cfg.token.length < 32) {
  console.error("CONTROL_URL et RUNNER_TOKEN (32 caractères au moins) sont requis.");
  process.exit(1);
}

const STATE_FILE = path.join(cfg.home, "state.json");
const state = recoverRuns(loadState(STATE_FILE));
const save = () => saveState(STATE_FILE, state);
const control = createControl({ url: cfg.controlUrl, token: cfg.token, accessId: cfg.accessId, accessSecret: cfg.accessSecret, machine: cfg.machine });

/** runId → { child, stopReason?, lastMilestoneAt, stallNotified } */
const live = new Map();
/** Tâches prêtes et pas encore prises, par agent (file d'Essaim, dans l'ordre). */
const readyCount = {};
/** agentId → dernier échec de prise de ticket : essai différé, erreur signalée une seule fois (scheduler.startFailure). */
const startFailures = {};
/** runId → réponse trouvée sur l'issue ou écrite dans Essaim. */
const replies = {};
/** runId → la réponse vient d'Essaim (à recopier sur l'issue). */
const repliesFromEssaim = new Set();
const lastReplyCheck = {};

const log = (...args) => console.log(new Date().toISOString(), ...args);
/** Places de la machine : CAPACITY, ou le réglage ponctuel fait dans Essaim. */
const capacity = () => effectiveCapacity(cfg.capacity, state.capacityOverride, Date.now());
const agentOf = (id) => state.agents.find((a) => a.id === id);
state.conversations ??= {};
/** Lancements d'actions déjà pris (pour ne pas relancer une action que la synchro renvoie encore), et ceux en cours. */
state.actionsSeen ??= [];
state.actionsRunning ??= {};
/** Tâches mises en pause dans Essaim (gardées sur disque : au redémarrage, elles ne reprennent pas avant la synchro). */
state.held ??= [];

/* ---------------- Fil en direct (hub d'Essaim) ---------------- */

const link = createLive({
  url: cfg.controlUrl,
  token: cfg.token,
  machine: cfg.machine,
  log,
  onMessage(msg) {
    if (msg.type === "user_message") deliver(msg);
    else if (msg.type === "action_run") startAction(msg);
    else if (msg.type === "action_stop") actionRuns.get(msg.id)?.stop();
    else if (msg.type === "task_hold") holdTask(String(msg.taskId ?? ""), Boolean(msg.hold));
    else if (msg.type === "task_abandon") dropAbandoned([String(msg.taskId ?? "")]).then(save);
    else if (msg.type === "sync") syncNow();
  },
});
/** Messages du propriétaire déjà traités (reçus en direct et par la synchro). */
const seenMessages = new Set();
/** La conversation d'un run : celle de sa tâche (les runs d'avant les tâches ont l'identifiant de leur tâche). */
const convOf = taskOf;
const push = (agentId, event) => link.send({ type: "live", agentId, event });

/** Un message dans le fil d'une conversation : en direct sur la page, et gardé dans Essaim (sauf store = false). */
function say(agentId, conversationId, role, text, level, store = true) {
  const mid = randomUUID();
  const at = new Date().toISOString();
  if (store) control.event({ agentId, conversationId, kind: "msg", role, level, text, mid });
  push(agentId, { type: "message", conversationId, message: { id: mid, mid, conversationId, role, level: level ?? null, text, at } });
}

/** Ce que Claude produit, dans le fil : son texte (en direct puis en entier) et ses appels d'outils. */
function relay(agentId, conversationId, info, entry) {
  if (info.delta) push(agentId, { type: "delta", conversationId, text: info.delta });
  for (const t of info.texts) say(agentId, conversationId, "agent", t);
  for (const l of info.logs) if (l.level !== "think") say(agentId, conversationId, "tool", l.text, l.level);
  const next = info.result ? "idle" : info.active ? "working" : null;
  if (next && entry && entry.shown !== next) {
    entry.shown = next;
    push(agentId, { type: "status", conversationId, state: next });
  }
}

function ack(ids) {
  control.event({ kind: "msg_ack", ids });
  link.send({ type: "ack", ids });
}

/* ---------------- Mémoire et consommation ---------------- */

/** Une session de cet agent est-elle déjà ouverte (tâche ou conversation) ? Elle a peut-être modifié MEMOIRE.md. */
const viewOf = (run) => forRepo(agentOf(run.agentId), run.repoId);
const agentBusy = (agentId, key = "") =>
  state.runs.some((r) => r.agentId === agentId && live.has(r.id) && (viewOf(r)?.memoryKey ?? "") === key) ||
  [...chats.values()].some((c) => c.agentId === agentId && (c.memoryKey ?? "") === key);

/** agentId → ACTIONS.json tel qu'écrit avant la dernière session : l'agent l'a modifié s'il diffère après. */
const actionsBase = {};
/** agentId → dernière erreur de lecture d'ACTIONS.json signalée (une seule fois). */
const actionsErrors = {};

/**
 * Prépare les fichiers de mémoire avant une session ; garde MEMOIRE.md et ACTIONS.json si une autre session de l'agent,
 * encore ouverte, les a modifiés.
 */
function memoryFor(agent) {
  const key = agent.memoryKey ?? "";
  const sk = `${agent.id}:${key}`;
  const busy = agentBusy(agent.id, key);
  const memory = busy ? changedMemory(cfg.home, agent) : null;
  const keepActions = busy && changedActions(memoryDir(cfg.home, agent.id, key), actionsBase[sk]) != null;
  const dir = writeMemory(cfg.home, memory != null ? { ...agent, memory } : agent, { keepActions });
  if (!keepActions) actionsBase[sk] = actionsText(agent.actions);
  return dir;
}

/** Après une session (ou un tour de conversation) : MEMOIRE.md et ACTIONS.json modifiés par l'agent → Essaim. */
function uploadMemory(agentId, conversationId, repoId) {
  const base = agentOf(agentId);
  if (!base) return;
  const agent = forRepo(base, repoId);
  const sk = `${agentId}:${agent.memoryKey ?? ""}`;
  const text = changedMemory(cfg.home, agent);
  if (text != null) {
    const link = linkFor(base, repoId);
    if (link && !base.specialty) link.memory = text;
    else base.memory = text;
    control.event({ agentId, repoId: agent.repoId, kind: "memory", text });
  }
  const changed = changedActions(memoryDir(cfg.home, agentId, agent.memoryKey), actionsBase[sk]);
  if (changed?.error) {
    if (actionsErrors[sk] !== changed.error && conversationId) say(agentId, conversationId, "system", `${changed.error} Les actions d'Essaim restent inchangées.`);
    actionsErrors[sk] = changed.error;
  } else if (changed) {
    delete actionsErrors[sk];
    actionsBase[sk] = changed.content;
    base.actions = changed.actions;
    control.event({ agentId, kind: "actions", text: `${changed.actions.length} action(s)`, actions: changed.actions });
    if (conversationId) say(agentId, conversationId, "system", `Actions en un clic mises à jour : ${changed.actions.map((a) => `« ${a.name} »`).join(", ") || "aucune"}.`);
  }
}

const reportUsage = (agentId, usage, taskId, conversationId) => usage && control.event({ agentId, taskId, conversationId, kind: "usage", text: "", usage });

function snapshot(run) {
  const { id, agentId, taskId, repoId, status, reason, sessionId, prUrl, summary, startedAt } = run;
  return { id, agentId, taskId, repoId, status, reason, sessionId, prUrl, summary, startedAt, issueNumber: run.issue.number, issueTitle: run.issue.title, issueUrl: run.issue.url };
}
const emit = (run, kind, text, extra = {}) => control.event({ agentId: run.agentId, runId: run.id, taskId: run.taskId, kind, text, run: snapshot(run), ...extra });

/* ---------------- Quota ---------------- */

function onRateLimit(rl) {
  state.quota = { ...state.quota, status: rl.status, fiveHour: rl.fiveHour, sevenDay: rl.sevenDay, resetsAt: rl.resetsAt, updatedAt: Date.now() };
  if (rl.status === "rejected" && !(state.quota.blockedUntil > Date.now())) {
    state.quota.blockedUntil = blockedUntil(rl.resetsAt, Date.now());
    control.event({ kind: "quota_hit", text: `Limite atteinte. Reprise automatique vers ${new Date(state.quota.blockedUntil).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`, quota: state.quota });
    log("Limite de l'abonnement atteinte, reprise à", new Date(state.quota.blockedUntil).toISOString());
  }
}

function checkQuotaReset() {
  if (state.quota.blockedUntil && Date.now() >= state.quota.blockedUntil) {
    delete state.quota.blockedUntil;
    state.quota.status = "allowed";
    const waiting = state.runs.filter((r) => r.status === "interrupted" && r.reason === "quota").length;
    control.event({ kind: "quota_reset", text: waiting ? `Quota réinitialisé : ${waiting} ticket(s) reprennent.` : "Quota réinitialisé.", quota: state.quota });
    save();
  }
}

/* ---------------- Connexion Claude ---------------- */

const AUTH_CHECK_MS = 6 * 3_600_000;
const AUTH_ALERT_MS = 20 * 3_600_000;
let authChecking = false;

/** Annonce un souci de connexion au plus une fois par jour et par type, pour ne pas inonder Telegram. */
function alertAuth(alert) {
  state.authAlerts ??= {};
  if (Date.now() - (state.authAlerts[alert.kind] ?? 0) < AUTH_ALERT_MS) return;
  state.authAlerts[alert.kind] = Date.now();
  control.event({ kind: alert.kind, level: alert.kind === "auth_expired" ? "error" : "warn", text: alert.text });
  log(alert.text);
  save();
}

/** Interroge `claude auth status` toutes les 6 h : prévient avant l'expiration plutôt qu'après l'arrêt des agents. */
async function checkAuth() {
  if (authChecking || Date.now() - (state.authCheckedAt ?? 0) < AUTH_CHECK_MS) return;
  authChecking = true;
  try {
    state.authCheckedAt = Date.now();
    const alert = authAlert(await readAuthStatus(cfg.bin));
    if (alert) alertAuth(alert);
    save();
  } finally {
    authChecking = false;
  }
}

/* ---------------- Exécution d'un run ---------------- */

function execute(run, prompt) {
  const agent = viewOf(run);
  Object.assign(run, { status: "running", reason: undefined, lastActivityAt: Date.now() });
  save();
  const entry = { stopReason: undefined, lastMilestoneAt: Date.now(), stallNotified: false, startedAt: Date.now() };
  let lastRateLimit;

  const dir = memoryFor(agent);
  const { child, send, end, done } = runClaude({
    bin: cfg.bin,
    cwd: run.worktree,
    prompt,
    system: systemPrompt(agent, dir),
    schema: RESULT_SCHEMA,
    resume: run.sessionId,
    addDirs: [dir],
    agents: SUBAGENTS,
    model: agent.settings?.model || cfg.model,
    effort: agent.settings?.effort || cfg.effort,
    onMessage(info) {
      if (info.sessionId && info.sessionId !== run.sessionId) {
        run.sessionId = info.sessionId;
        save();
      }
      relay(run.agentId, convOf(run), info, entry);
      // Fin d'un tour : sans nouveau message du propriétaire dans les 4 s, la tâche s'arrête là (sinon Claude enchaîne).
      if (info.active && entry.endTimer) {
        clearTimeout(entry.endTimer);
        entry.endTimer = null;
      }
      if (info.result) {
        entry.endTimer = setTimeout(() => entry.end?.(), 4_000);
        reportUsage(run.agentId, info.result.usage, convOf(run), convOf(run));
      }
      for (const m of info.milestones) {
        entry.lastMilestoneAt = Date.now();
        entry.stallNotified = false;
        emit(run, "milestone", m);
      }
      if (info.rateLimit) {
        lastRateLimit = info.rateLimit;
        onRateLimit(info.rateLimit);
      }
      run.lastActivityAt = Date.now();
    },
  });
  Object.assign(entry, { child, send, end });
  live.set(run.id, entry);
  done.then((exit) => finish(run, entry, exit, lastRateLimit)).catch((error) => log("Fin de run en erreur :", error));
}

async function finish(run, entry, { code, signal, result, stderr }, lastRateLimit) {
  live.delete(run.id);
  clearTimeout(entry.endTimer);
  uploadMemory(run.agentId, convOf(run), run.repoId);
  push(run.agentId, { type: "status", conversationId: convOf(run), state: "idle" });
  const agent = viewOf(run);
  try {
    if (entry.stopReason === "budget") {
      await askHuman(run, `J'ai atteint le temps maximum fixé pour ce ticket (${agent?.settings?.maxMinutes} min). Mon travail est poussé sur la branche \`${run.git.branch}\`. Je continue, je m'arrête, ou je découpe le ticket ?`);
    } else if (entry.stopReason === "abandon") {
      await forgetRun(run);
      log(`Tâche abandonnée : run de #${run.issue.number} arrêté et retiré.`);
    } else if (entry.stopReason === "hold") {
      Object.assign(run, { status: "interrupted", reason: "hold" });
      emit(run, "interrupted", "Mise en pause depuis Essaim.");
      say(run.agentId, convOf(run), "system", "Tâche en pause : son travail est gardé, elle reprendra là où elle s'est arrêtée.");
    } else if (entry.stopReason) {
      Object.assign(run, { status: "interrupted", reason: entry.stopReason });
      emit(run, "interrupted", `Arrêté (${entry.stopReason}).`);
    } else if (hitUsageLimit(result, lastRateLimit)) {
      if (!(state.quota.blockedUntil > Date.now())) onRateLimit({ ...(lastRateLimit ?? {}), status: "rejected" });
      Object.assign(run, { status: "interrupted", reason: "quota" });
      emit(run, "interrupted", "Mis en attente : limite de l'abonnement.");
    } else if (result && !result.isError && result.structured?.status) {
      await conclude(run, result.structured);
    } else if (hitAuthError(result, stderr)) {
      // Pas une erreur du ticket : on ne compte pas l'essai, on attend que la connexion soit renouvelée.
      Object.assign(run, { status: "interrupted", reason: "auth", retryAfter: Date.now() + 10 * 60_000 });
      emit(run, "interrupted", "Connexion Claude expirée : le ticket reprend dès qu'elle est renouvelée.");
      alertAuth({ kind: "auth_expired", text: "Connexion Claude expirée : les agents sont en attente. Lance `claude auth login` sur la machine du runner (ou `claude setup-token`). Les tickets reprennent seuls ensuite." });
    } else {
      run.attempts = (run.attempts ?? 0) + 1;
      const why = (result?.text || stderr || `code ${code ?? signal}`).trim().slice(-500);
      if (run.attempts >= 3) {
        await askHuman(run, `Je bute sur une erreur répétée (3 essais) :\n\n\`\`\`\n${why}\n\`\`\`\n\nMon travail est sur la branche \`${run.git.branch}\`. Remets l'étiquette agent:ready ou réponds pour que je reprenne.`);
        emit(run, "failed", why);
      } else {
        Object.assign(run, { status: "interrupted", reason: "crash", retryAfter: Date.now() + 2 * 60_000 });
        emit(run, "interrupted", `Session interrompue (${why.slice(0, 160)}). Nouvel essai dans 2 min.`);
      }
    }
  } catch (error) {
    log(`Run ${run.id} : erreur de clôture`, error);
    Object.assign(run, { status: "interrupted", reason: "crash", retryAfter: Date.now() + 5 * 60_000 });
  }
  save();
  await control.flush();
}

async function conclude(run, out) {
  run.summary = out.summary;
  if (out.prUrl) run.prUrl = out.prUrl;
  if (out.status === "split" && out.steps?.length) {
    const list = out.steps.map((st, i) => `${i + 1}. ${st.title}`).join("\n");
    await comment(run.repo, run.issue.number, `Tâche découpée en ${out.steps.length} étapes, traitées une à une (sous-issues) :\n\n${list}\n\n${out.summary}`);
    run.status = "done";
    control.event({ agentId: run.agentId, runId: run.id, taskId: convOf(run), kind: "split", text: `${out.steps.length} étapes`, steps: out.steps, run: snapshot(run) });
    await removeWorktree(cfg.home, run.repo, run.worktree);
    state.runs = state.runs.filter((r) => r.id !== run.id);
    return;
  }
  if (out.status === "needs_expert") {
    const project = viewOf(run)?.project;
    const target = project?.specialists?.find((x) => x.specialty === out.expert);
    // Pas de tel spécialiste dans ce projet : la question va au propriétaire, comme avant.
    if (!target || !out.question) await askHuman(run, out.question || out.summary, out.question ? out.summary : undefined);
    else await askExpert(run, target, out.expert, out.question, out.summary);
    return;
  }
  if (out.status === "needs_human") {
    await askHuman(run, out.question || out.summary, out.question ? out.summary : undefined);
    return;
  }
  await comment(run.repo, run.issue.number, `Ticket traité.\n\n${out.summary}${out.prUrl ? `\n\nPR : ${out.prUrl}` : ""}${out.deployed ? `\n\nDéployé : ${out.deployed}` : ""}`);
  await setStage(run.repo, run.issue.number, "done");
  run.status = "done";
  emit(run, "done", out.summary, { merged: Boolean(out.merged), deployed: out.deployed, verdict: out.verdict });
  await removeWorktree(cfg.home, run.repo, run.worktree);
  state.runs = state.runs.filter((r) => r.id !== run.id);
}

/** Consultation d'un spécialiste : la tâche attend sa réponse, qu'Essaim lui renvoie (comme une réponse du propriétaire). */
async function askExpert(run, target, expert, question, progress) {
  const done = progress ? `\n\n<sub>Ce que j'ai fait jusqu'ici : ${progress}</sub>` : "";
  await comment(run.repo, run.issue.number, `**Question à ${target.name} (${expert})**\n\n${question}${done}\n\nLa tâche reprend dès sa réponse.`);
  await setStage(run.repo, run.issue.number, "human");
  Object.assign(run, { status: "needs_human", questionAt: new Date().toISOString(), question, expert });
  delete replies[run.id];
  emit(run, "needs_expert", question, { expert });
}

async function askHuman(run, question, progress) {
  const done = progress ? `\n\n<sub>Ce que j'ai fait jusqu'ici : ${progress}</sub>` : "";
  await comment(run.repo, run.issue.number, `**Question de l'agent**\n\n${question}${done}\n\nRéponds en commentaire : le ticket repassera en tête de ma file.`);
  await setStage(run.repo, run.issue.number, "human");
  Object.assign(run, { status: "needs_human", questionAt: new Date().toISOString(), question });
  delete replies[run.id];
  emit(run, "needs_human", question);
}

/* ---------------- Messages du propriétaire et conversations libres ---------------- */

const CHAT_IDLE_MS = 20 * 60_000;
/** convId → { child, send, end, idle, busy } : conversations libres ouvertes (busy : réponse en cours). */
const chats = new Map();

/**
 * Un message écrit dans Essaim. Tâche en cours : glissé dans sa session. Tâche en attente de réponse : c'est la
 * réponse. Tâche interrompue : transmis à la reprise. Conversation libre : envoyé à sa session (ouverte au besoin).
 */
async function deliver(msg) {
  if (!msg?.id) return;
  const agent = agentOf(msg.agentId);
  if (!agent) return;
  if (seenMessages.has(msg.id)) return ack([msg.id]);
  seenMessages.add(msg.id);
  const text = String(msg.text ?? "").trim();
  const conv = msg.conversationId;
  try {
    if (!text) return;
    const run = state.runs.find((r) => convOf(r) === conv);
    if (run) {
      if (run.status === "running" && live.get(run.id)?.send?.(text)) return;
      if (run.status === "needs_human") {
        replies[run.id] = text;
        repliesFromEssaim.add(run.id);
        say(agent.id, conv, "system", "Réponse reçue : l'agent reprend la tâche dès qu'une place se libère.");
        return;
      }
      run.notes = [...(run.notes ?? []), text];
      save();
      say(agent.id, conv, "system", `Tâche ${state.held.includes(conv) ? "en pause" : "interrompue"} : ton message lui sera transmis à la reprise.`);
      return;
    }
    if (msg.task) {
      say(agent.id, conv, "system", "Cette tâche n'est pas en cours sur la machine. Pour en reparler, ouvre une nouvelle conversation.");
      return;
    }
    await chatMessage(agent, conv, text);
  } catch (error) {
    log(`${agent.name} : message non remis :`, error.message);
    say(agent.id, conv, "system", `Message non remis : ${error.message.slice(0, 200)}`);
  } finally {
    ack([msg.id]);
  }
}

function bumpIdle(entry) {
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => entry.end?.(), CHAT_IDLE_MS);
}

/** Conversation libre avec un agent, dans son propre worktree ; la session se rouvre avec --resume. */
async function chatMessage(base, convId, text) {
  // Une conversation reste sur son repo ; la première s'ouvre sur le repo principal de l'agent.
  const agent = forRepo(base, state.conversations[convId]?.repoId);
  const open = chats.get(convId);
  if (open?.send(text)) {
    open.busy = true;
    bumpIdle(open);
    return;
  }
  if (state.quota.blockedUntil > Date.now()) {
    say(agent.id, convId, "system", `Limite de l'abonnement atteinte : réessaie après ${new Date(state.quota.blockedUntil).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`);
    return;
  }
  const conv = (state.conversations[convId] ??= { agentId: agent.id });
  conv.repoId ??= agent.repoId;
  if (!conv.worktree) {
    await repoReady(base, agent.repoId);
    const g = await prepareWorktree(cfg.home, agent.repo, { number: `conv-${convId.slice(0, 8)}`, title: "conversation" });
    Object.assign(conv, { worktree: g.worktree, branch: g.branch, defaultBranch: g.defaultBranch });
    save();
  }
  const entry = { agentId: agent.id, busy: true, memoryKey: agent.memoryKey ?? "" };
  const dir = memoryFor(agent);
  // Conversation d'une action lancée : la première session reçoit la commande et la fin de sa sortie.
  const prompt = conv.context && !conv.sessionId ? `${conv.context}\n\n${text}` : text;
  const { child, send, end, done } = runClaude({
    bin: cfg.bin,
    cwd: conv.worktree,
    prompt,
    system: chatPrompt(agent, conv, dir),
    resume: conv.sessionId,
    addDirs: [dir],
    agents: SUBAGENTS,
    model: agent.settings?.model || cfg.model,
    effort: agent.settings?.effort || cfg.effort,
    onMessage(info) {
      if (info.sessionId && info.sessionId !== conv.sessionId) {
        conv.sessionId = info.sessionId;
        save();
        control.event({ agentId: agent.id, conversationId: convId, kind: "conversation", sessionId: info.sessionId });
      }
      relay(agent.id, convId, info, entry);
      if (info.rateLimit) onRateLimit(info.rateLimit);
      if (info.result) {
        entry.busy = false;
        bumpIdle(entry);
        reportUsage(agent.id, info.result.usage, undefined, convId);
        uploadMemory(agent.id, convId, agent.repoId);
      }
    },
  });
  Object.assign(entry, { child, send, end });
  chats.set(convId, entry);
  bumpIdle(entry);
  done.then(({ code, result, stderr }) => {
    chats.delete(convId);
    uploadMemory(agent.id, convId, agent.repoId);
    clearTimeout(entry.idle);
    push(agent.id, { type: "status", conversationId: convId, state: "idle" });
    if (code && !result) say(agent.id, convId, "system", `La session s'est arrêtée : ${(stderr || `code ${code}`).trim().slice(-200)}`);
  });
}

/* ---------------- Actions en un clic ---------------- */

/** actionRunId → { repo, agentId, stop } : commandes en cours. */
const actionRuns = new Map();
/** Lancements qui attendent qu'une autre action du même repo finisse (prévenu une fois). */
const actionWaiting = new Set();

/**
 * Lancement demandé dans Essaim (en direct ou par la synchro) : la commande tourne dans une copie à jour du repo,
 * sans prendre de place aux agents. Une seule action à la fois par repo (elles partagent cette copie).
 */
function startAction(r) {
  if (!r?.id) return;
  if (r.stop) return actionRuns.get(r.id)?.stop();
  if (!r.command || actionRuns.has(r.id) || state.actionsSeen.includes(r.id) || restartPending) return;
  const agent = forRepo(agentOf(r.agentId));
  if (!agent) return;
  if ([...actionRuns.values()].some((a) => a.repo === agent.repo)) {
    if (!actionWaiting.has(r.id)) say(agent.id, r.conversationId, "system", "Une autre action tourne dans ce repo : celle-ci part dès qu'elle a fini.");
    actionWaiting.add(r.id);
    return;
  }
  actionWaiting.delete(r.id);
  const entry = { repo: agent.repo, agentId: agent.id, stopRequested: false };
  entry.stop = () => (entry.stopRequested = true);
  actionRuns.set(r.id, entry);
  state.actionsSeen = [...state.actionsSeen, r.id].slice(-200);
  state.actionsRunning[r.id] = { agentId: agent.id, conversationId: r.conversationId, name: r.name };
  save();
  runAction(agent, r, entry).catch((error) => log(`Action « ${r.name} » :`, error));
}

async function runAction(agent, r, entry) {
  const conv = r.conversationId;
  const startedAt = Date.now();
  const timeoutMinutes = r.timeoutMinutes || DEFAULT_TIMEOUT;
  control.event({ agentId: agent.id, kind: "action_started", actionRunId: r.id, conversationId: conv, text: r.name });
  push(agent.id, { type: "status", conversationId: conv, state: "working" });
  log(`${agent.name} : action « ${r.name} » lancée.`);
  const out = createOutput({ onChunk: (text, store) => say(agent.id, conv, "tool", text, "output", store) });
  let outcome;
  let exit;
  try {
    await repoReady(agentOf(r.agentId), agent.repoId);
    const prep = await prepareActionDir(cfg.home, agent.repo);
    say(agent.id, conv, "system", `Lancée dans ${agent.repo} (${prep.defaultBranch} à jour, ${prep.commit}).`);
    const cmd = runCommand({
      command: r.command,
      cwd: prep.dir,
      env: commandEnv(process.env, { ESSAIM_AGENT: agent.name, ESSAIM_ACTION: r.name, ESSAIM_MEMORY: memoryDir(cfg.home, agent.id) }),
      timeoutMs: timeoutMinutes * 60_000,
      onData: (data) => out.write(data),
    });
    entry.stop = cmd.stop;
    if (entry.stopRequested) cmd.stop();
    exit = await cmd.done;
    out.flush();
    // Sortie trop longue pour être gardée en entier : sa fin, au moins.
    if (out.truncated) say(agent.id, conv, "tool", `… (sortie trop longue, seule la fin est gardée)\n${out.tail()}`, "output");
    outcome = shuttingDown
      ? { status: "echouee", text: `« ${r.name} » coupée par l'arrêt du runner : relance-la.` }
      : actionOutcome(r.name, exit, Date.now() - startedAt, timeoutMinutes);
  } catch (error) {
    out.flush();
    const why = String(error.stderr || error.message || error).trim().slice(-400);
    outcome = entry.stopRequested ? { status: "arretee", text: `« ${r.name} » arrêtée avant de commencer.` } : { status: "echouee", text: `« ${r.name} » n'a pas pu démarrer : ${why}` };
  }
  const tail = out.tail();
  actionRuns.delete(r.id);
  delete state.actionsRunning[r.id];
  // Si le propriétaire écrit ensuite dans cette conversation, l'agent reçoit la commande et la fin de sa sortie.
  state.conversations[conv] = {
    ...(state.conversations[conv] ?? {}),
    agentId: agent.id,
    context: `Contexte : le propriétaire a lancé depuis Essaim l'action en un clic « ${r.name} ». Résultat : ${outcome.text}\n\nCommande (lancée dans une copie à jour de la branche par défaut) :\n\`\`\`sh\n${r.command}\n\`\`\`\n\nFin de la sortie :\n\`\`\`\n${tail.slice(-4000) || "(rien)"}\n\`\`\`\n\nSi tu modifies l'action, mets à jour ACTIONS.json. Son message :`,
  };
  save();
  const icon = outcome.status === "reussie" ? "✅" : outcome.status === "arretee" ? "⏹️" : "❌";
  say(agent.id, conv, "system", `${icon} ${outcome.text}`);
  push(agent.id, { type: "status", conversationId: conv, state: "idle" });
  log(`${agent.name} : ${outcome.text}`);
  control.event({
    agentId: agent.id,
    kind: "action_ended",
    actionRunId: r.id,
    conversationId: conv,
    status: outcome.status,
    exitCode: exit?.code ?? null,
    text: outcome.text,
    detail: outcome.status === "echouee" ? tail.slice(-600) : undefined,
  });
  // Une action du même repo qui attendait part à la synchro suivante (toujours « demandée » dans Essaim).
  await control.flush();
}

/** Au démarrage : les actions coupées par l'arrêt du runner sont signalées en échec. */
function reportInterruptedActions() {
  for (const [id, a] of Object.entries(state.actionsRunning)) {
    say(a.agentId, a.conversationId, "system", "❌ Le runner a redémarré pendant l'action : relance-la.");
    control.event({ agentId: a.agentId, kind: "action_ended", actionRunId: id, conversationId: a.conversationId, status: "echouee", exitCode: null, text: `« ${a.name} » interrompue par le redémarrage du runner.` });
  }
  state.actionsRunning = {};
}

/* ---------------- Décisions ---------------- */

/** Les tâches de la file d'un agent qu'aucun run ne traite encore. */
function untaken(agent) {
  const own = state.runs.filter((r) => r.agentId === agent.id);
  const taskIds = new Set(own.map((r) => r.taskId).filter(Boolean));
  // Deux repos d'un même agent peuvent avoir la même issue #n : on compare le repo avec le numéro.
  const issues = new Set(own.map((r) => `${linkFor(agent, r.repoId)?.id ?? ""}#${r.issue.number}`));
  return (agent.queue ?? []).filter((t) => !taskIds.has(t.id) && !(t.issueNumber && issues.has(`${linkFor(agent, t.repoId)?.id ?? ""}#${t.issueNumber}`)));
}

/** Nouveau projet : le repo est créé avant la première issue ou le premier worktree. */
async function repoReady(base, repoId) {
  const agent = forRepo(base, repoId);
  if (!agent.settings?.createRepo) return;
  const created = await ensureRepo(agent.repo, { visibility: agent.settings.createRepo, description: repoDescription(agent.brief) });
  if (created) log(`${agent.name} : repo ${agent.repo} créé.`);
  // Créé ou déjà là : Essaim retire la demande (seule la création est annoncée sur Telegram).
  control.event({ agentId: agent.id, repoId: agent.repoId, kind: created ? "repo_created" : "repo_ready", text: agent.repo });
  const link = linkFor(base, repoId);
  if (link) delete link.createRepo;
  if (base.settings) delete base.settings.createRepo;
}

async function startNew(base) {
  const next = untaken(base);
  readyCount[base.id] = next.length;
  if (!next.length) return;
  const task = next[0];
  // La tâche se fait sur son repo, avec les droits, le brief et la mémoire de l'agent là-bas.
  const agent = forRepo(base, task.repoId);
  // L'issue miroir est normalement déjà créée au passage précédent ; sinon on la crée maintenant.
  const known = state.taskIssues[task.id];
  let issue = task.issueNumber ? { number: task.issueNumber, url: task.issueUrl } : known;
  await repoReady(base, agent.repoId);
  if (!issue) {
    issue = await createIssue(agent.repo, task.title, task.body);
    state.taskIssues[task.id] = issue;
    control.event({ agentId: agent.id, taskId: task.id, kind: "task_issue", text: `#${issue.number}`, issueNumber: issue.number, issueUrl: issue.url });
  }
  await setStage(agent.repo, issue.number, "wip");
  const ticket = { number: issue.number, title: task.title, body: task.body, url: issue.url };
  const gitInfo = await prepareWorktree(cfg.home, agent.repo, ticket);
  const run = {
    id: randomUUID(),
    agentId: agent.id,
    taskId: task.id,
    repo: agent.repo,
    repoId: agent.repoId,
    issue: { number: issue.number, title: task.title, url: issue.url },
    worktree: gitInfo.worktree,
    git: { branch: gitInfo.branch, defaultBranch: gitInfo.defaultBranch },
    status: "running",
    attempts: 0,
    startedAt: new Date().toISOString(),
  };
  state.runs.push(run);
  readyCount[agent.id] = next.length - 1;
  emit(run, "started", `#${issue.number} ${task.title}`);
  execute(run, newTicketPrompt(ticket, gitInfo));
}

/** Miroir GitHub : crée les issues des tâches devenues prêtes, recopie les tâches modifiées. */
async function mirrorTasks(ops) {
  for (const op of ops ?? []) {
    const base = agentOf(op.agentId);
    if (!base) continue;
    const agent = forRepo(base, op.repoId);
    try {
      if (op.action === "create") {
        let issue = state.taskIssues[op.id];
        if (!issue) {
          await repoReady(base, agent.repoId);
          issue = await createIssue(agent.repo, op.title, op.body);
          state.taskIssues[op.id] = issue;
          save();
          if (op.parentIssueNumber) await linkSubIssue(agent.repo, op.parentIssueNumber, issue.number).catch((e) => log("Sous-issue non rattachée :", e.message));
        }
        control.event({ agentId: agent.id, taskId: op.id, kind: "task_issue", text: `#${issue.number}`, issueNumber: issue.number, issueUrl: issue.url });
      } else if (op.issueNumber) {
        // Une tâche en cours garde son étiquette « en cours » : seul le texte est recopié.
        const busy = state.runs.some((r) => r.taskId === op.id || (r.agentId === agent.id && r.repo === agent.repo && r.issue.number === op.issueNumber));
        // Une tâche abandonnée se ferme même si son run tourne encore (il est arrêté à la même synchro).
        await updateIssue(agent.repo, op.issueNumber, { title: op.title, body: op.body, status: busy && op.status !== "abandonnee" ? undefined : op.status });
        control.event({ agentId: agent.id, taskId: op.id, kind: "task_synced", text: `#${op.issueNumber}` });
      }
    } catch (error) {
      log(`Miroir GitHub de « ${op.title} » impossible :`, error.message);
    }
  }
}

/**
 * Tâches abandonnées dans Essaim : on oublie leur run. Celui qui tourne est arrêté d'abord (finish le retire) ;
 * le travail déjà poussé reste sur sa branche.
 */
async function dropAbandoned(ids) {
  const gone = new Set(ids ?? []);
  for (const run of state.runs.filter((r) => gone.has(taskOf(r)))) {
    const entry = live.get(run.id);
    if (run.status === "running" && entry) {
      if (entry.stopReason !== "abandon") {
        entry.stopReason = "abandon";
        stopClaude(entry.child);
      }
      continue;
    }
    await forgetRun(run);
    log(`Tâche abandonnée : run de #${run.issue.number} retiré.`);
  }
}

async function forgetRun(run) {
  // Worktree retiré avant le run : une tâche reprise juste après son abandon ne repart pas dans un dossier qu'on efface.
  await removeWorktree(cfg.home, run.repo, run.worktree).catch(() => {});
  state.runs = state.runs.filter((r) => r.id !== run.id);
  delete replies[run.id];
  repliesFromEssaim.delete(run.id);
}

/**
 * Pause d'une tâche décidée dans Essaim (reçue en direct ; la synchro renvoie ensuite la liste complète) : son run
 * s'arrête tout de suite, puis attend qu'on la reprenne. Reprise : le tour suivant la relance.
 */
function holdTask(taskId, hold) {
  if (!taskId) return;
  state.held = hold ? [...new Set([...state.held, taskId])] : state.held.filter((id) => id !== taskId);
  save();
  const run = state.runs.find((r) => taskOf(r) === taskId && r.status === "running");
  const entry = run && live.get(run.id);
  if (hold && entry && !entry.stopReason) {
    entry.stopReason = "hold";
    stopClaude(entry.child);
  }
  if (!hold) tick();
}

/** Réponses écrites dans Essaim : rattachées au run en attente de la tâche. */
function takeEssaimReplies(list) {
  for (const r of list ?? []) {
    const run = state.runs.find((x) => x.status === "needs_human" && ((x.taskId ?? x.id) === r.taskId || (x.agentId === r.agentId && r.issueNumber && x.issue.number === r.issueNumber)));
    if (!run) continue;
    run.taskId ??= r.taskId;
    replies[run.id] = r.reply;
    repliesFromEssaim.add(run.id);
  }
}

async function resume(runId, reason, reply) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) return;
  if (reason === "reply") {
    // Copie de la réponse sur l'issue : GitHub garde tout l'historique.
    if (repliesFromEssaim.has(runId) && reply?.trim()) await comment(run.repo, run.issue.number, `**Réponse (depuis Essaim)**\n\n${reply.trim()}`).catch(() => {});
    await setStage(run.repo, run.issue.number, "wip");
  }
  delete replies[runId];
  repliesFromEssaim.delete(runId);
  delete run.retryAfter;
  emit(run, "resumed", reason === "reply" ? "Réponse reçue, reprise du ticket." : reason === "hold" ? "Reprise après la pause." : `Reprise (${reason}).`, { reason });
  if (reason === "hold") say(run.agentId, convOf(run), "system", "Tâche reprise là où elle s'était arrêtée.");
  // Messages écrits pendant l'interruption : transmis avec la reprise.
  const notes = run.notes?.length ? `\n\nMessages du propriétaire pendant l'interruption :\n${run.notes.map((n) => `- ${n}`).join("\n")}` : "";
  delete run.notes;
  execute(run, resumePrompt(reason, reply) + notes);
}

async function checkReplies() {
  for (const run of state.runs.filter((r) => r.status === "needs_human" && replies[r.id] == null)) {
    if (Date.now() - (lastReplyCheck[run.id] ?? 0) < cfg.replyCheckMs) continue;
    lastReplyCheck[run.id] = Date.now();
    try {
      const reply = await replySince(run.repo, run.issue.number, run.questionAt);
      if (reply != null) replies[run.id] = reply;
    } catch (error) {
      log(`Réponses de #${run.issue.number} illisibles :`, error.message);
    }
  }
}

function watchRunning() {
  for (const run of state.runs.filter((r) => r.status === "running")) {
    const entry = live.get(run.id);
    const settings = agentOf(run.agentId)?.settings ?? {};
    if (!entry || entry.stopReason) continue;
    const stallMin = Number(settings.stallMinutes ?? 180);
    if (stallMin > 0 && !entry.stallNotified && Date.now() - entry.lastMilestoneAt > stallMin * 60_000) {
      entry.stallNotified = true;
      emit(run, "stall", `Aucun jalon franchi depuis ${Math.round(stallMin / 60)} h sur #${run.issue.number}. L'agent continue.`);
    }
    const maxMin = Number(settings.maxMinutes ?? 0);
    if (maxMin > 0 && Date.now() - entry.startedAt > maxMin * 60_000) {
      entry.stopReason = "budget";
      stopClaude(entry.child);
    }
  }
}

function reportAgents() {
  const states = agentStates(
    { agents: state.agents, runs: state.runs, quota: state.quota, capacity: capacity(), focus: state.focus, now: Date.now(), readyCount, replies, startFailures, held: state.held },
    { updating: Boolean(restartPending) },
  );
  return state.agents.map((a) => {
    const run =
      state.runs.find((r) => r.agentId === a.id && r.status === "running") ??
      state.runs.find((r) => r.agentId === a.id && r.status === "interrupted" && !state.held.includes(taskOf(r)));
    return {
      id: a.id,
      status: states.get(a.id).status,
      retryAt: states.get(a.id).retryAt,
      runId: run?.id,
      issueNumber: run?.issue.number,
      issueTitle: run?.issue.title,
      waitingHuman: state.runs.filter((r) => r.agentId === a.id && r.status === "needs_human").map((r) => r.issue.number),
      ready: readyCount[a.id],
    };
  });
}

/* ---------------- Mise à jour ---------------- */

const RUNNER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let lastUpdateCheck = 0;
let lastUpdateSkip = "";
/** Le code du runner a changé sur disque (date en ms) : redémarrer dès que la machine est libre. */
let restartPending = 0;

async function checkUpdate() {
  if (!cfg.autoUpdate || restartPending || Date.now() - lastUpdateCheck < cfg.updateCheckMs) return;
  lastUpdateCheck = Date.now();
  try {
    const u = await pullUpdate(RUNNER_DIR);
    if (u.skipped && u.skipped !== lastUpdateSkip) log("Mise à jour automatique du runner sautée :", u.skipped);
    lastUpdateSkip = u.skipped ?? "";
    if (u.pulled) log(`Checkout du runner avancé de ${u.pulled} commit(s).`);
    if (u.changed) {
      restartPending = Date.now();
      log("Code du runner mis à jour : plus de nouveau ticket, redémarrage dès que les runs en cours sont finis (30 min au plus).");
    }
  } catch (error) {
    log("Mise à jour automatique du runner impossible :", error.message);
  }
}

let ticking = false;
/** Refaire un tour tout de suite après celui-ci (synchro demandée pendant le tour, run qui vient de partir). */
let tickAgain = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    try {
      const resources = await readResources({ pids: [...live.values()].map((e) => e.child?.pid).filter(Boolean), dir: cfg.home }).catch(() => null);
      const res = await control.sync({
        version: VERSION,
        capacity: capacity(),
        baseCapacity: cfg.capacity,
        running: live.size,
        chats: chats.size,
        resources,
        quota: state.quota,
        actionRuns: [...actionRuns.keys()],
        agents: reportAgents(),
      });
      // Places réglées dans Essaim : gardées si la synchro échoue plus tard (jusqu'à leur échéance).
      if ("capacityOverride" in res) {
        const before = capacity();
        state.capacityOverride = res.capacityOverride ?? null;
        if (capacity() !== before) log(`Places de la machine : ${before} → ${capacity()}${state.capacityOverride ? " (réglage d'Essaim)" : " (CAPACITY)"}.`);
      }
      state.agents = (res.agents ?? []).filter((a) => a.machine === cfg.machine && a.kind !== "svc");
      state.focus = Boolean(res.focus);
      for (const a of state.agents) readyCount[a.id] = untaken(a).length;
      takeEssaimReplies(res.replies);
      for (const m of res.messages ?? []) await deliver(m);
      for (const r of res.actionRuns ?? []) startAction(r);
      if (Array.isArray(res.held)) state.held = res.held.map(String);
      await dropAbandoned(res.abandoned);
      save();
      await mirrorTasks(res.github);
    } catch (error) {
      log("Plan de contrôle injoignable, on continue avec les derniers réglages :", error.message);
    }
    checkQuotaReset();
    checkAuth().catch((error) => log("Contrôle de la connexion Claude :", error.message));
    await checkReplies();
    watchRunning();

    const decision = plan({ agents: state.agents, runs: state.runs, quota: state.quota, capacity: capacity(), focus: state.focus, now: Date.now(), readyCount, replies, startFailures, held: state.held });
    for (const { runId, reason } of decision.interrupt) {
      const entry = live.get(runId);
      if (entry && !entry.stopReason) {
        entry.stopReason = reason;
        stopClaude(entry.child);
      }
    }
    await checkUpdate();
    if (restartPending) {
      // launchd (KeepAlive) relance le runner, qui repart sur le nouveau code.
      const busyChats = [...chats.values()].filter((c) => c.busy).length;
      if (readyToRestart({ since: restartPending, now: Date.now(), runs: live.size, busyChats, actions: actionRuns.size })) await shutdown("Mise à jour");
      return;
    }
    const runningBefore = live.size;
    for (const r of decision.resume) await resume(r.runId, r.reason, r.reply).catch((e) => log("Reprise impossible :", e.message));
    for (const s of decision.start) {
      const agent = agentOf(s.agentId);
      await startNew(agent).then(
        () => delete startFailures[agent.id],
        (error) => {
          const failure = (startFailures[agent.id] = startFailure(startFailures[agent.id], error.message, Date.now()));
          log(`${agent.name} : nouveau ticket impossible (nouvel essai dans ${failure.delay / 60_000} min) :`, error.message);
          readyCount[agent.id] = 0;
          if (failure.notify) control.event({ agentId: agent.id, kind: "error", text: `Impossible de prendre un ticket : ${error.message.slice(0, 300)}` });
        },
      );
    }
    // Un run vient de partir : Essaim l'affiche au travail tout de suite plutôt qu'au tour suivant (borné par les places).
    if (live.size > runningBefore) tickAgain = true;
  } finally {
    await control.flush();
    ticking = false;
    if (tickAgain) {
      tickAgain = false;
      setTimeout(tick, 0);
    }
  }
}

/**
 * Bouton « Actualiser » d'Essaim : synchro et plan tout de suite, sans attendre le tour suivant (20 s), et les essais
 * différés après un échec (prise de ticket, reprise après plantage) sont retentés maintenant.
 */
function syncNow() {
  log("Actualisation demandée depuis Essaim.");
  for (const failure of Object.values(startFailures)) failure.until = 0;
  for (const run of state.runs) if (run.status === "interrupted" && run.retryAfter) run.retryAfter = 0;
  if (ticking) tickAgain = true;
  else tick();
}

/* ---------------- Démarrage et arrêt ---------------- */

/** Arrêt en cours : une action coupée n'a pas été « arrêtée » par le propriétaire. */
let shuttingDown = false;

async function shutdown(sig) {
  shuttingDown = true;
  log(`${sig} : arrêt des runs en cours (ils reprendront au redémarrage).`);
  for (const chat of chats.values()) chat.end?.();
  for (const a of actionRuns.values()) a.stop();
  link.close();
  for (const [runId, entry] of live) {
    entry.stopReason = "restart";
    stopClaude(entry.child);
    const run = state.runs.find((r) => r.id === runId);
    if (run) Object.assign(run, { status: "interrupted", reason: "restart" });
  }
  save();
  await control.flush();
  setTimeout(() => process.exit(0), 3_000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log(`Runner ${VERSION} sur « ${cfg.machine} », ${capacity()} place(s), plan de contrôle ${cfg.controlUrl}`);
reportInterruptedActions();
save();
await tick();
setInterval(tick, cfg.pollMs);
setInterval(() => control.flush(), 3_000);
