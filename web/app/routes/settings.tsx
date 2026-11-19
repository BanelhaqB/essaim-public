import { Form, Link, useNavigation } from "react-router";

import { ThemeChoice } from "~/components/theme";
import { Icon } from "~/components/ui";
import { getSetting, listMachines, setSetting } from "~/.server/db";
import { serverEnv } from "~/.server/env";
import { listAgents } from "~/.server/db";
import { machineLabel } from "~/lib/machine";
import { call, chatId, createMissingTopics, forumRights, send } from "~/.server/telegram";

import type { Route } from "./+types/settings";

export const meta: Route.MetaFunction = () => [{ title: "Réglages · Essaim" }];

interface WebhookInfo {
  url?: string;
  allowed_updates?: string[];
  last_error_date?: number;
  ip_address?: string;
  last_error_message?: string;
  pending_update_count?: number;
}

const webhookUrl = (request: Request) => `${new URL(request.url).origin}/api/telegram`;

export async function loader({ request }: Route.LoaderArgs) {
  const env = serverEnv();
  const hasToken = Boolean(env.TELEGRAM_BOT_TOKEN);
  const [chat, candidateRaw, bot, webhook] = await Promise.all([
    chatId(env),
    getSetting(env.DB, "telegram_candidate"),
    hasToken ? call<{ username: string }>(env, "getMe", {}) : null,
    hasToken ? call<WebhookInfo>(env, "getWebhookInfo", {}) : null,
  ]);
  const candidate = candidateRaw ? (JSON.parse(candidateRaw) as { id: number; title: string }) : null;
  const [lastUpdate, errorRaw, rights, agents] = await Promise.all([
    getSetting(env.DB, "telegram_last"),
    getSetting(env.DB, "telegram_error"),
    chat ? forumRights(env) : null,
    listAgents(env.DB),
  ]);
  const lastError = errorRaw ? (JSON.parse(errorRaw) as { at: string; method: string; description: string }) : null;
  return {
    hasToken,
    hasSecret: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
    bot: bot?.username ?? null,
    chat,
    chatFromVar: Boolean(env.TELEGRAM_CHAT_ID),
    candidate,
    webhook: webhook ? { url: webhook.url ?? "", error: webhook.last_error_message ?? null, pending: webhook.pending_update_count ?? 0 } : null,
    expectedWebhook: webhookUrl(request),
    lastUpdate,
    lastError,
    rights,
    missingTopics: agents.filter((a) => !a.telegramTopic).map((a) => ({ id: a.id, name: a.name })),
    webhookRaw: webhook ? JSON.stringify(webhook) : null,
    machines: (await listMachines(env.DB)).map((m) => ({ name: m.name, online: m.online, places: m.places, override: Boolean(m.override) })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const env = serverEnv();
  const form = await request.formData();
  switch (form.get("intent")) {
    case "use-candidate": {
      const raw = await getSetting(env.DB, "telegram_candidate");
      if (raw) await setSetting(env.DB, "telegram_chat", String(JSON.parse(raw).id));
      return { ok: "Groupe enregistré." };
    }
    case "webhook": {
      if (!env.TELEGRAM_WEBHOOK_SECRET) return { error: "Le secret TELEGRAM_WEBHOOK_SECRET manque sur le Worker." };
      const ok = await call(env, "setWebhook", {
        url: webhookUrl(request),
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      return ok ? { ok: "Webhook branché." } : { error: "Telegram a refusé le webhook (voir les journaux du Worker)." };
    }
    case "topics": {
      const created = await createMissingTopics(env);
      return created ? { ok: `${created} sujet(s) créé(s).` } : { error: "Telegram a refusé de créer les sujets : voir le détail sous « Sujets des agents »." };
    }
    case "test":
      await send(env, "🐝 Essaim est branché. Les agents écriront ici, chacun dans son sujet.");
      return { ok: "Message envoyé dans le sujet Général." };
  }
  return null;
}

function Step({ done, title, children }: { done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className={`setup-step ${done ? "done" : ""}`}>
      <span className="dot" style={{ "--c": done ? "var(--ok)" : "var(--fg-3)" } as React.CSSProperties}>
        <Icon name={done ? "check" : "help"} />
      </span>
      <div>
        <b>{title}</b>
        <div className="setup-body">{children}</div>
      </div>
    </li>
  );
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { hasToken, hasSecret, bot, chat, chatFromVar, candidate, webhook, expectedWebhook, lastUpdate, lastError, rights, missingTopics, webhookRaw, machines } = loaderData;
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  const webhookOk = webhook?.url === expectedWebhook;
  const result = actionData as { ok?: string; error?: string } | null | undefined;

  return (
    <div className="enter">
      <div className="view-head">
        <div>
          <h1>Réglages</h1>
          <p>L'apparence de la console, et Telegram : les notifications des agents, un sujet par agent, et les commandes /etat, /pause, /reprise, /travail, /fin.</p>
        </div>
      </div>
      {result?.ok && (
        <p className="note ok" role="status">
          <Icon name="check" /> {result.ok}
        </p>
      )}
      {result?.error && (
        <p className="note err" role="alert">
          <Icon name="alert" /> {result.error}
        </p>
      )}
      <section className="panel" style={{ maxWidth: 760 }} aria-labelledby="apparence">
        <div className="panel-head">
          <div>
            <h3 id="apparence">Apparence</h3>
            <p className="muted small">Gardée sur cet appareil. « Automatique » suit le mode clair ou sombre du système.</p>
          </div>
        </div>
        <ThemeChoice />
      </section>
      {machines.length > 0 && (
        <section className="panel" style={{ maxWidth: 760, marginTop: 20 }} aria-labelledby="machines">
          <div className="panel-head">
            <div>
              <h3 id="machines">Machines</h3>
              <p className="muted small">Leurs ressources, et le nombre d'agents qui y travaillent en même temps.</p>
            </div>
          </div>
          <div className="machine-links">
            {machines.map((m) => (
              <Link className="machine" key={m.name} to={`/machines/${m.name}`}>
                <Icon name={m.name === "nuc" ? "server" : "laptop"} />
                <div>
                  <b>{machineLabel(m.name)}</b>
                  <span>{m.places != null ? `${m.places} place${m.places === 1 ? "" : "s"}${m.override ? " · réglage ponctuel" : ""}` : "services seulement"}</span>
                </div>
                <i className={`led ${m.online ? "" : "off"}`} aria-label={m.online ? "en ligne" : "hors ligne"} />
              </Link>
            ))}
          </div>
        </section>
      )}
      <section className="panel" style={{ maxWidth: 760, marginTop: 20 }} aria-label="Telegram">
        <ol className="setup">
          <Step done={hasToken && Boolean(bot)} title="Jeton du bot">
            {hasToken && bot ? (
              <p>
                Bot <span className="mono">@{bot}</span> reconnu.
              </p>
            ) : (
              <>
                <p>Dans un terminal, depuis le dossier web/ du projet, colle le jeton donné par @BotFather :</p>
                <pre className="code">npx wrangler secret put TELEGRAM_BOT_TOKEN</pre>
                {hasToken && <p className="err">Jeton présent mais refusé par Telegram : vérifie-le.</p>}
              </>
            )}
          </Step>
          <Step done={Boolean(webhookOk)} title="Webhook">
            {webhookOk ? (
              <>
                <p>Telegram envoie les messages du groupe à {expectedWebhook}.</p>
                {webhook?.error && <p className="err">Dernière erreur de Telegram : {webhook.error}</p>}
                {(webhook?.pending ?? 0) > 0 && <p className="muted">{webhook?.pending} message(s) en attente de livraison.</p>}
              </>
            ) : (
              <Form method="post">
                <p>{hasSecret ? "Telegram doit savoir où envoyer les messages du groupe." : "Le secret TELEGRAM_WEBHOOK_SECRET manque sur le Worker."}</p>
                {webhook?.error && <p className="err">Dernière erreur : {webhook.error}</p>}
                <button className="btn primary" name="intent" value="webhook" disabled={!hasToken || !hasSecret || busy}>
                  Brancher le webhook
                </button>
              </Form>
            )}
          </Step>
          <Step done={Boolean(chat)} title="Groupe">
            {chat ? (
              <p>
                Groupe <span className="mono">{chat}</span>
                {chatFromVar ? " (TELEGRAM_CHAT_ID)" : ""}.
              </p>
            ) : candidate ? (
              <Form method="post">
                <p>
                  Groupe détecté : <b>{candidate.title || candidate.id}</b> <span className="mono">{candidate.id}</span>
                </p>
                <button className="btn primary" name="intent" value="use-candidate" disabled={busy}>
                  Utiliser ce groupe
                </button>
              </Form>
            ) : (
              <p>
                Ajoute le bot au groupe en <b>administrateur</b> (droit « Gérer les sujets »), puis envoie <span className="mono">/etat</span> dans le groupe et
                recharge cette page.
              </p>
            )}
          </Step>
          {chat && (
            <Step done={Boolean(rights?.forum && missingTopics.length === 0)} title="Sujets des agents">
              {!rights?.forum ? (
                <p className="err">Les sujets ne sont pas activés dans ce groupe : Infos du groupe → Modifier → Sujets.</p>
              ) : (
                <p>
                  Crée un sujet par agent dans le groupe, copie son lien (appui long sur le sujet → Copier le lien) et colle-le dans « Sujet Telegram » à la
                  création de l'agent ou sur sa page.
                </p>
              )}
              {missingTopics.length > 0 && (
                <Form method="post">
                  <p className="muted">
                    Sans sujet :{" "}
                    {missingTopics.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && ", "}
                        <Link to={`/agents/${a.id}`}>{a.name}</Link>
                      </span>
                    ))}
                    .
                  </p>
                  {rights?.forum && rights.manageTopics ? (
                    <button className="btn" name="intent" value="topics" disabled={busy}>
                      Laisser le bot les créer
                    </button>
                  ) : (
                    <p className="muted small">Pour que le bot les crée lui-même, il lui faut le droit « Gérer les sujets » (Administrateurs → @{bot}).</p>
                  )}
                </Form>
              )}
              {lastError && (
                <p className="muted small">
                  Dernier refus de Telegram ({lastError.method}, {new Date(lastError.at).toLocaleString("fr-FR")}) : {lastError.description}
                </p>
              )}
            </Step>
          )}
          <Step done={false} title="Essai">
            <Form method="post">
              <p>Un message dans le sujet Général du groupe.</p>
              <button className="btn" name="intent" value="test" disabled={!hasToken || !chat || busy}>
                Envoyer un message de test
              </button>
            </Form>
          </Step>
        </ol>
        <details className="muted small">
          <summary>Diagnostic</summary>
          <p>Dernier message reçu : {lastUpdate ?? "aucun"}</p>
          <pre className="code">{webhookRaw ?? "pas de réponse de getWebhookInfo"}</pre>
        </details>
      </section>
    </div>
  );
}
