# Pharo Agent

TypeScript local coding agent for Pharo images and terminal workflows.

It gives developers a single `pharo-agent` CLI with a real local agent loop:

- OpenAI-compatible local model API support, including `llama.cpp`;
- GGUF model discovery, download, switching, serving, and publishing for Hugging Face;
- file read/write/edit/delete tools;
- workspace glob and grep tools;
- shell command execution with read-only detection and permission modes;
- Pharo image inspection, Smalltalk evaluation, `.st` script execution, and SUnit test runs;
- durable project memory;
- workspace task tracking;
- session recording/resume;
- stdio MCP tool listing/calling;
- subagent execution through the same local tool loop;
- optional web fetch/search tools for current external context.

## Install

From a hosted copy of this repository:

```sh
curl -fsSL https://raw.githubusercontent.com/pharo-llm/pharo-agent/main/install.sh | sh
```

The installer requires Node.js 22.6.0 or newer and has no npm dependency install step. It copies the CLI to
`~/.local/share/pharo-agent` and writes `~/.local/bin/pharo-agent`.

For local development from this checkout:

```sh
node pharo-agent/cli.ts
```

Running `pharo-agent` with no arguments opens the interactive terminal agent.

## Configure

```sh
pharo-agent setup --online
pharo-agent status --online
```

Manual configuration is also available:

```sh
pharo-agent configure --pharo-vm /path/to/pharo --image /path/to/Pharo.image
pharo-agent doctor
```

You can also use environment variables:

```sh
export PHARO_VM=/path/to/pharo
export PHARO_IMAGE=/path/to/Pharo.image
```

Project-local configuration is supported:

```sh
pharo-agent setup --local
pharo-agent configure --local --image ./Pharo.image
```

Model-driven file tools stay inside the current workspace by default, and the
web fetch tool blocks localhost/private-network targets unless explicitly
enabled. See [docs/SECURITY.md](docs/SECURITY.md).

## Use Pharo From The Terminal

Evaluate Smalltalk:

```sh
pharo-agent eval "Transcript show: Smalltalk version; cr"
```

Run a script:

```sh
pharo-agent st scripts/load.st
```

Run tests:

```sh
pharo-agent test --package MyPackage
pharo-agent test --class MyTestCase
pharo-agent test --class MyTestCase --selector testSomething
```

List the tools exposed to the model:

```sh
pharo-agent tools
```

Use task and memory state:

```sh
pharo-agent tasks add "Fix failing SUnit tests"
pharo-agent tasks list
pharo-agent memory write "This project loads packages through BaselineOfMyProject."
pharo-agent memory read
```

## Interactive Agent

The main product experience is the terminal chat:

```sh
pharo-agent
```

Inside the session, users ask normal questions:

```text
pharo-agent:1> inspect my image and tell me what tests exist
pharo-agent:2> run the package tests and summarize the failures
```

Useful in-session commands:

```text
/help
/status --online
/model
/model use qwen-coder-7b
/model download qwen-coder-7b --use
/model serve qwen-coder-7b
/tools
/resume <session-id>
/paste
/exit
```

One-shot mode is still available:

```sh
pharo-agent ask "Inspect this image and run the tests."
```

## Models

The default Hugging Face download model is Qwen2.5-Coder 7B Instruct GGUF:

```text
name: qwen-coder-7b
Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf
qwen2.5-coder-7b-instruct-q4_0-00002-of-00002.gguf
```

Users normally choose models by friendly name:

```sh
pharo-agent model
pharo-agent model use qwen-coder-7b
pharo-agent model download qwen-coder-7b --use
pharo-agent model serve qwen-coder-7b
```

Future predefined names can be added in `~/.config/pharo-agent/models.json` or
project-local `.pharo-agent.models.json`. Official shipped presets live in
`pharo-agent/model-presets.json`.

List available GGUF files:

```sh
pharo-agent model files qwen-coder-7b
```

Download the default split Q4_0 GGUF. This downloads both shard files and
configures shard 1 as the model path for `llama.cpp`:

```sh
pharo-agent model download --dry-run
pharo-agent model download --use
```

Download all GGUF files from the configured repo:

```sh
pharo-agent model download --all
```

Use a specific repo, filename, or quantization:

```sh
pharo-agent model download Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf --use
pharo-agent model use Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf
```

Start a local `llama.cpp` server:

```sh
pharo-agent model serve
```

The CLI speaks to `http://127.0.0.1:8080/v1` by default.

## Agent Loop

Once a local model server is running:

```sh
pharo-agent ask "Find the failing tests in this Pharo image and explain the fix."
```

If a downloaded GGUF is configured and `llama-server` is installed, the CLI can
start the model server for the current request:

```sh
pharo-agent ask --start-server "Run the package tests and summarize failures."
```

The agent loop uses a simple JSON tool protocol that works with local GGUF
models even when native function calling is unavailable. If a model server
supports native `tool_calls`, Pharo Agent consumes those too.

The loop is implemented in TypeScript in `pharo-agent/agent.ts` and executes
tools from `pharo-agent/tools.ts`.

## Hugging Face Publishing

The built-in publish target for your hosted copy is:

```text
https://huggingface.co/pharo-llm/pharo-agent
```

Recommended GGUF naming if you mirror or fine-tune the model:

```text
qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf
qwen2.5-coder-7b-instruct-q4_0-00002-of-00002.gguf
```

After upload, users can run `pharo-agent model list` and switch to any available
GGUF without changing the CLI.

The repository also includes a manual `Upload GGUF Model` GitHub Actions
workflow. Add an `HF_TOKEN` secret, provide a `.gguf` download URL, and the
workflow uploads it to the target Hugging Face model repo.

## Product Docs

- [Getting started](docs/GETTING_STARTED.md)
- [Pharo integration](docs/PHARO.md)
- [Model workflow](docs/MODELS.md)
- [Security model](docs/SECURITY.md)
- [Release process](docs/RELEASE.md)

## Development

Run the smoke tests:

```sh
npm test
npm run test:e2e
npm run verify:release
```

Run without installing:

```sh
node pharo-agent/cli.ts doctor
```
