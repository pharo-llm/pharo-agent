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
