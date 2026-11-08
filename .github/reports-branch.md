# Published reports

This branch is written by CI only; don't push to it by hand. It holds the
latest verification reports of `main`, which the
[Comline Observatory](https://comlineproject.github.io/observatory/) charts
from this branch's history:

- `typescript.bench.json`: instruction counts of the shared benchmarks
  (ComlineProject/runtime's `runtime/conformance/benches/`), from
  `.github/workflows/bench.yml` on every push to `main`, in two tiers per
  benchmark: `instructions` (`node --no-opt`) and `instructions-opt` (the
  optimizing tier on, after a warm-up), which is the one the Observatory's
  ratio to Rust uses. How they run: `runtime/bench/README.md` on `main`.
- `typescript.size.json`: bytes and gzip bytes of the runtime package as
  shipped (the `npm pack` tarball) and of its built entry file, from
  `.github/workflows/reports.yml` on every push to `main`.
- `typescript.coverage.json`: line, function and branch coverage of the
  runtime's own tests (Node's built-in coverage), per top-level directory of
  `runtime/src/`, from the same workflow.
- `typescript.fuzz.json`: the nightly property tests against the Rust
  reference, from `.github/workflows/nightly.yml`.

Each report names the `main` commit it measured. Every publish is one commit
here, so `git log -- typescript.bench.json` is the series. The publishing
action is `ComlineProject/observatory/.github/actions/publish-report`.
