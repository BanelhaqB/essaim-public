import { useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";

import { AgentFields } from "~/components/agent-fields";
import { Avatar, Icon } from "~/components/ui";
import { matesByRepo, parseAgentForm } from "~/.server/agent-form";
import { createAgent, getAgent } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { listRepos } from "~/.server/repos";
import { resolveTopic, saveTopic, welcomeAgent } from "~/.server/telegram";
import { parseHue } from "~/lib/avatar";
import { DEFAULT_SETTINGS } from "~/lib/types";

import type { Route } from "./+types/agent-new";

export const meta: Route.MetaFunction = () => [{ title: "Nouvel agent · Essaim" }];

export async function loader() {
  const { DB } = serverEnv();
  return { repos: await listRepos(DB), mates: await matesByRepo(DB) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const env = serverEnv();
  const name = String(form.get("name") ?? "").trim().slice(0, 40);
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Donne-lui un nom.";
  const parsed = await parseAgentForm(env.DB, form, DEFAULT_SETTINGS);
  if (!parsed.links.length) errors.repo = "Choisis au moins un repo : c'est là que l'agent travaille.";
  const topic = await resolveTopic(env, String(form.get("topic") ?? ""));
  if (!topic.ok) errors.topic = topic.error;
  if (Object.keys(errors).length || !topic.ok) return data({ errors }, { status: 400 });
  const main = parsed.repos.find((r) => r.id === parsed.links[0].repoId)!;
  const id = await createAgent(env.DB, {
    name,
    repo: main.repo,
    machine: parsed.machine,
    kind: "dev",
    hue: parseHue(form.get("hue")),
    seed: String(form.get("seed") || name),
    settings: parsed.settings,
    links: parsed.links,
  });
  // Le sujet Telegram de l'agent : celui du lien donné, sinon le bot tente de le créer.
  // Une erreur de Telegram ne bloque pas la création.
  if (topic.thread) await saveTopic(env, id, topic);
  const agent = await getAgent(env.DB, id);
  if (agent) await welcomeAgent(env, agent).catch((error) => console.error("Sujet Telegram :", error));
  return redirect(`/agents/${id}`);
}

export default function NewAgent({ actionData, loaderData }: Route.ComponentProps) {
  const [name, setName] = useState("");
  const [hue, setHue] = useState(200);
  const [salt, setSalt] = useState(0);
  const [spin, setSpin] = useState(0);
  const nav = useNavigation();
  const errors = (actionData as { errors?: Record<string, string> } | undefined)?.errors ?? {};
  const seed = `${name || "nouvel agent"}#${salt}`;
  const busy = nav.state === "submitting";

  return (
    <div className="enter">
      <div className="view-head">
        <div>
          <h1>Nouvel agent</h1>
          <p>Un agent travaille sur un ou plusieurs repos, avec ses propres droits sur chacun. Les repos se gèrent dans « Repos ».</p>
        </div>
      </div>
      <div className="wiz">
        <Form method="post" className="wiz-panel" noValidate>
          <input type="hidden" name="seed" value={seed} />
          <AgentFields
            repos={loaderData.repos}
            mates={loaderData.mates}
            errors={errors}
            nameField={
              <div className="field">
                <label htmlFor="name">Nom</label>
                <input type="text" id="name" name="name" autoComplete="off" placeholder="Ex. : Relecteur" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} />
                {errors.name && <span className="err">{errors.name}</span>}
              </div>
            }
          />
          {errors.repo && <span className="err">{errors.repo}</span>}
          <div className="field">
            <label htmlFor="hue">Couleur</label>
            <div className="hue-track" aria-hidden="true" />
            <input type="range" id="hue" name="hue" min="0" max="359" value={hue} onChange={(e) => setHue(Number(e.target.value))} />
          </div>
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
