#!/usr/bin/env bash
# Vendors the runtime wire conformance corpus (features.json, profiles/ and vectors/)
# from ComlineProject/runtime into test/conformance/, at a pinned commit.
#
#   scripts/vendor-conformance.sh <rev>   # vendor <rev> and pin it in VECTORS_REV
#   scripts/vendor-conformance.sh --check # fail if the copy differs from VECTORS_REV's
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/test/conformance"
repo="https://github.com/ComlineProject/runtime"

if [[ "${1:-}" == "--check" ]]; then
  rev="$(cat "$dest/VECTORS_REV")"
else
  rev="${1:?usage: vendor-conformance.sh <rev> | --check}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --filter=blob:none --no-checkout "$repo" "$tmp/runtime"
git -C "$tmp/runtime" checkout --quiet "$rev" -- runtime/conformance
corpus="$tmp/runtime/runtime/conformance"

if [[ "${1:-}" == "--check" ]]; then
  if diff -r "$corpus/vectors" "$dest/vectors" && diff -r "$corpus/profiles" "$dest/profiles" && diff "$corpus/features.json" "$dest/features.json"; then
    echo "test/conformance matches $repo@$rev"
  else
    echo "test/conformance differs from $repo@$rev: re-vendor with scripts/vendor-conformance.sh <rev>" >&2
    exit 1
  fi
  exit 0
fi

rm -rf "$dest/vectors" "$dest/profiles"
cp -r "$corpus/vectors" "$dest/vectors"
cp -r "$corpus/profiles" "$dest/profiles"
cp "$corpus/features.json" "$dest/features.json"
git -C "$tmp/runtime" rev-parse "$rev" > "$dest/VECTORS_REV"
echo "vendored $repo@$(cat "$dest/VECTORS_REV")"
echo "Now: CONFORMANCE_BLESS=1 npm test, and review conformance-report.json"
