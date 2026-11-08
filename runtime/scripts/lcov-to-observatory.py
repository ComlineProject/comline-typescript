#!/usr/bin/env python3
"""Convert an lcov file (node --test-reporter=lcov) to an Observatory
`coverage` report (observatory DATA.md). Units are the top-level directories
under src/ (files directly in src/ are the unit `src`). Standard library only.

  lcov-to-observatory.py <lcov> <out.json> <commit> <tool> [run-url]
"""
import json
import os
import sys


def empty():
    return {"lines": [0, 0], "functions": [0, 0], "branches": [0, 0]}


def add(acc, rec):
    for k in acc:
        acc[k][0] += rec[k][0]
        acc[k][1] += rec[k][1]


def finish(acc):
    out = {}
    for k, (cov, tot) in acc.items():
        # branches/functions are optional; drop them when the tool gave none
        if k == "lines" or tot > 0:
            out[k] = {"covered": cov, "total": tot}
    return out


def parse(path, root):
    files, cur = {}, None
    for line in open(path):
        line = line.strip()
        if line.startswith("SF:"):
            cur = os.path.relpath(os.path.abspath(line[3:]), root).replace(os.sep, "/")
            files[cur] = empty()
        elif cur and ":" in line:
            key, _, val = line.partition(":")
            slot = {"LH": ("lines", 0), "LF": ("lines", 1), "FNH": ("functions", 0),
                    "FNF": ("functions", 1), "BRH": ("branches", 0), "BRF": ("branches", 1)}.get(key)
            if slot:
                files[cur][slot[0]][slot[1]] = int(val)
    return files


def main():
    lcov, out, commit, tool = sys.argv[1:5]
    run = sys.argv[5] if len(sys.argv) > 5 else None
    files = parse(lcov, os.getcwd())
    units, totals = {}, empty()
    for path, rec in sorted(files.items()):
        parts = path.split("/")
        # only the shipped sources: src/**; tests and vendored data are elsewhere
        if parts[0] != "src" and not (parts[0] == "dist" and parts[1:2] == ["src"]):
            continue
        parts = parts[1:] if parts[0] == "dist" else parts
        unit = parts[1] if len(parts) > 2 else "src"
        add(units.setdefault(unit, empty()), rec)
        add(totals, rec)
    report = {"format": 1, "commit": commit, "toolchain": tool, "run": run, "tool": tool,
              "totals": finish(totals), "units": {u: finish(c) for u, c in sorted(units.items())}}
    with open(out, "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    t = report["totals"]["lines"]
    print(f"lines {t['covered']}/{t['total']} across {len(units)} units: {', '.join(units)}")


main()
