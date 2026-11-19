import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getService, listMachines, listServices, setServicePaused } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { handleServicesSync, servicePauseAction } from "~/.server/services";
import { handleUpdate } from "~/.server/telegram";
import { serviceStatus } from "~/lib/status";

import { createTestD1 } from "./sqlite-d1";

let env: Bindings;
let sent: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100" } as Bindings;
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const report = (over: Record<string, unknown> = {}) => [
  { id: "veille-sourcing", group: "Veille prospection", name: "Agent 1 · Sourcing", pausable: true, position: 0, status: "active", detail: { summary: "En service.", counts: [{ label: "Prospects", value: 434 }] }, ...over },
  { id: "rappels-support", group: "Rappels", name: "Support", pausable: true, position: 1, status: "active", detail: {} },
  { id: "home-assistant", group: "Infrastructure", name: "Home Assistant", pausable: false, position: 2, status: "active", detail: {} },
];
const texts = () => sent.filter((m) => m.method === "sendMessage").map((m) => String(m.body.text));

describe("services", () => {
  it("sync : déclare les services, fait vivre la machine et renvoie la pause demandée", async () => {
    const res = await handleServicesSync(env, { machine: "nuc", version: "0.1.0", services: report() });
    expect(res.services).toEqual([
      { id: "veille-sourcing", paused: false },
      { id: "rappels-support", paused: false },
      { id: "home-assistant", paused: false },
    ]);
    const s = await getService(env.DB, "veille-sourcing");
    expect(s).toMatchObject({ machine: "nuc", group: "Veille prospection", status: "active", detail: { counts: [{ value: 434 }] }, version: "0.1.0" });
    expect((await listMachines(env.DB)).find((m) => m.name === "nuc")).toMatchObject({ online: true });

    await setServicePaused(env.DB, { id: "veille-sourcing" }, true);
    const again = await handleServicesSync(env, { machine: "nuc", services: report() });
    expect(again.services.find((x) => x.id === "veille-sourcing")?.paused).toBe(true);
  });

  it("un service déjà en pause à sa déclaration le reste ; un service non pausable ne l'est jamais", async () => {
    await handleServicesSync(env, { machine: "nuc", services: report({ status: "paused" }) });
    expect((await getService(env.DB, "veille-sourcing"))?.paused).toBe(true);
    expect(await setServicePaused(env.DB, { id: "home-assistant" }, true)).toBe(0);
  });

  it("pause d'un groupe entier, et formulaire des pages", async () => {
    await handleServicesSync(env, { machine: "nuc", services: report() });
    const form = new FormData();
    form.set("intent", "pause");
    form.set("group", "Veille prospection");
    await servicePauseAction(env.DB, form);
    const s = await getService(env.DB, "veille-sourcing");
    expect(s?.paused).toBe(true);
    expect(s?.pausedAt).toBeTruthy();
    expect((await getService(env.DB, "rappels-support"))?.paused).toBe(false);

    form.set("intent", "resume");
    await servicePauseAction(env.DB, form);
    expect(await getService(env.DB, "veille-sourcing")).toMatchObject({ paused: false, pausedAt: null });
  });

  it("un service retiré de la configuration disparaît ; les identifiants invalides sont ignorés", async () => {
    await handleServicesSync(env, { machine: "nuc", services: report() });
    await handleServicesSync(env, { machine: "nuc", services: [...report().slice(0, 1), { id: "Pas Bon!", name: "x", status: "active" }] });
    expect((await listServices(env.DB)).map((s) => s.id)).toEqual(["veille-sourcing"]);
  });

  it("borne l'état inconnu et le détail trop gros", async () => {
    await handleServicesSync(env, { machine: "nuc", services: report({ status: "bizarre", detail: { summary: "s", facts: [{ label: "x", value: "y".repeat(20_000) }] } }) });
    const s = await getService(env.DB, "veille-sourcing");
    expect(s?.status).toBe("unknown");
    expect(s?.detail).toEqual({ summary: "s" });
  });

  it("refuse une machine absente", async () => {
    await expect(handleServicesSync(env, { services: report() })).rejects.toBeInstanceOf(Response);
  });

  it("prévient sur Telegram quand un service tombe puis repart, pas au premier relevé", async () => {
    await handleServicesSync(env, { machine: "nuc", services: report({ status: "down" }) });
    expect(texts()).toEqual([]);
    await handleServicesSync(env, { machine: "nuc", services: report() });
    await handleServicesSync(env, { machine: "nuc", services: report({ status: "down", detail: { summary: "Le hub est arrêté (failed)." } }) });
    await handleServicesSync(env, { machine: "nuc", services: report({ status: "down" }) });
    await handleServicesSync(env, { machine: "nuc", services: report() });
    expect(texts()).toEqual(["🟢 <b>Agent 1 · Sourcing</b> (Veille prospection) est reparti.", "🔴 <b>Agent 1 · Sourcing</b> (Veille prospection) est tombé : Le hub est arrêté (failed).", "🟢 <b>Agent 1 · Sourcing</b> (Veille prospection) est reparti."]);
  });

  it("état affiché : pause en cours, reprise en cours, veilleur muet", async () => {
    await handleServicesSync(env, { machine: "nuc", services: report() });
    let s = (await getService(env.DB, "veille-sourcing"))!;
    expect(serviceStatus(s)).toBe("active");
    expect(serviceStatus({ ...s, paused: true })).toBe("pausing");
    expect(serviceStatus({ ...s, status: "paused" })).toBe("resuming");
    expect(serviceStatus({ ...s, paused: true, status: "paused" })).toBe("paused");
    expect(serviceStatus(s, Date.parse(s.statusAt!) + 4 * 60_000)).toBe("offline");
    s = (await getService(env.DB, "home-assistant"))!;
    expect(serviceStatus({ ...s, status: "down" })).toBe("down");
  });

  it("Telegram : /etat liste les services, /pause et /reprise acceptent un service ou un groupe", async () => {
    await handleServicesSync(env, { machine: "nuc", services: report() });
    const msg = (text: string) => ({ message: { text, chat: { id: -100 } } });

    await handleUpdate(env, msg("/etat"));
    expect(texts().at(-1)).toContain("<b>Services</b>");
    expect(texts().at(-1)).toContain("Agent 1 · Sourcing (Veille prospection) : en service");

    await handleUpdate(env, msg("/pause veille-sourcing"));
    expect((await getService(env.DB, "veille-sourcing"))?.paused).toBe(true);
    expect(texts().at(-1)).toContain("se met en pause sur sa machine");

    await handleUpdate(env, msg("/pause Veille prospection"));
    expect(texts().at(-1)).toContain("déjà en pause");

    await handleUpdate(env, msg("/reprise veille prospection"));
    expect((await getService(env.DB, "veille-sourcing"))?.paused).toBe(false);

    await handleUpdate(env, msg("/pause home-assistant"));
    expect(texts().at(-1)).toContain("surveillé seulement");
  });
});
