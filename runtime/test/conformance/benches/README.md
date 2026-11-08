# Benchmark definitions

The work every runtime's benchmarks measure, so the numbers compare across
languages. Vendor this directory with the vectors; it uses the vectors' own
value and type encoding (see [the corpus README](../README.md)). It's whole on
its own: [`bench.schema.json`](bench.schema.json), which each file names in
`$schema`, is generated here from [the specs](../specs/bench.cue).

The Rust benches ([`runtime/core/benches`](../../core/benches)) are the
reference: where this README and they disagree, it's a bug in one of them.
Each section says what's inside the measured region; anything it doesn't name
(building the inputs, allocating the output buffer, I/O) is outside.

| File | Benchmarks |
| --- | --- |
| [`formats.json`](formats.json) | encode and decode, per format, per shape |
| [`framings.json`](framings.json) | framing encode and decode, per framing, per payload size |
| [`handshake.json`](handshake.json) | the handshake frame: encode, decode, check |
| [`comline2.json`](comline2.json) | the `comline@2` hello: encode, decode, answer |
| [`connection.json`](connection.json) | one connection step: issue a call, receive its reply |

## `formats.json`

- `formats`: the formats each shape is measured in.
- `shapes`: each has an `id`, a `description`, a `type` (as a `decode` case
  states it) and a `value` of that type (as an `encode` case states it, or
  generated).

A generated value is an array, written by the rule that makes it, so a large
shape stays readable. Expand it when loading the definitions:

```json
{"generate": {"count": 3, "item": {"u16": {"start": 0, "step": 40000, "modulo": 65536}}}}
```

is `{"array": [{"u16": 0}, {"u16": 40000}, {"u16": 14464}]}`. Item `i` is `item`
with each sequence replaced by `start + step * i`, then taken Euclidean modulo
`modulo` if it has one. Only integers narrower than 64 bits, which a value
holds as JSON numbers, can be sequences, and a number that doesn't fit its
type is an error.

| `id` | What it stresses |
| --- | --- |
| `small-scalar` | five fixed-width scalars: per-message overhead |
| `string-heavy` | strings, with non-ASCII text, a quote and a newline to escape |
| `nested` | structs three deep, options present and absent |
| `large-array` | 1000 small structs |
| `enum-heavy` | unit-variant enums, alone, optional and in lists |

**Encode** a value of the shape, as a generated type holds it, into bytes.
**Decode** those bytes back into the generated type. Build the value and the
bytes outside the measurement, and measure the code that generated types run:
in Rust that's a `serde` derive, not the corpus's `Value`.

## `framings.json`

The measured frame is an `ok` response to request `request_id` (`42`). Its
payload, already encoded, is `size` bytes for each of `payload_sizes`: a JSON
string, `"`, then `size - 2` copies of `payload_fill` (`a`), then `"`, so it's
valid JSON for `jsonrpc@1` too.

`protocol` (`1`) is the frame's protocol number in the framings whose reply
carries one, `datagram@2` and `datagram@3`. `datagram@1` and `jsonrpc@1` have
no protocol number in a reply, and ignore it.

**Encode** frames the payload. **Decode** parses the frame back into its
request id and envelope, the payload left as the bytes it was written as:
decoding those into values is a format's work, which `formats.json` measures.
For `jsonrpc@1` that means the envelope is parsed (`jsonrpc`, `id`, and which
of `result` and `error` it has), and `result` is only checked to be one
well-formed JSON value and handed on as its text, not parsed into values. In
Rust that's `serde_json`'s `RawValue`.

## `handshake.json`

`frame` is a handshake frame, with names unhashed as in a `handshake` case.
**Encode** writes it, **decode** reads its bytes back, and **check** compares
it with an identical frame from the peer.

## `comline2.json`

`hello` is a `comline@2` hello, as a `comline2_message` case states one: an
`offer`, canonical. **Encode** writes it as a message, **decode** reads the
message back, and **answer** is the responder's negotiation step, with default
parameters and this same hello as its own, reading the peer's: it accepts.

## `connection.json`

One step on a fresh connection state: frame a call to `call` on `protocol`
with the `params` shape's value as its params, in `framing` and `format`,
waiting on a reply; then receive the `reply` to it (an `ok`, with the hex
`payload`). Both halves are measured together.

Inside the measured region, in order:

1. Encoding the params: the `params` shape's value, as a generated type
   holds it, into `format`'s bytes (the work `format/encode/<params>/<format>`
   measures on its own).
2. Framing the call: taking the next request id and recording the call as
   waiting on it, then writing the request frame into an output buffer that
   already has room for it.
3. Receiving the reply: decoding the reply frame, already in memory, into its
   request id and envelope, matching it to the waiting call and taking that
   call off the waiting set. The reply's payload is left as bytes, not
   decoded.

Outside it: building the params value and the reply frame, sending or
receiving through a transport, and any handoff to the code that waits on the
reply (a promise, a future's waker, a callback). The step is the connection's
own work, sans I/O. In Rust that's `connection::State::encode_request` then
`State::receive`. A runtime whose connection is reachable only through a
transport measures this same work the closest way it can, and says in its
results what its number includes beyond it.

## Benchmark ids

Results name each benchmark by an id built from the definitions:

| Benchmark | Id |
| --- | --- |
| format | `format/<encode\|decode>/<shape>/<format>`, e.g. `format/decode/nested/packed@1` |
| framing | `framing/<encode\|decode>/<framing>/<size>`, e.g. `framing/encode/jsonrpc@1/4096` |
| handshake | `handshake/<encode\|decode\|check>` |
| `comline@2` | `comline2/<encode\|decode\|answer>` |
| connection | `connection/step` |

## Results: `reports/<lang>.bench.json`

```json
{
  "runtime": "rust",
  "commit": "<the measured commit>",
  "toolchain": "rustc 1.100.0-nightly (787af2b8c 2026-08-25)",
  "metric": "instructions",
  "benches": {
    "format/encode/small-scalar/packed@1": { "ir": 123 }
  }
}
```

- `metric` says what the numbers count. Rust counts instructions (`ir`, with
  Callgrind), which only compare against the same runtime on another commit.
- `benches` has one entry per id above. Rust's also has its own targets'
  benchmarks, under ids that start with the target's name, which no other
  runtime has: the C ABI's (`runtime/ffi/bench`), `ffi/abi/<call>` through
  each `extern "C"` function and `ffi/core/<call>` for the same work on the
  core directly, where `<call>` is
  `<feed|encode-request|encode-reply>/<framing>/<message|stream>/<size>`
  (sizes as `framings.json`'s) or `name-hash`, `handshake-encode`,
  `handshake-check`. A reader that knows only the ids above can skip them.

Rust's CI writes it as an artifact on every pull request. On every push to
`main` it benches the new head and commits the report to the
[`reports`](https://github.com/ComlineProject/runtime/tree/reports) branch,
where the docs read it:
`https://raw.githubusercontent.com/ComlineProject/runtime/reports/rust.bench.json`.
`commit` is the `main` commit it measured. See
[`runtime/core/benches`](../../core/benches) for how the Rust benches run.
