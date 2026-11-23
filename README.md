# Pharo Agent

TypeScript local coding agent for Pharo images and terminal workflows.

It gives developers a single `pharo-agent` CLI with a real local agent loop:

- OpenAI-compatible local model API support, including `llama.cpp`;
- GGUF model discovery, download, switching, serving, and publishing for Hugging Face;
- file read/write/edit/delete tools;
- workspace glob and grep tools;
- shell command execution with read-only detection and permission modes;
- your Pharo Launcher images and VMs in the terminal: list, create from templates, copy, start, stop, delete, on macOS, Linux and Windows;
- live connection to your running Pharo image (no MCP): evaluate, browse, define classes, compile methods, run SUnit, save;
- headless fallback that boots a throwaway copy of the image for each call;
- a terminal UI that shows every tool call, the Smalltalk it runs, and its result as it happens;
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

## Your Pharo Images (Pharo Launcher In The Terminal)

pharo-agent finds the images and VMs you already have. It reads Pharo
Launcher's own settings (`~/Library/Preferences/pharo-launcher/settings.ston`
on macOS, `~/.config/pharo-launcher/` on Linux, `%APPDATA%\pharo-launcher\`
on Windows) and uses the same folders: `images/`, `vms/`, template list and
template cache. Images you create here show up in Pharo Launcher, and the other
way round. Pharo Launcher itself doesn't have to be installed.

In the chat, everything happens from one prompt:

```text
❯ /image                      pick the image to work in, then start it
     #  Image                             Pharo   State
     1  Pharo 10.0 - 64bit                10.0    ○ stopped
  ❯  2  Pharo 14.0 - 64bit (next stable)  14.0    ● live 127.0.0.1:4044
❯ /image create               name + template (Pharo 14, Moose, …), downloads image and VM
❯ /image start [--headless]   open it (window by default) with the agent connected
Pharo 14.0 - 64bit … ● ❯ which classes in my package have no tests?
❯ /image stop --save          save and quit
```

The prompt shows the image your questions go to (● live, ○ stopped). The agent
can do the same itself with its `image_list`, `image_templates`,
`image_create`, `image_select`, `image_start` and `image_stop` tools. For
example, ask it to "create a Moose 13 image and load my baseline into it".

From the shell:

```sh
pharo-agent images                      # list (--all: also images elsewhere on the machine)
pharo-agent images where                # where images, VMs and templates live
pharo-agent images templates "Pharo 14"
pharo-agent images create MyProject --template "Pharo 14.0 - 64bit (stable)"
pharo-agent images use MyProject        # the image questions go to (saved in config)
pharo-agent images start                # window; --headless for none
pharo-agent images info
pharo-agent images copy MyProject "MyProject backup"
pharo-agent images stop --save
pharo-agent images delete "MyProject backup" --yes
pharo-agent images vms                  # installed VMs
pharo-agent images vm download 140      # VM for Pharo 14 (normally automatic)
```

Each image runs on the VM Pharo Launcher would choose: the one recorded in its
`meta-inf.ston`, else a VM shipped next to it, else `<version>-x64`, else the
closest newer 64-bit VM. Several images can run and be live at the same time,
each on its own port.

## Talk To Your Running Image (Live Mode)

By default every Pharo call boots a fresh headless copy of the image file and
throws it away afterwards. Live mode connects the agent to the image you have
open instead. It shares your state, keeps every change, and answers in
milliseconds. No MCP is involved: a small HTTP server runs inside the image,
bound to `127.0.0.1` and protected by a random token.

Connect the image you already have open. Print the one-liner, paste it into a
Playground, and Do it (Cmd+D):

```sh
pharo-agent live snippet
```

Or launch the configured image with the server already loaded:

```sh
pharo-agent live start            # opens the Pharo window
pharo-agent live start --headless
```

Then:

```sh
pharo-agent live status
pharo-agent eval "Smalltalk at: #Answer put: 42"
pharo-agent eval "Answer + 1"     # 43: same image, state is kept
pharo-agent live save             # save the image to disk
pharo-agent live stop             # stop the server; the image keeps running
```

`--pharo-mode` (or `PHARO_AGENT_PHARO_MODE`) chooses where Smalltalk runs:
`auto` (default) uses the live image when it answers, else a headless copy.
`live` requires the live image. `headless` never uses it. Every tool result is
labelled `live` or `headless`, so you always know whether a change was kept.
See [docs/PHARO.md](docs/PHARO.md).

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

It opens with the Pharo lighthouse, the model, the connected image, and the
workspace. Then you watch the agent work: every tool call is printed as it
happens. Pharo calls show the exact Smalltalk being evaluated or compiled,
shell calls show the command, and file edits show a `-`/`+` diff. Each result
is shown with where it ran (`live` or `headless`) and how long it took:

```text
❯ add an increment method to Counter and test it

● Pharo compile(Counter>>#increment · accessing)
  │ increment
  │     count := count + 1
  ⎿  Compiled Counter>>#increment  live · 12ms
● Pharo test(CounterTest)
  ⎿  classes: 1
     runs: 1
     passed: 1
     failures: 0
     errors: 0  live · 16ms
● Done: Counter>>#increment is compiled and CounterTest passes.
  1m43s · 2 tool calls
```

You can do anything the agent does yourself, in the same session. The agent
sees the result in its context:

```text
❯ > Counter new increment; count          evaluate Smalltalk in the image
❯ ! git status                            run a shell command
```

Press **Esc** or **Ctrl+C** to interrupt the agent mid-turn. When a write tool
needs approval, answer `y`, `n`, or `a` (always allow that tool for this session).

Useful in-session commands:

```text
/help
/live [status|start|snippet|stop]
/save
/mode auto|live|headless
/permissions ask|auto|read-only|dangerous
/verbose                 full tool output instead of previews
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

One-shot mode is still available. Agent activity goes to stderr, and the answer to stdout:

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
