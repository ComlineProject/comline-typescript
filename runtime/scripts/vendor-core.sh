#!/usr/bin/env bash
# Vendors the Comline core (the wasm32 build of `comline-runtime-ffi` and its
# JS glue) from ComlineProject/runtime into core/, at a pinned commit.
#
#   scripts/vendor-core.sh <rev>   # build <rev>, vendor it, pin it in CORE_REV
#   scripts/vendor-core.sh --check # rebuild CORE_REV, fail unless every byte matches
#
# The build is reproducible: the runtime's own pinned toolchain
# (rust-toolchain.toml) and its committed Cargo.lock (`--locked`),
# `--profile wasm`, every local path
# remapped and a fixed SOURCE_DATE_EPOCH, so `--check` can rebuild from source
# and compare bytes rather than trust a committed binary.
#
# CORE_REV and test/conformance/VECTORS_REV move together: the core is proven
# by the vectors of the same commit. Re-vendor both at the same rev
# (scripts/vendor-conformance.sh <rev> first).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/core"
repo="https://github.com/ComlineProject/runtime"
vectors_rev="$(cat "$here/test/conformance/VECTORS_REV")"
files=(comline_runtime_ffi.wasm comline.mjs comline.d.mts)

if [[ "${1:-}" == "--check" ]]; then
  rev="$(cat "$dest/CORE_REV")"
else
  rev="${1:?usage: vendor-core.sh <rev> | --check}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet "$repo" "$tmp/runtime"
git -C "$tmp/runtime" checkout --quiet --detach "$rev"
rev="$(git -C "$tmp/runtime" rev-parse HEAD)"

if [[ "$rev" != "$vectors_rev" ]]; then
  echo "core rev $rev differs from VECTORS_REV $vectors_rev: they move together;" >&2
  echo "run scripts/vendor-conformance.sh $rev first" >&2
  exit 1
fi

# Everything runs inside the clone, so rustup picks its rust-toolchain.toml.
cd "$tmp/runtime"

# The dependency versions are the runtime's own: its committed Cargo.lock,
# built `--locked`. A revision without one can't be vendored, since a new
# crates.io release would then change the bytes under an unchanged CORE_REV.
if [[ ! -f Cargo.lock ]]; then
  echo "$repo@$rev has no committed Cargo.lock: the core can only be vendored" >&2
  echo "at a runtime revision that commits its lock (cc31f21 or later)" >&2
  exit 1
fi
rustup toolchain install --profile minimal >/dev/null 2>&1 || rustup toolchain install
toolchain="$(rustup show active-toolchain | cut -d' ' -f1)"
rustup target add --toolchain "$toolchain" wasm32-unknown-unknown >/dev/null
sysroot="$(rustc --print sysroot)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"

export SOURCE_DATE_EPOCH=0
export CARGO_TARGET_DIR="$tmp/target"
export CARGO_INCREMENTAL=0
# RUSTFLAGS replaces any rustflags from the environment's cargo config, so
# nothing outside the clone shapes the build. The clone and target dir are
# both under $tmp, whose name differs on every run.
export RUSTFLAGS="--remap-path-prefix=$tmp=/build --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$rustup_home=/rustup --remap-path-prefix=$sysroot=/rust"
unset CARGO_BUILD_RUSTFLAGS CARGO_ENCODED_RUSTFLAGS RUSTC_WRAPPER CARGO_BUILD_RUSTC_WRAPPER
cargo build --quiet --locked -p comline-runtime-ffi --profile wasm --target wasm32-unknown-unknown

out="$tmp/out"
mkdir "$out"
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/wasm/comline_runtime_ffi.wasm" "$out/"
cp runtime/ffi/js/comline.mjs runtime/ffi/js/comline.d.mts "$out/"
echo "$rev" > "$out/CORE_REV"
chmod 644 "$out"/*
(cd "$out" && sha256sum "${files[@]}" > SHA256SUMS)

if [[ "${1:-}" == "--check" ]]; then
  status=0
  for f in "${files[@]}" CORE_REV SHA256SUMS; do
    cmp -s "$out/$f" "$dest/$f" || { echo "core/$f differs from the build of $repo@$rev" >&2; status=1; }
  done
  if [[ $status != 0 ]]; then
    echo "re-vendor with scripts/vendor-core.sh <rev>" >&2
    exit 1
  fi
  echo "core/ matches $repo@$rev, rebuilt with $toolchain"
  exit 0
fi

rm -rf "$dest"
mkdir -p "$dest"
cp "$out"/* "$dest/"
echo "vendored $repo@$rev, built with $toolchain"
cat "$dest/SHA256SUMS"
