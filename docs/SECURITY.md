# Security

Pharo Agent is a local coding agent. It can edit files, run shell commands, call MCP tools, and execute code in a Pharo image, so the defaults are intentionally conservative.

## Permission Modes

- `ask`: default. Read-only tools run automatically; write tools ask for approval in a terminal.
- `auto`: non-destructive write tools are allowed, but destructive tools still require a terminal approval.
- `read-only`: only read-only tools are allowed.
- `dangerous`: every local tool request is allowed.

Use `dangerous` only in a disposable workspace.

## Workspace Boundary

Model-driven file tools are restricted to the current workspace by default. To allow paths outside the workspace:

```sh
pharo-agent configure --allow-outside-workspace true
```

## Network Boundary

The `web_fetch` tool blocks localhost and private network targets by default. This prevents a model from reading local admin endpoints through the web tool.

```sh
pharo-agent configure --allow-private-network true
```

The LLM API itself can still point at `127.0.0.1`; this restriction only applies to the model-exposed web fetch tool.

## Shell Commands

Read-only commands such as `ls`, `rg`, `git status`, and `sed -n` are treated as read-only. Commands such as `rm`, `git reset`, `npm install`, and `curl | sh` are treated as destructive.

## Live Image Server

`pharo-agent/smalltalk/live-server.st` lets the agent run arbitrary Smalltalk in
your open image, which means it can run anything you can. It is locked down as
follows:

- It binds to `127.0.0.1` only, so it is not reachable from the network.
- Every request must carry a random token (a UUID generated when the server
  starts). The token is written to `~/.pharo-agent/live.json`, and the CLI
  creates and keeps `~/.pharo-agent` at mode `700` so other local users cannot
  read it.
- Each evaluation runs in its own process with a timeout (`timeoutSeconds`,
  default 120), so a runaway loop is terminated instead of freezing the image.
- Every request is logged to the image's Transcript as `[pharo-agent] ...`.
- `pharo_eval`, `pharo_compile`, `pharo_define_class`, `pharo_script`, and
  `pharo_save` are write tools, so they follow the permission mode. In `ask`
  mode you approve each one (or answer `a` to allow that tool for the session).
  `pharo_save` is only offered when you ask for a save.

`pharo_define_class` will not replace a class that already exists in another
package (a system class such as `Stack`, for example). Redefining one with new
slots or another superclass breaks everything that uses it.

Stop the server with `pharo-agent live stop`. Restarting it (evaluating the
snippet again) generates a new token.
