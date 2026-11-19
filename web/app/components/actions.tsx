/**
 * Actions en un clic d'un agent, dans l'historique de sa page : un bouton par action. Le clic poste sur la route de
 * l'agent (intent action-run) puis ouvre la conversation du lancement, où la sortie arrive en direct.
 */
import { useEffect, useRef } from "react";
import { Link, useFetcher, useNavigate } from "react-router";

import { Icon } from "~/components/ui";
import { ACTION_STATUS, actionOpen } from "~/lib/actions";
import { fmtWhen } from "~/lib/status";
import type { AgentAction } from "~/lib/types";

export function ActionList({ agentId, actions, online, now }: { agentId: string; actions: AgentAction[]; online: boolean; now: number }) {
  const fetcher = useFetcher<{ conversationId?: string; error?: string }>();
  const navigate = useNavigate();
  const followed = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || followed.current === fetcher.data) return;
    followed.current = fetcher.data;
    if (fetcher.data.conversationId) navigate(`/agents/${agentId}?c=${fetcher.data.conversationId}`);
  }, [fetcher.state, fetcher.data, agentId, navigate]);

  const launch = (a: AgentAction) => {
    if (a.confirm && !confirm(`Lancer « ${a.name} » ?${a.description ? `\n\n${a.description}` : ""}`)) return;
    fetcher.submit({ intent: "action-run", actionId: a.id }, { method: "post", action: `/agents/${agentId}` });
  };
  const pending = fetcher.state !== "idle" ? String(fetcher.formData?.get("actionId") ?? "") : "";

  if (!actions.length) {
    return (
      <p className="muted small actions-empty">
        Demande à l'agent d'ajouter une action (« ajoute une action qui installe l'app sur mon iPhone »), ou <Link to={`/agents/${agentId}/actions`}>crée-la toi-même</Link>.
      </p>
    );
  }
  return (
    <>
      <ul className="actions">
        {actions.map((a) => {
          const last = a.last ? ACTION_STATUS[a.last.status] : null;
          const running = actionOpen(a.last?.status);
          const kind = a.command ? "Commande lancée sur la machine" : "Consigne envoyée à l'agent";
          const offline = a.command && !online ? " · la machine ne répond pas : l'action partira à son retour" : "";
          return (
            <li key={a.id}>
              <button
                type="button"
                className={`action ${running ? "running" : ""}`}
                onClick={() => (running && a.last ? navigate(`/agents/${agentId}?c=${a.last.conversationId}`) : launch(a))}
                disabled={pending === a.id}
                title={`${a.description || kind}${offline}`}
              >
                <span className="action-icon" aria-hidden="true">
                  <Icon name={running ? "zap" : a.command ? "play" : "send"} />
                </span>
                <span className="action-name">{a.name}</span>
                {a.confirm && <span className="sr-only">, demande confirmation</span>}
              </button>
              {a.last && last && a.last.status !== "discussion" && (
                <Link
                  className="action-last"
                  to={`/agents/${agentId}?c=${a.last.conversationId}`}
                  style={{ "--c": last.color } as React.CSSProperties}
                  title={`${last.label} · ${fmtWhen(a.last.at, now)}`}
                >
                  <Icon name={last.icon} />
                  <span className="sr-only">
                    Dernier lancement : {last.label}, {fmtWhen(a.last.at, now)}
                  </span>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <Link className="actions-manage" to={`/agents/${agentId}/actions`}>
        <Icon name="sliders" /> Gérer les actions
      </Link>
      {fetcher.data?.error && (
        <p className="err small" role="alert">
          {fetcher.data.error}
        </p>
      )}
    </>
  );
}
