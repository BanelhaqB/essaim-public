/**
 * Veilleur des services d'un serveur : toutes les 30 s, relève l'état des services décrits dans SERVICES_CONFIG
 * (/etc/essaim-services.json par défaut, modèle : services.example.json), l'envoie à Essaim et applique la pause demandée.
 * Tourne en root (systemctl, drop-ins) : install-services.sh l'installe comme service systemd.
 * Essaim injoignable : les services gardent l'état demandé en dernier.
 */
import { readFileSync } from "node:fs";

import { createControl } from "./control.mjs";
import { createServices } from "./services.mjs";

const env = process.env;
for (const key of ["CONTROL_URL", "RUNNER_TOKEN"]) {
  if (!env[key]) {
    console.error(`${key} manque (voir /etc/essaim-services.env).`);
    process.exit(1);
  }
}
const configPath = env.SERVICES_CONFIG || "/etc/essaim-services.json";
const config = JSON.parse(readFileSync(configPath, "utf8"));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const POLL_MS = Number(env.POLL_MS || 30_000);

const control = createControl({
  url: env.CONTROL_URL,
  token: env.RUNNER_TOKEN,
  accessId: env.CF_ACCESS_CLIENT_ID,
  accessSecret: env.CF_ACCESS_CLIENT_SECRET,
  machine: env.MACHINE || "nuc",
});
const services = createServices({ config });

let stopping = false;
let timer;

async function tick() {
  let soon = false;
  try {
    const report = await services.collect();
    const res = await control.services({ version, services: report });
    const desired = Object.fromEntries((res.services ?? []).map((s) => [s.id, Boolean(s.paused)]));
    // Un changement appliqué est rapporté tout de suite, sans attendre le relevé suivant.
    soon = await services.apply(desired);
  } catch (error) {
    console.error("Relevé :", error.message);
  }
  if (!stopping) timer = setTimeout(tick, soon ? 3000 : POLL_MS);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    clearTimeout(timer);
    process.exit(0);
  });
}

console.log(`Veilleur des services ${version} : ${config.services.length} service(s), Essaim ${env.CONTROL_URL}`);
tick();
