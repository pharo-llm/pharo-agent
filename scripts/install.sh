#!/bin/sh
set -eu

REPO_URL="${PHARO_AGENT_REPO_URL:-https://github.com/pharo-llm/pharo-agent/archive/refs/heads/main.tar.gz}"
PREFIX="${PHARO_AGENT_PREFIX:-$HOME/.local}"
APP_HOME="${PHARO_AGENT_HOME:-$HOME/.local/share/pharo-agent}"
BIN_DIR="${PHARO_AGENT_BIN_DIR:-$PREFIX/bin}"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "pharo-agent: Node.js 22.6.0 or newer is required" >&2
  exit 1
fi

"$NODE_BIN" -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 6)) { console.error('pharo-agent: Node.js 22.6.0 or newer is required'); process.exit(1); }"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

ARCHIVE="$TMP_DIR/pharo-agent.tar.gz"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$REPO_URL" -o "$ARCHIVE"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$ARCHIVE" "$REPO_URL"
else
  echo "pharo-agent: curl or wget is required" >&2
  exit 1
fi

mkdir -p "$APP_HOME" "$BIN_DIR"
tar -xzf "$ARCHIVE" -C "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

rm -rf "$APP_HOME"
mkdir -p "$APP_HOME"
cp -R "$SRC_DIR"/. "$APP_HOME"/

WRAPPER="$BIN_DIR/pharo-agent"
cat > "$WRAPPER" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$APP_HOME/pharo-agent/cli.ts" "\$@"
EOF
chmod +x "$WRAPPER"

echo "pharo-agent installed to $WRAPPER"

# Put the bin directory on PATH for new shells, so nothing has to be exported
# by hand. Set PHARO_AGENT_NO_MODIFY_PATH=1 to skip.
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    if [ -z "${PHARO_AGENT_NO_MODIFY_PATH:-}" ]; then
      case "${SHELL:-}" in
        */zsh) RC="$HOME/.zshrc" ;;
        */bash) if [ "$(uname -s)" = "Darwin" ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
        *) RC="$HOME/.profile" ;;
      esac
      LINE="export PATH=\"$BIN_DIR:\$PATH\"  # pharo-agent"
      if ! grep -qs "# pharo-agent" "$RC"; then
        printf '\n%s\n' "$LINE" >> "$RC"
        echo "Added $BIN_DIR to PATH in $RC (new terminals will have it)."
      fi
    else
      echo "Add $BIN_DIR to PATH to run pharo-agent from any terminal."
    fi
    ;;
esac

# First-run setup right away when there is a terminal to ask in. With
# curl | sh, stdin is the script itself, so read answers from /dev/tty.
if [ -z "${PHARO_AGENT_NO_SETUP:-}" ] && [ -z "${CI:-}" ] && (exec </dev/tty) 2>/dev/null; then
  echo ""
  "$WRAPPER" setup </dev/tty || true
  echo "Run pharo-agent to start (in a new terminal if PATH was just updated)."
else
  echo "Run: pharo-agent    (first run asks a few setup questions)"
fi
