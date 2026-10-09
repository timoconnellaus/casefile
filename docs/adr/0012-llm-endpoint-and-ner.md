# 12. LLM endpoint and NER model

Date: 2026-10-07
Status: Accepted

## Context

Rules and known entities (ADR 6) miss names the case has not seen yet, and they miss indirect
identifiers such as schools, employers, clubs, nicknames and "Aunty Jo". We add two optional model
detectors. Both read **un-redacted original text**, which is the most sensitive data casefile
holds, so where that text goes is a safety-boundary decision (PD-AI 4.18–4.19).

We found that an address on this machine does not mean the text stays on this machine. Ollama
serves `:cloud` models (e.g. `deepseek-v4.1-flash:cloud`) from `localhost:11434` exactly like local
ones and forwards each request to ollama.com. On the developer's machine every installed Ollama
model is a cloud model. A localhost check alone would have sent original documents to a third
party with no warning.

## Decision

**NER** (`src/core/detect/ner.ts`): `Xenova/bert-base-NER` (quantised ONNX, about 110 MB) run by
transformers.js. The model is downloaded once from Hugging Face into
`~/Library/Caches/casefile/models` (`~/.cache/casefile/models` elsewhere), or `CASEFILE_MODEL_DIR`.
The download is NER's only network access; inference is offline and no text leaves the machine.
PER, LOC and ORG become person, place and organisation (organisations and places that look like
schools or childcare become `school`); MISC is dropped. Spans are widened to whole words, and
chunks that exceed the model's 512 word pieces are split rather than silently truncated. NER is
off by default (`nerEnabled`).

**LLM pass** (`src/core/detect/llm.ts`): any OpenAI-compatible chat-completions endpoint the user
chooses (base URL, model, optional API key). It returns entities with a kind and a suggested
role. Roles are public (ADR 3), so a suggested role containing any word of a flagged value is
dropped, and the user names the entity instead. Ordinary dates are not flagged; dates of birth
are.

**Where text may go** (`classifyEndpoint`):

1. A host that is not `localhost`, `*.localhost`, `127.0.0.0/8` or `::1` is **remote**.
2. For a local address, casefile asks Ollama's `GET /api/tags` about the configured model. A
   model with `remote_host`, or whose name ends in `:cloud` or `-cloud`, is **remote**, and the
   reason names the host it forwards to.
3. A local Ollama model without those markers is **local, confirmed**.
4. A local server that is not Ollama (LM Studio, llama.cpp, vLLM…), or an Ollama that does not
   list the model, is **local, unconfirmed**: allowed, but the app must tell the user that
   casefile cannot confirm the server does not forward requests.

The LLM detector refuses to send anything to a remote endpoint unless the case settings have
`allowRemote: true`, which the app sets only after the user explicitly accepts that original
text will leave the machine. A refusal is a detector error, which the pipeline reports to the
user (ADR 6). The classification is checked before every request (see the amendment).

## Consequences

- Local by default, and the Ollama cloud trap is caught. Other servers' forwarding (LM Studio
  remote backends, proxies, a tunnel listening on localhost) cannot be detected; the
  "unconfirmed" state exists so the app can say so instead of implying safety.
- Choosing a cloud model is still possible, but it is a deliberate, recorded choice, which the
  AI-use log can report under PD-AI 4.11.
- The NER model download needs network access the CLI never has; the CLI imports no detector
  (ADR 3), so its no-network guarantee is unchanged.
- Model quality varies. Both detectors only propose spans; the user reviews every one, and the
  leak check still runs before publishing.

## Amendment (security review, 2026-10-07)

- **Fail closed.** A local address casefile cannot inspect (not Ollama, or Ollama not listing
  the model, or a proxy configured in the environment) is *unconfirmed* and is refused unless the
  user turns on `trustLocalServer` ("this local server runs the model on this computer").
  `allowRemote` also covers it.
- **No redirects.** Requests use `redirect: "error"`; a 307/308 from a local server would
  otherwise re-send the document text to wherever it pointed.
- **Proxies.** Deno's `fetch` honours `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`. If one applies to
  the endpoint (not bypassed by `NO_PROXY`), the endpoint is unconfirmed.
- **Checked every time.** The classification is not cached: the user can switch Ollama to a
  `:cloud` model at any time.
- **No echo.** Error replies from the endpoint are not included in error messages, because they
  may quote the document.

## Amendment: same-user impersonation and model pinning (security review, 2026-10-07)

`classifyEndpoint` can only ask the endpoint about itself. Claude Code runs as the same OS user
and, unless sandboxed, can stop Ollama, listen on `127.0.0.1:11434` itself and answer `/api/tags`
with a "local" model: casefile would classify that as *local, confirmed* and send it original
text. No check from inside casefile can tell a real local server from an impersonator owned by the
same user. Mitigations, and what is left:

- The generated case settings turn on Claude Code's sandbox with `allowLocalBinding: false`
  (ADR 3), so Claude's commands cannot listen on a port on macOS (Linux gives each sandboxed
  command its own loopback). That holds only while Claude Code honours the settings.
- **Recommendation:** when Claude Code runs without the sandbox, use NER only. NER runs inside the
  app process and sends text nowhere.

**NER model pinning.** The model cache is outside the case folder and writable by the same user,
so the model could be replaced with one that ignores names. The default model is pinned in the
source (`DEFAULT_NER_SPEC` in `ner.ts`): a Hugging Face commit hash (the download URL uses that
revision, so the files land in `<cache>/Xenova/bert-base-NER/<commit>/`) and the SHA-256 of each
file it loads (`config.json`, `tokenizer.json`, `tokenizer_config.json`,
`onnx/model_quantized.onnx`). The hashes were checked on 2026-10-07 against a fresh HTTPS download
from huggingface.co at that commit and against the Hub's LFS SHA-256 for the weights. Any changed,
missing, extra or symlinked file is refused (`ModelPinError`, a detector error that fails closed,
ADR 6). There is no trust on first use: a tampered first download is refused too. A model other
than the default (`nerModel` in the case settings) must come with its commit and the hashes of its
files, or NER refuses to run.

**The bytes checked are the bytes loaded.** Each load reads every file in the model folder into
memory once, hashes those bytes, and hands the same bytes to transformers.js through its custom
cache hook (`env.useCustomCache`, `env.customCache`). transformers.js never opens the model files or
fetches them itself: its file-system and browser caches are off (`useFSCache`, `useBrowserCache`),
remote loading is off (`allowRemoteModels = false`), and its "local model" lookup goes only to the
custom cache, which answers it with nothing (`allowLocalModels` stays on only because
transformers.js refuses to run with both local and remote off; `useFS = false`, so even an
unreachable fallback could not read a path). The cache answers a request for any file outside the pin, or at another commit, with a
response that cannot be read, so the load fails instead of falling back to disk or network; it
accepts no writes. Swapping a file after the check therefore changes nothing: the swapped file is
never read. On first use casefile downloads each file itself over HTTPS from
`huggingface.co/<model>/resolve/<commit>/`, checks the hashes in memory, and only if every file
matches writes them to `<cache>/Xenova/bert-base-NER/<commit>/` (through a temporary folder renamed
into place) and loads the in-memory copy. A model loaded once stays in memory for the process.

Residual: the transformers.js code itself (in Deno's module cache when run from source) is not
pinned, though a compiled app embeds it.

Model ids and file names are validated as plain names (`owner/name`, relative paths of plain
segments, a 40-hex revision) before they are used in any path or URL, so a custom model spec
cannot read or write outside the model folder (security review, 2026-10-07).
