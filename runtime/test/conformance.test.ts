// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Wire conformance: the runtime against the byte-exact vectors of
 * `ComlineProject/runtime`'s `runtime/conformance/`, vendored in
 * `test/conformance/` at the commit in `VECTORS_REV`.
 *
 * Every claim in `conformance-support.json` must hold against the vectors:
 * a supported feature passes all its cases, an unsupported one reports each
 * as not implemented. The result, with the cases proving each claim, is
 * `conformance-report.json`; `CONFORMANCE_BLESS=1 npm test` rewrites it.
 * The vectors' format is described in the runtime repository's
 * `runtime/conformance/README.md`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { NotImplemented, canon, decode, encode, matches, show, unhex, type Case } from "./ops.js";

// Tests run from `dist/test/`; the vendored corpus and the claims stay in
// the source tree.
const RUNTIME = new URL("../../", import.meta.url);
const CORPUS = new URL("test/conformance/", RUNTIME);
const SUPPORT = new URL("conformance-support.json", RUNTIME);
const REPORT = new URL("conformance-report.json", RUNTIME);

interface Claim {
  state: "supported" | "partial" | "unsupported";
  note?: string;
  tracking?: string;
  failing?: string[];
}

/** What running one case gave. */
type Outcome = { pass: true } | { fail: string } | { notImplemented: string };

const readJson = <T>(url: URL): T => JSON.parse(readFileSync(url, "utf8")) as T;

function run(c: Case): Outcome {
  try {
    const bytes = unhex(c.bytes);
    if (c.expect === "reject") {
      const got = decode(c, bytes);
      return got === undefined
        ? { pass: true }
        : { fail: `accepted bytes it must reject, as ${canon(got)}` };
    }
    if (c.op !== "decode") {
      const encoded = encode(c);
      if (!matches(c, encoded, c.bytes)) {
        return { fail: `encodes to ${show(encoded)}, expected ${show(bytes)}` };
      }
      if (c.op === "name_hash" || c.op === "encode") return { pass: true };
    }
    const got = decode(c, bytes);
    if (got === undefined) return { fail: "refused bytes it must decode" };
    return canon(got) === canon(c.input)
      ? { pass: true }
      : { fail: `decodes to ${canon(got)}, expected ${canon(c.input)}` };
  } catch (e) {
    if (e instanceof NotImplemented) return { notImplemented: e.message };
    return { fail: `threw ${e instanceof Error ? e.message : String(e)}` };
  }
}

test("TypeScript runtime support is proven by the wire vectors", () => {
  const { features } = readJson<{ features: { id: string }[] }>(new URL("features.json", CORPUS));
  const support = readJson<{ runtime: string; support: Record<string, Claim> }>(SUPPORT);
  const vectorFiles = new Set(readdirSync(new URL("vectors/", CORPUS)));
  const problems: string[] = [];

  for (const id of Object.keys(support.support)) {
    if (!features.some((f) => f.id === id)) problems.push(`support claims unknown feature \`${id}\``);
  }

  const proven: Record<string, Claim & { proven_by: string[] }> = {};
  for (const { id } of [...features].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const claim = support.support[id];
    if (!claim) {
      problems.push(`\`${id}\` has no claim in conformance-support.json`);
      continue;
    }
    if (!vectorFiles.has(`${id}.json`)) {
      problems.push(`\`${id}\` has no vectors`);
      continue;
    }
    const { cases } = readJson<{ cases: Case[] }>(new URL(`vectors/${id}.json`, CORPUS));
    if (cases.length === 0) problems.push(`\`${id}\` has no cases`);

    const provenBy: string[] = [];
    for (const c of cases) {
      const outcome = run(c);
      const known = claim.failing?.includes(c.id) ?? false;
      if (claim.state === "partial") {
        if ("pass" in outcome && known) {
          problems.push(
            `${c.id}: listed as failing in \`${id}\`'s partial claim, but passes - drop it from \`failing\``,
          );
        } else if ("pass" in outcome) provenBy.push(c.id);
        else if (!known) problems.push(`${c.id}: ${"fail" in outcome ? outcome.fail : outcome.notImplemented}`);
      } else if (claim.state === "supported") {
        if ("pass" in outcome) provenBy.push(c.id);
        else if ("fail" in outcome) problems.push(`${c.id}: ${outcome.fail}`);
        else
          problems.push(
            `${c.id}: \`${id}\` is claimed supported, but ${outcome.notImplemented} isn't implemented`,
          );
      } else if (!("notImplemented" in outcome)) {
        problems.push(
          `${c.id}: \`${id}\` is claimed unsupported, but the runtime implements it - claim it`,
        );
      }
    }
    for (const failing of claim.failing ?? []) {
      if (claim.state !== "partial") {
        problems.push(`\`${id}\` lists failing cases but isn't partial`);
        break;
      }
      if (!cases.some((c) => c.id === failing)) {
        problems.push(`\`${id}\` lists \`${failing}\` as failing, but has no such case`);
      }
    }
    proven[id] = { ...claim, proven_by: provenBy };
  }

  assert.deepEqual(problems, []);

  const wanted = `${JSON.stringify({ runtime: support.runtime, support: proven }, null, 2)}\n`;
  if (process.env.CONFORMANCE_BLESS) {
    writeFileSync(REPORT, wanted);
  } else {
    let current = "";
    try {
      current = readFileSync(REPORT, "utf8");
    } catch {
      // a missing report is out of date
    }
    assert.equal(
      current,
      wanted,
      "conformance-report.json is out of date. Run: CONFORMANCE_BLESS=1 npm test",
    );
  }
});
