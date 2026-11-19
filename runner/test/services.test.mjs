import assert from "node:assert/strict";
import { test } from "node:test";

import { createServices, dropInContent, flagsIn, parseShow, unixToIso } from "../src/services.mjs";

const HUB = "hub-prospection.service";
const STATUS_URL = "http://hub/status";
const config = {
  services: [
    { id: "sourcing", group: "Veille", name: "Agent 1", type: "hub-agent", unit: HUB, statusUrl: STATUS_URL, flag: "SOURCING_ENABLED", jobs: ["sourcing"], show: ["prospects"] },
    { id: "conversation", group: "Veille", name: "Agent 2", type: "hub-agent", unit: HUB, statusUrl: STATUS_URL, flag: "CONVERSATION_ENABLED", jobs: ["conversation", "sms-inbox"], show: ["handoffs"] },
    { id: "relay", group: "MR", name: "Relais", type: "systemd", units: ["claude-relay.service", "app-repo-sync.timer"], healthUrl: "http://relay/health" },
    { id: "tunnel", group: "Infra", name: "Tunnel", type: "systemd", units: ["cloudflared.service"], pausable: false },
    { id: "ha", group: "Infra", name: "HA", type: "http", url: "http://ha/manifest.json" },
  ],
};

const unit = (id, active = "active", file = "enabled") =>
  `Id=${id}\nActiveState=${active}\nSubState=${active === "active" ? "running" : "dead"}\nUnitFileState=${file}\nActiveEnterTimestamp=@1700000000\nLastTriggerUSec=@1700000500\n`;

/** Une machine simulée : unités systemd, fichiers, réponses HTTP, et la liste des commandes lancées. */
function machine({ units = {}, files = {}, http = {} } = {}) {
  const calls = [];
  const state = {
    [HUB]: unit(HUB),
    "claude-relay.service": unit("claude-relay.service"),
    "app-repo-sync.timer": unit("app-repo-sync.timer"),
    "cloudflared.service": unit("cloudflared.service"),
    ...units,
  };
  const replies = {
    [STATUS_URL]: {
      jobs: [
        { name: "sourcing", cron: "0 9 * * *", enabled: true, running: false, lastRun: { status: "ok", finishedAt: "2026-11-16T08:00:00Z" } },
        { name: "conversation", cron: "*/10 * * * *", enabled: true, running: false, lastRun: null },
        { name: "sms-inbox", cron: "*/2 * * * *", enabled: true, running: false, lastRun: null },
      ],
      prospects: { nouveau: 3, contacte: 2, converti: 0, total: 5 },
      handoffs: { pending: 1 },
    },
    "http://relay/health": { ok: true, repo: { commit: "abcdef123456", date: "2026-11-16" } },
    "http://ha/manifest.json": {},
    ...http,
  };
  const sh = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "show") return args.filter((a) => state[a]).map((a) => state[a]).join("\n");
    if (args[0] === "disable") for (const a of args.slice(2)) state[a] = unit(a, "inactive", "disabled");
    if (args[0] === "enable") for (const a of args.slice(2)) state[a] = unit(a);
    return "";
  };
  const fetchImpl = async (url) => {
    const body = replies[url];
    if (body instanceof Error) throw body;
    if (body === undefined) return new Response("", { status: 404 });
    return Response.json(body);
  };
  const fs = {
    readFile: async (p) => {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[p];
    },
    writeFile: async (p, c) => void (files[p] = c),
    rm: async (p) => void delete files[p],
    mkdir: async () => {},
  };
  const svc = createServices({ config, sh, fetchImpl, fs, unitDir: "/etc/systemd/system", log: { log() {}, error() {} } });
  return { svc, calls, files, state, replies };
}

const DROP_IN = `/etc/systemd/system/${HUB}.d/essaim-pause.conf`;

test("parseShow et unixToIso lisent la sortie de systemctl", () => {
  const units = parseShow(`${unit("a.service")}\n${unit("b.timer", "inactive")}`);
  assert.equal(units["a.service"].ActiveState, "active");
  assert.equal(units["b.timer"].ActiveState, "inactive");
  assert.equal(unixToIso("@1700000000"), "2023-11-14T22:13:20.000Z");
  assert.equal(unixToIso("n/a"), null);
  assert.equal(unixToIso("@0"), null);
});

test("dropInContent et flagsIn font l'aller-retour", () => {
  assert.equal(dropInContent([]), "");
  const c = dropInContent(["SYNTHESIS_ENABLED", "CONVERSATION_ENABLED"]);
  assert.deepEqual(flagsIn(c), ["CONVERSATION_ENABLED", "SYNTHESIS_ENABLED"]);
});

test("collect rapporte l'état de chaque service", async () => {
  const { svc } = machine();
  const report = await svc.collect();
  const by = Object.fromEntries(report.map((r) => [r.id, r]));
  assert.deepEqual(report.map((r) => r.id), ["sourcing", "conversation", "relay", "tunnel", "ha"]);
  assert.equal(by.sourcing.status, "active");
  assert.equal(by.sourcing.position, 0);
  assert.equal(by.sourcing.detail.counts[0].value, 5);
  assert.ok(by.sourcing.detail.counts.every((c) => c.value), "les compteurs à zéro sont omis");
  assert.equal(by.conversation.detail.counts[0].value, 1);
  assert.deepEqual(by.conversation.detail.jobs.map((j) => j.name), ["conversation", "sms-inbox"]);
  assert.equal(by.relay.status, "active");
  assert.ok(by.relay.detail.facts.some((f) => f.value.startsWith("abcdef1")));
  assert.equal(by.tunnel.pausable, false);
  assert.equal(by.ha.pausable, false);
  assert.equal(by.ha.status, "active");
});

test("collect : hub arrêté, job en cours, état injoignable, désactivé", async () => {
  let m = machine({ units: { [HUB]: unit(HUB, "failed") } });
  assert.equal((await m.svc.collect())[0].status, "down");

  m = machine();
  m.replies[STATUS_URL].jobs[2].running = true;
  const r = await m.svc.collect();
  assert.equal(r[0].status, "active");
  assert.equal(r[1].status, "working");

  m = machine({ http: { [STATUS_URL]: new Error("connect ECONNREFUSED") } });
  assert.equal((await m.svc.collect())[0].status, "unknown");

  m = machine();
  m.replies[STATUS_URL].jobs[0].enabled = false;
  assert.equal((await m.svc.collect())[0].status, "disabled");

  m = machine({ http: { "http://ha/manifest.json": undefined } });
  assert.equal((await m.svc.collect())[4].status, "down");
});

test("pause d'un agent du hub : drop-in puis redémarrage, et rien de plus au relevé suivant", async () => {
  const { svc, calls, files } = machine();
  assert.equal(await svc.apply({ sourcing: false, conversation: true, relay: false }), true);
  assert.deepEqual(flagsIn(files[DROP_IN]), ["CONVERSATION_ENABLED"]);
  assert.ok(calls.includes("systemctl daemon-reload"));
  assert.ok(calls.includes(`systemctl restart ${HUB}`));
  const by = Object.fromEntries((await svc.collect()).map((r) => [r.id, r]));
  assert.equal(by.conversation.status, "paused");
  assert.equal(by.sourcing.status, "active");

  calls.length = 0;
  assert.equal(await svc.apply({ sourcing: false, conversation: true, relay: false }), false);
  assert.ok(!calls.some((c) => c.includes("restart")));
});

test("reprise du dernier agent en pause : le drop-in disparaît", async () => {
  const { svc, calls, files } = machine({ files: { [DROP_IN]: dropInContent(["SOURCING_ENABLED"]) } });
  assert.equal(await svc.apply({ sourcing: false, conversation: false }), true);
  assert.equal(files[DROP_IN], undefined);
  assert.ok(calls.includes(`systemctl restart ${HUB}`));
});

test("un service inconnu d'Essaim garde son état actuel", async () => {
  const { svc, calls, files } = machine({ files: { [DROP_IN]: dropInContent(["SOURCING_ENABLED"]) } });
  assert.equal(await svc.apply({}), false);
  assert.deepEqual(flagsIn(files[DROP_IN]), ["SOURCING_ENABLED"]);
  assert.ok(!calls.some((c) => c.startsWith("systemctl restart") || c.includes("able --now")));
});

test("pas de redémarrage pendant qu'un job du hub tourne : la pause attend", async () => {
  const m = machine();
  m.replies[STATUS_URL].jobs[1].running = true;
  assert.equal(await m.svc.apply({ sourcing: true }), false);
  assert.equal(m.files[DROP_IN], undefined);
  const r = await m.svc.collect();
  assert.match(r[0].detail.pending, /Pause au prochain moment calme : conversation en cours/);

  m.replies[STATUS_URL].jobs[1].running = false;
  assert.equal(await m.svc.apply({ sourcing: true }), true);
  assert.deepEqual(flagsIn(m.files[DROP_IN]), ["SOURCING_ENABLED"]);
  assert.equal((await m.svc.collect())[0].detail.pending, undefined);
});

test("pause d'unités systemd : disable --now, puis enable --now à la reprise", async () => {
  const { svc, calls } = machine();
  assert.equal(await svc.apply({ relay: true, tunnel: true }), true);
  assert.ok(calls.includes("systemctl disable --now claude-relay.service app-repo-sync.timer"));
  assert.ok(!calls.some((c) => c.includes("able --now") && c.includes("cloudflared")), "le tunnel n'est pas pausable");
  const relay = (await svc.collect()).find((r) => r.id === "relay");
  assert.equal(relay.status, "paused");

  calls.length = 0;
  assert.equal(await svc.apply({ relay: true }), false);
  assert.equal(await svc.apply({ relay: false }), true);
  assert.ok(calls.includes("systemctl enable --now claude-relay.service app-repo-sync.timer"));
});

test("un échec de systemctl est rapporté sur le service", async () => {
  const m = machine();
  const svc = createServices({
    config,
    sh: async (cmd, args) => {
      if (args[0] === "restart") throw new Error("Job failed");
      return args[0] === "show" ? Object.values(m.state).join("\n") : "";
    },
    fetchImpl: async () => Response.json({ jobs: [] }),
    fs: { readFile: async () => "", writeFile: async () => {}, rm: async () => {}, mkdir: async () => {} },
    log: { log() {}, error() {} },
  });
  assert.equal(await svc.apply({ sourcing: true }), false);
  assert.match((await svc.collect())[0].detail.error, /Job failed/);
});
