#!/usr/bin/env bash
# Install the solana-upgrade-safety skill into a project's agent config.
# Usage: bash install.sh [TARGET_DIR] [--agents]
#   TARGET_DIR  project root to install into (default: current directory)
#   --agents    install into .agents/ instead of .claude/ (Cursor/Windsurf/etc.)
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="."
DIRNAME=".claude"
for arg in "$@"; do
  case "$arg" in
    --agents) DIRNAME=".agents" ;;
    -*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) TARGET="$arg" ;;
  esac
done

DEST="$TARGET/$DIRNAME"
SKILL_DEST="$DEST/skills/solana-upgrade-safety"
CMD_DEST="$DEST/commands"

# Clean sync of the skill dir so files removed upstream don't linger on re-run.
rm -rf "$SKILL_DEST"
mkdir -p "$SKILL_DEST/scripts" "$SKILL_DEST/examples" "$SKILL_DEST/tests/fixtures" "$CMD_DEST"
cp -R "$SRC_DIR/skill/." "$SKILL_DEST/"
# Copy the tool sources + tests — never node_modules / lockfile / scratch files
# (the user runs `npm install` in the destination, see Next steps below).
cp "$SRC_DIR/scripts/layout-diff.ts" "$SRC_DIR/scripts/test.ts" \
   "$SRC_DIR/scripts/integration.test.ts" "$SRC_DIR/scripts/package.json" "$SKILL_DEST/scripts/"
cp "$SRC_DIR"/examples/*.idl.json "$SKILL_DEST/examples/"
cp "$SRC_DIR"/tests/fixtures/*.idl.json "$SKILL_DEST/tests/fixtures/"
cp "$SRC_DIR/commands/check-upgrade.md" "$CMD_DEST/check-upgrade.md"

echo "✓ installed solana-upgrade-safety into $SKILL_DEST"
echo "✓ installed /check-upgrade into $CMD_DEST"
echo
echo "Next:"
echo "  1) cd $SKILL_DEST/scripts && npm install   # installs tsx for the differ"
echo "  2) Add this route to your kit's $DIRNAME/skills/SKILL.md hub:"
echo
echo "     - **Upgrading a live program?** Before any redeploy that changes an"
echo "       account struct, load skills/solana-upgrade-safety/SKILL.md and run"
echo "       /check-upgrade. Catches account-layout breaks before they brick state."
