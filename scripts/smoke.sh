#!/bin/sh
# Quick end-to-end check of the CLI without a model server or a Pharo image.
set -eu
cd "$(dirname "$0")/.."
printf '/exit\n' | XDG_STATE_HOME=./.tmp-state node pharo-agent/cli.ts >/dev/null
node pharo-agent/cli.ts help >/dev/null
node pharo-agent/cli.ts tools >/dev/null
node pharo-agent/cli.ts model serve --hf Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf --print-command
echo "smoke test passed"
