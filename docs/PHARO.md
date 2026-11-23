# Pharo Integration

Pharo Agent runs Smalltalk in one of two places:

| Backend | What it is | Changes | Speed |
|---|---|---|---|
| **live** | The image you have open, through a small HTTP server inside it | Stay in the image | Milliseconds |
| **headless** | A fresh copy of the image file booted for one call, then discarded | Lost after the call | About 0.2s per call |

`--pharo-mode` (config `pharoMode`, env `PHARO_AGENT_PHARO_MODE`) picks the backend:

- `auto` (default): live when the live server answers, otherwise headless.
- `live`: live only. Calls fail with a clear message if the image isn't running.
- `headless`: never use the live image.

Every result says which backend ran it. In the chat, results show a green `live`
or a yellow `headless` label, and headless changes come with a warning that they
were discarded.

Tested on Pharo 10 and Pharo 14. The generated Smalltalk reaches version-specific
classes only through `Smalltalk at:`, so it compiles on both.

## Live mode

### Connect the image you already have open

```sh
pharo-agent live snippet
```

This prints one line like:

```smalltalk
Smalltalk compiler evaluate: '/path/to/pharo-agent/smalltalk/live-server.st' asFileReference contents.
```

Paste it into a Playground and Do it (Cmd+D). The Transcript shows:

```text
[pharo-agent] live server listening on http://127.0.0.1:4044 (token in ~/.pharo-agent/live.json)
```

Every request the agent makes is also logged in the Transcript, so you can watch
it from inside Pharo too.

### Or launch an image with the server

```sh
pharo-agent configure --pharo-vm /path/to/Pharo --image /path/to/Pharo.image
pharo-agent live start              # with the Pharo window
pharo-agent live start --headless   # no window
pharo-agent live start --port 4050
```

### Manage it

```sh
pharo-agent live status   # version, image path, requests served
pharo-agent live save     # save the image (World menu > Save)
pharo-agent live stop     # stop the server; the image keeps running
```

In the chat: `/live`, `/live start`, `/live snippet`, `/live stop`, `/save`.

If you save the image with the server running, Zinc restarts the server when the
image is reopened, using the same port and token.

### How it works

`pharo-agent/smalltalk/live-server.st` starts a Zinc server bound to `127.0.0.1`
(port 4044 by default, or `PHARO_AGENT_PORT`). It writes the URL and a random
token to `~/.pharo-agent/live.json`, and the CLI reads them from there. The
endpoints are:

- `GET /health`: Pharo version, image path, request count.
- `POST /eval` `{code, timeoutMs, ui}`: compiles and runs `code` with
  `Smalltalk compiler evaluate:`. It answers the `displayString` of the result,
  or the error class, message, and stack. Each evaluation runs in its own
  process and is terminated after `timeoutMs`, so an infinite loop cannot hang
  the image. `ui: true` runs the code in the UI process (to open windows).
- `POST /save`: snapshots the image.

Every request must send the token in `X-Pharo-Agent-Token`. Without it the
server answers 401.

Settings: `livePort` / `PHARO_AGENT_LIVE_PORT`, `liveFile` / `PHARO_AGENT_LIVE_FILE`,
and `liveUrl` + `liveToken` (`PHARO_AGENT_LIVE_URL`, `PHARO_AGENT_LIVE_TOKEN`)
to point at a server explicitly.

## Agent tools

| Tool | Purpose |
|---|---|
| `pharo_inspect` | Image overview, a package's classes, or a class (superclass, comment, variables, selectors, definition) |
| `pharo_find` | Classes by name, implementors, senders, references |
| `pharo_source` | A method's source, or a class definition and comment |
| `pharo_eval` | Evaluate Smalltalk (like Print it) |
| `pharo_define_class` | Create or redefine a class (works across Pharo versions) |
| `pharo_compile` | Add or replace one method |
| `pharo_test` | Run SUnit; failures include their messages (e.g. `Got 6 instead of 7`) |
| `pharo_script` | File in a `.st` chunk-format script |
| `pharo_save` | Save the live image (only when asked) |

Read-only tools run without asking. Write tools follow the permission mode (see
[SECURITY.md](SECURITY.md)).

## Commands

```sh
pharo-agent inspect
pharo-agent inspect MyClass
pharo-agent inspect MyPackage
pharo-agent inspect --pattern Zinc
pharo-agent eval "3 factorial"            # prints 6
pharo-agent eval --pharo-mode headless "Smalltalk version"
pharo-agent st examples/run-sunit.st
pharo-agent test --package MyPackage
pharo-agent test --class MyTestCase
pharo-agent test --class MyTestCase --selector testSomething
```

`eval` prints the value of the last statement. Add `--json` to any of these for
the full result: backend, result, errors, stack, warnings, and duration.

In the chat, `> code` does the same as `eval`, and the agent sees the result.

## E2E Tests

The repository includes optional E2E tests. They run only when the required environment variables exist:

```sh
PHARO_VM=/path/to/pharo PHARO_IMAGE=/path/to/Pharo.image npm run test:e2e
PHARO_AGENT_E2E_BASE_URL=http://127.0.0.1:8080/v1 npm run test:e2e
```

Full SUnit E2E is opt-in because some images contain very large test suites:

```sh
PHARO_VM=/path/to/pharo \
PHARO_IMAGE=/path/to/Pharo.image \
PHARO_AGENT_E2E_RUN_SUNIT=1 \
PHARO_AGENT_E2E_TEST_CLASS=MyTestCase \
npm run test:e2e
```
