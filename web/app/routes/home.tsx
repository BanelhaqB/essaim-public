import { useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";

import { ServiceCard } from "~/components/services";
import { Avatar, Icon, Pill } from "~/components/ui";
import { agentProgress, listAgents, listMachines, listServices, nightSummary, openQuestionTasks, reorderAgents, setFocus, setPaused, taskCounts } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { fmtSince, gaugeParts, type Progress } from "~/lib/progress";
import { displayStatus, fmtTime } from "~/lib/status";
import type { Agent, AgentStatus, TaskStatus } from "~/lib/types";

import type { Route } from "./+types/home";

export const meta: Route.MetaFunction = () => [{ title: "L'équipe · Essaim" }];

export async function loader() {
  const { DB } = serverEnv();
  const since = new Date(Date.now() - 12 * 3600_000).toISOString();
  const now = Date.now();
  const [agents, machines, questions, night, counts, services, progress] = await Promise.all([
    listAgents(DB),
    listMachines(DB),
    openQuestionTasks(DB),
    nightSummary(DB, since),
    taskCounts(DB),
    listServices(DB),
    agentProgress(DB, now),
  ]);
  const online = Object.fromEntries(machines.map((m) => [m.name, m.online]));
  return { agents, online, questions, night, counts, services, progress, now };
}

export async function action({ request }: Route.ActionArgs) {
  const { DB } = serverEnv();
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  switch (form.get("intent")) {
    case "focus":
      await setFocus(DB, form.get("on") === "1");
      break;
    case "pause":
      await setPaused(DB, id, true);
      break;
    case "resume":
      await setPaused(DB, id, false);
      break;
    case "reorder":
      await reorderAgents(DB, String(form.get("ids") ?? "").split(",").filter(Boolean));
      break;
  }
  return null;
}

function NowLine({ agent, status }: { agent: Agent; status: AgentStatus }) {
  const d = agent.statusDetail;
  const issue = d.issueNumber ? (
    <b>
      <span className="mono">#{d.issueNumber}</span> {d.issueTitle}
    </b>
  ) : null;
  switch (status) {
    case "working":
      return <>{issue}</>;
    case "starting":
      return <>Une place est libre : il démarre.</>;
    case "waiting":
      return <>Du travail en attente : toutes les places du Mac sont prises.</>;
    case "retry":
      return <>Le dernier essai a échoué{d.retryAt ? <>, nouvel essai à {fmtTime(d.retryAt)}</> : null}. Actualise pour réessayer tout de suite.</>;
    case "update":
      return <>Le runner redémarre pour une mise à jour dès que les tâches en cours sont finies.</>;
    case "quota":
      return <>{issue ?? "Du travail en attente"} · reprend à la réinitialisation du quota.</>;
    case "yield":
      return <>Te laisse la place tant que « Je travaille » est actif.</>;
    case "paused":
      return issue ? <>En pause sur {issue}, reprendra où il en était.</> : <>En pause.</>;
    case "offline":
      return <>La machine ne répond pas (veille, réseau ou runner arrêté).</>;
    default:
      return (
        <>
          File vide. Ouvre l'agent pour lui écrire une tâche.
        </>
      );
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Jauge de progression : faites (couleur de l'agent), en cours (rayée), la file (en creux), puis les brouillons (pointillés). */
function Gauge({ progress, now }: { progress?: Progress; now: number }) {
  const p = progress ?? { done: 0, active: 0, queued: 0, drafts: 0, since: new Date(now - 24 * 3600_000).toISOString() };
  const g = gaugeParts(p);
  const since = fmtSince(p.since, now);
  const parts = [
    plural(p.done, "faite", "faites"),
    p.active > 0 ? `${p.active} en cours` : null,
    `${p.queued} en file`,
  ].filter(Boolean);
  // Les brouillons sont comptés dans le pied de carte ; on les garde pour les lecteurs d'écran.
  const spoken = p.drafts > 0 ? [...parts, plural(p.drafts, "brouillon", "brouillons")] : parts;
  return (
    <div
      className={`gauge${g.total === 0 ? " is-empty" : ""}`}
      title={`Tâches faites ${since}, en cours (y compris en pause ou en question), en attente dans la file, puis les brouillons encore à détailler`}
    >
      <div className="gauge-head">
        <span>{g.total === 0 ? "Aucune tâche ces dernières 24 h" : parts.join(" · ")}</span>
        {g.total > 0 && (
          <span className="mono">
            {p.done}/{g.total}
          </span>
        )}
      </div>
      <div className="gauge-bar" role="progressbar" aria-label="Tâches faites" aria-valuemin={0} aria-valuemax={g.total} aria-valuenow={p.done} aria-valuetext={`${spoken.join(", ")} (${since})`}>
        <i className="g-done" style={{ width: `${g.done}%` }} />
        <i className="g-active" style={{ width: `${g.active}%` }} />
        <i className="g-queued" style={{ width: `${g.queued}%` }} />
        <i className="g-drafts" style={{ width: `${g.drafts}%` }} />
      </div>
    </div>
  );
}

type Drag = {
  dragging: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
};

function AgentCard({ agent, status, index, counts, progress, now, drag }: { agent: Agent; status: AgentStatus; index: number; counts?: Partial<Record<TaskStatus, number>>; progress?: Progress; now: number; drag: Drag }) {
  const waiting = counts?.question ?? 0;
  const drafts = progress?.drafts ?? 0;
  return (
    <article
      className={`acard stagger ${status === "working" ? "is-working" : ""} ${drag.dragging ? "dragging" : ""}`}
      style={{ "--h": agent.hue, "--i": index } as React.CSSProperties}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", agent.id);
        drag.onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        drag.onDragOver();
      }}
      onDrop={(e) => e.preventDefault()}
      onDragEnd={drag.onDragEnd}
    >
      {/* Le lien ne se glisse pas lui-même : c'est la carte entière qu'on déplace. */}
      <Link className="acard-link" to={`/agents/${agent.id}`} aria-label={`Ouvrir ${agent.name}`} draggable={false} />
      <div className="acard-top">
        <Avatar seed={agent.seed} hue={agent.hue} size={58} status={status} />
        <div className="acard-id">
          <h3>{agent.name}</h3>
          <span className="mono">{agent.repo}</span>
        </div>
        <Form method="post">
          <input type="hidden" name="id" value={agent.id} />
          <button className="icon-btn" name="intent" value={agent.paused ? "resume" : "pause"} aria-label={`${agent.paused ? "Relancer" : "Mettre en pause"} ${agent.name}`}>
            <Icon name={agent.paused ? "play" : "pause"} />
          </button>
        </Form>
      </div>
      <Pill status={status} />
      <div className="acard-now">
        <NowLine agent={agent} status={status} />
      </div>
      <Gauge progress={progress} now={now} />
      <footer className="acard-foot">
        {(counts?.en_pause ?? 0) > 0 && <span>{counts?.en_pause} en pause</span>}
        {waiting > 0 && (
          <span className="warn" title="Questions de l'agent : réponds depuis sa page">
            <Icon name="help" /> {waiting}
          </span>
        )}
        {/* Les brouillons ici plutôt qu'en tête de jauge, pour garder cette ligne courte. L'ordre se règle en glissant la carte. */}
        {drafts > 0 && (
          <span className="drafts" title="Brouillons encore à détailler (pointillés au bout de la jauge)">
            {plural(drafts, "brouillon", "brouillons")}
          </span>
        )}
      </footer>
    </article>
  );
}

/**
 * Les cartes des agents dev, dans l'ordre de priorité : on glisse une carte à la souris ; l'ordre change tout de suite
 * à l'écran et part en un seul envoi au lâcher.
 */
function AgentGrid({ agents, online, counts, progress, now }: { agents: Agent[]; online: Record<string, boolean>; counts: Record<string, Partial<Record<TaskStatus, number>>>; progress: Record<string, Progress>; now: number }) {
  const fetcher = useFetcher();
  const key = agents.map((a) => a.id).join(",");
  const [order, setOrder] = useState(agents.map((a) => a.id));
  const [dragging, setDragging] = useState<string | null>(null);
  // L'ordre du serveur reprend la main dès qu'il change (envoi accepté, autre onglet, temps réel).
  useEffect(() => setOrder(key ? key.split(",") : []), [key]);
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

  const commit = (ids: string[]) => {
    setOrder(ids);
    if (ids.join(",") !== key) fetcher.submit({ intent: "reorder", ids: ids.join(",") }, { method: "post" });
  };

  return (
    <div className="grid">
      {order.map((id, i) => {
        const a = byId[id];
        if (!a) return null;
        return (
          <AgentCard
            key={id}
            agent={a}
            status={displayStatus(a, online)}
            index={i}
            counts={counts[id]}
            progress={progress[id]}
            now={now}
            drag={{
              dragging: dragging === id,
              onDragStart: () => setDragging(id),
              // La carte glissée prend la place de celle survolée (avant ou après selon le sens du déplacement).
              onDragOver: () => {
                if (!dragging || dragging === id) return;
                const next = order.filter((x) => x !== dragging);
                next.splice(next.indexOf(id) + (order.indexOf(dragging) < i ? 1 : 0), 0, dragging);
                setOrder(next);
              },
              onDragEnd: () => {
                setDragging(null);
                commit(order);
              },
            }}
          />
        );
      })}
      <Link className="acard add stagger" to="/agents/nouveau" style={{ "--i": order.length } as React.CSSProperties}>
        <span className="plus">
          <Icon name="plus" />
        </span>
        <b>Nouvel agent</b>
        <span className="muted small">Un repo, une file de tâches</span>
      </Link>
    </div>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { agents, online, questions, night, counts, services, progress, now } = loaderData;
  const dev = agents.filter((a) => a.kind === "dev");

  return (
    <div className="enter">
      <div className="view-head">
        <div>
          <h1>L'équipe</h1>
          <p>Ce que les agents ont fait ces 12 dernières heures, et ce qui t'attend.</p>
        </div>
      </div>
      <div className="night">
        <span>
          <Icon name="check" />
          <b>{night.done}</b> ticket(s) terminé(s)
        </span>
        <span>
          <Icon name="pr" />
          <b>{night.prs}</b> PR
        </span>
        {questions.length > 0 && (
          <Link to={`/agents/${questions[0].agentId}?c=${questions[0].id}`} className="night-q">
            <Icon name="help" />
            <b>{questions.length}</b> question(s) pour toi
          </Link>
        )}
      </div>

      <section className="section" aria-labelledby="h-dev">
        <div className="section-head">
          <Icon name="laptop" />
          <h2 id="h-dev">Agents dev</h2>
        </div>
        <AgentGrid agents={dev} online={online} counts={counts} progress={progress} now={now} />
      </section>

      {services.length > 0 && (
        <section className="section" aria-labelledby="h-svc">
          <div className="section-head">
            <Icon name="server" />
            <h2 id="h-svc">Services</h2>
            <Link className="btn small ghost svc-group-actions" to="/services">
              Tout voir
            </Link>
          </div>
          <div className="grid">
            {services.map((s, i) => (
              <ServiceCard key={s.id} service={s} now={now} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
