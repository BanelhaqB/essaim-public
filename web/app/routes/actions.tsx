/**
 * Actions en un clic d'un agent : la liste, avec de quoi les lancer, les modifier, les ranger et en créer. L'agent
 * tient aussi cette liste (ACTIONS.json) quand on lui demande d'ajouter une action.
 */
import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { Icon } from "~/components/ui";
import { launchAction } from "~/.server/actions";
import { deleteAction, getAgent, listActions, moveAction, saveAction } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { ACTION_STATUS, DEFAULT_TIMEOUT, MAX_ACTIONS, MAX_TIMEOUT, normalizeAction } from "~/lib/actions";
import { fmtWhen } from "~/lib/status";
import type { AgentAction } from "~/lib/types";

import type { Route } from "./+types/actions";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `Actions de ${loaderData?.agent.name ?? "l'agent"} · Essaim` }];

export async function loader({ params }: Route.LoaderArgs) {
  const { DB } = serverEnv();
  const agent = await getAgent(DB, params.id);
  if (!agent) throw data("Cet agent n'existe pas.", { status: 404 });
  return { agent, actions: await listActions(DB, agent.id), now: Date.now() };
}

export async function action({ request, params }: Route.ActionArgs) {
  const env = serverEnv();
  const form = await request.formData();
  const intent = form.get("intent");
  const id = String(form.get("id") ?? "");
  if (!(await getAgent(env.DB, params.id))) throw data("Cet agent n'existe pas.", { status: 404 });
  switch (intent) {
    case "save": {
      const kind = form.get("kind") === "prompt" ? "prompt" : "command";
      const input = normalizeAction({
        name: form.get("name"),
        description: form.get("description"),
        [kind]: form.get("body"),
        confirm: form.get("confirm"),
        timeoutMinutes: form.get("timeoutMinutes"),
      });
      if (!input) return data({ error: "Donne un nom et une commande (ou une consigne).", id }, { status: 400 });
      if (!id && (await listActions(env.DB, params.id)).length >= MAX_ACTIONS) return data({ error: `${MAX_ACTIONS} actions au plus.`, id }, { status: 400 });
      await saveAction(env.DB, params.id, input, id || undefined);
      return { saved: Date.now() };
    }
    case "delete":
      await deleteAction(env.DB, params.id, id);
      return null;
    case "up":
    case "down":
      await moveAction(env.DB, params.id, id, intent === "up" ? -1 : 1);
      return null;
    case "run": {
      const res = await launchAction(env, params.id, id);
      if ("error" in res) return data({ error: res.error, id }, { status: 400 });
      return redirect(`/agents/${params.id}?c=${res.conversationId}`);
    }
  }
  return null;
}

/** Formulaire d'une action : création (sans action) ou modification. */
function ActionForm({ action, onDone }: { action?: AgentAction; onDone?: () => void }) {
  const [kind, setKind] = useState<"command" | "prompt">(action && !action.command ? "prompt" : "command");
  const nav = useNavigation();
  const p = action ? `a-${action.id.slice(0, 8)}` : "a-new";
  return (
    <Form method="post" className="settings action-form" onSubmit={() => onDone?.()}>
      {action && <input type="hidden" name="id" value={action.id} />}
      <div className="field">
        <label htmlFor={`${p}-name`}>Nom du bouton</label>
        <input type="text" id={`${p}-name`} name="name" required maxLength={80} defaultValue={action?.name} placeholder="Installer sur mon iPhone" />
      </div>
      <div className="field">
        <label htmlFor={`${p}-desc`}>Description (facultative)</label>
        <input type="text" id={`${p}-desc`} name="description" maxLength={300} defaultValue={action?.description} placeholder="Build Release puis installation sur l'iPhone branché ou sur le même Wi-Fi" />
      </div>
      <div className="field">
        <span className="lbl">Ce que fait le bouton</span>
        <div className="seg" role="radiogroup" aria-label="Type d'action">
          <button type="button" role="radio" aria-checked={kind === "command"} onClick={() => setKind("command")}>
            Commande
          </button>
          <button type="button" role="radio" aria-checked={kind === "prompt"} onClick={() => setKind("prompt")}>
            Consigne à l'agent
          </button>
        </div>
        <input type="hidden" name="kind" value={kind} />
      </div>
      <div className="field">
        <label htmlFor={`${p}-body`}>{kind === "command" ? "Commande" : "Consigne"}</label>
        <textarea
          id={`${p}-body`}
          name="body"
          required
          rows={kind === "command" ? 4 : 5}
          className={kind === "command" ? "mono" : ""}
          defaultValue={(kind === "command" ? action?.command : action?.prompt) ?? ""}
          placeholder={kind === "command" ? "npm ci && cd android && ./gradlew assembleRelease" : "Publie la dernière version sur l'App Store et le Play Store, puis donne-moi les liens."}
        />
        <span className="help">
          {kind === "command"
            ? "Lancée par le runner dans une copie du repo à jour sur la branche par défaut (shell de la machine). La sortie s'affiche en direct."
            : "Envoyée à l'agent dans une nouvelle discussion : pour ce qui demande du jugement."}
        </span>
      </div>
      {kind === "command" && (
        <div className="field">
          <label htmlFor={`${p}-timeout`}>Durée max (minutes)</label>
          <input id={`${p}-timeout`} type="number" name="timeoutMinutes" min="1" max={MAX_TIMEOUT} defaultValue={action?.timeoutMinutes ?? ""} placeholder={String(DEFAULT_TIMEOUT)} />
        </div>
      )}
      <label className="tg" htmlFor={`${p}-confirm`}>
        <span className="tg-text">
          <b>Demander confirmation</b>
          <span>Pour une action qui publie ou coûte</span>
        </span>
        <span className="switch">
          <input type="checkbox" id={`${p}-confirm`} name="confirm" defaultChecked={action?.confirm} />
          <i />
        </span>
      </label>
      <div className="row">
        <button className="btn primary" name="intent" value="save" disabled={nav.state === "submitting"}>
          {action ? "Enregistrer" : "Ajouter l'action"}
        </button>
        {onDone && (
          <button type="button" className="btn ghost" onClick={onDone}>
            Annuler
          </button>
        )}
      </div>
    </Form>
  );
}

function ActionCard({ action, first, last, now }: { action: AgentAction; first: boolean; last: boolean; now: number }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const st = action.last ? ACTION_STATUS[action.last.status] : null;
  if (editing) {
    return (
      <li className="panel">
        <h2>Modifier « {action.name} »</h2>
        <ActionForm action={action} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="panel action-card">
      <div className="action-card-head">
        <h3 className="action-card-name">{action.name}</h3>
        {action.confirm && (
          <span className="pill-lite" style={{ "--c": "var(--quota)" } as React.CSSProperties}>
            Confirmation
          </span>
        )}
        <Form method="post" className="action-card-tools">
          <input type="hidden" name="id" value={action.id} />
          <button className="btn small ghost" name="intent" value="up" disabled={first} aria-label="Monter">
            <Icon name="up" />
          </button>
          <button className="btn small ghost" name="intent" value="down" disabled={last} aria-label="Descendre">
            <Icon name="down" />
          </button>
        </Form>
      </div>
      {action.description && <p className="muted small">{action.description}</p>}
      {action.command ? <pre className="action-cmd">{action.command}</pre> : <p className="action-prompt">{action.prompt}</p>}
      <p className="muted small">
        {action.command ? `Commande · ${action.timeoutMinutes ?? DEFAULT_TIMEOUT} min max` : "Consigne à l'agent"}
        {action.last && st && (
          <>
            {" · dernier lancement "}
            <Link to={`/agents/${action.agentId}?c=${action.last.conversationId}`} style={{ color: st.color }}>
              {st.label.toLowerCase()} {fmtWhen(action.last.at, now)}
            </Link>
          </>
        )}
      </p>
      <Form method="post" className="row">
        <input type="hidden" name="id" value={action.id} />
        <button
          className="btn primary small"
          name="intent"
          value="run"
          onClick={(e) => {
            if (action.confirm && !confirm(`Lancer « ${action.name} » ?`)) e.preventDefault();
          }}
        >
          <Icon name="play" /> Lancer
        </button>
        <button type="button" className="btn small" onClick={() => setEditing(true)}>
          <Icon name="edit" /> Modifier
        </button>
        {confirmDelete ? (
          <>
            <button className="btn small danger" name="intent" value="delete">
              Supprimer
            </button>
            <button type="button" className="btn small ghost" onClick={() => setConfirmDelete(false)}>
              Annuler
            </button>
          </>
        ) : (
          <button type="button" className="btn small ghost" onClick={() => setConfirmDelete(true)}>
            <Icon name="x" /> Supprimer…
          </button>
        )}
      </Form>
    </li>
  );
}

export default function ActionsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { agent, actions, now } = loaderData;
  const error = actionData && "error" in actionData ? actionData.error : null;
  const savedAt = actionData && "saved" in actionData ? actionData.saved : 0;
  return (
    <div className="enter agent-actions" style={{ "--h": agent.hue } as React.CSSProperties}>
      <Link className="back" to={`/agents/${agent.id}`}>
        <Icon name="left" />
        Conversations de {agent.name}
      </Link>
      <h1>Actions en un clic</h1>
      <p className="muted">
        Des boutons à portée de main sur la page de {agent.name} : installer l'app sur ton iPhone, générer l'APK, publier la dernière version… Le plus simple est de
        lui demander dans une discussion (« ajoute une action qui installe l'app sur mon iPhone ») : il met la commande au point, la teste et l'ajoute ici.
      </p>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {actions.length > 0 && (
        <ul className="action-cards">
          {actions.map((a, i) => (
            <ActionCard key={`${a.id}-${savedAt}`} action={a} first={i === 0} last={i === actions.length - 1} now={now} />
          ))}
        </ul>
      )}
      <section className="panel">
        <h2>Nouvelle action</h2>
        <ActionForm key={savedAt} />
      </section>
    </div>
  );
}
