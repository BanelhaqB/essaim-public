import { Form, useNavigation } from "react-router";

import { Icon } from "~/components/ui";
import { assignTask, getTask, inboxTasks, listAgents, setTaskStatus } from "~/.server/db";
import { serverEnv } from "~/.server/env";

import type { Route } from "./+types/inbox";

export const meta: Route.MetaFunction = () => [{ title: "Boîte de réception · Essaim" }];

export async function loader() {
  const { DB } = serverEnv();
  const [tasks, agents] = await Promise.all([inboxTasks(DB), listAgents(DB)]);
  return { tasks, agents: agents.map(({ id, name, repo }) => ({ id, name, repo })) };
}

export async function action({ request }: Route.ActionArgs) {
  const { DB } = serverEnv();
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const task = await getTask(DB, id);
  if (!task || task.agentId) return null;
  if (form.get("intent") === "abandon") {
    await setTaskStatus(DB, id, "abandonnee");
    return null;
  }
  const agentId = String(form.get("agent") ?? "");
  if (!agentId) return { error: "Choisis un agent." };
  await assignTask(DB, id, agentId);
  if (form.get("intent") === "assign-ready") await setTaskStatus(DB, id, "prete");
  return null;
}

export default function Inbox({ loaderData }: Route.ComponentProps) {
  const { tasks, agents } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <div className="enter">
      <div className="view-head">
        <div>
          <h1>Boîte de réception</h1>
          <p>Les tâches importées (brouillons du Project 4) qui n'ont pas encore d'agent. Attribue-les en brouillon, ou directement en file.</p>
        </div>
      </div>
      {tasks.length === 0 ? (
        <div className="panel empty">
          <Icon name="inbox" />
          <p>Rien à trier.</p>
        </div>
      ) : (
        <ul className="inbox">
          {tasks.map((t) => (
            <li key={t.id} className="panel inbox-item">
              <div className="inbox-text">
                <b>{t.title}</b>
                {t.sourceLabel && <span className="tag">{t.sourceLabel}</span>}
                {t.body && <p className="muted small pre">{t.body.slice(0, 400)}</p>}
              </div>
              <Form method="post" className="inbox-actions">
                <input type="hidden" name="id" value={t.id} />
                <label className="sr-only" htmlFor={`a-${t.id}`}>
                  Agent pour « {t.title} »
                </label>
                <select id={`a-${t.id}`} name="agent" defaultValue="" required>
                  <option value="" disabled>
                    Agent…
                  </option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.repo}
                    </option>
                  ))}
                </select>
                <button className="btn" name="intent" value="assign" disabled={busy}>
                  En brouillon
                </button>
                <button className="btn primary" name="intent" value="assign-ready" disabled={busy}>
                  En file
                </button>
                <button className="icon-btn" name="intent" value="abandon" formNoValidate aria-label={`Écarter « ${t.title} »`} disabled={busy}>
                  <Icon name="x" />
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
