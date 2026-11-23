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

## Images and VMs

pharo-agent stores images exactly as Pharo Launcher does, so both tools see the
same images. Pharo Launcher does not need to be installed.

| | macOS | Linux | Windows |
|---|---|---|---|
| Launcher settings | `~/Library/Preferences/pharo-launcher/settings.ston` | `~/.config/pharo-launcher/settings.ston` | `%APPDATA%\pharo-launcher\settings.ston` |
| Images, VMs (default) | `~/Documents/Pharo/{images,vms}` | `~/Pharo/{images,vms}` | `%USERPROFILE%\Documents\Pharo\{images,vms}` |
| Template cache | `~/Library/Preferences/pharo/templateCache` | `~/.config/pharo/templateCache` | `%APPDATA%\pharo\templateCache` |
| VM executable | `Pharo.app/Contents/MacOS/Pharo` | `pharo` or `bin/pharo` | `PharoConsole.exe` (headless), `Pharo.exe` (window) |

The settings file's `locationString` and `vmStoreString` override the default
folders, and so do `PHARO_AGENT_IMAGES_DIR` and `PHARO_AGENT_VMS_DIR`.
`pharo-agent images where` prints what is in use.

- **An image** is a folder `D` of the images directory holding `D.image`.
  Its version comes from `pharo.version`, else `meta-inf.ston`, else the
  `.sources` file name. Its architecture comes from the image header.
- **Templates** come from Pharo Launcher's `sources.list` (official versions,
  Moose, Spec-Toplo, Pharo-LLM, ...), refreshed from
  `https://files.pharo.org/pharo-launcher/sources.list` with
  `images templates --refresh`. Your own `mysources.list` is included, and so are
  templates already in the cache, which work offline.
- **Creating** downloads the template into the shared cache, unpacks it as
  `images/<name>/<name>.image`, and writes `pharo.version` and a
  Launcher-format `meta-inf.ston`. It also downloads the VM for that version
  from files.pharo.org if it is missing.
- **A running image** is a VM process whose command line names the image file.
  It is **live** when its agent server answers. Each live server writes
  `~/.pharo-agent/endpoints/<port>.json`, so several images can be live at once.
- **Selecting** an image (`/image`, `images use`, or the agent's `image_select`)
  saves it as `image` in `.pharo-agent.json` when the project has one,
  otherwise in the global config. Every Pharo call then goes to that image.

### Why not drive Pharo Launcher's CLI?

The [Evref-BL](https://github.com/orgs/Evref-BL/repositories) tools take two
approaches. `pharo-launcher-mcp` runs Launcher's `clap launcher` commands, and
`PLexus` manages images itself. pharo-agent follows the parts both agree on:
read image folders and metadata from disk, and treat a running image as a
process. It does not shell out to Launcher:

- Launcher 3.0.x (still common) has no CLI, so the commands hang.
- Each Launcher command boots an image, which takes seconds per command.
- Its on-disk format is stable and simple, so writing it directly keeps both
  tools in sync.

Unlike Evref-BL's MCP, the in-image part is a single script loaded on demand.
Nothing is installed into the image with Metacello, so it works on any image,
including ones you already have.

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

### Or let pharo-agent start it

```sh
pharo-agent images use "Pharo 14.0 - 64bit (next stable)"
pharo-agent images start              # with the Pharo window
pharo-agent images start --headless   # no window
```

`pharo-agent live start` does the same for the selected image.

### Manage it

```sh
pharo-agent live status   # version, image path, requests served
pharo-agent live save     # save the image (World menu > Save)
pharo-agent live stop     # stop the server; the image keeps running
```

In the chat: `/live`, `/live start`, `/live snippet`, `/live stop`, `/save`.

The server is not saved into the image. When pharo-agent starts an image it
loads a fresh server with a new port and token. If you reopen an image yourself
(from Pharo Launcher, for example), paste the snippet again.

### How it works

`pharo-agent/smalltalk/live-server.st` starts a Zinc server bound to `127.0.0.1`
(the first free port from 4044, chosen by the CLI). It writes the URL, the image
path and a random token to `~/.pharo-agent/endpoints/<port>.json` and to
`~/.pharo-agent/live.json` (the latest). The CLI uses the endpoint whose image is
the selected one. The
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
| `image_list` | Images (Launcher's, or `all` on the machine), version, state, selected |
| `image_templates` | Templates to create images from |
| `image_create` | New image from a template (downloads image and VM) |
| `image_select` | Choose the image all `pharo_*` tools work in |
| `image_start` / `image_stop` | Open the image with the agent server / quit it (optionally saving) |

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
