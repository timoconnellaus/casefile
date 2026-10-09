import type { EntityKind } from "../kinds.ts";
import { type Chunk, chunkText } from "./chunk.ts";
import type { Detector, Span } from "./types.ts";

/**
 * Named-entity recognition with a BERT token-classification model run locally through
 * transformers.js (ONNX). Text never leaves the machine; only the model files are downloaded,
 * once, from Hugging Face (ADR 12).
 */

export const DEFAULT_NER_MODEL = "Xenova/bert-base-NER";

/** One classified word piece, as returned by the token-classification pipeline. */
export interface TokenPrediction {
  entity: string; // B-PER, I-LOC, ...
  score: number;
  /** 1-based index into the tokenised input ([CLS] is 0). */
  index: number;
  word: string;
}

/** The two things we need from a transformers.js pipeline; injectable for tests. */
export interface TokenClassifier {
  tokenize(text: string): string[];
  classify(text: string): Promise<TokenPrediction[]>;
}

export interface NerOptions {
  minScore?: number;
  /** Maximum characters per model call. */
  chunkChars?: number;
  /**
   * Maximum word pieces per model call. BERT takes 512 including [CLS] and [SEP]; anything past
   * that would be silently truncated, so longer chunks are split again.
   */
  maxTokens?: number;
}

const LABEL_KIND: Record<string, EntityKind | undefined> = {
  PER: "person",
  LOC: "place",
  ORG: "organisation",
  // MISC is mostly nationalities and events ("Australian", "Easter"); not identifying.
};

const SCHOOL_RE =
  /\b(school|college|childcare|child care|kindergarten|kinder|preschool|pre-school|academy|grammar|early learning|daycare|day care|oshc)\b/i;

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** BERT's basic tokenizer splits these off as single-character tokens. */
function isBertPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96)) return true;
  if (cp >= 123 && cp <= 126) return true;
  return /\p{P}/u.test(ch);
}

function charAt(text: string, i: number): string {
  return String.fromCodePoint(text.codePointAt(i)!);
}

/** Map each word piece back to character offsets in `text` (null if it cannot be placed). */
export function alignTokens(
  text: string,
  tokens: string[],
): ({ start: number; end: number } | null)[] {
  const out: ({ start: number; end: number } | null)[] = [];
  let cursor = 0;
  for (const tok of tokens) {
    const cont = tok.startsWith("##") && tok.length > 2;
    const piece = cont ? tok.slice(2) : tok;
    if (!cont) { while (cursor < text.length && /\s/.test(text[cursor])) cursor++; }
    if (tok === "[UNK]") {
      // An unknown "word": either one punctuation character or a run up to whitespace/punctuation.
      const start = cursor;
      if (cursor < text.length && isBertPunctuation(charAt(text, cursor))) {
        cursor += charAt(text, cursor).length;
      } else {
        while (cursor < text.length) {
          const ch = charAt(text, cursor);
          if (/\s/.test(ch) || isBertPunctuation(ch)) break;
          cursor += ch.length;
        }
      }
      out.push(cursor > start ? { start, end: cursor } : null);
      continue;
    }
    if (text.startsWith(piece, cursor)) {
      out.push({ start: cursor, end: cursor + piece.length });
      cursor += piece.length;
      continue;
    }
    // Normalisation differences (accents, odd unicode): search a little way ahead.
    const found = text.indexOf(piece, cursor);
    if (found !== -1 && found - cursor < 20) {
      out.push({ start: found, end: found + piece.length });
      cursor = found + piece.length;
    } else {
      out.push(null);
    }
  }
  return out;
}

/**
 * Turn per-piece predictions into entity spans: word pieces are joined into words, B-/I- runs into
 * entities, and names joined by a hyphen or apostrophe ("O'Brien-Smith") into one. Spans are then
 * widened to whole words, so a name is never half-redacted when the model only tagged part of it.
 */
export function groupPredictions(
  text: string,
  tokens: string[],
  preds: TokenPrediction[],
  minScore: number,
): Span[] {
  const offsets = alignTokens(text, tokens);
  type Group = { type: string; start: number; end: number; scores: number[]; lastIndex: number };
  const groups: Group[] = [];
  for (const p of [...preds].sort((a, b) => a.index - b.index)) {
    const dash = p.entity.indexOf("-");
    const bio = dash === -1 ? p.entity : p.entity.slice(0, dash);
    const type = dash === -1 ? "" : p.entity.slice(dash + 1);
    if (!type || bio === "O") continue;
    const off = offsets[p.index - 1];
    if (!off) continue;
    const tok = tokens[p.index - 1] ?? "";
    const last = groups.at(-1);
    const gap = last ? text.slice(last.end, off.start) : "";
    const joiner = /^[-'’‐–]$/.test(gap);
    const joinable = last !== undefined && last.type === type && off.start >= last.end &&
      !gap.includes("\n") &&
      (p.index === last.lastIndex + 1 || joiner) &&
      (tok.startsWith("##") || bio === "I" || gap === "" || joiner);
    if (last && joinable) {
      last.end = off.end;
      last.scores.push(p.score);
      last.lastIndex = p.index;
    } else {
      groups.push({ type, start: off.start, end: off.end, scores: [p.score], lastIndex: p.index });
    }
  }
  const spans: Span[] = [];
  for (const g of groups) {
    let kind = LABEL_KIND[g.type];
    if (!kind) continue;
    const confidence = g.scores.reduce((a, b) => a + b, 0) / g.scores.length;
    if (confidence < minScore) continue;
    let { start, end } = g;
    while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
    while (end < text.length && WORD_CHAR.test(text[end])) end++;
    const value = text.slice(start, end);
    if (value.trim().length < 2) continue;
    if ((kind === "organisation" || kind === "place") && SCHOOL_RE.test(value)) kind = "school";
    spans.push({
      start,
      end,
      text: value,
      kind,
      source: "ner",
      confidence,
      label: `ner:${g.type}`,
    });
  }
  return spans;
}

type ClassifierSource = TokenClassifier | (() => Promise<TokenClassifier>);

export class NerDetector implements Detector {
  readonly name = "ner";
  readonly findsNames = true;
  private loaded?: Promise<TokenClassifier>;

  /** `classifier` may be a loader; it is called on first use, so a failed load is reported then. */
  constructor(private classifier: ClassifierSource, private opts: NerOptions = {}) {}

  private load(): Promise<TokenClassifier> {
    if (typeof this.classifier !== "function") return Promise.resolve(this.classifier);
    if (!this.loaded) {
      const p = this.classifier();
      this.loaded = p;
      p.catch(() => {
        if (this.loaded === p) this.loaded = undefined;
      });
    }
    return this.loaded;
  }

  async detect(text: string): Promise<Span[]> {
    const classifier = await this.load();
    const minScore = this.opts.minScore ?? 0.6;
    const maxTokens = this.opts.maxTokens ?? 500;
    const out: Span[] = [];
    const queue: Chunk[] = chunkText(text, this.opts.chunkChars ?? 1200);
    while (queue.length) {
      const chunk = queue.shift()!;
      if (!chunk.text.trim()) continue;
      const tokens = classifier.tokenize(chunk.text);
      if (tokens.length > maxTokens && chunk.text.length > 1) {
        const parts = chunkText(chunk.text, Math.ceil(chunk.text.length / 2));
        queue.unshift(...parts.map((p) => ({ offset: p.offset + chunk.offset, text: p.text })));
        continue;
      }
      const preds = await classifier.classify(chunk.text);
      for (const s of groupPredictions(chunk.text, tokens, preds, minScore)) {
        out.push({ ...s, start: s.start + chunk.offset, end: s.end + chunk.offset });
      }
    }
    return out;
  }
}

export function defaultModelDir(): string {
  const env = Deno.env.get("CASEFILE_MODEL_DIR");
  if (env) return env;
  const home = Deno.env.get("HOME") ?? ".";
  return Deno.build.os === "darwin"
    ? `${home}/Library/Caches/casefile/models`
    : `${home}/.cache/casefile/models`;
}

// ── model pinning (ADR 12) ────────────────────────────────────────────────
//
// The model cache is outside the case folder, and a process running as the same user could
// replace the model files with a model that ignores names. So the expected SHA-256 of every file
// the default model loads is fixed in this source and the download is pinned to one Hugging Face
// commit. Each file is read (or downloaded) into memory once, hashed, and those same bytes are
// handed to transformers.js through its custom cache: the library never reads the model from disk
// or the network itself, so a file swapped after the check is never used. A mismatch is a
// detector error: NER fails closed (ADR 6).

/** Relative path → SHA-256 (hex) of every file the model loads. */
export type ModelPin = Record<string, string>;

/** Verified model files: relative path → the exact bytes that were hashed. */
export type ModelFiles = Map<string, Uint8Array<ArrayBuffer>>;

export interface NerModelSpec {
  id: string;
  /** Hugging Face commit hash the files are downloaded from. */
  revision: string;
  files: ModelPin;
}

/**
 * Xenova/bert-base-NER at commit 8e892123…, quantised (q8). Hashes checked on 2026-10-07 against a
 * fresh HTTPS download from huggingface.co at this revision (JSON files) and the Hub's LFS SHA-256
 * for the ONNX weights.
 */
export const DEFAULT_NER_SPEC: NerModelSpec = {
  id: DEFAULT_NER_MODEL,
  revision: "8e892123e8b7c2c0c2bd1dcb598b7d244c4e53aa",
  files: {
    "config.json": "a73a2eccc921bbdea95a94b49a157d3694b5c2abbae7a6f3000e14404a9c31a8",
    "tokenizer.json": "343989712a36cd8b253efeaf8baf6a08b9d2583f78e395e83832e8ee9f8d8ee1",
    "tokenizer_config.json": "5be1a180e9badb4811a6c31502d70fb35a085af5457982937419c42d7530bae6",
    "onnx/model_quantized.onnx": "caaee70a5518ec7f9e46e5308fcc9263a8c227703a9ce46cf61c69a552349648",
  },
};

/** A model other than the default must come with its commit and the hashes of its files. */
/** "owner/name", each part a plain name: no "..", no slashes beyond the one, no leading dot. */
const MODEL_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
/** A relative file path of plain segments: no "..", ".", empty or absolute parts. */
const MODEL_FILE_RE =
  /^(?:[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\/)*[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * Model ids and file names become folder paths and URLs, so they must be plain names. A spec with
 * "../" (or similar) could otherwise write or read outside the model folder.
 */
export function isSafeModelId(id: string): boolean {
  return MODEL_ID_RE.test(id);
}

export function isSafeModelFile(file: string): boolean {
  return file.length <= 200 && MODEL_FILE_RE.test(file);
}

export function checkModelSpec(spec: Partial<NerModelSpec> | undefined): NerModelSpec {
  if (!spec || (spec.id === DEFAULT_NER_SPEC.id && !spec.files)) return DEFAULT_NER_SPEC;
  if (spec.id !== undefined && !isSafeModelId(spec.id)) {
    throw new ModelPinError([`model id ${JSON.stringify(spec.id)} is not a plain "owner/name"`]);
  }
  const badFiles = Object.keys(spec.files ?? {}).filter((f) => !isSafeModelFile(f));
  if (badFiles.length) {
    throw new ModelPinError(badFiles.map((f) => `unsafe file name ${JSON.stringify(f)}`));
  }
  if (
    !spec.id || !spec.revision || !/^[0-9a-f]{40}$/.test(spec.revision) || !spec.files ||
    !Object.keys(spec.files).length ||
    !Object.values(spec.files).every((h) => /^[0-9a-f]{64}$/.test(h))
  ) {
    throw new ModelPinError([
      "a custom NER model needs a commit hash and the SHA-256 of each of its files",
    ]);
  }
  return spec as NerModelSpec;
}

export class ModelPinError extends Error {
  constructor(readonly files: string[]) {
    super(
      `The NER model files are not the expected ones (${files.join(", ")}). ` +
        "Delete the model folder so it is downloaded again.",
    );
    this.name = "ModelPinError";
  }
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Throws ModelPinError unless `found` (path → hash) is exactly `pin`. */
function comparePin(found: Record<string, string>, pin: ModelPin): void {
  const names = new Set([...Object.keys(pin), ...Object.keys(found)]);
  const bad = [...names].filter((n) => pin[n] !== found[n]).sort();
  if (bad.length) throw new ModelPinError(bad);
}

/**
 * Read every file under `dir` once, hash those bytes, and return them if the folder holds exactly
 * the pinned files. The returned bytes are the ones that were hashed, so what is later loaded is
 * what was checked, whatever happens to the folder afterwards. Symlinks are refused.
 */
export async function readVerifiedModelFiles(dir: string, pin: ModelPin): Promise<ModelFiles> {
  const found: Record<string, string> = {};
  const files: ModelFiles = new Map();
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(rel ? `${dir}/${rel}` : dir)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymlink) found[r] = "symlink";
      else if (e.isDirectory) await walk(r);
      else if (e.isFile) {
        const bytes = await Deno.readFile(`${dir}/${r}`);
        found[r] = await sha256(bytes);
        if (Object.hasOwn(pin, r)) files.set(r, bytes);
      }
    }
  };
  try {
    await walk("");
  } catch {
    throw new ModelPinError(["(model folder missing)"]);
  }
  comparePin(found, pin);
  return files;
}

/** Throws ModelPinError unless the files under `dir` are exactly the pinned ones. */
export async function verifyModelPin(dir: string, pin: ModelPin): Promise<void> {
  await readVerifiedModelFiles(dir, pin);
}

/**
 * The HTTPS URL of a model file at the pinned commit. It is also the key transformers.js asks its
 * custom cache for (its default `remoteHost` and `remotePathTemplate`, which we set explicitly).
 */
export function pinnedFileUrl(spec: NerModelSpec, file: string): string {
  return `https://huggingface.co/${spec.id}/resolve/${spec.revision}/${file}`;
}

export type ModelFetch = (url: string) => Promise<Response>;

/**
 * First use: download each pinned file at the pinned commit into memory and check its hash. Only
 * if every file matches are they written to `dir` (via a temporary folder renamed into place);
 * the verified in-memory bytes are returned for loading. Nothing is written on a mismatch.
 */
export async function downloadPinnedModel(
  spec: NerModelSpec,
  dir: string,
  fetchFn: ModelFetch = (url) => fetch(url),
): Promise<ModelFiles> {
  // Never trust a spec's names as paths, whoever built it.
  const unsafe = [
    ...(isSafeModelId(spec.id) ? [] : [`model id ${JSON.stringify(spec.id)}`]),
    ...(/^[0-9a-f]{40}$/.test(spec.revision) ? [] : ["revision"]),
    ...Object.keys(spec.files).filter((f) => !isSafeModelFile(f)).map((f) =>
      `file ${JSON.stringify(f)}`
    ),
  ];
  if (unsafe.length) throw new ModelPinError(unsafe);
  const files: ModelFiles = new Map();
  const found: Record<string, string> = {};
  for (const rel of Object.keys(spec.files)) {
    const res = await fetchFn(pinnedFileUrl(spec, rel));
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Could not download the NER model file ${rel} (HTTP ${res.status}).`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    found[rel] = await sha256(bytes);
    files.set(rel, bytes);
  }
  comparePin(found, spec.files);

  // Cache the verified bytes for next time. Best effort: they are served from memory either way,
  // and the next load verifies the folder again.
  const parent = dir.replace(/\/[^/]*$/, "") || ".";
  await Deno.mkdir(parent, { recursive: true });
  const tmp = await Deno.makeTempDir({ dir: parent, prefix: ".download-" });
  try {
    for (const [rel, bytes] of files) {
      // Defence in depth: every path written must stay inside the temporary folder.
      if (!isSafeModelFile(rel)) {
        throw new ModelPinError([`unsafe file name ${JSON.stringify(rel)}`]);
      }
      const path = `${tmp}/${rel}`;
      await Deno.mkdir(path.replace(/\/[^/]*$/, ""), { recursive: true });
      await Deno.writeFile(path, bytes);
    }
    await Deno.rename(tmp, dir);
  } catch {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a classifier from files that match `pin`. If the model folder exists its files are read
 * into memory and verified; if not (first use), `download` fetches and verifies them. `load` gets
 * the verified bytes and must load the model from those and nothing else. Any mismatch throws
 * ModelPinError and `load` is never called.
 */
export async function loadPinnedClassifier(opts: {
  modelDir: string;
  pin: ModelPin;
  download?: () => Promise<ModelFiles>;
  load: (files: ModelFiles) => Promise<TokenClassifier>;
  /** Test hook: runs after the files are verified and before they are loaded. */
  afterVerify?: () => void | Promise<void>;
}): Promise<TokenClassifier> {
  if (!Object.keys(opts.pin).length) throw new ModelPinError(["(no hashes to check against)"]);
  let files: ModelFiles;
  if (await exists(opts.modelDir)) files = await readVerifiedModelFiles(opts.modelDir, opts.pin);
  else if (opts.download) files = await opts.download();
  else throw new ModelPinError(["(model folder missing)"]);
  await opts.afterVerify?.();
  return await opts.load(files);
}

/** transformers.js asks for this "local model" path first; the cache answers it with nothing. */
const NO_LOCAL_MODELS = "/casefile-no-local-models/";

/** The Web-Cache-like object transformers.js uses when `env.useCustomCache` is on. */
export interface PinnedModelCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  /** Keys that were asked for but are not pinned files; any one fails the load. */
  readonly refused: string[];
}

/** A response whose body cannot be read: transformers.js's read of it rejects with `err`. */
function failingResponse(err: Error): Response {
  return new Response(new ReadableStream({ pull: (c) => c.error(err) }));
}

/**
 * Serve exactly the verified bytes to transformers.js, by the URL it asks for. Any other file it
 * asks for is answered with a response that fails to read (fail closed) rather than "not cached",
 * which would make it fall back to the network or disk. Nothing may be written to it.
 */
export function pinnedModelCache(spec: NerModelSpec, files: ModelFiles): PinnedModelCache {
  const prefix = pinnedFileUrl(spec, "");
  const byUrl = new Map([...files].map(([rel, bytes]) => [pinnedFileUrl(spec, rel), bytes]));
  const refused: string[] = [];
  const refuse = (key: string) => {
    const name = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    refused.push(name);
    return new ModelPinError([`${name} (not a pinned file)`]);
  };
  return {
    refused,
    match(key) {
      // The local-path lookup comes first; "not here" makes transformers.js ask again by URL.
      if (typeof key === "string" && key.startsWith(NO_LOCAL_MODELS)) {
        return Promise.resolve(undefined);
      }
      const bytes = byUrl.get(key);
      if (bytes) return Promise.resolve(new Response(bytes));
      return Promise.resolve(failingResponse(refuse(String(key))));
    },
    put(key) {
      return Promise.reject(refuse(String(key)));
    },
  };
}

/** transformers.js's `env` is global; loads take turns so each sees only its own cache. */
let envTurn: Promise<unknown> = Promise.resolve();

async function transformersPipeline(
  spec: NerModelSpec,
  files: ModelFiles,
): Promise<TokenClassifier> {
  const { pipeline, env } = await import("@huggingface/transformers");
  const cache = pinnedModelCache(spec, files);
  const run = envTurn.catch(() => {}).then(async () => {
    // Model files come only from `cache`. The library's own file-system and browser caches are
    // off, remote downloads are off, and "local models" may only be looked up through the cache
    // (useFS off, so even an unreachable fallback could not read a path from disk).
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.useFS = false;
    env.allowRemoteModels = false;
    env.allowLocalModels = true; // transformers.js refuses to run with both local and remote off
    env.localModelPath = NO_LOCAL_MODELS;
    env.remoteHost = "https://huggingface.co/";
    env.remotePathTemplate = "{model}/resolve/{revision}/";
    env.useCustomCache = true;
    env.customCache = cache;
    try {
      // deno-lint-ignore no-explicit-any
      const pipe: any = await pipeline("token-classification", spec.id, {
        dtype: "q8",
        revision: spec.revision,
      });
      if (cache.refused.length) throw new ModelPinError(cache.refused);
      return pipe;
    } finally {
      // Drop the reference to the model bytes; anything asked for later is refused.
      env.customCache = pinnedModelCache(spec, new Map());
    }
  });
  envTurn = run;
  // deno-lint-ignore no-explicit-any
  const pipe: any = await run;
  return {
    tokenize: (t: string) => pipe.tokenizer.tokenize(t) as string[],
    classify: async (t: string) => (await pipe(t)) as TokenPrediction[],
  };
}

const loaders = new Map<string, Promise<TokenClassifier>>();

/** Where a model's verified files (at a pinned revision) are kept in the cache directory. */
export function modelFilesDir(
  spec: NerModelSpec = DEFAULT_NER_SPEC,
  cacheDir = defaultModelDir(),
): string {
  if (!isSafeModelId(spec.id) || !/^[0-9a-f]{40}$/.test(spec.revision)) {
    throw new ModelPinError([`unsafe model id or revision`]);
  }
  return `${cacheDir}/${spec.id}/${spec.revision}`;
}

/**
 * Load the pinned model once per process. The first call downloads it (about 110 MB, quantised)
 * into the model directory; later calls read it from there. Either way the files are verified in
 * memory and transformers.js is given those bytes, never a path or URL to read itself.
 */
export function loadTransformersClassifier(
  spec: NerModelSpec = DEFAULT_NER_SPEC,
  cacheDir = defaultModelDir(),
): Promise<TokenClassifier> {
  const key = `${spec.id}\0${spec.revision}\0${cacheDir}`;
  let p = loaders.get(key);
  if (!p) {
    const modelDir = modelFilesDir(spec, cacheDir);
    p = loadPinnedClassifier({
      modelDir,
      pin: spec.files,
      download: () => downloadPinnedModel(spec, modelDir),
      load: (files) => transformersPipeline(spec, files),
    });
    loaders.set(key, p);
    p.catch(() => loaders.delete(key));
  }
  return p;
}
