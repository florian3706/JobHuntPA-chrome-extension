#!/usr/bin/env bash
# Builds dist/jobhuntpa-<browser>-<version>.zip containing only the extension files (no tests, no scripts).
set -euo pipefail
cd "$(dirname "$0")/.."
BROWSER="chrome"
grep -q '"gecko"' manifest.json && BROWSER="firefox"
VERSION=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
OUT="dist/jobhuntpa-${BROWSER}-${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
FILES=(manifest.json background.js lib popup options css icons)
if command -v zip >/dev/null 2>&1; then
  zip -X -r -q "$OUT" "${FILES[@]}" -x '*.DS_Store'
else
  python3 - "$OUT" "${FILES[@]}" <<'PY'
import os, sys, zipfile
out, *items = sys.argv[1:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for item in items:
        paths = [item] if os.path.isfile(item) else [os.path.join(d, f) for d, _, fs in os.walk(item) for f in sorted(fs)]
        for p in paths:
            if not p.endswith(".DS_Store"):
                z.write(p, p)
PY
fi
echo "Wrote $OUT"
unzip -l "$OUT" 2>/dev/null | tail -n +4 || true
