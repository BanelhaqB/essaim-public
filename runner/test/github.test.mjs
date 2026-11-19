import assert from "node:assert/strict";
import { test } from "node:test";

import { repoDescription } from "../src/github.mjs";

test("description d'un nouveau repo : première ligne du brief, sur une ligne et courte", () => {
  assert.equal(repoDescription("  Réservations du salon,\tavec rappels SMS.\n\nDétails…"), "Réservations du salon, avec rappels SMS.");
  assert.equal(repoDescription(""), "");
  assert.equal(repoDescription(undefined), "");
  assert.equal(repoDescription("x".repeat(500)).length, 200);
});
