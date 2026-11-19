/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = path.join(import.meta.dirname, "..", "migrations");

type Value = string | number | null;

/** `?1`, `?2`… (syntaxe D1) → `?` positionnels : le SQLite de Node ne lie pas les `?NNN`. */
function positional(sql: string, params: Value[]): [string, Value[]] {
  const out: Value[] = [];
  const text = sql.replace(/\?(\d+)/g, (_, n: string) => {
    out.push(params[Number(n) - 1]);
    return "?";
  });
  return text === sql ? [sql, params] : [text, out];
}

/**
 * Une base D1 de test : le SQLite de Node, avec les migrations du repo. Assez de l'API D1
 * (`prepare/bind/first/all/run`, `batch` en transaction) pour exécuter les vraies requêtes.
 */
export function createTestD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(path.join(MIGRATIONS, file), "utf8"));
  }

  class Statement {
    constructor(
      readonly sql: string,
      readonly params: Value[] = [],
    ) {}
    bind(...params: Value[]) {
      return new Statement(this.sql, params);
    }
    private exec(): [ReturnType<DatabaseSync["prepare"]>, Value[]] {
      const [sql, params] = positional(this.sql, this.params);
      return [sqlite.prepare(sql), params];
    }
    async first<T>(column?: string): Promise<T | null> {
      const [stmt, params] = this.exec();
      const row = stmt.get(...params) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? row[column] : { ...row }) as T;
    }
    async all<T>() {
      const [stmt, params] = this.exec();
      return { results: stmt.all(...params).map((r) => ({ ...r })) as T[], success: true };
    }
    async run() {
      const [stmt, params] = this.exec();
      const info = stmt.run(...params);
      return { success: true, results: [], meta: { changes: Number(info.changes) } };
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return { db: db as unknown as D1Database, sqlite };
}
