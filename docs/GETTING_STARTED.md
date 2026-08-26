# Getting Started

Pharo Agent is a zero-dependency TypeScript CLI. It runs directly on Node.js 22.6.0 or newer.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/pharo-llm/pharo-agent/main/install.sh | sh
```

The installer copies this repository into `~/.local/share/pharo-agent` and creates `~/.local/bin/pharo-agent`.

## First Setup

```sh
pharo-agent setup --online
pharo-agent status --online
```

`setup` searches common locations for a Pharo VM, Pharo image, and `llama-server`, then writes either the global config or `.pharo-agent.json` when `--local` is used.

Non-interactive setup is available for scripts:

```sh
pharo-agent setup --yes
```

## Run Pharo

```sh
pharo-agent eval "Stdio stdout nextPutAll: Smalltalk version; cr"
pharo-agent st scripts/load.st
pharo-agent test --package MyPackage
```

## Run The Agent

Start or point at an OpenAI-compatible model server, then ask:

```sh
pharo-agent model serve
pharo-agent
```

With `llama-server` installed and a downloaded model configured:

```sh
pharo-agent ask --start-server "Run SUnit and explain failures."
```

Inside `pharo-agent`, users can ask normal questions and use slash commands:

```text
pharo-agent:1> inspect this image
pharo-agent:2> run the tests for MyPackage
/status
/model
/model use qwen-coder-7b
/exit
```
