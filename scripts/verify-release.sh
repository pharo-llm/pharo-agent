#!/bin/sh
set -eu

cleanup() {
  rm -rf .npm-cache .tmp-state
}
trap cleanup EXIT INT TERM

node pharo-agent/cli.ts version
npm test
npm run smoke
npm run pack:dry-run >/dev/null
sh -n install.sh scripts/install.sh scripts/verify-release.sh
echo "release verification passed"
