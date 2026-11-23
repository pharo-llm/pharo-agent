# Architecture

Pharo Agent is one Node.js program (TypeScript, run directly by Node 22.6+,
no npm dependencies) and one Smalltalk script that it loads into Pharo images.

## The big picture

```text
 you ──► terminal UI (cli.ts, ui.ts)
              │ prompt, slash commands, ! shell, > Smalltalk
              ▼
         agent loop (agent.ts) ◄──────► local model (llm.ts)
              │ tool calls                OpenAI-compatible API:
              ▼                           llama.cpp, Ollama, …
           tools (tools.ts)
     ┌────────┼───────────────┬──────────────────┐
     ▼        ▼               ▼                  ▼
  files,   Pharo code      Pharo images        memory, tasks,
  shell,   (pharo.ts)      (image-manager.ts,  MCP, web,
  search      │             launcher.ts)        subagents
              │ auto: live if it answers, else headless
       ┌──────┴────────┐
       ▼               ▼
   live.ts ──HTTP──► live-server.st        headless VM run
   (token,         inside the running      (a fresh copy of the image
   127.0.0.1)      image: changes stay      for one call, then discarded)
```

## One turn, end to end

0. **First run only:** `onboarding.ts` asks the setup questions and saves the
   answers. A folder seen for the first time is asked to be trusted.
1. **You type a question.** `cli.ts` (chat mode) hands it to `PharoAgentLoop.runTurn`.
   If the model server is down but a GGUF is configured, llama.cpp is started first.
2. **The agent loop** (`agent.ts`) sends the conversation, the system prompt and
   the tool schemas to the model (`llm.ts`): Pharo Cloud or a local server. Pharo
   Cloud requests carry this machine's client ID. A usage-limit answer is shown
   as is, with its reset time.
3. **The model answers** with tool calls, either native `tool_calls` or JSON in
   the text (a fallback for GGUF models without function calling).
4. **Each tool runs** (`tools.ts`) after a permission check (`permissions.ts`).
   Its result goes back into the conversation, and the loop continues until the
   model gives a final answer.
5. **Every step is an event** (`model_start`, `tool_start`, `tool_end`, …).
   `ui.ts` turns these events into what you see: the spinner, `● Pharo compile(…)`
   with the source, and `⎿ result · live · 12ms`. `sessions.ts` records them to
   a transcript.

Esc and Ctrl+C abort the turn's `AbortSignal`, which stops both the model
request and the running tool. Lines you type while the agent works are queued
and run afterwards.

## Modules

| Area | Files | Job |
|---|---|---|
| Entry and UI | `cli.ts`, `ui.ts` | Commands (`images`, `eval`, `test`, `model`, …), the interactive chat, the banner, rendering of agent activity |
| Setup | `onboarding.ts`, `prompts.ts` | First-run questions (trust, model, permissions, MCP, image, VM) and the arrow-key menus |
| Agent | `agent.ts`, `llm.ts`, `permissions.ts` | The tool loop, the model client, approvals (`y` / `n` / `a`lways) |
| Tools | `tools.ts`, `web-tools.ts`, `mcp.ts` | Everything the model can call |
| Pharo code | `pharo.ts`, `live.ts`, `smalltalk/live-server.st` | Run Smalltalk live or headless, with the same result shape |
| Pharo images | `launcher.ts`, `image-manager.ts`, `ston.ts` | Pharo Launcher's images, VMs and templates, plus start/stop/select |
| Models | `models.ts`, `hf.ts`, `llama.ts`, `model-presets.json` | GGUF presets, Hugging Face downloads, llama.cpp server |
| Pharo Cloud | `cloud.ts` | Machine registration (hashed fingerprint, no login), client ID header, usage (`/usage`, banner) |
| State | `config.ts`, `sessions.ts`, `memory.ts`, `task-store.ts` | Config (global, project, env), transcripts, project memory, tasks |
| Support | `platform.ts`, `workspace.ts`, `safety.ts`, `setup.ts`, `diagnostics.ts` | Paths and processes, workspace scanning, path guards, `setup`, `doctor` |

## Running Smalltalk: two backends, one result

`pharo.ts` builds a Smalltalk *doit* for each operation (eval, inspect, source,
find, define class, compile, test) and runs it in one of two places:

- **Live.** It is sent over HTTP to `live-server.st`, which runs inside your
  running image. The server listens only on `127.0.0.1`, requires a random
  token, and runs each evaluation in its own process with a timeout. State is
  shared and changes stay in the image. Calls take milliseconds.
- **Headless.** A fresh copy of the image file is booted with the right VM, the
  same doit runs, and the VM quits without saving (about 0.2 s per call).

Both backends evaluate with `Smalltalk compiler evaluate:` and capture errors
the same way, so the result is identical: `{ ok, result | error, errorClass,
stack, warnings, durationMs }`. Every result says which backend produced it.
`pharoMode` (`auto` by default) picks live when the selected image's server
answers.

The generated Smalltalk reaches version-specific classes only through
`Smalltalk at:`, so the same code compiles on Pharo 10 through 14. Classes are
defined through `Smalltalk classInstaller`, which works on every version.
Redefining a class that belongs to another package is refused.

## Images: Pharo Launcher's layout, without Pharo Launcher

`launcher.ts` reads Pharo Launcher's `settings.ston` to find the images and VMs
folders (per-OS defaults otherwise) and implements the Launcher's rules:

- **An image** is a folder `D` holding `D.image`. Its version and template come
  from `pharo.version`, `meta-inf.ston` (parsed by `ston.ts`) and the image header.
- **A VM** is a folder `<version>-x64` in the VMs folder. An image uses the VM
  recorded in its metadata, else the one matching its version, else the closest
  newer one. Missing VMs are downloaded from files.pharo.org.
- **Templates** come from `sources.list`, plus the user's `mysources.list` and
  the downloaded-template cache.
- **A running image** is a VM process whose command line names the image file.
  It is *live* when its endpoint file (`~/.pharo-agent/endpoints/<port>.json`,
  written by the server) answers.

`image-manager.ts` combines these into the image workflow shared by the CLI, the
chat (`/image`), and the agent's `image_*` tools: status, select, start, stop.

## Design decisions

- **No MCP inside the image.** A single script loaded on demand works on any
  image you already have, with nothing to install through Metacello.
- **No Pharo Launcher CLI.** Older Launchers don't have one, and each command
  boots an image. Reading and writing its file layout directly is fast, and it
  keeps both tools in sync.
- **No npm dependencies.** Node's built-ins (fetch, test runner, type stripping)
  are enough, so installing is just copying files.
- **Trust before config.** A project's `.pharo-agent.json` and `.mcp.json` could
  change permissions or run commands, so they apply only in folders the user
  trusted. The trust list lives only in the global config.
- **Everything visible.** The loop emits events for every step, and the UI never
  hides a tool call.

## Repository layout

```text
pharo-agent/          the CLI (one .ts file per module, see the table above)
  smalltalk/          live-server.st, loaded into images
docs/                 all documentation (this file, PHARO, MODELS, SECURITY, …)
scripts/              install.sh, install.ps1, smoke.sh, verify-release.sh
tests/unit/           fast tests: npm test
tests/e2e/            tests against a real image or model server: npm run test:e2e
examples/             sample configs (MCP servers, model presets, project config)
```
