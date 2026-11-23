# Changelog

## Unreleased

- First-run setup, Claude Code style: trust the folder, then pick the model
  (finds Ollama / llama.cpp / LM Studio), permissions, MCP (off, project
  `.mcp.json`, or Evref-BL PLexus), image and VM. Arrow-key menus. Runs from the
  installer or on the first `pharo-agent`, and again with `setup` / `/setup`.
- Installers put pharo-agent on PATH and start setup: `scripts/install.sh`
  (macOS/Linux, answers via `/dev/tty`) and new `scripts/install.ps1` (Windows).
- llama.cpp starts automatically when the chat needs a configured GGUF model.
- A project's `.pharo-agent.json` and MCP files only apply in trusted folders.
  `.mcp.json` is read, and both `mcpServers` and `servers` keys are accepted.
- Never use ports that fetch refuses (4045, 4190, …). Before this fix, a second
  live image on 4045 could never be reached.
- Double-escaped code from small models (`\\n` instead of a line break) is
  repaired before compiling.
- Repository: docs in `docs/` (new ARCHITECTURE.md, CHANGELOG.md moved there),
  scripts in `scripts/`, tests in `tests/unit` and `tests/e2e`.

- `pharo_define_class` refuses to replace a class that already exists in
  another package (for example `Stack`). Redefining it broke the image.
  `replaceExisting: true` overrides this, only when asked.
- When a model returns an empty reply mid-task, the agent asks it to continue
  (up to twice) instead of ending the turn with no answer. `<think>` blocks are
  not taken as answers.
- README rewritten: short, task-focused, with screenshots.

- Images and VMs as Pharo Launcher stores them, on macOS, Linux and Windows.
  pharo-agent reads Launcher's settings and uses its images, VMs, templates
  (`sources.list`, `mysources.list`) and template cache. New `pharo-agent images`
  command: list (with running/live state; `--all` searches the machine), where,
  use, info, templates, create (downloads the template and its VM), copy, delete,
  start (window or headless), stop (`--save`), vms, `vm download`.
- Chat: `/image` picker, `/image create|start|stop|copy|delete|info`, `/images`,
  `/templates`, `/vms`. The prompt shows the selected image and whether it is live.
  Lines typed while the agent works are queued instead of lost.
- Agent tools: `image_list`, `image_templates`, `image_create`, `image_select`,
  `image_start`, `image_stop`.
- Several live images at once: each server publishes
  `~/.pharo-agent/endpoints/<port>.json`, and Pharo calls go to the selected
  image's server. The server is no longer registered with Zinc, so a saved
  image never reopens with a stale server.
- The VM is resolved per image (Launcher's recorded VM, then its version's),
  instead of one global `pharoVm`.

- Live mode: `pharo-agent/smalltalk/live-server.st` runs a token-protected Zinc
  server on 127.0.0.1 inside your open image, so the agent works on the running
  image (shared state, persistent changes, millisecond calls) without MCP.
  New `pharo-agent live status|start|snippet|stop|save` commands.
  `--pharo-mode auto|live|headless` (default `auto`).
- New Pharo tools: `pharo_find`, `pharo_source`, `pharo_define_class`
  (version-independent class creation), `pharo_compile`, `pharo_save`.
  `pharo_test` failures now include their messages.
- Headless and live runs return the same result: the value of the last statement,
  or the error class, message, and stack. Fixed generated scripts breaking on `!`
  (chunk format), and the image overview listing no packages on Pharo 12+.
- Terminal UI: Pharo lighthouse banner with model and image status. Every tool
  call is shown live, with the Smalltalk it runs, file diffs, results, the
  backend, and timings. Spinner while the model thinks.
- Esc / Ctrl+C interrupts a turn. `! cmd` runs a shell command and `> code`
  evaluates Smalltalk yourself; the agent sees both. Approvals reuse the chat
  input and accept `a` (always for this session).
  New `/live`, `/save`, `/mode`, `/permissions`, `/verbose`, `/eval`.
- `doctor`/`status` report the live image. The VM and image file are only
  required when no live image is connected.

## 0.1.0

- Initial TypeScript Pharo Agent CLI.
- Local agent loop with native tool call support and JSON fallback for GGUF models.
- Pharo image inspection, Smalltalk evaluation, script execution, and SUnit test commands.
- Hugging Face GGUF list/download/use/serve/publish workflows.
- Workspace file/search/shell tools, memory, tasks, sessions, MCP stdio tools, web fetch/search, and subagents.
- First-run setup, status dashboard, safer defaults, CI, release packaging, and optional E2E hooks.
