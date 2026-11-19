import { describe, expect, it } from "vitest";

import { createAgent, getAgent, listAgents, reorderAgents, setHue } from "~/.server/db";
import { parseHue } from "~/lib/avatar";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { createTestD1 } from "./sqlite-d1";

describe("couleur d'un agent", () => {
  it("parseHue garde 0, ramène dans 0..359 et retombe sur la valeur par défaut", () => {
    expect(parseHue("0")).toBe(0);
    expect(parseHue("120.4")).toBe(120);
    expect(parseHue("360")).toBe(0);
    expect(parseHue("-10")).toBe(350);
    expect(parseHue("", 42)).toBe(42);
    expect(parseHue("abc", 42)).toBe(42);
    expect(parseHue(null)).toBe(200);
  });

  it("la couleur change après la création, le reste de l'agent ne bouge pas", async () => {
    const db = createTestD1().db;
    await createAgent(db, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
    await setHue(db, "lumen", 12);
    expect(await getAgent(db, "lumen")).toMatchObject({ hue: 12, seed: "n", name: "Lumen" });
  });
});

describe("ordre de priorité des agents", () => {
  const ids = async (db: D1Database) => (await listAgents(db)).map((a) => a.id);

  it("reorderAgents range dans l'ordre donné, ignore l'inconnu et garde les oubliés à la suite", async () => {
    const db = createTestD1().db;
    for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
      await createAgent(db, { name, repo: `octo/${name.toLowerCase()}`, machine: "mac", kind: "dev", hue: 10, seed: name, settings: DEFAULT_SETTINGS });
    }
    expect(await ids(db)).toEqual(["alpha", "beta", "gamma", "delta"]);

    await reorderAgents(db, ["gamma", "alpha", "delta", "beta"]);
    expect(await ids(db)).toEqual(["gamma", "alpha", "delta", "beta"]);
    expect((await listAgents(db)).map((a) => a.priority)).toEqual([0, 1, 2, 3]);

    // Liste partielle (un agent créé entre-temps), doublon et identifiant inconnu.
    await reorderAgents(db, ["beta", "fantome", "beta", "delta"]);
    expect(await ids(db)).toEqual(["beta", "delta", "gamma", "alpha"]);
  });
});
