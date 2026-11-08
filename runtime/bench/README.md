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
`wasm-request-<bytes>-into` is the wasm request encoding into one reused
array (`encodeRequestInto`) rather than a new one per frame; `--compare`
pairs it with `ts-request-<bytes>`, whose encode is unchanged.
`binding-handshake` is the handshake as `ComlineHandshake` runs it, through
the runtime's binding (`src/core/core.ts`) over the vendored `core/`.
`ts-duplex-send-<bytes>` is one frame through `duplex()`: `send`, then the
peer's `recv`, with its promises run to completion inside the iteration (a
forced microtask checkpoint, `%PerformMicrotaskCheckpoint`).
`ts-duplex-send-<bytes>-nocopy` queues the caller's array instead of a copy:
the difference is what the `Transport` contract's copy costs (`send` gives the
frame back when it resolves, so an in-memory transport has to copy it).
`ts-roundtrip-<bytes>` and `wasm-roundtrip-<bytes>` are one call and its reply
through two `Connection`s over `duplex()` (`datagram@2`; params and result both
<bytes> long), with the framing and state in TypeScript or on the core.
`-jsonrpc-roundtrip-<bytes>` is the same over `JsonRpcConnectionFraming`, the
params and result a JSON string <bytes> long.

## Shared benchmarks

`bench/shared.mjs` runs the benchmarks every runtime measures, from the
definitions vendored in `test/conformance/benches/` (ComlineProject/runtime's
`runtime/conformance/benches/`, pinned by `VECTORS_REV`), under their ids:
`format/<encode|decode>/<shape>/<format>`,
`framing/<encode|decode>/<framing>/<size>`, `handshake/<encode|decode|check>`
and `connection/step`. Each measures what generated code runs (a codec with
the shape's `Layout`, a framing, `HandshakeFrame`), with values and bytes
built outside the iteration, and follows the definitions' README on what's
inside the measured region. `connection/step` is the connection's own work,
sans I/O, as Rust measures it: the params encoded, the call framed and
recorded as waiting, the reply frame decoded and matched to it. No transport
and no promise handoff, which the definition leaves out; the TypeScript
runtime has no sans-I/O connection state, so the workload runs
`Connection`'s TypeScript path step for step (codec, `Datagram2Framing`, the
waiting map). Beyond the definition, its framing writes a new array per frame
where Rust's writes into a reused buffer. `framing/decode/jsonrpc@1/*` runs
`JsonRpcFraming.decodeResponse`, which parses the whole frame into a JSON
tree, `result` included, where the definition (and Rust) only checks
`result` is well formed and passes on its text: that extra work is the
runtime's, and shows in its number. Left out: `msgpack@1` (not shipped) and
`comline2/*` (the `comline@2` hello runs on the wasm core).
`node bench/shared.mjs` lists the ids, each with its measured and warm-up
iterations for each tier (fewer for the heaviest; a long warm-up with the
optimizing tier on, so TurboFan has compiled the work before the region).
`count.py --shared --json FILE` counts them all in both tiers and writes the
report CI publishes (`.github/workflows/bench.yml`), in the Observatory's
bench format 2:

```json
{"format": 2, "runtime": "typescript", "commit": "<sha>", "toolchain": "node v22.x.y",
 "benches": {"format/encode/nested/packed@1": {
   "instructions":     {"value": 12345, "spread": 0.002},
   "instructions-opt": {"value": 2345,  "spread": 0.004}}}}
```

`instructions` is with `--no-opt` (interpreter and baseline tiers, very
repeatable); `instructions-opt` with the optimizing tier on, after the
warm-up: the one to set beside Rust's counts (the Observatory's ratio to Rust
uses it). `value` is the median instructions per iteration of 5 runs (the
loop's own few included), `spread` their (max - min) / median. No `runner`:
instruction counts don't depend on the machine.

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
  TurboFan build of the TypeScript would be faster than these show. `--opt`
  drops `--no-opt` so the optimizing tier runs; give it the warm-up to get
  there (`-W 20000` is enough for these workloads: check with
  `node --trace-opt`).
- The spread across the 5 runs is small but not zero: up to about 0.6% in the
  spike, and 1.3% on one workload in the last check. The median is the number
  to quote; differences below a couple of percent are noise.
- Counts are instructions, not time: they ignore cache behaviour, wasm-to-JS
  call overhead in wall time, and the cost of the first call.
- It is for PR evidence, not a CI gate.
