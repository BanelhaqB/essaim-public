/**
 * Conversation avec un agent sur toute la page, façon Claude Code : une tâche = une conversation. Le fil s'ouvre sur
 * la demande (la tâche), puis le texte de l'agent, ses appels d'outils repliés, ses questions et tes messages ; il se
 * clôt sur ce que l'agent a fait. Le direct arrive par la WebSocket de la page (/ws/agents/:id, relayée par le hub) ;
 * l'historique vient du loader. Entrée envoie, Maj+Entrée va à la ligne.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Form, Link, useFetcher, useNavigate, useRevalidator } from "react-router";

import { Markdown } from "~/components/markdown";
import { TASK_LABEL } from "~/components/tasks";
import { Avatar, Icon } from "~/components/ui";
import { ACTION_STATUS, actionOpen, fmtDuration } from "~/lib/actions";
import { fmtTime } from "~/lib/status";
import type { ActionRun, AgentStatus, Conversation, LiveEvent, Message, Task } from "~/lib/types";

export interface ConversationView {
  id: string;
  title: string;
  taskId: string | null;
  taskStatus: Conversation["taskStatus"];
  actionStatus: Conversation["actionStatus"];
}

type ChatAgent = { id: string; name: string; seed: string; hue: number };

const key = (m: Message) => m.mid ?? String(m.id);

function merge(base: Message[], extra: Message[]) {
  const seen = new Set(base.map(key));
  const out = [...base];
  for (const m of extra) if (!seen.has(key(m))) out.push(m);
  return out;
}

/** WebSocket de la page d'un agent, reconnectée toute seule. */
function useAgentSocket(agentId: string, onEvent: (e: LiveEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/agents/${agentId}`);
      ws.onopen = () => {
        retry = 1000;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        try {
          handler.current(JSON.parse(event.data));
        } catch {
          /* message illisible */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [agentId]);
  return connected;
}

function ToolLine({ m }: { m: Message }) {
  return (
    <div className={`msg-tool ${m.level ?? ""}`}>
      <Icon name={m.level === "run" ? "zap" : m.level === "error" ? "alert" : "git"} />
      <span>{m.text}</span>
    </div>
  );
}

function QuestionCard({ m, agentName, open }: { m: Message; agentName: string; open: boolean }) {
  return (
    <div className="msg-card question" role="note">
      <div className="msg-card-head">
        <Icon name="help" />
        <b>{open ? `${agentName} attend ta réponse` : `Question de ${agentName}`}</b>
        <time className="msg-time num">{fmtTime(m.at)}</time>
      </div>
      <div className="msg-text">
        <Markdown text={m.text} />
      </div>
      {open && <p className="msg-card-foot">Réponds dans la zone ci-dessous : l'agent reprend la tâche avec ta réponse.</p>}
    </div>
  );
}

function Bubble({ m, agentName, openQuestion }: { m: Message; agentName: string; openQuestion: boolean }) {
  if (m.role === "tool") return <ToolLine m={m} />;
  if (m.role === "system") return <p className="msg-system">{m.text}</p>;
  if (m.level === "question") return <QuestionCard m={m} agentName={agentName} open={openQuestion} />;
  return (
    <div className={`msg ${m.role === "user" ? "msg-user" : "msg-agent"}`}>
      <div className="msg-text">{m.role === "agent" ? <Markdown text={m.text} /> : m.text}</div>
      <time className="msg-time num">{fmtTime(m.at)}</time>
    </div>
  );
}

/** Regroupe les appels d'outils consécutifs : seuls les 3 derniers restent visibles, le reste se déplie. */
function Thread({ messages, agentName, questionOpen }: { messages: Message[]; agentName: string; questionOpen: boolean }) {
  const out: React.ReactNode[] = [];
  let tools: Message[] = [];
  // Seule la dernière question attend encore une réponse.
  const lastQuestion = questionOpen ? [...messages].reverse().find((m) => m.level === "question") : undefined;
  const flush = (k: string) => {
    if (!tools.length) return;
    const hidden = tools.slice(0, -3);
    const shown = tools.slice(-3);
    out.push(
      <div className="msg-tools" key={k}>
        {hidden.length > 0 && (
          <details>
            <summary>{hidden.length} action(s) de plus</summary>
            {hidden.map((m) => (
              <ToolLine key={key(m)} m={m} />
            ))}
          </details>
        )}
        {shown.map((m) => (
          <ToolLine key={key(m)} m={m} />
        ))}
      </div>,
    );
    tools = [];
  };
  let output: Message[] = [];
  const flushOutput = (k: string) => {
    if (!output.length) return;
    out.push(<Output key={k} lines={output.map((m) => m.text).join("")} />);
    output = [];
  };
  messages.forEach((m, i) => {
    // Sortie d'une commande (action en un clic) : les morceaux consécutifs forment un seul terminal.
    if (m.role === "tool" && m.level === "output") {
      flush(`t${i}`);
      output.push(m);
      return;
    }
    flushOutput(`o${i}`);
    if (m.role === "tool") {
      tools.push(m);
      return;
    }
    flush(`t${i}`);
    out.push(<Bubble key={key(m)} m={m} agentName={agentName} openQuestion={m === lastQuestion} />);
  });
  flush("t-end");
  flushOutput("o-end");
  return <>{out}</>;
}

/** Sortie d'une commande, façon terminal : on suit la fin tant qu'on n'est pas remonté lire. */
function Output({ lines }: { lines: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (ref.current && stick.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <pre
      className="msg-output"
      ref={ref}
      tabIndex={0}
      aria-label="Sortie de la commande"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {lines.replace(/\n$/, "")}
    </pre>
  );
}

/** En tête du fil d'une action lancée : son nom, sa commande et où elle en est. */
function ActionHead({ run }: { run: ActionRun }) {
  const st = ACTION_STATUS[run.status];
  const took = run.startedAt && run.endedAt ? fmtDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt)) : null;
  return (
    <div className="msg msg-user msg-brief action-brief">
      <div className="msg-text">
        <b className="brief-title">{run.name}</b>
        {run.command ? <pre className="action-cmd">{run.command}</pre> : null}
      </div>
      <div className="brief-meta">
        <span style={{ color: st.color }}>
          {run.status === "demandee" ? "En attente de la machine…" : st.label}
          {took ? ` · ${took}` : ""}
          {run.exitCode != null && run.status === "echouee" ? ` · code ${run.exitCode}` : ""}
        </span>
        <time className="msg-time num">{fmtTime(run.requestedAt)}</time>
      </div>
    </div>
  );
}

/** La demande qui ouvre la conversation d'une tâche : son titre et sa description, repliée si elle est longue. */
function Brief({ task }: { task: Task }) {
  const long = task.body.length > 600 || task.body.split("\n").length > 12;
  const [open, setOpen] = useState(!long);
  return (
    <div className="msg msg-user msg-brief">
      <div className={`msg-text ${open ? "" : "clamped"}`}>
        <b className="brief-title">{task.title}</b>
        {task.body.trim() && <Markdown text={task.body} />}
      </div>
      <div className="brief-meta">
        {long && (
          <button type="button" className="linkish" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Replier" : "Tout afficher"}
          </button>
        )}
        {task.sourceLabel && <span>{task.sourceLabel}</span>}
        <time className="msg-time num">{fmtTime(task.createdAt)}</time>
      </div>
    </div>
  );
}

/** Fin du fil : ce que l'agent a fait, ou l'abandon. */
function Outcome({ task }: { task: Task }) {
  if (task.status === "abandonnee") return <p className="msg-system">Tâche abandonnée. Le travail déjà poussé reste sur sa branche : « Reprendre » la remet en tête de file.</p>;
  if (task.status !== "terminee") return null;
  return (
    <div className="msg-card done" role="note">
      <div className="msg-card-head">
        <Icon name="check" />
        <b>Tâche terminée</b>
        {task.prUrl && (
          <a href={task.prUrl} target="_blank" rel="noreferrer">
            <Icon name="pr" /> Pull request
          </a>
        )}
      </div>
      {task.summary && (
        <div className="msg-text">
          <Markdown text={task.summary} />
        </div>
      )}
    </div>
  );
}

const MEMORY_ASK = "Retiens l'essentiel de cette conversation : mets à jour ta mémoire du projet (MEMOIRE.md), en fusionnant avec ce qui y est déjà.";

export function Chat({
  agent,
  status,
  conversation,
  task,
  actionRun = null,
  initial,
  working,
  side,
  canPause = true,
}: {
  agent: ChatAgent;
  status: AgentStatus;
  conversation: ConversationView | null;
  task: Task | null;
  /** Conversation d'une action lancée : son lancement. */
  actionRun?: ActionRun | null;
  initial: Message[];
  working: boolean;
  /** Bouton qui ouvre ou replie l'historique. */
  side: React.ReactNode;
  /** Une tâche découpée n'a pas de session à elle : ses étapes se mettent en pause une à une. */
  canPause?: boolean;
}) {
  const convId = conversation?.id ?? "new";
  const [messages, setMessages] = useState(initial);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState(working);
  const [mode, setMode] = useState<"chat" | "task">("chat");
  const fetcher = useFetcher<{ conversationId?: string; taskId?: string; error?: string }>();
  // Pause, reprise, abandon : à part, pour ne pas mêler leur résultat à celui de l'envoi.
  const control = useFetcher();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  // Nouvelle conversation choisie : on repart de l'historique du loader ; sinon on y ajoute ce qui est arrivé en direct.
  const lastConv = useRef(convId);
  useEffect(() => {
    if (lastConv.current !== convId) {
      lastConv.current = convId;
      setMessages(initial);
      setStream("");
      stick.current = true;
    } else {
      setMessages((prev) => merge(initial, prev));
    }
  }, [convId, initial]);
  useEffect(() => setBusy(working), [working, convId]);

  const connected = useAgentSocket(agent.id, (e) => {
    if (e.type === "refresh") {
      if (revalidator.state === "idle") revalidator.revalidate();
      return;
    }
    if (e.conversationId !== convId) return;
    if (e.type === "message") {
      setMessages((prev) => merge(prev, [e.message]));
      if (e.message.role === "agent") setStream("");
    } else if (e.type === "delta") {
      setStream((s) => s + e.text);
      setBusy(true);
    } else if (e.type === "status") {
      setBusy(e.state === "working");
      if (e.state === "idle") setStream("");
    }
  });

  // Défilement : on reste en bas tant que l'utilisateur n'est pas remonté lire.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, stream, convId]);

  // Première réponse d'une nouvelle conversation, ou tâche créée : on passe sur son adresse, une seule fois (le
  // résultat du fetcher reste là quand on ouvre ensuite une autre conversation).
  const followed = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || followed.current === fetcher.data) return;
    followed.current = fetcher.data;
    const created = fetcher.data.taskId ?? fetcher.data.conversationId;
    if (created && created !== convId) navigate(`/agents/${agent.id}?c=${created}`, { replace: !fetcher.data.taskId });
  }, [fetcher.state, fetcher.data, convId, agent.id, navigate]);

  const taskStatus = task?.status ?? conversation?.taskStatus ?? null;
  // Une commande qui tourne : le fil défile, on n'écrit pas à l'agent en même temps.
  const actionRunning = Boolean(actionRun?.command) && actionOpen(actionRun?.status);
  const closed = taskStatus === "terminee" || taskStatus === "abandonnee";
  const held = taskStatus === "en_pause";
  // Une tâche commencée se met en pause ou s'abandonne depuis l'en-tête.
  const pending = control.formData?.get("intent");
  const started = Boolean(task) && (taskStatus === "en_cours" || held || taskStatus === "question");
  const waiting = taskStatus === "prete" || taskStatus === "brouillon";
  const isNew = !conversation;
  const locked = closed || waiting;
  const placeholder = closed
    ? "Tâche terminée : ouvre une nouvelle conversation pour en reparler."
    : waiting
      ? `La conversation s'ouvre quand ${agent.name} commence la tâche.`
      : taskStatus === "question"
        ? `Réponds à ${agent.name}…`
        : held
        ? `Tâche en pause : ton message sera transmis à ${agent.name} à la reprise…`
        : taskStatus === "en_cours"
          ? `Écris à ${agent.name} pendant qu'il travaille…`
          : actionRun?.command
            ? `Demande à ${agent.name} ce qu'il en pense, ou de corriger l'action…`
            : isNew && mode === "task"
            ? "Décris la tâche : la première ligne sert de titre."
            : `Demande quelque chose à ${agent.name}…`;

  const send = () => {
    const text = input.current?.value.trim();
    if (!text || locked || fetcher.state !== "idle") return;
    if (isNew && mode === "task") {
      fetcher.submit({ intent: "task-create", text }, { method: "post", action: `/agents/${agent.id}` });
    } else {
      fetcher.submit({ intent: "send", conversationId: convId, text }, { method: "post", action: `/agents/${agent.id}` });
      setBusy(true);
    }
    if (input.current) input.current.value = "";
    stick.current = true;
  };

  // Question restée sans message dans le fil (tâche d'avant cette version) : on l'affiche quand même.
  const thread =
    task?.status === "question" && task.question && !messages.some((m) => m.level === "question")
      ? [...messages, { id: `q-${task.id}`, conversationId: convId, role: "agent" as const, level: "question", text: task.question, mid: `q-${task.id}`, at: task.updatedAt }]
      : messages;
  const label = taskStatus ? TASK_LABEL[taskStatus] : actionRun?.command ? ACTION_STATUS[actionRun.status] : null;
  const empty = !task && !actionRun && messages.length === 0 && !stream;

  return (
    <section className="cmain" aria-label={`Conversation avec ${agent.name}`}>
      <header className="chead">
        {side}
        <h1 className="chead-title">{task?.title ?? conversation?.title ?? "Nouvelle conversation"}</h1>
        {label && (
          <span className="pill-lite" style={{ "--c": label.color } as React.CSSProperties}>
            <Icon name={label.icon} /> {label.label}
          </span>
        )}
        <div className="chead-actions">
          {task?.issueNumber && (
            <a className="chead-link mono" href={task.issueUrl ?? "#"} target="_blank" rel="noreferrer" title="Issue GitHub">
              #{task.issueNumber}
            </a>
          )}
          {task?.prUrl && (
            <a className="chead-link" href={task.prUrl} target="_blank" rel="noreferrer" title="Pull request">
              <Icon name="pr" />
              <span>PR</span>
            </a>
          )}
          {task && started && taskStatus === "en_cours" && canPause && (
            <control.Form method="post" action={`/agents/${agent.id}`}>
              <input type="hidden" name="id" value={task.id} />
              <button className="chead-link" name="intent" value="task-hold" disabled={control.state !== "idle"} title="Arrête l'agent sur cette tâche ; elle reprendra là où elle en est">
                <Icon name="pause" />
                <span>{pending === "task-hold" ? "Pause…" : "Pause"}</span>
              </button>
            </control.Form>
          )}
          {task && held && (
            <control.Form method="post" action={`/agents/${agent.id}`}>
              <input type="hidden" name="id" value={task.id} />
              <button className="chead-link" name="intent" value="task-unhold" disabled={control.state !== "idle"} title="L'agent reprend la tâche là où il l'a laissée">
                <Icon name="play" />
                <span>{pending === "task-unhold" ? "Reprise…" : "Reprendre"}</span>
              </button>
            </control.Form>
          )}
          {task && started && (
            <control.Form
              method="post"
              action={`/agents/${agent.id}`}
              onSubmit={(e) => {
                const ok = confirm(`Abandonner « ${task.title} » ?\n\n${agent.name} arrête d'y travailler et l'issue est fermée. Ce qui est déjà poussé reste sur sa branche.`);
                if (!ok) e.preventDefault();
              }}
            >
              <input type="hidden" name="id" value={task.id} />
              <button className="chead-link" name="intent" value="task-abandon" disabled={control.state !== "idle"} title="Arrête et ferme la tâche">
                <Icon name="x" />
                <span>Abandonner</span>
              </button>
            </control.Form>
          )}
          {task && taskStatus === "abandonnee" && (
            <control.Form method="post" action={`/agents/${agent.id}`}>
              <input type="hidden" name="id" value={task.id} />
              <button
                className="chead-link"
                name="intent"
                value="task-reopen"
                disabled={control.state !== "idle"}
                title="La tâche repart en tête de file, depuis ce qui est déjà poussé sur sa branche"
              >
                <Icon name="play" />
                <span>{pending === "task-reopen" ? "Reprise…" : "Reprendre"}</span>
              </button>
            </control.Form>
          )}
          {actionRun && actionRunning && (
            <fetcher.Form method="post" action={`/agents/${agent.id}`}>
              <input type="hidden" name="runId" value={actionRun.id} />
              <button className="chead-link" name="intent" value="action-stop" title="Arrête la commande sur la machine">
                <Icon name="x" />
                <span>Arrêter</span>
              </button>
            </fetcher.Form>
          )}
          {actionRun?.actionId && !actionOpen(actionRun.status) && actionRun.status !== "discussion" && (
            <fetcher.Form method="post" action={`/agents/${agent.id}`}>
              <input type="hidden" name="actionId" value={actionRun.actionId} />
              <button className="chead-link" name="intent" value="action-run" title="Relance l'action (nouvelle conversation)">
                <Icon name="reroll" />
                <span>Relancer</span>
              </button>
            </fetcher.Form>
          )}
          {task && (
            <Link className="chead-link" to={`/agents/${agent.id}/taches/${task.id}`} title="Description, étapes et consommation">
              <Icon name="edit" />
              <span>{waiting ? "Modifier" : "Détails"}</span>
            </Link>
          )}
          {conversation && !task && !actionRunning && (
            <button
              type="button"
              className="chead-link"
              title="Demande à l'agent de verser l'essentiel de cette conversation dans sa mémoire"
              disabled={fetcher.state !== "idle"}
              onClick={() => {
                fetcher.submit({ intent: "send", conversationId: convId, text: MEMORY_ASK }, { method: "post", action: `/agents/${agent.id}` });
                setBusy(true);
              }}
            >
              <Icon name="list" />
              <span>Retenir</span>
            </button>
          )}
          <span className={`live-dot ${connected ? "on" : ""}`} title={connected ? "En direct" : "Reconnexion…"} />
        </div>
      </header>

      <div
        className="cscroll"
        ref={list}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className={`ccol ${empty ? "ccol-empty" : ""}`}>
          {empty ? (
            <div className="chat-hello">
              <Avatar seed={agent.seed} hue={agent.hue} size={76} status={status} />
              <h2>{conversation ? `Écris à ${agent.name}` : `Que doit faire ${agent.name} ?`}</h2>
              <p>
                {isNew && mode === "task"
                  ? "La tâche part dans sa file avec son issue GitHub ; sa conversation s'ouvre quand il la commence."
                  : "Il répond tout de suite, dans son repo, sur une branche à part. Ce qu'il apprend rejoint sa mémoire, partagée avec ses tâches."}
              </p>
            </div>
          ) : (
            <>
              {task && <Brief task={task} />}
              {actionRun?.command && <ActionHead run={actionRun} />}
              <Thread messages={thread} agentName={agent.name} questionOpen={task?.status === "question"} />
              {stream && (
                <div className="msg msg-agent streaming">
                  <div className="msg-text">{stream}</div>
                </div>
              )}
              {(busy || actionRunning) && !stream && !locked && (
                <div className="typing" aria-label={`${agent.name} travaille`}>
                  <i />
                  <i />
                  <i />
                </div>
              )}
              {task && <Outcome task={task} />}
              {held && task && (
                <control.Form method="post" action={`/agents/${agent.id}`} className="msg-held">
                  <span>En pause : {agent.name} la reprendra là où il s'est arrêté. En attendant, il avance sur la suite de sa file.</span>
                  <input type="hidden" name="id" value={task.id} />
                  <button className="btn small primary" name="intent" value="task-unhold" disabled={control.state !== "idle"}>
                    <Icon name="play" /> Reprendre
                  </button>
                </control.Form>
              )}
              {waiting && task && (
                <p className="msg-system">
                  {task.status === "prete" ? `En file d'attente : ${agent.name} la prendra à son tour.` : "Brouillon : mets-la en file quand elle est prête."}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="cfoot">
        <div className="ccol">
          {actionRunning && actionRun ? (
            <fetcher.Form method="post" action={`/agents/${agent.id}`} className="composer-locked">
              <span>
                {actionRun.status === "demandee" ? "L'action attend la machine." : "L'action tourne sur la machine."} Tu pourras ensuite en parler à {agent.name} ici.
              </span>
              <input type="hidden" name="runId" value={actionRun.id} />
              <button className="btn small" name="intent" value="action-stop">
                <Icon name="x" /> Arrêter
              </button>
            </fetcher.Form>
          ) : closed ? (
            <div className="composer-locked">
              <span>{placeholder}</span>
              <Link className="btn small primary" to={`/agents/${agent.id}?c=new`}>
                <Icon name="plus" /> Nouvelle conversation
              </Link>
            </div>
          ) : waiting && task ? (
            <Form method="post" action={`/agents/${agent.id}`} className="composer-locked">
              <span>{placeholder}</span>
              <input type="hidden" name="id" value={task.id} />
              {task.status === "brouillon" && (
                <button className="btn small primary" name="intent" value="task-ready">
                  <Icon name="list" /> Mettre en file
                </button>
              )}
              <Link className="btn small" to={`/agents/${agent.id}/taches/${task.id}`}>
                <Icon name="edit" /> Modifier
              </Link>
            </Form>
          ) : (
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <label className="sr-only" htmlFor="composer-text">
                Message à {agent.name}
              </label>
              <textarea
                id="composer-text"
                ref={input}
                rows={2}
                placeholder={placeholder}
                autoFocus={isNew}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-bar">
                {isNew ? (
                  <div className="seg" role="radiogroup" aria-label="Type de conversation">
                    <button type="button" role="radio" aria-checked={mode === "chat"} onClick={() => setMode("chat")}>
                      Discussion
                    </button>
                    <button type="button" role="radio" aria-checked={mode === "task"} onClick={() => setMode("task")}>
                      Tâche en file
                    </button>
                  </div>
                ) : (
                  <span className="composer-hint">Entrée pour envoyer · Maj+Entrée pour aller à la ligne</span>
                )}
                {isNew && mode === "task" && (
                  <Link className="composer-hint" to={`/agents/${agent.id}/taches/nouvelle`}>
                    Rédiger en détail
                  </Link>
                )}
                <button className="btn primary composer-send" disabled={fetcher.state !== "idle"} aria-label={isNew && mode === "task" ? "Mettre en file" : "Envoyer"}>
                  <Icon name={isNew && mode === "task" ? "list" : "send"} />
                </button>
              </div>
            </form>
          )}
          {fetcher.data?.error && (
            <p className="err small" role="alert">
              {fetcher.data.error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
