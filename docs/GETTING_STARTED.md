# Getting Started

Pharo Agent is a zero-dependency TypeScript CLI. It runs directly on Node.js 22.6.0 or newer.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/pharo-llm/pharo-agent/main/scripts/install.sh | sh
```

The installer copies this repository into `~/.local/share/pharo-agent` and creates `~/.local/bin/pharo-agent`.

## Check Your Setup

```sh
pharo-agent doctor
```

It reports the model server, your Pharo Launcher images, and the selected image.

## Pick An Image

pharo-agent uses Pharo Launcher's images and VMs (see [PHARO.md](PHARO.md)):

```sh
pharo-agent images                       # what you have
pharo-agent images use 2                 # work in image #2
pharo-agent images create MyApp --template "Pharo 14.0 - 64bit (stable)" --use
pharo-agent images start                 # open it with the agent connected
```

In the chat, `/image` does all of this interactively.

## Start A Model

Any OpenAI-compatible server works. The built-in llama.cpp flow:

```sh
pharo-agent model download qwen-coder-7b --use
pharo-agent model serve
```

Or an existing server, for example Ollama:

```sh
export PHARO_AGENT_BASE_URL=http://127.0.0.1:11434/v1
export PHARO_AGENT_MODEL=qwen3:4b
```

See [MODELS.md](MODELS.md).

## Run The Agent

```sh
pharo-agent
```

```text
Agent Demo ● ❯ which classes in AgentDemo have no tests?
Agent Demo ● ❯ > Counter new increment; count         (evaluate Smalltalk yourself)
Agent Demo ● ❯ ! git status                         (run a shell command yourself)
Agent Demo ● ❯ /help
```

One-shot, for scripts:

```sh
pharo-agent ask "Run the MyApp tests and explain the failures."
pharo-agent eval "3 factorial"
pharo-agent test --package MyApp
```

## Configuration

`pharo-agent setup` writes the global config (`~/.config/pharo-agent/config.json`),
or `.pharo-agent.json` in the project with `--local`. Environment variables
override it: `PHARO_AGENT_BASE_URL`, `PHARO_AGENT_MODEL`, `PHARO_IMAGE`,
`PHARO_VM`, `PHARO_AGENT_PERMISSION_MODE`, `PHARO_AGENT_PHARO_MODE`.
