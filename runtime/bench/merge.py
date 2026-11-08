#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Merge the partial reports of `count.py --shared --shard I/N` into one.

    merge.py --out typescript.bench.json part0.json part1.json ...

Fails unless every id `bench/shared.mjs` lists is present exactly once, and
the parts agree on format, runtime, commit and toolchain.
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENVELOPE = ("format", "runtime", "commit", "toolchain")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("parts", nargs="+")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    parts = [json.load(open(p)) for p in a.parts]
    for key in ENVELOPE:
        vals = {json.dumps(p.get(key)) for p in parts}
        if len(vals) != 1:
            sys.exit(f"parts disagree on {key}: {sorted(vals)}")
    benches = {}
    for name, p in zip(a.parts, parts):
        for id_, v in p["benches"].items():
            if id_ in benches:
                sys.exit(f"{id_} is in more than one part ({name})")
            benches[id_] = v
    expected = [l.split()[0] for l in subprocess.run(["node", os.path.join(HERE, "shared.mjs")],
                capture_output=True, text=True, check=True).stdout.splitlines()]
    missing = [i for i in expected if i not in benches]
    extra = [i for i in benches if i not in expected]
    if missing or extra:
        sys.exit(f"missing: {missing}\nunexpected: {extra}")
    report = {k: parts[0][k] for k in ENVELOPE}
    report["benches"] = {i: benches[i] for i in expected}
    with open(a.out, "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    print(f"merged {len(parts)} parts, {len(expected)} benchmarks")


if __name__ == "__main__":
    main()
