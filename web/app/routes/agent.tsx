/**
 * Un agent = un projet, façon Claude Code : la conversation occupe la page, l'historique se replie sur le côté.
 * Une tâche = une conversation (sa demande, le travail de l'agent, ses questions, son résultat) ; les discussions
 * libres s'y ajoutent. Toutes partagent la mémoire de l'agent.
 */
import { useEffect, useState } from "react";
import { data, Form, Link, redirect, useLocation } from "react-router";

import { ActionList } from "~/components/actions";
import { Chat, type ConversationView } from "~/components/conversation";
import { Queue, TASK_LABEL } from "~/components/tasks";
import { Avatar, Icon, Pill } from "~/components/ui";
import {
  actionRunForConversation,
  addUserMessage,
  agentUsage,
  answerTask,
  createConversation,
  createTask,
  eventsForRun,
  getAgent,
  getTask,
  listActions,
  listConversations,
  listMachines,
  messagesFor,
  reorderQueue,
  setPaused,
  setTaskStatus,
  tasksForAgent,
} from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { launchAction, stopAction } from "~/.server/actions";
import { dropTask, pauseTask, reopenDropped } from "~/.server/tasks";
import { pushToRunner } from "~/.server/hub";
import { ACTION_STATUS, actionOpen } from "~/lib/actions";
import { displayStatus, fmtWhen } from "~/lib/status";
import { fmtTokens, totalTokens } from "~/lib/usage";
import type { ActionRunStatus, Conversation, Message, Task } from "~/lib/types";

import type { Route } from "./+types/agent";

export const handle = { fullBleed: true };

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `${loaderData?.agent.name ?? "Agent"} · Essaim` }];

export async function loader({ params, request }: Route.LoaderArgs) {
  const { DB } = serverEnv();
  const agent = await getAgent(DB, params.id);
  if (!agent) throw data("Cet agent n'existe pas.", { status: 404 });
  const [machines, tasks, conversations, week, actions] = await Promise.all([
    listMachines(DB),
    tasksForAgent(DB, agent.id, { closedLimit: 60 }),
    listConversations(DB, agent.id, 100),
    agentUsage(DB, agent.id, new Date(Date.now() - 7 * 86_400_000).toISOString()),
    listActions(DB, agent.id),
  ]);
  const online = Object.fromEntries(machines.map((m) => [m.name, m.online]));

  // Conversation affichée : celle demandée (?c=, conversation ou tâche), sinon la tâche en cours, sinon une question,
  // sinon la plus récente.
  const asked = new URL(request.url).searchParams.get("c");
  const findTask = (id?: string | null) => (id ? tasks.find((t) => t.id === id) : undefined);
  const view = (id: string): ConversationView | null => {
    const c = conversations.find((x) => x.id === id);
    if (c) return { id: c.id, title: c.title, taskId: c.taskId, taskStatus: c.taskStatus, actionStatus: c.actionStatus };
    // Une tâche pas encore commencée n'a pas de conversation : elle s'ouvre sur sa demande.
    const t = findTask(id);
    return t ? { id: t.id, title: t.title, taskId: t.id, taskStatus: t.status, actionStatus: null } : null;
  };
  const running = tasks.find((t) => t.status === "en_cours") ?? tasks.find((t) => t.status === "question");
  let conversation: ConversationView | null = null;
  if (asked && asked !== "new") conversation = view(asked);
  else if (!asked) conversation = (running && view(running.id)) ?? (conversations[0] ? view(conversations[0].id) : null);

  // Une tâche ancienne (hors des 60 dernières) se charge à part.
  let task: Task | null = conversation?.taskId ? (findTask(conversation.taskId) ?? (await getTask(DB, conversation.taskId))) : null;
  if (task && task.agentId !== agent.id) task = null;
  let messages: Message[] = conversation ? await messagesFor(DB, conversation.id) : [];
  // Tâches traitées avant les conversations : leur journal tient lieu de fil.
  if (conversation && !messages.length && task?.runId) {
    messages = (await eventsForRun(DB, task.runId, 300)).map((e) => ({
      id: `e${e.id}`,
      conversationId: conversation.id,
      role: e.kind === "log" ? (e.level === "think" ? "agent" : "tool") : "system",
      level: e.level,
      text: e.text,
      mid: `e${e.id}`,
      at: e.at,
    }));
  }
  // Conversation d'une action lancée : son lancement (statut, arrêt, relance).
  const actionRun = conversation?.actionStatus ? await actionRunForConversation(DB, conversation.id) : null;
  return { agent, status: displayStatus(agent, online), online: online[agent.machine] ?? false, tasks, conversations, conversation, task, messages, week, actions, actionRun, now: Date.now() };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { DB } = serverEnv();
  const form = await request.formData();
  const intent = form.get("intent");
  const taskId = String(form.get("id") ?? "");
  // Une tâche ne se manipule que depuis la page de son agent.
  const own = async () => (await getTask(DB, taskId))?.agentId === params.id;
  switch (intent) {
    case "send": {
      const text = String(form.get("text") ?? "").trim().slice(0, 20_000);
      if (!text) return { error: "Message vide." };
      const agent = await getAgent(DB, params.id);
      if (!agent) throw data("Cet agent n'existe pas.", { status: 404 });
      let conversationId = String(form.get("conversationId") ?? "new");
      const conversations = await listConversations(DB, agent.id, 200);
      let conv: Conversation | undefined = conversations.find((c) => c.id === conversationId);
      if (!conv) {
        // Une tâche sans conversation n'a pas commencé : on n'ouvre pas de discussion à sa place.
        const pending = conversationId !== "new" ? await getTask(DB, conversationId) : null;
        if (pending?.agentId === agent.id) return { error: "La tâche n'a pas encore commencé : modifie sa description en attendant." };
        conversationId = await createConversation(DB, agent.id, text.split("\n")[0].slice(0, 80));
        conv = { id: conversationId, agentId: agent.id, taskId: null, title: "", taskStatus: null, actionStatus: null, updatedAt: "" };
      }
      if (conv.taskStatus && !["en_cours", "en_pause", "question"].includes(conv.taskStatus)) return { error: "Cette tâche est terminée : ouvre une nouvelle conversation." };
      if (actionOpen(conv.actionStatus)) return { error: "L'action tourne encore : attends sa fin (ou arrête-la) avant d'en parler à l'agent." };
      const message = await addUserMessage(DB, agent.id, conversationId, text);
      // Réponse à une question : gardée aussi sur la tâche, le runner la reprend à sa synchro s'il n'a pas eu le direct.
      if (conv.taskId && conv.taskStatus === "question") await answerTask(DB, conv.taskId, text);
      // Remis tout de suite si le runner est connecté ; sinon il le prendra à sa prochaine synchro.
      await pushToRunner(
        serverEnv(),
        agent.machine,
        { type: "user_message", id: message.mid, agentId: agent.id, conversationId, text, task: Boolean(conv.taskId) },
        agent.id,
        { type: "message", conversationId, message },
      );
      return { conversationId };
    }
    case "action-run":
      return launchAction(serverEnv(), params.id, String(form.get("actionId") ?? ""));
    case "action-stop":
      await stopAction(serverEnv(), params.id, String(form.get("runId") ?? ""));
      return null;
    case "task-create": {
      // Depuis la zone de saisie : la première ligne est le titre, le tout la description.
      const text = String(form.get("text") ?? "").trim().slice(0, 60_000);
      const [first, ...rest] = text.split("\n");
      const title = first.trim().slice(0, 200);
      if (!title) return { error: "Décris la tâche." };
      const body = first.trim().length > 200 ? text : rest.join("\n").trim();
      return { taskId: await createTask(DB, { agentId: params.id, title, body, status: "prete" }) };
    }
    case "task-ready":
      if (await own()) await setTaskStatus(DB, taskId, "prete");
      return null;
    case "task-hold":
    case "task-unhold":
      await pauseTask(serverEnv(), params.id, taskId, intent === "task-hold");
      return null;
    case "task-abandon":
      await dropTask(serverEnv(), params.id, taskId);
      return null;
    case "task-reopen":
      await reopenDropped(serverEnv(), params.id, taskId);
      return null;
    case "task-reorder": {
      const ids = String(form.get("ids") ?? "").split(",").filter(Boolean).slice(0, 500);
      await reorderQueue(DB, params.id, ids);
      return null;
    }
    case "pause":
    case "resume":
      await setPaused(DB, params.id, intent === "pause");
      return null;
    // Anciennes adresses des réglages : ils ont leur page.
    case "settings":
    case "delete":
      return redirect(`/agents/${params.id}/reglages`);
  }
  return null;
}

type Item = { id: string; title: string; status: Task["status"] | null; action?: ActionRunStatus | null; at: string; issueNumber?: number | null };

/** Une entrée de l'historique : une tâche (pastille de son statut), une action lancée ou une discussion libre. */
function Entry({ agentId, item, current, now }: { agentId: string; item: Item; current: boolean; now: number }) {
  const l = item.status ? TASK_LABEL[item.status] : item.action && item.action !== "discussion" ? ACTION_STATUS[item.action] : null;
  const live = item.status === "en_cours" || actionOpen(item.action);
  return (
    <li>
      <Link className="centry" to={`/agents/${agentId}?c=${item.id}`} aria-current={current ? "page" : undefined} title={fmtWhen(item.at, now)}>
        <span className={`centry-dot ${live ? "live" : ""}`} style={{ "--c": l?.color ?? "var(--fg-3)" } as React.CSSProperties} aria-hidden="true">
          <Icon name={l ? (live ? "zap" : l.icon) : "send"} />
        </span>
        <span className="centry-title">{item.title}</span>
        {item.issueNumber ? <span className="centry-meta mono">#{item.issueNumber}</span> : null}
        <span className="sr-only">{l ? `, ${l.label}` : ", discussion"}</span>
      </Link>
    </li>
  );
}

function Group({ title, children, count }: { title: string; children: React.ReactNode; count?: number }) {
  return (
    <div className="cgroup">
      <h2>
        {title}
        {count != null && count > 0 && <span className="num">{count}</span>}
      </h2>
      {children}
    </div>
  );
}

const SIDE_KEY = "essaim.historique";

export default function AgentPage({ loaderData }: Route.ComponentProps) {
  const { agent, status, online, tasks, conversations, conversation, task, messages, week, actions, actionRun, now } = loaderData;
  const current = conversation?.id ?? null;
  const location = useLocation();
  // Historique : ouvert sur grand écran (préférence gardée), en tiroir sur téléphone.
  const [open, setOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (localStorage.getItem(SIDE_KEY) === "0") setOpen(false);
  }, []);
  useEffect(() => setDrawer(false), [location.search]);
  const toggle = () => {
    if (matchMedia("(max-width: 860px)").matches) return setDrawer((d) => !d);
    setOpen((o) => {
      localStorage.setItem(SIDE_KEY, o ? "0" : "1");
      return !o;
    });
  };

  const by = (st: Task["status"]) => tasks.filter((t) => t.status === st);
  const asItem = (t: Task): Item => ({ id: t.id, title: t.title, status: t.status, at: t.updatedAt, issueNumber: t.issueNumber });
  const convAt = new Map(conversations.map((c) => [c.id, c.updatedAt]));
  // Historique : tâches closes et discussions libres, les plus récentes d'abord.
  const history: Item[] = [
    ...tasks.filter((t) => t.status === "terminee" || t.status === "abandonnee").map((t) => ({ ...asItem(t), at: convAt.get(t.id) ?? t.updatedAt })),
    ...conversations.filter((c) => !c.taskId).map((c) => ({ id: c.id, title: c.title, status: null, action: c.actionStatus, at: c.updatedAt })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const questions = by("question");
  const working = [...by("en_cours"), ...by("en_pause")];
  const queue = by("prete");
  const drafts = by("brouillon");

  const sideButton = (
    <button type="button" className="chead-toggle" onClick={toggle} aria-expanded={open} aria-controls="historique" title={open ? "Replier l'historique" : "Afficher l'historique"}>
      <Icon name="sidebar" />
      <span className="sr-only">Historique des conversations</span>
      {questions.length > 0 && <span className="chead-badge num" aria-label={`${questions.length} question(s)`}>{questions.length}</span>}
    </button>
  );

  return (
    <div className={`chat ${open ? "" : "side-closed"} ${drawer ? "drawer" : ""}`} style={{ "--h": agent.hue } as React.CSSProperties}>
      <aside className="cside" id="historique" aria-label={`Conversations de ${agent.name}`}>
        <div className="cside-head">
          <Avatar seed={agent.seed} hue={agent.hue} size={40} status={status} />
          <div className="cside-id">
            <b>{agent.name}</b>
            <Pill status={status} />
          </div>
          <button type="button" className="chead-toggle" onClick={toggle} title="Replier l'historique">
            <Icon name="sidebar" />
            <span className="sr-only">Replier l'historique</span>
          </button>
        </div>
        <Link className="btn cside-new" to={`/agents/${agent.id}?c=new`} aria-current={current === null ? "page" : undefined}>
          <Icon name="plus" /> Nouvelle conversation
        </Link>

        <nav className="cside-scroll" aria-label="Historique">
          <Group title="Actions">
            <ActionList agentId={agent.id} actions={actions} online={online} now={now} />
          </Group>
          {questions.length > 0 && (
            <Group title="À toi de répondre" count={questions.length}>
              <ul className="centries q">
                {questions.map((t) => (
                  <Entry key={t.id} agentId={agent.id} item={asItem(t)} current={current === t.id} now={now} />
                ))}
              </ul>
            </Group>
          )}
          {working.length > 0 && (
            <Group title="En cours">
              <ul className="centries">
                {working.map((t) => (
                  <Entry key={t.id} agentId={agent.id} item={asItem(t)} current={current === t.id} now={now} />
                ))}
              </ul>
            </Group>
          )}
          <Group title="File d'attente" count={queue.length}>
            <Queue agentId={agent.id} tasks={queue} to={(id) => `/agents/${agent.id}?c=${id}`} current={current} />
          </Group>
          {drafts.length > 0 && (
            <Group title="Brouillons" count={drafts.length}>
              <ul className="centries">
                {drafts.map((t) => (
                  <Entry key={t.id} agentId={agent.id} item={asItem(t)} current={current === t.id} now={now} />
                ))}
              </ul>
            </Group>
          )}
          <Group title="Historique">
            {history.length === 0 ? (
              <p className="muted small">Rien pour l'instant.</p>
            ) : (
              <ul className="centries">
                {history.map((it) => (
                  <Entry key={it.id} agentId={agent.id} item={it} current={current === it.id} now={now} />
                ))}
              </ul>
            )}
          </Group>
        </nav>

        <div className="cside-foot">
          <Link className="cside-link" to={`/agents/${agent.id}/memoire`}>
            <Icon name="list" />
            <span>
              Mémoire
              <small>{agent.memoryAt ? `mise à jour ${fmtWhen(agent.memoryAt, now)}` : "pas encore écrite"}</small>
            </span>
          </Link>
          <Link className="cside-link" to={`/agents/${agent.id}/reglages`}>
            <Icon name="sliders" />
            <span>
              Réglages
              <small>
                {agent.repo}
                {week.sessions > 0 ? ` · ${fmtTokens(totalTokens(week))} tokens sur 7 j` : ""}
              </small>
            </span>
          </Link>
          <Form method="post">
            <button className={`btn small cside-pause ${agent.paused ? "primary" : "ghost"}`} name="intent" value={agent.paused ? "resume" : "pause"}>
              <Icon name={agent.paused ? "play" : "pause"} />
              {agent.paused ? "Relancer l'agent" : "Mettre en pause"}
            </button>
          </Form>
        </div>
      </aside>
      <button type="button" className="cside-backdrop" onClick={() => setDrawer(false)} aria-label="Fermer l'historique" tabIndex={drawer ? 0 : -1} />

      <Chat
        key={agent.id}
        agent={agent}
        status={status}
        conversation={conversation}
        task={task}
        actionRun={actionRun}
        initial={messages}
        working={task?.status === "en_cours" && status === "working"}
        canPause={!task || !tasks.some((t) => t.parentId === task.id)}
        side={sideButton}
      />
    </div>
  );
}
