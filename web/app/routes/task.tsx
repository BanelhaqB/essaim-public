import { data, Form, Link, redirect, useNavigation } from "react-router";

import { TASK_LABEL } from "~/components/tasks";
import { Icon } from "~/components/ui";
import { answerTask, createTask, deleteTask, getAgent, getTask, setTaskRepo, setTaskStatus, subtasks, taskUsage, updateTaskText } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { dropTask, reopenDropped } from "~/.server/tasks";
import { fmtWhen } from "~/lib/status";
import { cacheShare, fmtTokens, totalTokens } from "~/lib/usage";

import type { Route } from "./+types/task";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `${loaderData?.task?.title ?? "Nouvelle tâche"} · Essaim` }];

export async function loader({ params }: Route.LoaderArgs) {
  const { DB } = serverEnv();
  const agent = await getAgent(DB, params.id);
  if (!agent) throw data("Cet agent n'existe pas.", { status: 404 });
  if (params.taskId === "nouvelle") return { agent, task: null, parent: null, steps: [], usage: null, now: Date.now() };
  const task = await getTask(DB, params.taskId);
  if (!task || task.agentId !== agent.id) throw data("Cette tâche n'existe pas.", { status: 404 });
  const [parent, steps, usage] = await Promise.all([task.parentId ? getTask(DB, task.parentId) : null, subtasks(DB, task.id), taskUsage(DB, task.id)]);
  return { agent, task, parent, steps, usage, now: Date.now() };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { DB } = serverEnv();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const title = String(form.get("title") ?? "").trim().slice(0, 200);
  const body = String(form.get("body") ?? "").slice(0, 60_000);
  const back = `/agents/${params.id}`;
  const toConversation = (id: string) => `${back}?c=${id}`;

  const agent = await getAgent(DB, params.id);
  // Le repo de la tâche : un de ceux de l'agent (le principal si rien de valide n'est choisi).
  const repoId = agent?.repos.find((l) => l.repoId === form.get("repo"))?.repoId;

  if (params.taskId === "nouvelle") {
    if (!title) return { error: "Donne un titre à la tâche." };
    const id = await createTask(DB, { agentId: params.id, repoId, title, body, status: intent === "ready" ? "prete" : "brouillon" });
    return redirect(intent === "ready" ? toConversation(id) : `${back}/taches/${id}`);
  }

  const task = await getTask(DB, params.taskId);
  if (!task || task.agentId !== params.id) throw data("Cette tâche n'existe pas.", { status: 404 });
  const editable = !["terminee", "abandonnee"].includes(task.status);
  if (["save", "ready", "draft"].includes(intent) && editable) {
    if (!title) return { error: "Donne un titre à la tâche." };
    if (title !== task.title || body !== task.body) await updateTaskText(DB, task.id, title, body);
    // Le repo ne change plus une fois l'issue ouverte sur GitHub.
    if (repoId && repoId !== task.repoId && task.issueNumber == null) await setTaskRepo(DB, task.id, repoId);
  }
  switch (intent) {
    case "save":
      return { saved: Date.now() };
    case "ready":
      await setTaskStatus(DB, task.id, "prete");
      return redirect(toConversation(task.id));
    case "draft":
      await setTaskStatus(DB, task.id, "brouillon");
      return { saved: Date.now() };
    case "abandon":
      await dropTask(serverEnv(), params.id, task.id);
      return redirect(toConversation(task.id));
    case "reopen":
      await reopenDropped(serverEnv(), params.id, task.id);
      return redirect(toConversation(task.id));
    case "delete":
      await deleteTask(DB, task.id);
      return redirect(back);
    case "answer": {
      const reply = String(form.get("reply") ?? "").trim().slice(0, 8000);
      if (reply) await answerTask(DB, task.id, reply);
      return { answered: Date.now() };
    }
  }
  return null;
}

export default function TaskPage({ loaderData, actionData }: Route.ComponentProps) {
  const { agent, task, parent, steps, usage, now } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const result = actionData as { error?: string; saved?: number; answered?: number } | null | undefined;
  const status = task?.status ?? "brouillon";
  const editable = !["terminee", "abandonnee"].includes(status);
  const l = TASK_LABEL[status];

  return (
    <div className="enter task-page" style={{ "--h": agent.hue } as React.CSSProperties}>
      <Link className="back" to={`/agents/${agent.id}${task ? `?c=${task.id}` : ""}`}>
        <Icon name="left" />
        {task ? "Conversation" : agent.name}
      </Link>

      <div className="task-head">
        <span className="pill-lite" style={{ "--c": l.color } as React.CSSProperties}>
          <Icon name={l.icon} /> {task ? l.label : "Nouvelle tâche"}
        </span>
        {task?.issueNumber && (
          <a className="mono small" href={task.issueUrl ?? "#"} target="_blank" rel="noreferrer">
            {(agent.repos.find((l) => l.repoId === task.repoId) ?? agent.repos[0])?.repo ?? agent.repo}#{task.issueNumber}
          </a>
        )}
        {task?.prUrl && (
          <a className="small" href={task.prUrl} target="_blank" rel="noreferrer">
            <Icon name="pr" /> PR
          </a>
        )}
        {task && <span className="muted small">modifiée {fmtWhen(task.updatedAt, now)}</span>}
        {usage && usage.sessions > 0 && (
          <span className="muted small" title={`${fmtTokens(usage.input)} en entrée, ${fmtTokens(usage.cacheRead)} relus du cache, ${fmtTokens(usage.cacheWrite)} mis en cache, ${fmtTokens(usage.output)} écrits`}>
            {fmtTokens(totalTokens(usage))} tokens · {cacheShare(usage)} % du cache
          </span>
        )}
      </div>
      {parent && (
        <p className="muted small">
          Étape de <Link to={`/agents/${agent.id}/taches/${parent.id}`}>{parent.title}</Link>
        </p>
      )}
      {steps.length > 0 && (
        <section className="panel">
          <h2>
            Étapes ({steps.filter((s) => s.status === "terminee").length}/{steps.length})
          </h2>
          <ul className="tasks">
            {steps.map((st) => {
              const sl = TASK_LABEL[st.status];
              return (
                <li key={st.id} className="task-row">
                  <span className="dot" style={{ "--c": sl.color } as React.CSSProperties}>
                    <Icon name={sl.icon} />
                  </span>
                  <Link className="task-title" to={`/agents/${agent.id}/taches/${st.id}`}>
                    {st.title}
                  </Link>
                  <span className="muted small">{sl.label}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {result?.error && (
        <p className="note err" role="alert">
          <Icon name="alert" /> {result.error}
        </p>
      )}

      {task?.status === "question" && (
        <section className="panel question-panel">
          <h2>
            <Icon name="help" /> {agent.name} attend ta réponse
          </h2>
          <p className="pre">{task.question}</p>
          {task.reply || result?.answered ? (
            <p className="muted small">Réponse envoyée : l'agent reprend la tâche au prochain passage (20 s).</p>
          ) : (
            <Form method="post" className="req-reply">
              <input type="hidden" name="intent" value="answer" />
              <label className="sr-only" htmlFor="reply">
                Ta réponse
              </label>
              <textarea id="reply" name="reply" required rows={4} placeholder="Ta réponse…" />
              <div className="row">
                <button className="btn primary" disabled={busy}>
                  <Icon name="send" /> Répondre
                </button>
              </div>
            </Form>
          )}
        </section>
      )}

      {task?.summary && task.status === "terminee" && (
        <section className="panel">
          <h2>Ce que l'agent a fait</h2>
          <p className="pre">{task.summary}</p>
        </section>
      )}

      <Form method="post" className="panel task-editor">
        {agent.repos.length > 1 && (
          <div className="field">
            <label htmlFor="t-repo">Repo</label>
            <select id="t-repo" name="repo" defaultValue={task?.repoId ?? agent.repos[0].repoId} disabled={!editable || task?.issueNumber != null}>
              {agent.repos.map((l) => (
                <option key={l.repoId} value={l.repoId}>
                  {l.repo}
                </option>
              ))}
            </select>
            {task?.issueNumber != null && <span className="help">Le repo ne change plus une fois l'issue ouverte.</span>}
          </div>
        )}
        <div className="field">
          <label htmlFor="t-title">Titre</label>
          <input type="text" id="t-title" name="title" defaultValue={task?.title ?? ""} required maxLength={200} readOnly={!editable} autoFocus={!task} />
        </div>
        <div className="field">
          <label htmlFor="t-body">Description</label>
          <textarea
            id="t-body"
            name="body"
            defaultValue={task?.body ?? ""}
            readOnly={!editable}
            rows={16}
            placeholder={"Ce que tu attends, le contexte, les critères de fin.\nL'agent découpera lui-même une grosse tâche en étapes."}
          />
          <span className="help">
            Markdown. {task?.issueNumber ? "Chaque enregistrement est recopié sur l'issue GitHub." : "L'issue GitHub est créée quand la tâche passe en file."}
          </span>
        </div>
        {editable && (
          <div className="row">
            {(status === "brouillon" || !task) && (
              <button className="btn primary" name="intent" value="ready" disabled={busy}>
                <Icon name="list" /> Mettre en file
              </button>
            )}
            <button className={`btn ${status === "brouillon" ? "" : "primary"}`} name="intent" value="save" disabled={busy}>
              Enregistrer
            </button>
            {status === "prete" && (
              <button className="btn ghost" name="intent" value="draft" disabled={busy}>
                Retirer de la file
              </button>
            )}
            {result?.saved && !busy && (
              <span className="saved" role="status">
                <Icon name="check" /> Enregistré
              </span>
            )}
          </div>
        )}
      </Form>

      {task && editable && (
        <Form
          method="post"
          className="row task-danger"
          onSubmit={(e) => {
            // L'agent y travaille peut-être : on demande confirmation avant de l'arrêter.
            if (!["brouillon", "prete"].includes(status) && !confirm(`Abandonner « ${task.title} » ? ${agent.name} arrête d'y travailler et l'issue est fermée.`)) e.preventDefault();
          }}
        >
          {status === "brouillon" && !task.issueNumber ? (
            <button className="btn ghost small" name="intent" value="delete">
              <Icon name="x" /> Supprimer le brouillon
            </button>
          ) : (
            <button className="btn ghost small" name="intent" value="abandon">
              <Icon name="x" /> Abandonner la tâche
            </button>
          )}
        </Form>
      )}

      {task && status === "abandonnee" && (
        <Form method="post" className="row task-danger">
          <button className="btn small" name="intent" value="reopen" disabled={busy} title="Elle repart en tête de file, depuis ce qui est déjà poussé sur sa branche">
            <Icon name="play" /> Reprendre la tâche
          </button>
        </Form>
      )}
    </div>
  );
}
