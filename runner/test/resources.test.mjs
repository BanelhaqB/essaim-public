import assert from "node:assert/strict";
import { test } from "node:test";

import { cpuBusy, parseVmStat, readResources, treeRss } from "../src/resources.mjs";

test("vm_stat : pages libres, inactives et spéculatives", () => {
  const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   100.
Pages active:                                 969169.
Pages inactive:                               200.
Pages speculative:                              10.
Pages wired down:                             314395.`;
  assert.equal(parseVmStat(text), 310 * 16384);
  assert.equal(parseVmStat("rien"), null);
});

test("occupation du processeur entre deux relevés", () => {
  const t = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  assert.ok(Math.abs(cpuBusy([t(0, 0), t(0, 0)], [t(30, 70), t(10, 90)]) - 0.2) < 1e-9);
  assert.equal(cpuBusy(null, [t(1, 1)]), null);
  assert.equal(cpuBusy([t(5, 5)], [t(5, 5)]), null);
});

test("mémoire d'un run : le processus et tous ses descendants", () => {
  const ps = `  10     1  1000
  11    10   500
  12    11   250
  20     1  4000
  13    10   100`;
  assert.deepEqual(treeRss(ps, [10, 20, 99]), [1850 * 1024, 4000 * 1024, null]);
});

test("relevé réel de la machine", async () => {
  const r = await readResources({ pids: [process.pid] });
  assert.ok(r.cpus > 0 && r.memTotal > 0);
  assert.ok(r.memAvailable > 0 && r.memAvailable <= r.memTotal);
  assert.equal(r.runsRss.length, 1);
  assert.ok(r.runsRss[0] > 0);
});
