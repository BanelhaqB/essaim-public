import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { Avatar, Icon, Pill } from "~/components/ui";
import { deleteAgent, getAgent, listMachines, setHue, updateSettings } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { chatId, resolveTopic, saveTopic, topicLink, welcomeAgent } from "~/.server/telegram";
import { parseHue } from "~/lib/avatar";
import { machineLabel } from "~/lib/machine";
import { displayStatus } from "~/lib/status";
import type { AgentSettings } from "~/lib/types";

import type { Route } from "./+types/agent-settings";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `Réglages de ${loaderData?.agent.name ?? "l'agent"} · Essaim` }];

export async function loader({ params }: Route.LoaderArgs) {
  const env = serverEnv();
  const agent = await getAgent(env.DB, params.id);
  if (!agent) throw data("Cet agent n'existe pas.", { status: 404 });
  const [machines, chat] = await Promise.all([listMachines(env.DB), chatId(env)]);
  const online = Object.fromEntries(machines.map((m) => [m.name, m.online]));
  return { agent, status: displayStatus(agent, online), topic: topicLink(chat, agent.telegramTopic) };
}

const num = (v: FormDataEntryValue | null) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

export async function action({ request, params }: Route.ActionArgs) {
  const env = serverEnv();
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "delete") {
    await deleteAgent(env.DB, params.id);
    return redirect("/");
  }
  const agent = await getAgent(env.DB, params.id);
  if (!agent) throw data("Cet agent n'existe pas.", { status: 404 });
  if (intent === "color") {
    await setHue(env.DB, params.id, parseHue(form.get("hue"), agent.hue));
    return { saved: Date.now(), part: "color" as const };
  }
  const topic = await resolveTopic(env, String(form.get("topic") ?? ""));
  if (!topic.ok) return data({ topicError: topic.error }, { status: 400 });
  const settings: AgentSettings = {
    ...agent.settings,
    merge: form.get("merge") === "on",
    deploy: form.get("deploy") === "on",
    store: form.get("store") === "on",
    yieldOnFocus: form.get("yieldOnFocus") === "on",
    maxMinutes: num(form.get("maxMinutes")),
    stallMinutes: num(form.get("stallMinutes")),
  };
  await updateSettings(env.DB, params.id, settings);
  if (topic.thread !== agent.telegramTopic) {
    await saveTopic(env, params.id, topic);
    // Un nouveau sujet s'ouvre par le message d'accueil : on voit tout de suite s'il est le bon.
    if (topic.thread) await welcomeAgent(env, { ...agent, telegramTopic: topic.thread }).catch((error) => console.error("Sujet Telegram :", error));
  }
  return { saved: Date.now(), part: "settings" as const };
}

function Toggle({ name, label, help, checked }: { name: string; label: string; help: string; checked?: boolean }) {
  return (
    <label className="tg" htmlFor={`s-${name}`}>
      <span className="tg-text">
        <b>{label}</b>
        <span>{help}</span>
      </span>
      <span className="switch">
        <input type="checkbox" id={`s-${name}`} name={name} defaultChecked={checked} />
        <i />
      </span>
    </label>
  );
}

export default function AgentSettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { agent, status, topic } = loaderData;
  const nav = useNavigation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const s = agent.settings;
  const savedPart = actionData && "saved" in actionData && nav.state === "idle" ? actionData.part : null;
  const saved = savedPart === "settings";
  // Teinte en cours de choix : l'avatar et la page la suivent avant l'enregistrement.
  const [hue, setHue] = useState(agent.hue);
  const [baseHue, setBaseHue] = useState(agent.hue);
  if (baseHue !== agent.hue) {
    setBaseHue(agent.hue);
    setHue(agent.hue);
  }
  const topicError = actionData && "topicError" in actionData ? actionData.topicError : null;

  return (
    <div className="enter agent-settings" style={{ "--h": hue } as React.CSSProperties}>
      <Link className="back" to={`/agents/${agent.id}`}>
        <Icon name="left" />
        Conversations de {agent.name}
      </Link>
      <div className="hero">
        <Avatar seed={agent.seed} hue={hue} size={72} status={status} />
        <div className="hero-id">
          <h1>{agent.name}</h1>
          <div className="hero-meta">
            <Pill status={status} />
            <span>
              <Icon name="git" />
              <a className="mono" href={`https://github.com/${agent.repo}`} target="_blank" rel="noreferrer">
                {agent.repo}
              </a>
            </span>
            <span>
              <Icon name={agent.machine === "nuc" ? "server" : "laptop"} />
              {machineLabel(agent.machine)}
            </span>
          </div>
        </div>
      </div>

      <section className="panel">
        <h2>Couleur</h2>
        <Form method="post" className="settings">
          <div className="field">
            <label htmlFor="s-hue">Teinte de l'avatar et de ses pages</label>
            <div className="hue-track" aria-hidden="true" />
            <input type="range" id="s-hue" name="hue" min="0" max="359" value={hue} onChange={(e) => setHue(Number(e.target.value))} />
          </div>
          <div className="row">
            <button className="btn primary" name="intent" value="color" disabled={nav.state === "submitting" || hue === agent.hue}>
              Enregistrer la couleur
            </button>
            {hue !== agent.hue && (
              <button type="button" className="btn ghost" onClick={() => setHue(agent.hue)}>
                Annuler
              </button>
            )}
            {savedPart === "color" && hue === agent.hue && (
              <span className="saved" role="status">
                <Icon name="check" /> Enregistrée
              </span>
            )}
          </div>
        </Form>
      </section>

      <section className="panel">
        <h2>Autonomie</h2>
        <Form method="post" className="settings">
          <div className="toggles">
            <Toggle name="merge" label="Merger seul" help="Quand la CI est verte" checked={s.merge} />
            <Toggle name="deploy" label="Déployer sur Cloudflare" help="Quand le ticket le demande" checked={s.deploy} />
            <Toggle name="store" label="Publier sur les stores" help="App Store et Play Console" checked={s.store} />
            <Toggle name="yieldOnFocus" label="Te laisser la place" help="Pause quand « Je travaille » est actif" checked={s.yieldOnFocus} />
          </div>
          <div className="field">
            <label htmlFor="s-max">Temps max par ticket (minutes)</label>
            <input type="number" min="0" step="30" id="s-max" name="maxMinutes" defaultValue={s.maxMinutes || ""} placeholder="Aucune limite" />
            <span className="help">Vide : aucune limite. Au-delà, l'agent pousse son travail et te pose la question.</span>
          </div>
          <div className="field">
            <label htmlFor="s-stall">Alerte si aucun jalon depuis (minutes)</label>
            <input type="number" min="0" step="30" id="s-stall" name="stallMinutes" defaultValue={s.stallMinutes ?? 180} />
            <span className="help">Une notification Telegram, l'agent continue. 0 : jamais.</span>
          </div>
          <div className="field">
            <label htmlFor="s-topic">Sujet Telegram</label>
            <input
              type="text"
              inputMode="url"
              id="s-topic"
              name="topic"
              autoComplete="off"
              key={topic}
              defaultValue={topic}
              placeholder="https://t.me/c/1234567890/42"
              aria-invalid={Boolean(topicError)}
              aria-describedby={topicError ? "s-topic-err" : "s-topic-help"}
            />
            {topicError ? (
              <span className="err" id="s-topic-err">
                {topicError}
              </span>
            ) : (
              <span className="help" id="s-topic-help">
                Le lien du sujet de l'agent dans le groupe (appui long sur le sujet → Copier le lien). Un message d'accueil y part à chaque changement.
              </span>
            )}
          </div>
          <div className="row">
            <button className="btn primary" name="intent" value="settings" disabled={nav.state === "submitting"}>
              Enregistrer
            </button>
            {saved && (
              <span className="saved" role="status">
                <Icon name="check" /> Enregistré
              </span>
            )}
          </div>
        </Form>
      </section>

      <section className="panel danger-zone">
        <h2>Supprimer l'agent</h2>
        <p className="muted small">Le repo, les issues et les branches ne sont pas touchés. Un ticket en cours sera interrompu.</p>
        {confirmDelete ? (
          <Form method="post" className="row">
            <button className="btn danger" name="intent" value="delete">
              Supprimer {agent.name}
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>
              Annuler
            </button>
          </Form>
        ) : (
          <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>
            <Icon name="x" /> Supprimer…
          </button>
        )}
      </section>
    </div>
  );
}
