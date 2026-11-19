import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "~/.server/env";
import { handleSync } from "~/.server/runner-api";
import { action } from "~/routes/refresh";

import { env as cfEnv } from "./cloudflare-workers";
import { createTestD1 } from "./sqlite-d1";

let env: Bindings;
let pushed: Array<{ machine?: string; runner?: { type: string } }>;

beforeEach(() => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" } as Bindings;
  pushed = [];
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, result: {} })));
});
afterEach(() => vi.unstubAllGlobals());

/** Faux hub : seul le Mac a son runner connecté ; il se synchronise dès qu'on le lui demande. */
function hub(onSync: (machine: string) => Promise<unknown>) {
  const stub = {
    fetch: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      pushed.push(body);
      const online = body.machine === "mac";
      if (online) await onSync(body.machine);
      return Response.json({ online });
    },
  };
  env.HUB = { idFromName: () => "hub", get: () => stub } as never;
  Object.assign(cfEnv, env);
}

describe("bouton Actualiser", () => {
  it("demande une synchro à chaque machine et attend celle des runners connectés", async () => {
    await handleSync(env, { machine: "mac", agents: [] });
    await handleSync(env, { machine: "nuc", agents: [] });
    let synced = 0;
    // Le runner répond un peu plus tard, comme en vrai.
    hub(async (machine) => void setTimeout(() => handleSync(env, { machine, agents: [] }).then(() => synced++), 50));
    const res = (await action()) as Response;
    expect(await res.json()).toEqual({ reached: ["mac"] });
    expect(pushed.map((p) => [p.machine, p.runner?.type])).toEqual([
      ["mac", "sync"],
      ["nuc", "sync"],
    ]);
    expect(synced).toBe(1);
  });

  it("sans runner connecté, répond tout de suite", async () => {
    hub(async () => undefined);
    const res = (await action()) as Response;
    expect(await res.json()).toEqual({ reached: [] });
  });
});
