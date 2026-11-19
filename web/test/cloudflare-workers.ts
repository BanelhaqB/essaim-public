/** Remplace `cloudflare:workers` dans les tests (vitest.config.ts → alias) : un env que chaque test remplit. */
export const env: Record<string, unknown> = {};

/** Base des Durable Objects : les tests n'instancient pas le hub. */
export class DurableObject<E = unknown> {
  constructor(
    public ctx: unknown,
    public env: E,
  ) {}
}
