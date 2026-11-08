#!/bin/sh
# Copies shared/js/*.js into the mods that use them (mods can't import outside their own
# folder), as <mod>/shared/<file>, each marked generated. Edit shared/js, then run this.
#   shared/sync.sh          write the copies
#   shared/sync.sh --check  exit 1 if any copy is out of date (the pre-commit hook runs this)
set -eu
cd "$(dirname "$0")/.."

MANIFEST="
workflows      look.js media-kinds.js viewer-link.js
claude-reader  look.js media-kinds.js viewer-link.js claude-model.js claude-rows.js claude-chat.js
claude-picker  claude-state.js
my-pane        claude-state.js
hq             look.js media-kinds.js viewer-link.js claude-model.js claude-rows.js claude-chat.js proxy-ui.js proxy-views.js
proxy          look.js proxy-ui.js proxy-views.js
"

stale=0
echo "$MANIFEST" | while read -r mod files; do
  [ -n "$mod" ] || continue
  mkdir -p "mods/$mod/shared"
  for f in $files; do
    want=$(printf '// Generated from shared/js/%s by shared/sync.sh: edit it there.\n\n' "$f"; cat "shared/js/$f")
    have=$(cat "mods/$mod/shared/$f" 2>/dev/null || true)
    if [ "$want" != "$have" ]; then
      if [ "${1:-}" = "--check" ]; then echo "out of date: mods/$mod/shared/$f"; exit 1
      else printf '%s\n' "$want" > "mods/$mod/shared/$f"; echo "wrote mods/$mod/shared/$f"; fi
    fi
  done
done
