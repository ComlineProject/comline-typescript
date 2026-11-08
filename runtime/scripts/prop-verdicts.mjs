// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A `node --test` reporter that writes each test's verdict as one JSON
// object, `{"<test name>": "pass" | "fail"}`: suites and skipped tests are
// left out. The nightly workflow builds typescript.fuzz.json's `proptest`
// from it.
//
//     node --test --test-reporter=./scripts/prop-verdicts.mjs \
//       --test-reporter-destination=verdicts.json dist/test/prop/*.test.js

export default async function* verdicts(source) {
  const out = {};
  for await (const { type, data } of source) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    if (data.details?.type === "suite" || data.skip || data.todo) continue;
    out[data.name] = type === "test:pass" ? "pass" : "fail";
  }
  yield JSON.stringify(out, null, 2) + "\n";
}
