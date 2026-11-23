# Getting Started

Pharo Agent is a zero-dependency TypeScript CLI. It runs directly on Node.js 22.6.0 or newer.

## Install

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/pharo-llm/pharo-agent/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/pharo-llm/pharo-agent/main/scripts/install.ps1 | iex
```

The installer copies pharo-agent to `~/.local/share/pharo-agent` (or
`%LOCALAPPDATA%\pharo-agent`) and adds `pharo-agent` to your PATH, in your shell's
rc file or your Windows user PATH. When it runs in a terminal, it then starts
setup. Options: `PHARO_AGENT_NO_MODIFY_PATH=1`, `PHARO_AGENT_NO_SETUP=1`.

## Setup

Setup runs by itself the first time (from the installer, or on your first
`pharo-agent`). Run it again anytime with `pharo-agent setup`, or `/setup` in
the chat.

| Step | What it does |
|---|---|
| Trust | The current folder is added to your trusted folders. A project's `.pharo-agent.json` and `.mcp.json` are only used in trusted folders. Each new folder asks once. |
| Model | Lists models from running Ollama (11434), llama.cpp (8080) and LM Studio (1234) servers. It can also download Qwen2.5-Coder 7B for llama.cpp, which is then started automatically when the chat needs it, or take any OpenAI-compatible URL (with an API key). |
| Permissions | `ask` (approve each change), `auto` (still asks before destructive steps), or `read-only` |
| MCP | Off, the project's `.mcp.json`, Evref-BL's PLexus (`npx @evref-bl/plexus mcp`), or a config file |
| Image | Your Pharo Launcher images, images found elsewhere, or a new one from a template |
| VM | The image's recorded or matching VM. Only compatible VMs are offered, and a missing one is downloaded |
| Start | With a window, headless, or later |

Answers go to `~/.config/pharo-agent/config.json`. Environment variables still
override them (`PHARO_AGENT_BASE_URL`, `PHARO_AGENT_MODEL`, `PHARO_IMAGE`, …),
but you don't need any.

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

`~/.config/pharo-agent/config.json` holds the setup answers. A project can add
`.pharo-agent.json` (applied only in trusted folders). Every key can be
overridden with an environment variable, for example `PHARO_AGENT_MODEL`,
`PHARO_AGENT_PERMISSION_MODE` or `PHARO_AGENT_PHARO_MODE`.
