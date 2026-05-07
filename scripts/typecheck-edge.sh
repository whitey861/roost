#!/usr/bin/env bash
# Roost: type-check every Edge Function entry point with Deno.
# Skips _shared/ (it's a library, not a function entry point).

set -euo pipefail

if ! command -v deno &> /dev/null; then
  echo "ERROR: deno is not installed. Install from https://deno.land/"
  exit 1
fi

# Materialise npm dependencies in node_modules so Deno can resolve npm:
# specifiers without re-fetching from the registry on every check.
if [[ ! -d node_modules ]]; then
  echo "Installing npm dependencies (node_modules) for Deno to consume..."
  npm ci
fi

FAILED=0

for fn_dir in supabase/functions/*/; do
  fn_name=$(basename "$fn_dir")

  if [[ "$fn_name" == _* ]]; then
    continue
  fi

  if [[ -f "$fn_dir/index.ts" ]]; then
    echo "Checking $fn_name..."
    if ! deno check "$fn_dir/index.ts"; then
      FAILED=1
      echo "  FAILED: $fn_name"
    fi
  fi
done

if [[ $FAILED -eq 1 ]]; then
  echo ""
  echo "One or more Edge Functions failed type-check."
  exit 1
fi

echo ""
echo "All Edge Functions type-check cleanly."
