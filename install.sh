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
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to PATH to run pharo-agent from any terminal." ;;
esac
echo "Run: pharo-agent doctor"
