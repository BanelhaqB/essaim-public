import assert from "node:assert/strict";
import { test } from "node:test";

import { repoDescription, withRepoLock } from "../src/github.mjs";

test("description d'un nouveau repo : première ligne du brief, sur une ligne et courte", () => {
  assert.equal(repoDescription("  Réservations du salon,\tavec rappels SMS.\n\nDétails…"), "Réservations du salon, avec rappels SMS.");
  assert.equal(repoDescription(""), "");
  assert.equal(repoDescription(undefined), "");
  assert.equal(repoDescription("x".repeat(500)).length, 200);
});

test("verrou par repo : les opérations d'un même repo passent une à une, celles des autres repos en parallèle", async () => {
  const order = [];
  const task = (name, ms) => async () => {
    order.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${name}:end`);
  };
  await Promise.all([withRepoLock("a/x", task("1", 30)), withRepoLock("a/x", task("2", 5)), withRepoLock("b/y", task("3", 5))]);
  assert.ok(order.indexOf("1:end") < order.indexOf("2:start"), "même repo : la seconde attend la première");
  assert.ok(order.indexOf("3:start") < order.indexOf("1:end"), "autre repo : pas d'attente");
});

test("verrou par repo : une erreur ne bloque pas la suite", async () => {
  await assert.rejects(withRepoLock("c/z", async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await withRepoLock("c/z", async () => "ok"), "ok");
});
