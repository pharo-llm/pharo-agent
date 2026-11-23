# Pharo Agent

A local coding agent for Pharo, in your terminal. Ask questions and it works
directly inside your Pharo image: it browses classes, writes methods, and runs
tests. You see every step as it happens.

![The agent building a class and its test inside a live Pharo image](docs/images/chat-agent.png)

- **Works inside your running image.** No MCP: a tiny server loads into the
  image, so changes stay and calls take milliseconds.
- **Manages your images like Pharo Launcher.** It uses the same images, VMs and
  templates on macOS, Linux and Windows: list, create, start, stop, copy, delete.
- **Shows everything it does.** You see every Smalltalk snippet, method source,
  test result and shell command, with where it ran and how long it took.
- **You can do the same yourself.** `> 3 factorial` evaluates Smalltalk and
  `! git status` runs a shell command. Esc interrupts.
- **Runs on local models** (llama.cpp, Ollama, any OpenAI-compatible server).

## Install

Requires Node.js 22.6 or newer. There are no npm dependencies.

```sh
curl -fsSL https://raw.githubusercontent.com/pharo-llm/pharo-agent/main/scripts/install.sh | sh
```

From a checkout, run `node pharo-agent/cli.ts` instead of `pharo-agent`.

## Quick Start

1. **Start a model.** Either use the built-in llama.cpp model:

   ```sh
   pharo-agent model download qwen-coder-7b --use
   pharo-agent model serve
   ```

   or point at a server you already run, such as Ollama:

   ```sh
   export PHARO_AGENT_BASE_URL=http://127.0.0.1:11434/v1 PHARO_AGENT_MODEL=qwen3:4b
   ```

2. **Open the agent:**

   ```sh
   pharo-agent
   ```

3. **Pick or create an image** with `/image`, then just ask.

![Creating an image from a template, starting it, and listing images](docs/images/chat-images.png)

## In The Chat

| Type | To |
|---|---|
| *a question* | ask the agent (Esc or Ctrl+C interrupts) |
| `/image` | pick the image to work in, then start it |
| `/image create` | new image from a template (Pharo, Moose, …): downloads image and VM |
| `/image start` · `/image stop --save` | open it (window or `--headless`) · save and quit |
| `/images` · `/templates` · `/vms` | list images (`--all`: whole machine), templates, VMs |
| `> code` | evaluate Smalltalk in the image yourself |
| `! command` | run a shell command yourself |
| `/verbose` | show full tool output |
| `/help` | everything else (models, permissions, sessions, …) |

The prompt shows the image your questions go to: `Agent Demo ● ❯` means it's
live, `○` means it's stopped (questions then run in a throwaway headless copy).

## From The Shell

```sh
pharo-agent images                       # your images, with version and state
pharo-agent images create MyApp --template "Pharo 14.0 - 64bit (stable)" --use
pharo-agent images start                 # --headless for no window
pharo-agent eval "3 factorial"           # → 6
pharo-agent test --package MyApp
pharo-agent ask "Why does MyAppTest fail?"
pharo-agent images stop --save
```

Already have an image open? `pharo-agent live snippet` prints one line to paste
into its Playground. That connects it to the agent.

## Safety

Read-only tools run freely. Tools that change things (compile, define a class,
eval, write files, shell) ask first: answer `y`, `n`, or `a` (always, for this
session). The agent won't redefine existing classes from other packages, and the
in-image server only accepts local connections that carry a secret token. See
[docs/SECURITY.md](docs/SECURITY.md).

## Docs

- [Getting started](docs/GETTING_STARTED.md)
- [Architecture](docs/ARCHITECTURE.md): how the pieces fit together
- [Pharo: images, live mode, tools](docs/PHARO.md)
- [Models: download, serve, publish](docs/MODELS.md)
- [Security](docs/SECURITY.md)
- [Releases](docs/RELEASE.md) · [Changelog](docs/CHANGELOG.md)

## Development

```text
pharo-agent/   the CLI source       docs/      all documentation
scripts/       install & checks     tests/     unit/ and e2e/
```

```sh
npm test                                              # unit tests
PHARO_VM=… PHARO_IMAGE=… npm run test:e2e             # against a real image
npm run verify:release                                # everything CI checks
```
