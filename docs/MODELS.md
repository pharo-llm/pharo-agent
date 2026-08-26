# Models

The default download model is Qwen2.5-Coder 7B Instruct GGUF:

```text
qwen-coder-7b
Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf
qwen2.5-coder-7b-instruct-q4_0-00002-of-00002.gguf
```

Pharo Agent uses GGUF files with `llama.cpp` or any compatible local OpenAI-style server. The Q4_0 model is split into two shards; `pharo-agent model download --use` downloads both and configures the first shard as the model path.

## List And Download

```sh
pharo-agent model
pharo-agent model list
pharo-agent model files qwen-coder-7b
pharo-agent model download qwen-coder-7b --dry-run
pharo-agent model download qwen-coder-7b --use
pharo-agent model files Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
```

Specific repo, filename, and quantization selectors are supported:

```sh
pharo-agent model download Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf --use
pharo-agent model use Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf
```

## Add Future Friendly Names

Official presets shipped with the CLI live in `pharo-agent/model-presets.json`.
That file is where release-owned names such as `qwen-coder-7b` belong.

Add custom presets globally:

```json
{
  "models": [
    {
      "id": "my-pharo-model",
      "name": "My Pharo Model",
      "repoId": "pharo-llm/pharo-agent",
      "filename": "my-pharo-model.Q4_K_M.gguf",
      "description": "A future Pharo-tuned coding model.",
      "tags": ["pharo", "coding"],
      "aliases": ["pharo-local"]
    }
  ]
}
```

Save that as `~/.config/pharo-agent/models.json`, or put the same structure in
`.pharo-agent.models.json` inside a project. Then users can run:

```sh
pharo-agent model use my-pharo-model
pharo-agent model download my-pharo-model --use
pharo-agent model serve my-pharo-model
```

## Serve

```sh
pharo-agent model serve
pharo-agent model serve qwen-coder-7b
pharo-agent model serve --hf Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf
pharo-agent model serve ./models/qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf
```

The default API base URL is `http://127.0.0.1:8080/v1`.

## Publish

Local upload:

```sh
pharo-agent model publish ./qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf --repo pharo-llm/pharo-agent
```

GitHub Actions upload:

1. Add the `HF_TOKEN` repository secret.
2. Run the `Upload GGUF Model` workflow.
3. Provide the HTTPS URL for the `.gguf` file and the target repo/path.

Recommended names:

```text
qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf
qwen2.5-coder-7b-instruct-q4_0-00002-of-00002.gguf
```
