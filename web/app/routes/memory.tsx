import { data, Form, Link, useNavigation } from "react-router";

import { Icon } from "~/components/ui";
import { agentUsage, getAgent, journalFor, updateBrief, updateMemory } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { fmtWhen } from "~/lib/status";
import { cacheShare, fmtTokens, totalTokens } from "~/lib/usage";

import type { Route } from "./+types/memory";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `Mémoire de ${loaderData?.agent.name ?? "l'agent"} · Essaim` }];

export async function loader({ params }: Route.LoaderArgs) {
  const { DB } = serverEnv();
  const agent = await getAgent(DB, params.id);
  if (!agent) throw data("Cet agent n'existe pas.", { status: 404 });
  const day = 86_400_000;
  const [journal, week, month] = await Promise.all([
    journalFor(DB, agent.id, 40),
    agentUsage(DB, agent.id, new Date(Date.now() - 7 * day).toISOString()),
    agentUsage(DB, agent.id, new Date(Date.now() - 30 * day).toISOString()),
  ]);
  return { agent, journal, week, month, now: Date.now() };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { DB } = serverEnv();
  const form = await request.formData();
  const text = String(form.get("text") ?? "").slice(0, 60_000);
  if (form.get("intent") === "brief") await updateBrief(DB, params.id, text);
  if (form.get("intent") === "memory") await updateMemory(DB, params.id, text);
  return { saved: String(form.get("intent")) };
}

export default function Memory({ loaderData, actionData }: Route.ComponentProps) {
  const { agent, journal, week, month, now } = loaderData;
  const busy = useNavigation().state !== "idle";
  const saved = (k: string) => actionData?.saved === k && !busy;
  return (
    <div className="enter task-page" style={{ "--h": agent.hue } as React.CSSProperties}>
      <Link className="back" to={`/agents/${agent.id}`}>
        <Icon name="left" />
        {agent.name}
      </Link>
      <div className="view-head">
        <div>
          <h1>Mémoire de {agent.name}</h1>
          <p>Ce que l'agent sait du projet au début de chaque session. Gardée courte, elle reste en cache d'une session à l'autre.</p>
        </div>
      </div>

      <section className="panel">
        <h2>Consommation</h2>
        <div className="usage-grid">
          {[
            ["7 jours", week],
            ["30 jours", month],
          ].map(([label, u]) => {
            const usage = u as typeof week;
            return (
              <div key={String(label)} className="usage-card">
                <span className="muted small">{String(label)}</span>
                <b className="num">{fmtTokens(totalTokens(usage))}</b>
                <span className="muted small">
                  {usage.sessions} session(s) · {cacheShare(usage)} % relu du cache · {fmtTokens(usage.output)} écrits
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <Form method="post" className="panel task-editor">
        <input type="hidden" name="intent" value="brief" />
        <div className="field">
          <label htmlFor="brief">Brief</label>
          <textarea id="brief" name="text" rows={8} defaultValue={agent.brief} placeholder={"Ce qu'est le projet, à qui il sert, ses objectifs, ses règles et ce qu'il ne faut jamais faire."} />
          <span className="help">Écrit par toi. L'agent le lit au début de chaque session.</span>
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy}>
            Enregistrer le brief
          </button>
          {saved("brief") && (
            <span className="saved" role="status">
              <Icon name="check" /> Enregistré
            </span>
          )}
        </div>
      </Form>

      <Form method="post" className="panel task-editor">
        <input type="hidden" name="intent" value="memory" />
        <div className="field">
          <label htmlFor="memory">Mémoire de l'agent</label>
          <textarea id="memory" name="text" rows={14} defaultValue={agent.memory} placeholder="Vide : l'agent la remplira à la fin de sa première tâche." />
          <span className="help">
            Tenue par l'agent en fin de tâche (200 lignes au plus){agent.memoryAt ? ` · mise à jour ${fmtWhen(agent.memoryAt, now)}` : ""}. Tu peux la corriger.
          </span>
        </div>
        <div className="row">
          <button className="btn" disabled={busy}>
            Enregistrer la mémoire
          </button>
          {saved("memory") && (
            <span className="saved" role="status">
              <Icon name="check" /> Enregistrée
            </span>
          )}
        </div>
      </Form>

      <section className="panel">
        <h2>Journal ({journal.length})</h2>
        <p className="muted small">Un résumé par tâche terminée. L'agent le consulte seulement quand il a besoin d'un détail passé.</p>
        {journal.length === 0 ? (
          <p className="muted">Aucune tâche terminée.</p>
        ) : (
          <ul className="journal">
            {journal.map((j, i) => (
              <li key={i}>
                <b>
                  {j.issueNumber && <span className="mono">#{j.issueNumber} </span>}
                  {j.title}
                </b>
                <span className="muted small"> · {fmtWhen(j.at, now)}</span>
                <p className="pre muted small">{j.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
