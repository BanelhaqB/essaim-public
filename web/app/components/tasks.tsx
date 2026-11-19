/**
 * Les tâches d'un agent : libellés des statuts et file ordonnable (glisser-déposer ou flèches). La file poste sur la
 * route de l'agent (intent task-reorder).
 */
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import { Icon } from "~/components/ui";
import type { Task, TaskStatus } from "~/lib/types";

export const TASK_LABEL: Record<TaskStatus, { label: string; color: string; icon: string }> = {
  brouillon: { label: "Brouillon", color: "var(--fg-3)", icon: "edit" },
  prete: { label: "En file", color: "var(--wait)", icon: "list" },
  en_cours: { label: "En cours", color: "var(--ok)", icon: "play" },
  en_pause: { label: "En pause", color: "var(--wait)", icon: "pause" },
  question: { label: "Attend ta réponse", color: "var(--quota)", icon: "help" },
  terminee: { label: "Terminée", color: "var(--accent)", icon: "check" },
  abandonnee: { label: "Abandonnée", color: "var(--fg-3)", icon: "x" },
};

/** La file des tâches prêtes : glisser-déposer à la souris, flèches au clavier et au doigt. */
export function Queue({ agentId, tasks, to, current }: { agentId: string; tasks: Task[]; to: (id: string) => string; current?: string | null }) {
  const fetcher = useFetcher();
  const [order, setOrder] = useState(tasks.map((t) => t.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const key = tasks.map((t) => t.id).join(",");
  useEffect(() => setOrder(key ? key.split(",") : []), [key]);
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

  const commit = (ids: string[]) => {
    setOrder(ids);
    fetcher.submit({ intent: "task-reorder", ids: ids.join(",") }, { method: "post", action: `/agents/${agentId}` });
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  };

  if (!order.length) return <p className="muted small">File vide.</p>;
  return (
    <ol className="queue" aria-label="File d'attente, dans l'ordre de traitement">
      {order.map((id, i) => {
        const t = byId[id];
        if (!t) return null;
        return (
          <li
            key={id}
            className={`task-row ${dragging === id ? "dragging" : ""} ${current === id ? "current" : ""}`}
            draggable
            onDragStart={(e) => {
              setDragging(id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDragging(null);
              commit(order);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragging || dragging === id) return;
              const next = order.filter((x) => x !== dragging);
              next.splice(next.indexOf(id) + (order.indexOf(dragging) < order.indexOf(id) ? 1 : 0), 0, dragging);
              setOrder(next);
            }}
          >
            <span className="grip" aria-hidden="true">
              <Icon name="grip" />
            </span>
            <span className="task-pos num">{i + 1}</span>
            <Link className="task-title" to={to(id)} aria-current={current === id ? "page" : undefined}>
              {t.title}
            </Link>
            {t.parentId && <span className="task-parent">étape</span>}
            <span className="task-move">
              <button type="button" onClick={() => move(id, -1)} disabled={i === 0} aria-label={`Monter « ${t.title} »`}>
                <Icon name="up" />
              </button>
              <button type="button" onClick={() => move(id, 1)} disabled={i === order.length - 1} aria-label={`Descendre « ${t.title} »`}>
                <Icon name="down" />
              </button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
