#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Instructions per iteration, TypeScript against the wasm core.

Runs each workload REPEAT times (default 5) under `valgrind --tool=callgrind`
with `node --predictable --no-opt` (or, with --opt, the optimizing tier on), counting only the measured loop of
count.mjs, and prints the median per-iteration count and the min-max spread.
With --compare, prints a markdown table of each ts-X against wasm-X.
With --shared, runs the shared benchmarks (bench/shared.mjs) instead, and
--json FILE writes them as the runtime's report (typescript.bench.json).

    count.py ts-request-16 wasm-request-16 ts-name-hash wasm-name-hash --compare
    count.py ts-request-16 wasm-request-16 --compare      # pairs by name
    count.py noop                                         # the loop's own cost
    count.py --shared --json typescript.bench.json        # the shared benchmarks

Needs valgrind on PATH, `npm run build`, and bench/.core/region.node (see
README.md). The wasm workloads read COMLINE_WASM and COMLINE_GLUE.
"""

import argparse
import json
import concurrent.futures as cf
import os
import re
import statistics
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULTS = ["ts-request-16", "wasm-request-16", "ts-request-4096", "wasm-request-4096",
            "ts-name-hash", "wasm-name-hash", "ts-handshake", "wasm-handshake", "noop"]
TOTAL = re.compile(rb"^summary:\s+(\d+)", re.M)


def run_once(node, workload, k, w, region, opt):
    env = dict(os.environ, COMLINE_REGION=region)
    with tempfile.TemporaryDirectory(prefix="count-") as tmp:
        out = os.path.join(tmp, "cg.out")
        cmd = [
            "valgrind", "--tool=callgrind", f"--callgrind-out-file={out}",
            "--collect-atstart=no", "--toggle-collect=comline_bench_region",
            node, "--allow-natives-syntax", "--predictable",
            *([] if opt else ["--no-opt"]),
            os.path.join(HERE, "count.mjs"), workload, str(k), str(w),
        ]
        p = subprocess.run(cmd, cwd=os.path.dirname(HERE), capture_output=True, env=env)
        if p.returncode != 0:
            raise RuntimeError(f"{workload}: {' '.join(cmd)} failed:\n{p.stderr.decode()[-2000:]}")
        with open(out, "rb") as f:
            return int(TOTAL.search(f.read()).group(1)) / k


def real_node(node):
    # Version-manager shims (proto, volta, ...) exec the real binary, and
    # valgrind would then count the shim: ask node where it really is.
    return subprocess.run([node, "-p", "process.execPath"], capture_output=True, text=True, check=True).stdout.strip()


def pct(x):
    return f"{x:.3f}%"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workload", nargs="*", help=f"default: {' '.join(DEFAULTS)}")
    ap.add_argument("--compare", action="store_true", help="print ts/wasm pairs as a markdown table")
    ap.add_argument("--repeat", type=int, default=5)
    ap.add_argument("-K", type=int, help="measured iterations (default 5000; with --shared, per benchmark)")
    ap.add_argument("-W", type=int, help="warm-up iterations (default 5000; with --shared, per benchmark)")
    ap.add_argument("-j", type=int, default=4, help="parallel valgrind runs")
    ap.add_argument("--node", default="node", help="node binary (shims are resolved)")
    ap.add_argument("--opt", action="store_true",
                    help="leave V8's optimizing tier on (drop --no-opt); give -W enough warm-up to reach it")
    ap.add_argument("--shared", action="store_true",
                    help="every shared benchmark this runtime measures (bench/shared.mjs), unless workloads are named")
    ap.add_argument("--json", metavar="FILE", help="write the results as a bench report (with --shared)")
    ap.add_argument("--commit", help="the measured commit, for --json (default: git rev-parse HEAD)")
    ap.add_argument("--region", default=os.path.join(HERE, ".core", "region.node"))
    a = ap.parse_args()
    a.node = real_node(a.node)
    plan = {}
    if a.shared:
        for line in subprocess.run([a.node, os.path.join(HERE, "shared.mjs")], capture_output=True,
                                   text=True, check=True).stdout.splitlines():
            w, k, wu = line.split()
            plan[w] = (int(k), int(wu))
        a.workload = a.workload or list(plan)
    workloads = a.workload or DEFAULTS
    kw = {w: (a.K or plan.get(w, (5000, 5000))[0], a.W or plan.get(w, (5000, 5000))[1]) for w in workloads}
    if not os.path.exists(a.region):
        sys.exit(f"{a.region} not found: build the region addon (bench/README.md)")

    with cf.ThreadPoolExecutor(a.j) as pool:
        futs = {w: [pool.submit(run_once, a.node, w, *kw[w], a.region, a.opt) for _ in range(a.repeat)]
                for w in workloads}
        runs = {w: [f.result() for f in fs] for w, fs in futs.items()}
    med = {w: statistics.median(r) for w, r in runs.items()}

    print("| workload | median instr/iter | min | max | spread |")
    print("|---|---:|---:|---:|---:|")
    for w, r in runs.items():
        spread = 100 * (max(r) - min(r)) / med[w] if med[w] else 0
        print(f"| {w} | {med[w]:,.0f} | {min(r):,.0f} | {max(r):,.0f} | {pct(spread)} |")

    if a.json:
        commit = a.commit or subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True,
                                            text=True, check=True).stdout.strip()
        version = subprocess.run([a.node, "--version"], capture_output=True, text=True, check=True).stdout.strip()
        report = {
            "runtime": "typescript",
            "commit": commit,
            "toolchain": f"node {version}",
            "metric": "instructions",
            "benches": {w: {"ir": round(med[w]),
                            "spread": round((max(r) - min(r)) / med[w], 6) if med[w] else 0}
                        for w, r in runs.items()},
        }
        with open(a.json, "w") as f:
            json.dump(report, f, indent=2)
            f.write("\n")

    if a.compare:
        # ts-X against wasm-X, and against wasm-X-into when it ran.
        pairs = [(w, c) for w in workloads if w.startswith("ts-")
                 for c in ("wasm-" + w[3:], "wasm-" + w[3:] + "-into") if c in med]
        if not pairs:
            sys.exit("--compare needs a ts-X and a wasm-X workload")
        print()
        print("| workload | TS | core (wasm) | delta | % |")
        print("|---|---:|---:|---:|---:|")
        for t, c in pairs:
            d = med[c] - med[t]
            print(f"| {c[5:]} | {med[t]:,.0f} | {med[c]:,.0f} | {d:+,.0f} | {100 * d / med[t]:+.1f}% |")


if __name__ == "__main__":
    main()
