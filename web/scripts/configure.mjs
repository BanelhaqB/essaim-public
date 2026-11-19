#!/usr/bin/env node
/**
 * Fabrique web/wrangler.jsonc depuis la configuration de TON instance, gardée hors du repo :
 * $ESSAIM_INSTANCE, sinon ~/.essaim/instance.json. Le repo ne contient ainsi aucune valeur propre à une installation
 * (domaine, compte Cloudflare, base D1, Access), et une mise à jour depuis le repo public ne touche jamais à la tienne.
 *
 *   node scripts/configure.mjs                         génère (sans instance : config neutre pour le dev local)
 *   node scripts/configure.mjs --require               échoue si l'instance est incomplète (avant un déploiement)
 *   node scripts/configure.mjs --set domain=essaim.exemple.fr --set databaseId=…   met à jour l'instance, puis génère
 *   node scripts/configure.mjs --show                  affiche l'instance et ce qui manque
 *
 * Clés : domain, databaseId, accessTeamDomain, accessAud (obligatoires pour déployer) ;
 *        accountId, workerName (essaim), databaseName (essaim), telegramChatId (facultatives).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const WEB = path.join(import.meta.dirname, "..");
const OUT = path.join(WEB, "wrangler.jsonc");
export const INSTANCE_FILE = process.env.ESSAIM_INSTANCE || path.join(homedir(), ".essaim", "instance.json");

export const REQUIRED = ["domain", "databaseId", "accessTeamDomain", "accessAud"];
const OPTIONAL = ["accountId", "workerName", "databaseName", "telegramChatId"];
const KEYS = [...REQUIRED, ...OPTIONAL];

/** Nettoie une valeur saisie : domaine sans https:// ni barre finale, équipe Access complétée. */
export function normalize(key, raw) {
  let value = String(raw ?? "").trim();
  if (key === "domain") value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (key === "accessTeamDomain") {
    value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (value && !value.includes(".")) value = `${value}.cloudflareaccess.com`;
  }
  return value;
}

export function missing(instance) {
  return REQUIRED.filter((k) => !instance[k]);
}

/** Configuration Wrangler de l'instance (sans instance : valeurs neutres, suffisantes pour `npm run dev` et les types). */
export function wranglerConfig(instance = {}) {
  const domain = instance.domain;
  return {
    $schema: "node_modules/wrangler/config-schema.json",
    name: instance.workerName || "essaim",
    ...(instance.accountId ? { account_id: instance.accountId } : {}),
    compatibility_date: "2026-10-01",
    main: "./workers/app.ts",
    ...(domain ? { routes: [{ pattern: domain, custom_domain: true }] } : {}),
    // Pas d'URL workers.dev : elle contournerait Cloudflare Access.
    workers_dev: false,
    preview_urls: false,
    vars: {
      ENVIRONMENT: "production",
      PUBLIC_URL: domain ? `https://${domain}` : "",
      ACCESS_TEAM_DOMAIN: instance.accessTeamDomain || "",
      ACCESS_AUD: instance.accessAud || "",
      // Groupe Telegram à sujets (-100…). Vide : celui choisi dans la page Réglages.
      TELEGRAM_CHAT_ID: instance.telegramChatId || "",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: instance.databaseName || "essaim",
        database_id: instance.databaseId || "00000000-0000-0000-0000-000000000000",
        migrations_dir: "migrations",
      },
    ],
    // Hub temps réel : relaie les runners (WebSocket sortante) et les pages ouvertes (fil de conversation en direct).
    durable_objects: { bindings: [{ name: "HUB", class_name: "Hub" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Hub"] }],
    // Toutes les 5 minutes : prévenir quand une machine ne répond plus.
    triggers: { crons: ["*/5 * * * *"] },
    observability: { enabled: true },
    upload_source_maps: true,
  };
}

const HEADER = `/**
 * FICHIER GÉNÉRÉ par scripts/configure.mjs depuis la configuration de ton instance (%SOURCE%).
 * Ne pas modifier ni committer : change l'instance (npm run configure -- --set clé=valeur) puis regénère.
 *
 * Essaim : plan de contrôle des agents Claude (un seul Worker : interface React Router + API des runners).
 * L'interface est protégée par Cloudflare Access ; le Worker vérifie lui-même le jeton (app/.server/access.ts).
 * /api/runner/* (runners) : Bearer RUNNER_TOKEN, chemin en Bypass dans Access (ou jeton de service).
 * /api/telegram (webhook du bot) : en-tête secret TELEGRAM_WEBHOOK_SECRET, chemin en Bypass dans Access.
 * Secrets (wrangler secret put) : RUNNER_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET.
 */
`;

export function render(instance, source) {
  return HEADER.replace("%SOURCE%", source) + JSON.stringify(wranglerConfig(instance), null, "\t") + "\n";
}

function readInstance() {
  if (!existsSync(INSTANCE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(INSTANCE_FILE, "utf8"));
  } catch (error) {
    console.error(`${INSTANCE_FILE} n'est pas un JSON valide : ${error.message}`);
    process.exit(1);
  }
}

function main(argv) {
  const sets = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--set") sets.push(argv[++i] ?? "");
  let instance = readInstance();

  if (sets.length) {
    instance ??= {};
    for (const pair of sets) {
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq);
      if (eq < 1 || !KEYS.includes(key)) {
        console.error(`--set attend clé=valeur, avec une clé parmi : ${KEYS.join(", ")}.`);
        process.exit(1);
      }
      const value = normalize(key, pair.slice(eq + 1));
      if (value) instance[key] = value;
      else delete instance[key];
    }
    mkdirSync(path.dirname(INSTANCE_FILE), { recursive: true });
    writeFileSync(INSTANCE_FILE, JSON.stringify(instance, null, 2) + "\n", { mode: 0o600 });
    console.log(`Instance mise à jour : ${INSTANCE_FILE}`);
  }

  const lack = instance ? missing(instance) : REQUIRED;
  if (argv.includes("--show")) {
    console.log(instance ? JSON.stringify(instance, null, 2) : `Pas d'instance (${INSTANCE_FILE}).`);
    console.log(lack.length ? `Manque pour déployer : ${lack.join(", ")}.` : "Instance complète.");
  }
  if (argv.includes("--require") && lack.length) {
    console.error(
      `Instance incomplète (${INSTANCE_FILE}) : manque ${lack.join(", ")}.\n` +
        "Renseigne-la avec npm run configure -- --set clé=valeur (voir README, « Installer ton instance »).",
    );
    process.exit(1);
  }

  const text = render(instance ?? {}, instance ? INSTANCE_FILE : "aucune instance : configuration de dev local");
  const before = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  // Réécrire seulement si ça change : wrangler et vite surveillent ce fichier.
  if (text !== before) writeFileSync(OUT, text);
}

if (process.argv[1] === import.meta.filename) main(process.argv.slice(2));
