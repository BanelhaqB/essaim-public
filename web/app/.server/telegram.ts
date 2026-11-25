/**
 * Notifications Telegram : un groupe à sujets, un sujet par agent, le sujet « Général » pour le quota
 * et les machines. Et les commandes reçues par le webhook.
 * Le sujet d'un agent se donne de préférence par son lien (créé à la main dans Telegram, « Copier le lien ») ;
 * à défaut, le bot tente de le créer au premier message, ce qui demande le droit « Gérer les sujets ».
 */
import { getAgent, getSetting, listAgents, listServices, setFocus, setPaused, setServicePaused, setSetting, setTelegramTopic } from "./db";
import type { Bindings } from "./env";
import { SERVICE_STATUS, serviceStatus } from "~/lib/status";
import type { Agent } from "~/lib/types";

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s: string, max = 900) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export interface RunnerEvent {
  agentId?: string;
  runId?: string;
  at?: string;
  kind: string;
  level?: string;
  text: string;
  reason?: string;
  merged?: boolean;
  deployed?: string;
  /** Relecture ou tests : approved | changes_requested. */
  verdict?: string;
  /** Spécialiste consulté : po | ux | architect. */
  expert?: string;
  /** Repo concerné (un agent peut en avoir plusieurs). */
  repoId?: string;
  taskId?: string;
  conversationId?: string;
  sessionId?: string;
  role?: string;
  mid?: string;
  ids?: string[];
  usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
  steps?: Array<{ title?: string; body?: string }>;
  issueNumber?: number;
  issueUrl?: string;
  /** Actions en un clic : lancement concerné, issue (reussie | echouee | arretee), code de sortie, fin de la sortie. */
  actionRunId?: string;
  status?: string;
  exitCode?: number | null;
  detail?: string;
  actions?: unknown;
  run?: { taskId?: string; issueNumber?: number; issueTitle?: string; issueUrl?: string; prUrl?: string; summary?: string };
}

/** Le message Telegram d'un événement du runner, ou null s'il ne mérite pas de notification. */
export function formatEvent(e: RunnerEvent, agent: Agent | null, publicUrl?: string): string | null {
  const who = agent ? `<b>${esc(agent.name)}</b>` : "";
  const n = e.run?.issueNumber;
  const issue = n ? (e.run?.issueUrl ? `<a href="${esc(e.run.issueUrl)}">#${n}</a>` : `#${n}`) : "";
  const title = e.run?.issueTitle ? ` ${esc(e.run.issueTitle)}` : "";
  const pr = e.run?.prUrl ? `\n<a href="${esc(e.run.prUrl)}">Voir la PR</a>` : "";
  const open = publicUrl && agent ? `\n<a href="${esc(publicUrl)}/agents/${esc(agent.id)}">Ouvrir dans la console</a>` : "";
  switch (e.kind) {
    case "started":
      return `▶️ ${who} commence ${issue}${title}`;
    case "resumed":
      return e.reason === "reply" ? `▶️ ${who} reprend ${issue} avec ta réponse` : null;
    case "milestone":
      return `📍 ${who} · ${issue} : ${esc(e.text)}`;
    case "done":
      return `✅ ${who} a terminé ${issue}${title}\n\n${esc(cut(e.text))}${e.merged ? "\n\nPR mergée." : ""}${e.deployed ? `\nDéployé : ${esc(e.deployed)}` : ""}${pr}`;
    case "needs_human":
      return `❓ ${who} a besoin de toi sur ${issue}${title}\n\n${esc(cut(e.text))}\n\nRéponds en commentaire de l'issue : il est passé au ticket suivant en attendant.${open}`;
    case "failed":
      return `🔴 ${who} bloque sur ${issue} après 3 essais.\n<code>${esc(cut(e.text, 400))}</code>${open}`;
    case "split":
      return `🧩 ${who} a découpé ${issue} en ${esc(e.text)}, traitées une à une.`;
    case "stall":
      return `⏳ ${who} · ${esc(e.text)}${open}`;
    case "action_ended": {
      const icon = e.status === "reussie" ? "✅" : e.status === "arretee" ? "⏹️" : "❌";
      const link = publicUrl && agent && e.conversationId ? `\n<a href="${esc(publicUrl)}/agents/${esc(agent.id)}?c=${esc(e.conversationId)}">Voir la sortie</a>` : "";
      const tail = e.status === "echouee" && e.detail?.trim() ? `\n<code>${esc(cut(e.detail.trim(), 600))}</code>` : "";
      return `${icon} ${who} · ${esc(e.text)}${tail}${link}`;
    }
    case "repo_created":
      return `🌱 ${who} a créé le repo <a href="https://github.com/${esc(agent?.repo ?? e.text)}">${esc(agent?.repo ?? e.text)}</a> et va initialiser le projet.`;
    case "error":
      return `⚠️ ${who} · ${esc(cut(e.text, 400))}`;
    case "handoff":
      return `${e.status === "fix" ? "↩️" : "🤝"} ${who} · ${esc(e.text)}`;
    case "expert_asked":
      return `🧭 ${who} · ${esc(cut(e.text, 400))}`;
    case "expert_replied":
      return `💬 ${who} · ${esc(cut(e.text, 400))}`;
    case "handoff_stopped":
      return `🛑 ${who} · ${esc(cut(e.text, 500))}${open}`;
    case "auth_expired":
      return `🔑 ${esc(e.text)}`;
    case "auth_expiring":
      return `⏰ ${esc(e.text)}`;
    case "quota_hit":
      return `🌙 ${esc(e.text)}`;
    case "quota_reset":
      return `☀️ ${esc(e.text)}`;
    default:
      return null;
  }
}

/**
 * Le groupe des notifications : TELEGRAM_CHAT_ID s'il est fixé, sinon celui choisi dans la page Réglages
 * (le webhook retient le dernier groupe où le bot a reçu un message).
 */
export async function chatId(env: Bindings): Promise<string | null> {
  return env.TELEGRAM_CHAT_ID || (await getSetting(env.DB, "telegram_chat"));
}

export async function call<T = unknown>(env: Bindings, method: string, payload: Record<string, unknown>): Promise<T | null> {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!body?.ok) {
    const description = body?.description ?? `HTTP ${res.status}`;
    console.error(`Telegram ${method} : ${description}`);
    // Retenu pour la page Réglages : sans ça, un refus de Telegram (droits du bot…) passe inaperçu.
    await setSetting(env.DB, "telegram_error", JSON.stringify({ at: new Date().toISOString(), method, description })).catch(() => {});
    return null;
  }
  return body.result ?? null;
}

/** Le sujet de l'agent dans le groupe, créé au premier message. */
export async function topicFor(env: Bindings, agent: Agent): Promise<number | undefined> {
  if (agent.telegramTopic) return agent.telegramTopic;
  const chat = await chatId(env);
  if (!chat) return undefined;
  const topic = await call<{ message_thread_id: number }>(env, "createForumTopic", { chat_id: chat, name: agent.name });
  if (!topic) return undefined;
  await setTelegramTopic(env.DB, agent.id, topic.message_thread_id);
  agent.telegramTopic = topic.message_thread_id;
  return topic.message_thread_id;
}

export async function send(env: Bindings, html: string, agent?: Agent | null, threadId?: number) {
  const chat = await chatId(env);
  if (!chat || !env.TELEGRAM_BOT_TOKEN) return null;
  const thread = threadId ?? (agent ? await topicFor(env, agent) : undefined);
  const message = { chat_id: chat, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  const sent = await call(env, "sendMessage", thread ? { ...message, message_thread_id: thread } : message);
  // Sujet supprimé ou mal renseigné : le message part dans « Général » plutôt que de se perdre (le refus reste visible dans Réglages).
  if (!sent && thread && agent && threadId === undefined) return call(env, "sendMessage", message);
  return sent;
}

/* ---------------- Sujet d'un agent donné par son lien ---------------- */

export type TopicInput = { ok: true; thread: number | null; chat?: string } | { ok: false; error: string };

/**
 * Lit le lien d'un sujet tel que Telegram le copie : https://t.me/c/1234567890/42 (groupe privé),
 * https://t.me/nom_du_groupe/42 (groupe public), un lien de message dans le sujet (…/42/123 ou …/123?thread=42),
 * ou simplement le numéro du sujet. Vide : pas de sujet.
 */
export function parseTopicLink(raw: string): TopicInput {
  const input = raw.trim();
  if (!input) return { ok: true, thread: null };
  const fail = { ok: false, error: "Colle le lien du sujet (Telegram : appui long sur le sujet → Copier le lien), par exemple https://t.me/c/1234567890/42." } as const;
  let thread: number | undefined;
  let chat: string | undefined;
  if (/^\d+$/.test(input)) thread = Number(input);
  else {
    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      return fail;
    }
    if (!/^(www\.)?(t|telegram)\.me$/i.test(url.hostname)) return fail;
    const parts = url.pathname.split("/").filter(Boolean);
    const query = url.searchParams.get("thread") ?? url.searchParams.get("topic");
    if (parts[0] === "c") {
      if (!/^\d+$/.test(parts[1] ?? "")) return fail;
      chat = `-100${parts[1]}`;
      parts.splice(0, 2);
    } else parts.splice(0, 1);
    const id = query ?? parts[0];
    if (!id || !/^\d+$/.test(id)) return fail;
    thread = Number(id);
  }
  if (!thread || !Number.isSafeInteger(thread)) return fail;
  if (thread === 1) return { ok: false, error: "C'est le sujet « Général » : crée un sujet propre à l'agent et colle son lien." };
  return { ok: true, thread, chat };
}

/** Le lien d'un sujet, pour l'afficher (le numéro seul si le groupe n'a pas d'identifiant -100…). */
export function topicLink(chat: string | null, thread: number | null): string {
  if (!thread) return "";
  return chat?.startsWith("-100") ? `https://t.me/c/${chat.slice(4)}/${thread}` : String(thread);
}

/** Lit le lien et vérifie qu'il pointe dans le groupe des notifications. N'écrit rien. */
export async function resolveTopic(env: Bindings, raw: string): Promise<TopicInput> {
  const parsed = parseTopicLink(raw);
  if (!parsed.ok || !parsed.chat) return parsed;
  const chat = await chatId(env);
  if (chat && chat !== parsed.chat) return { ok: false, error: "Ce sujet est dans un autre groupe que celui des notifications (voir Réglages)." };
  return parsed;
}

/** Rattache l'agent au sujet lu par resolveTopic. Si aucun groupe n'est encore choisi, celui du lien le devient. */
export async function saveTopic(env: Bindings, agentId: string, topic: { thread: number | null; chat?: string }) {
  if (topic.chat && !(await chatId(env))) await setSetting(env.DB, "telegram_chat", topic.chat);
  await setTelegramTopic(env.DB, agentId, topic.thread);
}

/** À la création d'un agent : son sujet dans le groupe, ouvert par un message d'accueil. */
export async function welcomeAgent(env: Bindings, agent: Agent) {
  const machine = agent.machine === "nuc" ? "le serveur" : "le PC";
  await send(
    env,
    `🤖 <b>${esc(agent.name)}</b> est prêt. Il prend les issues étiquetées <code>agent:ready</code> de <b>${esc(agent.repo)}</b>, une à une, sur ${machine}.\n\nIci : ses débuts de ticket, ses jalons, ses questions et ses résultats. /pause et /reprise s'appliquent à lui dans ce sujet.`,
    agent,
  );
}

export async function notifyEvent(env: Bindings, e: RunnerEvent) {
  const agent = e.agentId ? await getAgent(env.DB, e.agentId) : null;
  const text = formatEvent(e, agent, env.PUBLIC_URL);
  if (text) await send(env, text, agent);
}

/* ---------------- Webhook : commandes ---------------- */

interface Update {
  message?: { text?: string; chat: { id: number; type?: string; title?: string }; message_thread_id?: number; from?: { is_bot?: boolean } };
}

const HELP = `Commandes :
/etat · où en est chaque agent et chaque service des serveurs
/pause [agent ou service] · met en pause (dans le sujet d'un agent, le nom est facultatif)
/reprise [agent ou service] · relance
/travail · mode « Je travaille » : les agents du Mac te laissent la place
/fin · fin du mode « Je travaille »`;

const STATUS_LABEL: Record<string, string> = {
  working: "au travail",
  starting: "démarre",
  waiting: "attend une place",
  retry: "nouvel essai bientôt",
  update: "attend la mise à jour du runner",
  quota: "attend le quota",
  paused: "en pause",
  yield: "te laisse la place",
  idle: "file vide",
};

export async function handleUpdate(env: Bindings, update: Update) {
  const msg = update.message;
  console.log("Telegram", JSON.stringify({ chat: msg?.chat?.id, type: msg?.chat?.type, text: msg?.text?.slice(0, 30) }));
  await setSetting(env.DB, "telegram_last", JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(update), chat: msg?.chat?.id, type: msg?.chat?.type }));
  if (!msg || msg.from?.is_bot) return;
  const chat = await chatId(env);
  if (!chat) {
    // Pas encore de groupe : on retient celui-ci pour la page Réglages (« Utiliser ce groupe »).
    if (msg.chat.type === "supergroup" || msg.chat.type === "group") {
      await setSetting(env.DB, "telegram_candidate", JSON.stringify({ id: msg.chat.id, title: msg.chat.title ?? "", type: msg.chat.type }));
    }
    return;
  }
  if (!msg.text || String(msg.chat.id) !== String(chat)) return;
  const [command, ...rest] = msg.text.trim().split(/\s+/);
  const name = rest.join(" ").toLowerCase();
  const cmd = command.toLowerCase().replace(/@.*$/, "");
  const thread = msg.message_thread_id;
  const reply = (html: string) => send(env, html, null, thread);
  const agents = await listAgents(env.DB);
  const target = name ? agents.find((a) => a.id === name || a.name.toLowerCase() === name) : agents.find((a) => a.telegramTopic === thread);

  if (cmd === "/etat") {
    const lines = agents.map((a) => {
      const d = a.statusDetail;
      const now = a.status === "working" && d.issueNumber ? ` · #${d.issueNumber} ${esc(d.issueTitle ?? "")}` : "";
      const waiting = d.waitingHuman?.length ? ` · ${d.waitingHuman.length} question(s) pour toi` : "";
      return `• <b>${esc(a.name)}</b> : ${a.paused ? "en pause" : (STATUS_LABEL[a.status] ?? a.status)}${now}${waiting}`;
    });
    const services = await listServices(env.DB);
    if (services.length) {
      lines.push("", "<b>Services</b>");
      for (const s of services) lines.push(`• ${esc(s.name)}${s.group ? ` (${esc(s.group)})` : ""} : ${SERVICE_STATUS[serviceStatus(s)].label.toLowerCase()}`);
    }
    return reply(lines.join("\n") || "Aucun agent.");
  }
  if ((cmd === "/pause" || cmd === "/reprise") && !target && name) {
    // Pas d'agent de ce nom : un service (identifiant, nom, ou groupe entier comme « veille »).
    const services = await listServices(env.DB);
    const service = services.find((s) => s.id === name || s.name.toLowerCase() === name);
    const group = service ? null : services.find((s) => s.group.toLowerCase() === name)?.group;
    if (service || group) {
      const paused = cmd === "/pause";
      const n = await setServicePaused(env.DB, service ? { id: service.id } : { group: group! }, paused);
      const label = esc(service?.name ?? group!);
      if (service && !service.pausable) return reply(`<b>${label}</b> est surveillé seulement : pas de pause depuis Essaim.`);
      if (!n) return reply(`<b>${label}</b> est déjà ${paused ? "en pause" : "en marche"}.`);
      return reply(paused ? `⏸ <b>${label}</b> se met en pause sur sa machine (moins d'une minute).` : `▶️ <b>${label}</b> repart sur sa machine (moins d'une minute).`);
    }
  }
  if (cmd === "/pause" || cmd === "/reprise") {
    if (!target) {
      const services = await listServices(env.DB);
      return reply(`Quel agent ou service ? ${[...agents.map((a) => a.id), ...services.filter((s) => s.pausable).map((s) => s.id)].join(", ")}`);
    }
    await setPaused(env.DB, target.id, cmd === "/pause");
    return reply(cmd === "/pause" ? `⏸ <b>${esc(target.name)}</b> se met en pause. Son ticket reprendra où il en était.` : `▶️ <b>${esc(target.name)}</b> se remet au travail.`);
  }
  if (cmd === "/travail" || cmd === "/fin") {
    await setFocus(env.DB, cmd === "/travail");
    return reply(cmd === "/travail" ? "🎧 Mode « Je travaille » : les agents du Mac te laissent la place." : "▶️ Les agents du Mac reprennent leur file.");
  }
  if (cmd.startsWith("/")) return reply(esc(HELP));
}

/** Ce que le bot peut faire dans le groupe : sujets activés, droit de les gérer. */
export async function forumRights(env: Bindings) {
  const chat = await chatId(env);
  if (!chat || !env.TELEGRAM_BOT_TOKEN) return null;
  const me = await call<{ id: number }>(env, "getMe", {});
  const [info, member] = await Promise.all([
    call<{ is_forum?: boolean }>(env, "getChat", { chat_id: chat }),
    me ? call<{ status: string; can_manage_topics?: boolean }>(env, "getChatMember", { chat_id: chat, user_id: me.id }) : null,
  ]);
  return {
    forum: Boolean(info?.is_forum),
    admin: member?.status === "administrator" || member?.status === "creator",
    manageTopics: member?.status === "creator" || Boolean(member?.can_manage_topics),
  };
}

/** Crée les sujets des agents qui n'en ont pas encore. Renvoie le nombre de sujets créés. */
export async function createMissingTopics(env: Bindings) {
  let created = 0;
  for (const agent of await listAgents(env.DB)) {
    if (agent.telegramTopic) continue;
    await welcomeAgent(env, agent);
    if (agent.telegramTopic) created++;
  }
  return created;
}
