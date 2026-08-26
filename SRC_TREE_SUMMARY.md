# Source Tree Summary

Generated on 2026-08-26 while converting the repository into a TypeScript Pharo Agent.

## Executive Summary

The original `src/` directory was a large extracted TypeScript/TSX terminal-agent source tree, apparently from a Claude Code/Codex-style CLI application. It did not initially build in this repository root because the root did not contain the required JavaScript package metadata, lockfile, TypeScript config, Bun macros, or build setup.

The active Pharo Agent implementation now lives in the top-level `pharo-agent/` directory. The broader legacy `src/` tree was used as the feature reference, then removed from this repository after the TypeScript local-agent implementation was moved outside it.

## Tree Size

- Files: 1,903
- Directories: 301
- Disk usage: about 36 MB

## File Types

| Extension | Count |
| --- | ---: |
| `.ts` | 1,332 |
| `.tsx` | 552 |
| `.js` | 18 |
| `.DS_Store` | 1 |

## Root Files In `src/`

| File | Role |
| --- | --- |
| `main.tsx` | Very large primary CLI/TUI entrypoint, commander setup, startup, auth, MCP, plugin, model, session, and REPL orchestration. |
| `entrypoints/cli.tsx` | Fast-path CLI bootstrap with dynamic imports and Bun `feature()` gates. |
| `entrypoints/init.ts` | Global initialization, config loading, telemetry, remote settings, proxy, policy, and cleanup setup. |
| `commands.ts` | Registry of slash/CLI commands and dynamic feature-gated command imports. |
| `tools.ts` | Registry of built-in tools and feature-gated tool availability. |
| `Tool.ts` | Shared tool schema, validation, permission, progress, and execution context types. |
| `QueryEngine.ts` | Headless/SDK conversation engine for submitting messages, maintaining state, recording usage, dispatching tools, and handling permissions. |
| `query.ts` | Main model query path and tool-use lifecycle support. |
| `Task.ts` / `tasks.ts` | Task-related types and helpers. |
| `context.ts` | System/user context generation. |
| `setup.ts` | Startup and setup support. |
| `history.ts` | Prompt/session history support. |
| `replLauncher.tsx` | Interactive REPL launch wrapper. |
| `interactiveHelpers.tsx` | Rendering, setup screen, and interactive command helpers. |
| `cost-tracker.ts` / `costHook.ts` | Usage and cost tracking support. |
| `dialogLaunchers.tsx` | TUI dialog launch helpers. |
| `ink.ts` | Ink/TUI rendering exports. |
| `projectOnboardingState.ts` | Project onboarding state helper. |

## Top-Level Directories

| Directory | Files | Summary |
| --- | ---: | --- |
| `src/utils` | 564 | Broad utility layer: auth, config, shell, git, sessions, plugins, model metadata, permissions, telemetry, filesystem, tool results, settings, sandboxing, deep links, terminal handling, and message mapping. |
| `src/components` | 389 | Ink/React terminal UI components: messages, permissions dialogs, agents UI, help, spinners, structured diffs, MCP UI, setup flows, search boxes, and status notices. |
| `src/commands` | 207 | Slash and CLI commands: help, config, model, MCP, agents, review, commit, diff, doctor, memory, plugins, hooks, sessions, permissions, status, usage, export, login/logout, and more. |
| `src/tools` | 184 | Tool implementations exposed to the model: file read/write/edit, grep/glob, shell, PowerShell, MCP, agent/subagent, task tools, notebook edit, web fetch/search, skill tools, config tools, and REPL tools. |
| `src/services` | 130 | Services for API clients, analytics, MCP, plugins, compacting, remote settings, policy limits, voice, LSP, team memory, diagnostics, and session memory. |
| `src/hooks` | 104 | React hooks for REPL behavior, permissions, settings, IDE integration, LSP, notifications, input handling, command queues, background tasks, sessions, and model selection. |
| `src/ink` | 96 | Custom Ink-like terminal rendering engine, layout, screen handling, ANSI/OSC/CSI parsing, focus, colors, bidi, wrapping, and output. |
| `src/bridge` | 31 | Remote-control bridge and session sync: websocket/session handling, bridge config, JWT, trusted device, permissions, inbound messages, and transport. |
| `src/constants` | 21 | Product constants, prompts, system strings, API limits, tool limits, keys, OAuth, XML tags, output styles, and messages. |
| `src/skills` | 20 | Bundled skills and dynamic skill loading/building. |
| `src/cli` | 19 | Non-UI CLI support: handlers, structured IO, remote IO, transports, printing, update, and exit helpers. |
| `src/keybindings` | 14 | Keybinding parser, resolver, schemas, default bindings, provider setup, matching, validation, and shortcut formatting. |
| `src/tasks` | 12 | Task model and task execution helpers. |
| `src/types` | 11 | Shared generated and hand-written types for messages, hooks, logs, commands, plugins, permissions, IDs, and text input. |
| `src/migrations` | 11 | Configuration/model migration helpers for previous product settings. |
| `src/context` | 9 | React contexts for voice, mailbox, modal, notifications, prompt overlay, queue, stats, and FPS. |
| `src/memdir` | 8 | Memory directory support, relevant memory search, team memory paths/prompts, and memory age scanning. |
| `src/entrypoints` | 8 | CLI, MCP, SDK, init, sandbox, and agent SDK type entrypoints. |
| `src/state` | 6 | Application state store, selectors, and state-change handling. |
| `src/buddy` | 6 | Optional companion/buddy UI and prompt assets. |
| `src/vim` | 5 | Vim input modes, motions, operators, transitions, and text objects. |
| `src/remote` | 4 | Remote session management and websocket bridge adapters. |
| `src/query` | 4 | Query dependency/config helpers and token budget/stop hook support. |
| `src/native-ts` | 4 | Native TypeScript support modules such as file indexing, color diff, and yoga layout bindings. |
| `src/server` | 3 | Direct-connect session server support. |
| `src/screens` | 3 | REPL, doctor, and resume screens. |
| `src/upstreamproxy` | 2 | Upstream proxy relay support. |
| `src/plugins` | 2 | Built-in plugin registration. |
| `src/voice` | 1 | Voice mode feature flag/helper. |
| `src/schemas` | 1 | Hook schema definitions. |
| `src/outputStyles` | 1 | Output style loading. |
| `src/moreright` | 1 | TUI layout/right-side helper. |
| `src/coordinator` | 1 | Coordinator-mode integration point. |
| `src/bootstrap` | 1 | Global process/session state singleton. |
| `src/assistant` | 1 | Assistant session history helper. |

## Important Architecture Observations

- The source tree depended on a Bun build environment and compile-time macros such as `feature()` from `bun:bundle` and `MACRO.VERSION`.
- Many imports referenced package-style aliases like `src/...`, but the repository root did not include a matching TypeScript config or bundler configuration.
- The root repository had no `package.json`, JavaScript lockfile, or build scripts when inspected.
- The source tree was untracked in git and this repository had no commits at inspection time.
- `git fetch origin` succeeded, but `git ls-remote origin` returned no refs, so there was no usable upstream branch to restore package metadata from.
- The tree was broad and product-specific. It included cloud auth, analytics, remote control, plugin marketplaces, MCP, React/Ink UI, and many Claude-specific/product-specific commands that were unrelated to a minimal local Pharo image agent.

## Pharo Relevance

The legacy `src/` tree did not contain Pharo-specific integration when searched for terms such as `pharo`, `smalltalk`, `gguf`, `llama`, and `huggingface`. It had general model, tool, shell, MCP, and agent infrastructure, but not a working Pharo image bridge.

The new top-level `pharo-agent/` package provides the Pharo-specific implementation:

- `pharo-agent/agent.ts`: local model/tool loop for coding and Pharo actions.
- `pharo-agent/tools.ts`: built-in local tools for files, edits, search, shell, memory, MCP, and Pharo.
- `pharo-agent/pharo.ts`: Pharo VM/image execution, snippet evaluation, script execution, SUnit test scripts, and image inspection scripts.
- `pharo-agent/hf.ts`: Hugging Face GGUF discovery, selection, and download.
- `pharo-agent/llama.ts`: `llama.cpp` server command construction and lifecycle.
- `pharo-agent/cli.ts`: user-facing `pharo-agent` commands.

## Replacement Decision

The first replacement attempt created a smaller Python CLI outside `src/`, but that did not meet the clarified requirement for a TypeScript agent with the same practical local-agent feature surface. The production direction is now TypeScript, with `pharo-agent/` acting as the focused local Pharo agent while avoiding cloud auth and remote-control product baggage.

- installation can be a simple shell script;
- users need Node.js 22.6.0 or newer, but do not need Bun or npm dependencies just to run the agent;
- the CLI can manage GGUF files from Hugging Face and talk to `llama.cpp`;
- Pharo image tools are explicit, testable, and focused.

## Deletion Note

This file is a summary and inventory of the original legacy tree, not a source-code backup.
