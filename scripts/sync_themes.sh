#!/usr/bin/env bash
# Copies JobHuntPA's themes and fonts into the extension: css/themes.css from the app's frontend/themes.css (only the
# font paths change, fonts/ -> ../fonts/) and fonts/ from frontend/fonts/. Run it after the app's themes change:
#   scripts/sync_themes.sh /path/to/JobHuntPA
set -euo pipefail
cd "$(dirname "$0")/.."
APP="${1:-../JobHuntPA}"
SRC="$APP/frontend/themes.css"
[ -f "$SRC" ] || { echo "Not the app's folder: $APP (no frontend/themes.css)" >&2; exit 1; }
mkdir -p fonts
cp "$APP"/frontend/fonts/* fonts/
{
  cat <<'EOF'
/* A copy of JobHuntPA's frontend/themes.css (the app's themes, one block per theme), with only the font paths changed
   (fonts/ -> ../fonts/: the same Ubuntu Sans files, shipped here under the same licence, see THIRD-PARTY.md). Keep it
   in step with the app's file: scripts/sync_themes.sh copies it over. The popup and options page paint the theme
   chosen for the account (lib/theme.js). */
EOF
  sed 's#url("fonts/#url("../fonts/#g' "$SRC"
} > css/themes.css
echo "Copied $SRC to css/themes.css and $(ls fonts | wc -l | tr -d ' ') font files to fonts/"
