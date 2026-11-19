import { beforeEach, describe, expect, it } from "vitest";

import { agentProgress, createAgent, createTask } from "~/.server/db";
import { MAX_WINDOW_MS, MIN_WINDOW_MS, fmtSince, gaugeParts, progressSince } from "~/lib/progress";
import { DEFAULT_SETTINGS } from "~/lib/types";

import { createTestD1 } from "./sqlite-d1";

const NOW = Date.parse("2026-11-17T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3600_000;

describe("fenêtre des tâches faites", () => {
  it("24 h quand la file est vide ou récente", () => {
    expect(progressSince(NOW, null)).toBe(ago(MIN_WINDOW_MS));
    expect(progressSince(NOW, ago(2 * H))).toBe(ago(MIN_WINDOW_MS));
  });

  it("remonte au début de la file actuelle, sans dépasser 7 jours", () => {
    expect(progressSince(NOW, ago(50 * H))).toBe(ago(50 * H));
    expect(progressSince(NOW, ago(30 * 24 * H))).toBe(ago(MAX_WINDOW_MS));
  });

  it("parts de la jauge", () => {
    expect(gaugeParts({ done: 0, active: 0, queued: 0, drafts: 0 })).toEqual({ total: 0, done: 0, active: 0, queued: 0, drafts: 0 });
    expect(gaugeParts({ done: 3, active: 1, queued: 2, drafts: 2 })).toEqual({ total: 8, done: 37.5, active: 12.5, queued: 25, drafts: 25 });
  });

  it("libellé du début de la fenêtre, heure de Paris", () => {
    expect(fmtSince("2026-11-17T08:30:00.000Z", NOW)).toBe("depuis 09:30");
    expect(fmtSince("2026-11-16T13:05:00.000Z", NOW)).toBe("depuis hier 14:05");
    expect(fmtSince("2026-11-14T08:00:00.000Z", NOW)).toBe("depuis samedi 09:00");
  });
});

describe("agentProgress", () => {
  let db: D1Database;
  const task = async (title: string, status: string, created: string, updated = created, parentId?: string) => {
    const id = await createTask(db, { agentId: "lumen", title, status: "prete", parentId });
    await db.prepare("UPDATE tasks SET status = ?2, created_at = ?3, updated_at = ?4 WHERE id = ?1").bind(id, status, created, updated).run();
    return id;
  };

  beforeEach(async () => {
    db = createTestD1().db;
    await createAgent(db, { name: "Lumen", repo: "octo/lumen", machine: "mac", kind: "dev", hue: 330, seed: "n", settings: DEFAULT_SETTINGS });
  });

  it("compte faites, en cours, en file et brouillons ; ignore abandons et tâches découpées", async () => {
    await task("Vieille, finie avant la file", "terminee", ago(10 * 24 * H), ago(9 * 24 * H));
    await task("Finie avant-hier", "terminee", ago(60 * H), ago(40 * H));
    await task("Finie ce matin", "terminee", ago(6 * H), ago(5 * H));
    await task("Abandonnée", "abandonnee", ago(5 * H));
    await task("Brouillon", "brouillon", ago(100 * H));
    await task("Plus ancienne de la file", "prete", ago(48 * H));
    await task("En question", "question", ago(3 * H));
    const parent = await task("Découpée", "en_cours", ago(4 * H));
    await task("Étape 1", "terminee", ago(4 * H), ago(2 * H), parent);
    await task("Étape 2", "en_cours", ago(4 * H), ago(1 * H), parent);
    await task("Étape 3", "prete", ago(4 * H), ago(4 * H), parent);

    const p = (await agentProgress(db, NOW)).lumen;
    // Fenêtre depuis la plus ancienne tâche ouverte (48 h ; le brouillon de 100 h ne compte pas) : « avant-hier »,
    // « ce matin » et l'étape 1.
    expect(p).toEqual({ done: 3, active: 2, queued: 2, drafts: 1, since: ago(48 * H) });
  });

  it("file vide : les dernières 24 h", async () => {
    await task("Finie avant-hier", "terminee", ago(60 * H), ago(40 * H));
    await task("Finie ce matin", "terminee", ago(6 * H), ago(5 * H));
    expect((await agentProgress(db, NOW)).lumen).toEqual({ done: 1, active: 0, queued: 0, drafts: 0, since: ago(24 * H) });
  });

  it("brouillons seuls : comptés, la fenêtre reste de 24 h", async () => {
    await task("Brouillon ancien", "brouillon", ago(100 * H));
    await task("Finie avant-hier", "terminee", ago(60 * H), ago(40 * H));
    expect((await agentProgress(db, NOW)).lumen).toEqual({ done: 0, active: 0, queued: 0, drafts: 1, since: ago(24 * H) });
  });
});
