# Release

Run the local release gate:

```sh
npm run verify:release
```

This runs unit tests, CLI smoke checks, packaging checks, and shell syntax checks.

## Tag Release

```sh
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow builds the npm tarball, uploads it as an artifact, and creates a GitHub release for the tag.

## CI

The main `CI` workflow runs on Linux and macOS with Node.js 22 and 24.

Optional Pharo E2E tests run when `PHARO_VM` and `PHARO_IMAGE` secrets are configured for the workflow environment.

Model uploads use the separate `Upload GGUF Model` workflow with an `HF_TOKEN` secret. The default download source is `Qwen/Qwen2.5-Coder-7B-Instruct-GGUF`; the default publish target is `pharo-llm/pharo-agent`.
