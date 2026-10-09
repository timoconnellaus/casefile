/**
 * Finding 9: the generated Claude Code settings sandbox Claude's commands, and the NER model files
 * are pinned by SHA-256, and the bytes that are hashed are the bytes the model is loaded from
 * (ADR 3, ADR 12).
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  checkModelSpec,
  DEFAULT_NER_SPEC,
  downloadPinnedModel,
  loadPinnedClassifier,
  type ModelFiles,
  modelFilesDir,
  type ModelPin,
  ModelPinError,
  type NerModelSpec,
  pinnedFileUrl,
  pinnedModelCache,
  type TokenClassifier,
  verifyModelPin,
} from "../src/core/detect/ner.ts";
import { publishedCase } from "./fixtures/case.ts";
import { tempDir } from "./fixtures/synthetic.ts";

Deno.test("the case's .claude/settings.json enables a strict sandbox and denies app folders", async () => {
  const { s, dir } = await publishedCase();
  const settings = JSON.parse(await Deno.readTextFile(join(dir, ".claude", "settings.json")));
  assertEquals(settings.sandbox.enabled, true);
  assertEquals(settings.sandbox.failIfUnavailable, true);
  assertEquals(settings.sandbox.allowUnsandboxedCommands, false);
  assertEquals(settings.sandbox.network.allowLocalBinding, false);
  assertEquals(settings.sandbox.network.allowedDomains, undefined, "no host is pre-allowed");
  for (const d of ["./vault", "~/Library/Application Support/casefile", "~/.cache/casefile"]) {
    assert(settings.sandbox.filesystem.denyRead.includes(d), `denyRead ${d}`);
    assert(settings.sandbox.filesystem.denyWrite.includes(d), `denyWrite ${d}`);
  }
  assert(settings.permissions.deny.includes("Read(~/Library/Caches/casefile/**)"));
  assert(settings.permissions.deny.includes("Edit(~/.config/casefile/**)"));
  s.close();
});

Deno.test("the case's settings deny Claude Code's web tools and artifacts (PD-AI 5.4)", async () => {
  const { s, dir } = await publishedCase();
  const settings = JSON.parse(await Deno.readTextFile(join(dir, ".claude", "settings.json")));
  // Bare tool names remove the tools entirely (https://code.claude.com/docs/en/permissions).
  for (const tool of ["WebSearch", "WebFetch", "Artifact"]) {
    assert(settings.permissions.deny.includes(tool), `deny ${tool}`);
  }
  assertEquals(settings.enableArtifact, false);
  const guide = await Deno.readTextFile(join(dir, "CLAUDE.md"));
  assert(guide.includes("Do not search the web or fetch URLs"), "guide forbids web access");
  assert(guide.includes("Do not save case text"), "guide forbids saving case content to files");
  s.close();
});

const fakeClassifier: TokenClassifier = {
  tokenize: () => [],
  classify: () => Promise.resolve([]),
};

async function sha(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A synthetic model folder and the hashes it should have. */
async function modelDir() {
  const dir = join(await tempDir("casefile-model-"), "model");
  await Deno.mkdir(join(dir, "onnx"), { recursive: true });
  await Deno.writeTextFile(join(dir, "config.json"), "{}");
  await Deno.writeTextFile(join(dir, "onnx", "model_quantized.onnx"), "weights");
  const pin: ModelPin = {
    "config.json": await sha("{}"),
    "onnx/model_quantized.onnx": await sha("weights"),
  };
  const spec: NerModelSpec = { id: "test/ner", revision: "c".repeat(40), files: pin };
  return { dir, pin, spec };
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

Deno.test("the default model's files are pinned in the source to a fixed revision", () => {
  assertEquals(DEFAULT_NER_SPEC.revision.length, 40);
  assertEquals(Object.keys(DEFAULT_NER_SPEC.files).sort(), [
    "config.json",
    "onnx/model_quantized.onnx",
    "tokenizer.json",
    "tokenizer_config.json",
  ]);
  assert(modelFilesDir(DEFAULT_NER_SPEC, "/c").endsWith(`/${DEFAULT_NER_SPEC.revision}`));
  assertEquals(checkModelSpec(undefined), DEFAULT_NER_SPEC);
  assertEquals(
    pinnedFileUrl(DEFAULT_NER_SPEC, "onnx/model_quantized.onnx"),
    `https://huggingface.co/Xenova/bert-base-NER/resolve/${DEFAULT_NER_SPEC.revision}/onnx/model_quantized.onnx`,
  );
});

Deno.test("a custom model must come with its revision and file hashes", () => {
  assertThrows(() => checkModelSpec({ id: "someone/other-ner" }), ModelPinError);
  assertThrows(
    () => checkModelSpec({ id: "someone/other-ner", revision: "a".repeat(40), files: {} }),
    ModelPinError,
  );
  const ok = { id: "someone/other-ner", revision: "a".repeat(40), files: { "x": "b".repeat(64) } };
  assertEquals(checkModelSpec(ok), ok);
});

Deno.test("model files are checked against the pin before every load", async () => {
  const { dir, pin } = await modelDir();
  let loads = 0;
  const load = () => {
    loads++;
    return Promise.resolve(fakeClassifier);
  };
  await loadPinnedClassifier({ modelDir: dir, pin, load });
  assertEquals(loads, 1);

  // Swapped weights (e.g. a model that ignores names): refused before loading.
  await Deno.writeTextFile(join(dir, "onnx", "model_quantized.onnx"), "other weights");
  const err = await assertRejects(
    () => loadPinnedClassifier({ modelDir: dir, pin, load }),
    ModelPinError,
  );
  assertEquals(err.files, ["onnx/model_quantized.onnx"]);
  assertEquals(loads, 1, "the tampered model is never loaded");

  // An extra file is a change too.
  await Deno.writeTextFile(join(dir, "onnx", "model_quantized.onnx"), "weights");
  await Deno.writeTextFile(join(dir, "extra.onnx"), "x");
  await assertRejects(() => loadPinnedClassifier({ modelDir: dir, pin, load }), ModelPinError);

  // A missing folder with no way to download it is refused.
  await assertRejects(
    () => loadPinnedClassifier({ modelDir: join(dir, "nope"), pin, load }),
    ModelPinError,
  );
});

Deno.test("a file swapped on disk after the check is not what gets loaded", async () => {
  const { dir, pin, spec } = await modelDir();
  const onnx = join(dir, "onnx", "model_quantized.onnx");
  let served = "";
  await loadPinnedClassifier({
    modelDir: dir,
    pin,
    // The race: another process replaces the weights between the check and the load.
    afterVerify: () => Deno.writeTextFile(onnx, "weights that ignore names"),
    load: async (files: ModelFiles) => {
      const cache = pinnedModelCache(spec, files);
      const r = await cache.match(pinnedFileUrl(spec, "onnx/model_quantized.onnx"));
      served = await r!.text();
      return fakeClassifier;
    },
  });
  assertEquals(await Deno.readTextFile(onnx), "weights that ignore names");
  assertEquals(served, "weights", "the cache serves the bytes that were hashed");
});

Deno.test("the model cache refuses files that are not pinned (fail closed)", async () => {
  const { dir, pin, spec } = await modelDir();
  const files: ModelFiles = new Map();
  for (const f of Object.keys(pin)) {
    files.set(f, new Uint8Array(await Deno.readFile(join(dir, f))));
  }
  const cache = pinnedModelCache(spec, files);
  assertEquals(
    text(
      new Uint8Array(await (await cache.match(pinnedFileUrl(spec, "config.json")))!.arrayBuffer()),
    ),
    "{}",
  );

  // transformers.js asks for its "local model" path first; that is never answered from disk.
  assertEquals(await cache.match("/casefile-no-local-models/test/ner/config.json"), undefined);

  // An unpinned file, the same file at another revision, or another model: a response that
  // cannot be read (never "not cached", which would let the library fetch or read it itself).
  for (
    const key of [
      pinnedFileUrl(spec, "tokenizer.json"),
      pinnedFileUrl({ ...spec, revision: "d".repeat(40) }, "config.json"),
      "https://huggingface.co/evil/ner/resolve/main/config.json",
    ]
  ) {
    const r = await cache.match(key);
    assert(r, `answered ${key}`);
    await assertRejects(() => r.arrayBuffer(), ModelPinError);
  }
  assertEquals(cache.refused.length, 3);
  assertEquals(cache.refused[0], "tokenizer.json");
  // Nothing can be written into it.
  await assertRejects(
    () => cache.put(pinnedFileUrl(spec, "config.json"), new Response("x")),
    ModelPinError,
  );
});

Deno.test("a first download that does not match the pin is refused and nothing is written", async () => {
  const { dir, pin, spec } = await modelDir();
  await Deno.remove(dir, { recursive: true });
  const asked: string[] = [];
  const tamperedFetch = (url: string) => {
    asked.push(url);
    const body = url.endsWith("config.json") ? "{}" : "tampered";
    return Promise.resolve(new Response(body));
  };
  let loads = 0;
  const err = await assertRejects(
    () =>
      loadPinnedClassifier({
        modelDir: dir,
        pin,
        download: () => downloadPinnedModel(spec, dir, tamperedFetch),
        load: () => {
          loads++;
          return Promise.resolve(fakeClassifier);
        },
      }),
    ModelPinError,
  );
  assertEquals(err.files, ["onnx/model_quantized.onnx"]);
  assertEquals(loads, 0);
  assertEquals(asked.sort(), Object.keys(pin).map((f) => pinnedFileUrl(spec, f)).sort());
  assertEquals([...Deno.readDirSync(join(dir, ".."))], [], "nothing written to the cache");

  // A good download is verified, cached, and the in-memory bytes are what get loaded.
  const goodFetch = (url: string) =>
    Promise.resolve(new Response(url.endsWith("config.json") ? "{}" : "weights"));
  let got: ModelFiles | undefined;
  await loadPinnedClassifier({
    modelDir: dir,
    pin,
    download: () => downloadPinnedModel(spec, dir, goodFetch),
    load: (files) => {
      got = files;
      return Promise.resolve(fakeClassifier);
    },
  });
  assertEquals(text(got?.get("onnx/model_quantized.onnx")), "weights");
  await verifyModelPin(dir, pin);

  // An empty pin is never accepted.
  await assertRejects(
    () =>
      loadPinnedClassifier({ modelDir: dir, pin: {}, load: () => Promise.resolve(fakeClassifier) }),
    ModelPinError,
  );
});

Deno.test({
  name: "the pinned hashes match a real copy of the default model, if one is cached here",
  ignore: !(() => {
    try {
      Deno.statSync(modelFilesDir(DEFAULT_NER_SPEC));
      return true;
    } catch {
      return false;
    }
  })(),
  fn: async () => {
    await verifyModelPin(modelFilesDir(DEFAULT_NER_SPEC), DEFAULT_NER_SPEC.files);
  },
});

Deno.test("model ids and file names that could escape the model folder are refused", async () => {
  const {
    checkModelSpec,
    downloadPinnedModel,
    isSafeModelFile,
    isSafeModelId,
    modelFilesDir,
    ModelPinError,
  } = await import("../src/core/detect/ner.ts");
  const hash = "a".repeat(64);
  const revision = "b".repeat(40);
  for (
    const id of [
      "../evil",
      "owner/../x",
      "owner/name/extra",
      "/abs/name",
      "owner/.hidden",
      "owner/na me",
      "owner\\name",
      "..",
    ]
  ) {
    assertEquals(isSafeModelId(id), false, id);
    assertThrows(
      () => checkModelSpec({ id, revision, files: { "config.json": hash } }),
      ModelPinError,
    );
    assertThrows(
      () => modelFilesDir({ id, revision, files: { "config.json": hash } }, "/tmp/m"),
      ModelPinError,
    );
  }
  for (const f of ["../x.json", "a/../../x", "/etc/passwd", "a//b", "./x", "a/.", "x\\y", ""]) {
    assertEquals(isSafeModelFile(f), false, f);
    assertThrows(
      () => checkModelSpec({ id: "owner/name", revision, files: { [f]: hash } }),
      ModelPinError,
    );
  }
  assertEquals(isSafeModelId("Xenova/bert-base-NER"), true);
  assertEquals(isSafeModelFile("onnx/model_quantized.onnx"), true);
  // The downloader refuses before fetching anything.
  let fetched = 0;
  const dir = await Deno.makeTempDir();
  await assertRejects(
    () =>
      downloadPinnedModel(
        { id: "owner/name", revision, files: { "../../escape.txt": hash } },
        `${dir}/models/owner/name/${revision}`,
        () => {
          fetched++;
          return Promise.resolve(new Response("x"));
        },
      ),
    ModelPinError,
  );
  assertEquals(fetched, 0);
  assertEquals([...Deno.readDirSync(dir)].length, 0);
});
