#!/usr/bin/env bash
# Vendors the Comline specification's conformance corpus (features.json,
# profiles/, vectors/, the shared benchmark definitions in benches/, and
# VERSION) from ComlineProject/specification into test/conformance/, at a
# pinned commit.
#
#   scripts/vendor-conformance.sh <rev>   # vendor <rev> and pin it in SPEC_REV
#   scripts/vendor-conformance.sh --check # fail if the copy differs from SPEC_REV's
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/test/conformance"
repo="https://github.com/ComlineProject/specification"

if [[ "${1:-}" == "--check" ]]; then
  rev="$(cat "$dest/SPEC_REV")"
else
  rev="${1:?usage: vendor-conformance.sh <rev> | --check}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --no-checkout "$repo" "$tmp/specification"
git -C "$tmp/specification" checkout --quiet "$rev" -- vectors profiles benches features.json VERSION
corpus="$tmp/specification"

if [[ "${1:-}" == "--check" ]]; then
  if diff -r "$corpus/vectors" "$dest/vectors" && diff -r "$corpus/profiles" "$dest/profiles" && diff -r "$corpus/benches" "$dest/benches" && diff "$corpus/features.json" "$dest/features.json" && diff "$corpus/VERSION" "$dest/VERSION"; then
    echo "test/conformance matches $repo@$rev"
  else
    echo "test/conformance differs from $repo@$rev: re-vendor with scripts/vendor-conformance.sh <rev>" >&2
    exit 1
  fi
  exit 0
fi

rm -rf "$dest/vectors" "$dest/profiles" "$dest/benches"
cp -r "$corpus/vectors" "$dest/vectors"
cp -r "$corpus/profiles" "$dest/profiles"
cp -r "$corpus/benches" "$dest/benches"
cp "$corpus/features.json" "$dest/features.json"
cp "$corpus/VERSION" "$dest/VERSION"
git -C "$tmp/specification" rev-parse "$rev^{commit}" > "$dest/SPEC_REV"
echo "vendored $repo@$(cat "$dest/SPEC_REV")"
echo "Now: CONFORMANCE_BLESS=1 npm test, and review conformance-report.json"
