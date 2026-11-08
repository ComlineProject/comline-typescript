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


def shard_of(ids, plan, spec):
    """Shard I of N: a deterministic balanced split. Longest-processing-time
    first over a cost guess (iterations, times 16 for the large payloads, which
    cost far more per iteration), so the heavy ids spread across the shards."""
    i, n = map(int, spec.split("/"))
    if not 0 <= i < n:
        sys.exit(f"--shard {spec}: need 0 <= I < N")

    def cost(w):
        c = sum(k + wu for k, wu in plan[w].values())
        return c * 16 if "/large-array/" in w or w.endswith("/65536") else c

    load = [0] * n
    mine = []
    for w in sorted(ids, key=lambda w: (-cost(w), w)):
        s = min(range(n), key=lambda j: (load[j], j))
        load[s] += cost(w)
        if s == i:
            mine.append(w)
    return sorted(mine, key=ids.index)


def pct(x):
    return f"{x:.3f}%"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workload", nargs="*", help=f"default: {' '.join(DEFAULTS)}")
    ap.add_argument("--compare", action="store_true", help="print ts/wasm pairs as a markdown table")
    ap.add_argument("--repeat", type=int, default=5, help="most runs per workload and tier")
    ap.add_argument("--min-repeat", type=int, default=3,
                    help="runs first; stop there if they settled (default 3)")
    ap.add_argument("--settle", type=float, default=0.001,
                    help="(max-min)/median at or below which --min-repeat runs are enough (default 0.001 = 0.1%%)")
    ap.add_argument("--shard", metavar="I/N",
                    help="with --shared: only shard I of N (0-based) of the ids; shards are disjoint and cover all")
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
            w, *n = line.split()
            plan[w] = {False: (int(n[0]), int(n[1])), True: (int(n[2]), int(n[3]))}
        a.workload = a.workload or list(plan)
        if a.shard:
            a.workload = shard_of(a.workload, plan, a.shard)
    workloads = a.workload or DEFAULTS
    if not os.path.exists(a.region):
        sys.exit(f"{a.region} not found: build the region addon (bench/README.md)")
    # A shared report has both tiers: interpreter/baseline (--no-opt) and optimized.
    modes = [False, True] if a.shared and a.json else [a.opt]

    def iters(w, opt):
        k, wu = plan.get(w, {}).get(opt, (5000, 5000))
        return a.K or k, a.W or wu

    spread_of = lambda r, m: (max(r) - min(r)) / m if m else 0
    first = max(1, min(a.min_repeat, a.repeat))
    with cf.ThreadPoolExecutor(a.j) as pool:
        def submit(key, n):
            w, opt = key
            return [pool.submit(run_once, a.node, w, *iters(w, opt), a.region, opt) for _ in range(n)]

        keys = [(w, opt) for opt in modes for w in workloads]
        allruns = {key: [f.result() for f in fs] for key, fs in {k: submit(k, first) for k in keys}.items()}
        # Runs that disagree beyond --settle get the rest of --repeat.
        more = {k: submit(k, a.repeat - first) for k, r in allruns.items()
                if len(r) < a.repeat and spread_of(r, statistics.median(r)) > a.settle}
        for k, fs in more.items():
            allruns[k] += [f.result() for f in fs]
        print(f"{len(keys) - len(more)} of {len(keys)} (workload, tier) pairs settled after {first} runs",
              file=sys.stderr)

    for opt in modes:
        runs = {w: allruns[(w, opt)] for w in workloads}
        med = {w: statistics.median(r) for w, r in runs.items()}
        if len(modes) > 1:
            print(f"\n{'--opt' if opt else '--no-opt'}\n")
        print("| workload | median instr/iter | min | max | spread |")
        print("|---|---:|---:|---:|---:|")
        for w, r in runs.items():
            print(f"| {w} | {med[w]:,.0f} | {min(r):,.0f} | {max(r):,.0f} | {pct(100 * spread_of(r, med[w]))} |")

    if a.json:
        commit = a.commit or subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True,
                                            text=True, check=True).stdout.strip()
        version = subprocess.run([a.node, "--version"], capture_output=True, text=True, check=True).stdout.strip()

        def metric(r):
            m = statistics.median(r)
            return {"value": round(m), "spread": round(spread_of(r, m), 6)}

        report = {
            "format": 2,
            "runtime": "typescript",
            "commit": commit,
            "toolchain": f"node {version}",
            "benches": {w: {("instructions-opt" if opt else "instructions"): metric(allruns[(w, opt)])
                            for opt in modes}
                        for w in workloads},
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
