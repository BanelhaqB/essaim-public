import { beforeEach, describe, expect, it } from "vitest";

import { createTask } from "~/.server/db";
import type { Bindings } from "~/.server/env";
import { handleServicesSync } from "~/.server/services";
import { loader } from "~/routes/badge";

import { env as cfEnv } from "./cloudflare-workers";
import { createTestD1 } from "./sqlite-d1";

let env: Bindings;

beforeEach(() => {
  env = { ENVIRONMENT: "production", DB: createTestD1().db, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" } as Bindings;
  Object.assign(cfEnv, env);
});

const badge = async () => {
  const res = await loader();
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return res.json();
};

describe("badge de l'app macOS", () => {
  it("compte les questions en attente et les services en panne", async () => {
    expect(await badge()).toEqual({ questions: 0, servicesDown: 0, total: 0 });

    const id = await createTask(env.DB, { agentId: null, title: "Logo", status: "prete" });
    await createTask(env.DB, { agentId: null, title: "Autre", status: "prete" });
    await env.DB.prepare("UPDATE tasks SET status = 'question' WHERE id = ?").bind(id).run();
    await handleServicesSync(env, {
      machine: "nuc",
      services: [
        { id: "a", group: "G", name: "A", pausable: false, position: 0, status: "active", detail: {} },
        { id: "b", group: "G", name: "B", pausable: false, position: 1, status: "down", detail: {} },
      ],
    } as never);

    expect(await badge()).toEqual({ questions: 1, servicesDown: 1, total: 2 });
  });
});
