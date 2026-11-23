# Changelog

## Unreleased

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
