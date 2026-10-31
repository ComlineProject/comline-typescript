import assert from "node:assert/strict";
import { test } from "node:test";

import { ABI_MAJOR, ABI_MINOR, Status } from "#core/comline.mjs";
import { loadCore } from "../src/core/load.js";
import { nameHash } from "../src/index.js";

test("loadCore loads the vendored core, once", async () => {
  const core = await loadCore();
  assert.equal(await loadCore(), core);
  assert.equal(core.poisoned, false);
});

test("the vendored core is ABI 0.1", async () => {
  const core = await loadCore();
  assert.equal(ABI_MAJOR, 0);
  assert.equal(ABI_MINOR, 1);
  assert.equal(core.abiVersion(), (0 << 16) | 1);
});

test("the core's nameHash is the TypeScript nameHash", async () => {
  const core = await loadCore();
  for (const name of ["comline", "comline@1", "datagram@2", "packed@1", "jsonrpc@1", "", "naïve"]) {
    assert.deepEqual(core.nameHash(name), { status: Status.OK, hash: nameHash(name) }, name);
  }
});
