import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { AgentFields } from "~/components/agent-fields";
import { Avatar, Icon, Pill } from "~/components/ui";
import { matesByRepo, parseAgentForm } from "~/.server/agent-form";
import { deleteAgent, getAgent, listMachines, setHue, setMachine, updateSettings } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { listRepos, setAgentRepos } from "~/.server/repos";
import { chatId, resolveTopic, saveTopic, topicLink, welcomeAgent } from "~/.server/telegram";
import { parseHue } from "~/lib/avatar";
import { machineLabel } from "~/lib/machine";
import { displayStatus } from "~/lib/status";

import type { Route } from "./+types/agent-settings";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `Réglages de ${loaderData?.agent.name ?? "l'agent"} · Essaim` }];

export async function loader({ params }: Route.LoaderArgs) {
  const env = serverEnv();
  const agent = await getAgent(env.DB, params.id);
  if (!agent) throw data("Cet agent n'existe pas.", { status: 404 });
  const [machines, chat, repos, mates] = await Promise.all([listMachines(env.DB), chatId(env), listRepos(env.DB), matesByRepo(env.DB, agent.id)]);
  const online = Object.fromEntries(machines.map((m) => [m.name, m.online]));
  return { agent, repos, mates, status: displayStatus(agent, online), topic: topicLink(chat, agent.telegramTopic) };
}

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
  if (!topic.ok) return data({ errors: { topic: topic.error } }, { status: 400 });
  const parsed = await parseAgentForm(env.DB, form, agent.settings, agent.id);
  if (!parsed.links.length) return data({ errors: { repo: "Garde au moins un repo : c'est là que l'agent travaille." } }, { status: 400 });
  await updateSettings(env.DB, params.id, parsed.settings);
  await setMachine(env.DB, params.id, parsed.machine);
  await setAgentRepos(env.DB, params.id, parsed.links);
  if (topic.thread !== agent.telegramTopic) {
    await saveTopic(env, params.id, topic);
    // Un nouveau sujet s'ouvre par le message d'accueil : on voit tout de suite s'il est le bon.
    if (topic.thread) await welcomeAgent(env, { ...agent, telegramTopic: topic.thread }).catch((error) => console.error("Sujet Telegram :", error));
  }
  return { saved: Date.now(), part: "settings" as const };
}

export default function AgentSettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { agent, repos, mates, status, topic } = loaderData;
  const nav = useNavigation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const savedPart = actionData && "saved" in actionData && nav.state === "idle" ? actionData.part : null;
  const saved = savedPart === "settings";
  // Teinte en cours de choix : l'avatar et la page la suivent avant l'enregistrement.
  const [hue, setHue] = useState(agent.hue);
  const [baseHue, setBaseHue] = useState(agent.hue);
  if (baseHue !== agent.hue) {
    setBaseHue(agent.hue);
    setHue(agent.hue);
  }
  const errors = (actionData && "errors" in actionData ? actionData.errors : {}) as Record<string, string>;

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
            {agent.repos.map((r) => (
              <span key={r.repoId}>
                <Icon name="git" />
                <Link className="mono" to={`/repos/${r.repoId}`}>
                  {r.repo}
                </Link>
              </span>
            ))}
            <span>
              <Icon name={agent.machine === "nuc" ? "server" : "laptop"} />
              {machineLabel(agent.machine)}
            </span>
          </div>
        </div>
      </div>

      <section className="panel">
        <h2>Réglages</h2>
        <Form method="post" className="settings">
          <AgentFields agent={agent} repos={repos} mates={mates} errors={errors} topic={topic} />
          {errors.repo && <span className="err">{errors.repo}</span>}
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

      <section className="panel danger-zone">
        <h2>Supprimer l'agent</h2>
        <p className="muted small">Les repos, les issues et les branches ne sont pas touchés. Un ticket en cours sera interrompu.</p>
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
