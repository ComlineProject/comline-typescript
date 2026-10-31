// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Loads the Comline core: the wasm32 build of `comline-runtime-ffi`, vendored
// with its JS glue in `core/` by `scripts/vendor-core.sh`.
//
// The glue is imported through the package's own `#core/comline.mjs`
// (`imports` in package.json), which resolves against the package root both
// from `src/` (typechecking, types from `core/comline.d.mts`) and from
// `dist/src/` (running, built or installed). The wasm is a file beside it,
// found from this module's URL: this file runs as `dist/src/core/load.js`,
// so the package root is three levels up. `new URL(<literal>,
// import.meta.url)` is also the form bundlers recognise as an asset.

import { instantiate, instantiateStreaming, type Comline } from "#core/comline.mjs";

export type { Comline } from "#core/comline.mjs";

const wasmUrl = new URL("../../../core/comline_runtime_ffi.wasm", import.meta.url);

let core: Promise<Comline> | undefined;
let loaded: Comline | undefined;

/**
 * The core's instance for this realm: instantiated on the first call, then
 * shared. A failed load isn't kept, so the next call tries again.
 */
export function loadCore(): Promise<Comline> {
  core ??= instantiateCore().then(
    (instance) => (loaded = instance),
    (e: unknown) => {
      core = undefined;
      throw e;
    },
  );
  return core;
}

/**
 * Drop `instance` if it's the cached one (a trap poisoned it), so the next
 * {@link loadCore} instantiates afresh. An instance already replaced is left
 * alone.
 */
export function discardCore(instance: Comline): void {
  if (loaded === instance) {
    core = undefined;
    loaded = undefined;
  }
}

async function instantiateCore(): Promise<Comline> {
  if (wasmUrl.protocol === "file:") {
    // Node (and Deno, Bun) on a local file: `fetch` can't read `file:` URLs
    // there. A dynamic import, so a browser never resolves `node:` modules.
    const { readFile } = await import("node:fs/promises");
    return instantiate(await readFile(wasmUrl));
  }
  return instantiateStreaming(fetch(wasmUrl));
}
