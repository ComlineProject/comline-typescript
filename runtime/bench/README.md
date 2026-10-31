# Instruction counts: TypeScript against the wasm core

A dev tool for PR evidence. It counts the instructions one iteration of a
workload costs, in the TypeScript runtime and in the wasm build of the shared
Rust core, so a move PR can carry a comparison table. It is not a CI gate and
is not run by `npm test`; `package.json`'s `files` ships only `dist` and `src`,
so none of this is published.

Each workload runs under `valgrind --tool=callgrind`. `count.mjs` warms the
workload up, then runs K iterations inside a native call (`region/region.c`)
that callgrind toggles collection on, so only the measured loop is counted.
`count.py` runs each workload 5 times and reports the median
instructions per iteration and the min-max spread.

Workloads: `ts-` and `wasm-` `request-16`, `request-4096` (encode a request,
decode it), `name-hash`, `handshake`, and `noop` (the loop's own cost).
`binding-handshake` is the handshake as `ComlineHandshake` runs it, through
the runtime's binding (`src/core/core.ts`) over the vendored `core/`.

## Build

Needs `valgrind` and a C compiler. From `runtime/`:

```sh
# the TypeScript runtime
npm ci && npm run build

# the region addon (any Node 20+ with headers next to the binary)
mkdir -p bench/.core
cc -O2 -shared -fPIC -I"$(dirname "$(dirname "$(node -p process.execPath)")")/include/node" \
   -o bench/.core/region.node bench/region/region.c

# the wasm core and its JS glue, from a comline-runtime checkout of PR #62's
# branch `ffi/js-binding-fit` (or main, once it merges)
cargo build -p comline-runtime-ffi --profile wasm --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/wasm/comline_runtime_ffi.wasm bench/.core/   # from the checkout's target/
cp runtime/ffi/js/comline.mjs bench/.core/                                    # from the checkout
```

`bench/.core*/` is git-ignored. To load a wasm build and glue from elsewhere,
set `COMLINE_WASM` and `COMLINE_GLUE` to their paths.

## Run

```sh
export PATH=/path/to/valgrind-dir:$PATH     # if valgrind isn't already on it
python3 bench/count.py                                       # every workload
python3 bench/count.py ts-request-16 wasm-request-16 ts-name-hash wasm-name-hash --compare
```

`--compare` adds a markdown table of each `ts-X` against `wasm-X`: TS, core,
delta (core minus TS) and the delta as a % of TS. `-K`, `-W`, `--repeat` and
`-j` set the measured and warm-up iterations, the repeats and the parallel
runs.

## Caveats

- Node runs with `--predictable --no-opt`, so the counts are repeatable but
  there is no optimizing tier: they compare interpreter- and baseline-tier JS
  (and the wasm module's own baseline compile) against wasm. A warmed-up
  TurboFan build of the TypeScript would be faster than these show.
- The spread across the 5 runs is small but not zero: up to about 0.6% in the
  spike, and 1.3% on one workload in the last check. The median is the number
  to quote; differences below a couple of percent are noise.
- Counts are instructions, not time: they ignore cache behaviour, wasm-to-JS
  call overhead in wall time, and the cost of the first call.
- It is for PR evidence, not a CI gate.
