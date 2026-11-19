import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMachine, listMachines } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { handleSync } from "~/.server/runner-api";
import { DEFAULT_RUN_BYTES, fmtUntil, MAX_CAPACITY, parseCapacity, suggestCapacity, untilFor } from "~/lib/machine";
import { action, loader } from "~/routes/machine";

import { env as cfEnv } from "./cloudflare-workers";
import { createTestD1 } from "./sqlite-d1";

const GIB = 1024 ** 3;
let env: Bindings;
let sent: string[];

beforeEach(() => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100" } as Bindings;
  Object.assign(cfEnv, env);
  sent = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(String(JSON.parse(String(init.body)).text ?? ""));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
});
afterEach(() => vi.unstubAllGlobals());

const resources = { cpus: 14, memTotal: 48 * GIB, memAvailable: 20 * GIB, diskTotal: 1000 * GIB, diskFree: 400 * GIB, runsRss: [GIB], load: [3, 2, 1], cpuBusy: 0.25 };

async function submit(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return action({ request: new Request("https://e/machines/mac", { method: "POST", body }), params: { name: "mac" } } as never);
}

describe("places d'une machine", () => {
  it("valide le nombre de places et calcule l'échéance", () => {
    expect(parseCapacity("4")).toBe(4);
    expect(parseCapacity("0")).toBeNull();
    expect(parseCapacity(String(MAX_CAPACITY + 1))).toBeNull();
    expect(parseCapacity("2.5")).toBeNull();
    expect(untilFor("8", 0)).toBe(new Date(8 * 3_600_000).toISOString());
    expect(untilFor("0", 0)).toBeNull();
    expect(untilFor("5", 0)).toBeNull();
    const now = Date.parse("2026-11-16T10:00:00Z");
    expect(fmtUntil("2026-11-16T17:30:00Z", now)).toBe("18:30");
    expect(fmtUntil("2026-11-17T07:00:00Z", now)).toBe("demain 08:00");
  });

  it("conseille d'après la mémoire libre, la mémoire d'un run et les cœurs", () => {
    // 20 Go libres − 7,2 Go gardés = 12,8 Go ; 1 Go par run mesuré → 1 + 12 ; mais 14 cœurs → 7.
    expect(suggestCapacity(resources)).toMatchObject({ value: 7, limit: "processeur", measured: true });
    // Peu de mémoire libre : c'est elle qui limite (1,5 Go estimé par run).
    expect(suggestCapacity({ ...resources, memAvailable: 10 * GIB, runsRss: [] })).toMatchObject({ value: 1, limit: "memoire", perRun: DEFAULT_RUN_BYTES });
    expect(suggestCapacity({ ...resources, memAvailable: 1 * GIB, runsRss: [] })?.value).toBe(1);
    expect(suggestCapacity(null)).toBeNull();
  });

  it("la synchro garde les ressources et renvoie le réglage d'Essaim au runner", async () => {
    const first = await handleSync(env, { machine: "mac", version: "0.1.0", capacity: 2, baseCapacity: 2, running: 1, chats: 0, resources });
    expect(first.capacityOverride).toBeNull();
    let mac = await getMachine(env.DB, "mac");
    expect(mac).toMatchObject({ capacity: 2, baseCapacity: 2, places: 2, override: null });
    expect(mac?.resources).toMatchObject({ cpus: 14, running: 1 });

    expect(await submit({ intent: "places", capacity: "5", duration: "2" })).toMatchObject({ saved: expect.any(Number) });
    mac = await getMachine(env.DB, "mac");
    expect(mac?.places).toBe(5);
    expect(mac?.override?.capacity).toBe(5);
    const res = await handleSync(env, { machine: "mac", capacity: 2, baseCapacity: 2 });
    expect(res.capacityOverride?.capacity).toBe(5);
    expect(res.capacityOverride?.until).toBeGreaterThan(Date.now());
    // Une synchro sans relevé ne perd pas le précédent.
    expect((await getMachine(env.DB, "mac"))?.resources?.cpus).toBe(14);

    // Retour à la valeur par défaut.
    await submit({ intent: "reset" });
    expect((await handleSync(env, { machine: "mac", capacity: 5, baseCapacity: 2 })).capacityOverride).toBeNull();
  });

  it("revenir à CAPACITY sans échéance efface le réglage ; une valeur hors bornes est refusée", async () => {
    await handleSync(env, { machine: "mac", capacity: 2, baseCapacity: 2 });
    await submit({ intent: "places", capacity: "2", duration: "0" });
    expect((await getMachine(env.DB, "mac"))?.override).toBeNull();
    await submit({ intent: "places", capacity: "6", duration: "0" });
    expect((await getMachine(env.DB, "mac"))?.override).toEqual({ capacity: 6, until: null });
    const bad = (await submit({ intent: "places", capacity: "40", duration: "0" })) as { data: { error: string } };
    expect(bad.data.error).toMatch(/entre 1 et 16/);
  });

  it("un réglage arrivé à échéance s'efface à la synchro, avec un message", async () => {
    await handleSync(env, { machine: "mac", capacity: 2, baseCapacity: 2 });
    await env.DB.prepare("UPDATE machines SET capacity_override = 4, capacity_until = ?1 WHERE name = 'mac'").bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await listMachines(env.DB))[0]).toMatchObject({ override: null, places: 2 });
    const res = await handleSync(env, { machine: "mac", capacity: 4, baseCapacity: 2 });
    expect(res.capacityOverride).toBeNull();
    const row = await env.DB.prepare("SELECT capacity_override FROM machines WHERE name = 'mac'").first<number | null>("capacity_override");
    expect(row).toBeNull();
    expect(sent.some((t) => t.includes("retour à 2 place"))).toBe(true);
  });

  it("la page d'une machine inconnue renvoie 404", async () => {
    await expect(loader({ params: { name: "zz" } } as never)).rejects.toMatchObject({ init: { status: 404 } });
    await handleSync(env, { machine: "mac", capacity: 2, baseCapacity: 2, resources });
    const data = await loader({ params: { name: "mac" } } as never);
    expect(data.suggestion?.value).toBe(7);
  });
});
