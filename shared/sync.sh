#!/bin/sh
# Copies shared/js/*.js into the mods that use them (mods can't import outside their own
# folder), as <mod>/shared/<file>, each marked generated. Edit shared/js, then run this.
# Also mirrors whole mods that another mod mounts as a nested view (MIRRORS below).
#   shared/sync.sh          write the copies
#   shared/sync.sh --check  exit 1 if any copy is out of date (the pre-commit hook runs this)
set -eu
cd "$(dirname "$0")/.."

MANIFEST="
workflows      look.js media-kinds.js viewer-link.js
claude-reader  look.js media-kinds.js viewer-link.js claude-model.js claude-rows.js claude-chat.js rich.js
claude-picker  claude-state.js
my-pane        claude-state.js
hq             look.js media-kinds.js viewer-link.js claude-model.js claude-rows.js claude-chat.js rich.js proxy-ui.js proxy-views.js
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

# Mods mounted inside another mod with cx.new: every .js of <source>, as <target>/<same path>,
# each marked generated. A changed mirror is built aside and swapped in with one rename, so
# the mod that hosts it reloads once, not once per file.
#   workflows -> hq/wf: HQ's Workflows section embeds the Workflows view (host in util.js).
MIRRORS="
workflows  hq/wf
"

mirror() {  # mirror <source mod> <target dir> <out dir>
  (cd "mods/$1" && find . -name '*.js' ! -path '*/node_modules/*' | sort) | while read -r f; do
    f=${f#./}
    mkdir -p "$3/$(dirname "$f")"
    { printf '// Generated from mods/%s/%s by shared/sync.sh: edit it there.\n\n' "$1" "$f"; cat "mods/$1/$f"; } > "$3/$f"
  done
}

echo "$MIRRORS" | while read -r src dest; do
  [ -n "$src" ] || continue
  tmp="mods/.$(echo "$dest" | tr / -).sync"
  rm -rf "$tmp"
  mirror "$src" "mods/$dest" "$tmp"
  if diff -r -x '*.d.ts' -x jsconfig.json "$tmp" "mods/$dest" >/dev/null 2>&1; then
    rm -rf "$tmp"
    continue
  fi
  if [ "${1:-}" = "--check" ]; then rm -rf "$tmp"; echo "out of date: mods/$dest (mirror of mods/$src)"; exit 1; fi
  if [ -d "mods/$dest" ]; then mv "mods/$dest" "$tmp.old"; fi
  mv "$tmp" "mods/$dest"
  rm -rf "$tmp.old"
  echo "wrote mods/$dest (mirror of mods/$src)"
done
