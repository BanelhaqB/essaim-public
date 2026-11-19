import { useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";

import { Avatar, Icon } from "~/components/ui";
import { createAgent, createTask, getAgent, listAgents } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { resolveTopic, saveTopic, welcomeAgent } from "~/.server/telegram";
import { parseHue } from "~/lib/avatar";
import { initTask, MIN_DESCRIPTION, parseRepo, repoName, usualOwner } from "~/lib/new-project";
import { DEFAULT_SETTINGS, type AgentSettings } from "~/lib/types";

import type { Route } from "./+types/agent-new";

export const meta: Route.MetaFunction = () => [{ title: "Nouvel agent · Essaim" }];

export async function loader() {
  const agents = await listAgents(serverEnv().DB);
  return { owner: usualOwner(agents.map((a) => a.repo)) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim().slice(0, 40);
  const repo = parseRepo(form.get("repo"));
  // Nouveau projet : pas encore de repo, l'agent le crée et part de la description.
  const fresh = form.get("fresh") === "on";
  const description = String(form.get("description") ?? "").trim().slice(0, 4000);
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Donne-lui un nom.";
  if (!repo) errors.repo = fresh ? "Au format propriétaire/nom, par exemple ton-compte/mon-projet." : "Au format propriétaire/nom, par exemple ton-compte/mon-app.";
  if (fresh && description.length < MIN_DESCRIPTION) errors.description = "Décris le projet en quelques phrases : c'est le point de départ de l'agent.";
  const env = serverEnv();
  const topic = await resolveTopic(env, String(form.get("topic") ?? ""));
  if (!topic.ok) errors.topic = topic.error;
  if (Object.keys(errors).length || !topic.ok || !repo) return data({ errors }, { status: 400 });
  const machine = form.get("machine") === "nuc" ? "nuc" : "mac";
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, store: form.get("store") === "on", deploy: form.get("deploy") === "on", merge: form.get("merge") === "on" };
  if (fresh) settings.createRepo = form.get("public") === "on" ? "public" : "private";
  const id = await createAgent(env.DB, {
    name,
    repo,
    machine,
    kind: form.get("kind") === "svc" ? "svc" : "dev",
    hue: parseHue(form.get("hue")),
    seed: String(form.get("seed") || name),
    settings,
    brief: fresh ? description : undefined,
  });
  // Première tâche d'un nouveau projet : le runner crée le repo avant d'ouvrir son issue.
  if (fresh) await createTask(env.DB, { agentId: id, ...initTask(repo, description), status: "prete" });
  // Le sujet Telegram de l'agent : celui du lien donné, sinon le bot tente de le créer.
  // Une erreur de Telegram ne bloque pas la création.
  if (topic.thread) await saveTopic(env, id, topic);
  const agent = await getAgent(env.DB, id);
  if (agent) await welcomeAgent(env, agent).catch((error) => console.error("Sujet Telegram :", error));
  return redirect(`/agents/${id}`);
}

export default function NewAgent({ actionData, loaderData }: Route.ComponentProps) {
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(false);
  // Repo tapé à la main ; null : on propose propriétaire habituel/nom de l'agent (nouveau projet).
  const [repo, setRepo] = useState<string | null>(null);
  const [hue, setHue] = useState(200);
  const [salt, setSalt] = useState(0);
  const [spin, setSpin] = useState(0);
  const nav = useNavigation();
  const errors = (actionData as { errors?: Record<string, string> } | undefined)?.errors ?? {};
  const seed = `${name || "nouvel agent"}#${salt}`;
  const busy = nav.state === "submitting";
  const suggested = fresh && loaderData.owner ? `${loaderData.owner}/${repoName(name)}` : "";

  return (
    <div className="enter">
      <div className="view-head">
        <div>
          <h1>Nouvel agent</h1>
          <p>Un agent = un repo, existant ou à créer pour un nouveau projet. Il prend ses tâches une à une et te prévient sur Telegram.</p>
        </div>
      </div>
      <div className="wiz">
        <Form method="post" className="wiz-panel" noValidate>
          <input type="hidden" name="seed" value={seed} />
          <div className="field">
            <label htmlFor="name">Nom</label>
            <input type="text" id="name" name="name" autoComplete="off" placeholder="Ex. : Salon suivi" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "name-err" : undefined} />
            {errors.name && (
              <span className="err" id="name-err">
                {errors.name}
              </span>
            )}
          </div>
          <label className="tg" htmlFor="fresh">
            <span className="tg-text">
              <b>Nouveau projet</b>
              <span>Pas encore de repo : l'agent le crée et pose les fondations à partir de ta description.</span>
            </span>
            <span className="switch">
              <input type="checkbox" id="fresh" name="fresh" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
              <i />
            </span>
          </label>
          <div className="field">
            <label htmlFor="repo">{fresh ? "Repo à créer" : "Repo GitHub"}</label>
            <input
              type="text"
              id="repo"
              name="repo"
              autoComplete="off"
              placeholder={fresh ? "ton-compte/mon-projet" : "ton-compte/mon-app"}
              value={repo ?? suggested}
              onChange={(e) => setRepo(e.target.value)}
              aria-invalid={Boolean(errors.repo)}
              aria-describedby={errors.repo ? "repo-err" : "repo-help"}
            />
            {errors.repo ? (
              <span className="err" id="repo-err">
                {errors.repo}
              </span>
            ) : (
              <span className="help" id="repo-help">
                {fresh ? "Créé par l'agent avec le compte GitHub de la machine, s'il n'existe pas déjà." : "Le compte GitHub connecté sur la machine doit pouvoir y pousser."}
              </span>
            )}
          </div>
          {fresh && (
            <>
              <div className="field">
                <label htmlFor="description">Description du projet</label>
                <textarea
                  id="description"
                  name="description"
                  rows={5}
                  maxLength={4000}
                  placeholder="Ce que tu veux construire, pour qui, les fonctions clés, et la stack si tu as une préférence."
                  aria-invalid={Boolean(errors.description)}
                  aria-describedby={errors.description ? "description-err" : "description-help"}
                />
                {errors.description ? (
                  <span className="err" id="description-err">
                    {errors.description}
                  </span>
                ) : (
                  <span className="help" id="description-help">
                    Elle devient le brief de l'agent et sa première tâche : « Initialiser le projet ».
                  </span>
                )}
              </div>
              <label className="tg" htmlFor="public">
                <span className="tg-text">
                  <b>Repo public</b>
                  <span>Privé sinon</span>
                </span>
                <span className="switch">
                  <input type="checkbox" id="public" name="public" />
                  <i />
                </span>
              </label>
            </>
          )}
          <div className="field">
            <label htmlFor="topic">Sujet Telegram</label>
            <input type="text" inputMode="url" id="topic" name="topic" autoComplete="off" placeholder="https://t.me/c/1234567890/42" aria-invalid={Boolean(errors.topic)} aria-describedby={errors.topic ? "topic-err" : "topic-help"} />
            {errors.topic ? (
              <span className="err" id="topic-err">
                {errors.topic}
              </span>
            ) : (
              <span className="help" id="topic-help">
                Crée le sujet dans le groupe, puis appui long dessus → Copier le lien. Vide : le bot tente de le créer lui-même.
              </span>
            )}
          </div>
          <fieldset className="field">
            <legend className="lbl">Machine</legend>
            <div className="choice">
              <label>
                <input type="radio" name="machine" value="mac" defaultChecked />
                <Icon name="laptop" />
                <span>
                  <b>Mac</b>
                  <span>Simulateurs, Xcode, tests lourds</span>
                </span>
              </label>
              <label>
                <input type="radio" name="machine" value="nuc" />
                <Icon name="server" />
                <span>
                  <b>Serveur</b>
                  <span>Tâches légères, toujours allumé</span>
                </span>
              </label>
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="hue">Couleur</label>
            <div className="hue-track" aria-hidden="true" />
            <input type="range" id="hue" name="hue" min="0" max="359" value={hue} onChange={(e) => setHue(Number(e.target.value))} />
          </div>
          <div className="toggles">
            <label className="tg" htmlFor="merge">
              <span className="tg-text">
                <b>Merger seul</b>
                <span>Quand la CI est verte</span>
              </span>
              <span className="switch">
                <input type="checkbox" id="merge" name="merge" defaultChecked />
                <i />
              </span>
            </label>
            <label className="tg" htmlFor="deploy">
              <span className="tg-text">
                <b>Déployer sur Cloudflare</b>
                <span>Quand le ticket le demande</span>
              </span>
              <span className="switch">
                <input type="checkbox" id="deploy" name="deploy" defaultChecked />
                <i />
              </span>
            </label>
            <label className="tg" htmlFor="store">
              <span className="tg-text">
                <b>Publier sur les stores</b>
                <span>App Store et Play Console</span>
              </span>
              <span className="switch">
                <input type="checkbox" id="store" name="store" />
                <i />
              </span>
            </label>
          </div>
          <p className="help">Aucune limite de temps par ticket par défaut ; tu pourras en fixer une sur la page de l'agent.</p>
          <div className="wiz-nav">
            <span />
            <button className="btn primary" disabled={busy}>
              {busy ? "Réveil…" : "Réveiller l'agent"}
            </button>
          </div>
        </Form>
        <aside className="preview" style={{ "--h": hue } as React.CSSProperties} aria-label="Aperçu de l'agent">
          <Avatar key={spin} seed={seed} hue={hue} size={132} status={busy ? "working" : "idle"} className={spin ? "spin" : ""} />
          <h3>{name || "Sans nom"}</h3>
          <button
            type="button"
            className="btn ghost reroll"
            onClick={() => {
              setSalt((s) => s + 1);
              setSpin((s) => s + 1);
            }}
          >
            <Icon name="reroll" /> Autre tête
          </button>
        </aside>
      </div>
    </div>
  );
}

