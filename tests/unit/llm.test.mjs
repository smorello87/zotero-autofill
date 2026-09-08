import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";

let response;
let selectedModel = "deepseek/deepseek-v4-flash";
let selectedProvider = "cail";
let openrouterKey = "";
let cailKey = "cail-test-key";
let lastRequest;
globalThis.Zotero = {
  Prefs: {
    get: (key) => {
      if (key.endsWith(".openrouterApiKey")) return openrouterKey;
      if (key.endsWith(".cailApiKey")) return cailKey;
      if (key.endsWith(".aiProvider")) return selectedProvider;
      return selectedModel;
    },
  },
  HTTP: {
    request: async (...args) => {
      lastRequest = args;
      return {
        response: {
          choices: [{ message: { content: JSON.stringify(response) } }],
        },
      };
    },
  },
};
globalThis.ztoolkit = { log() {} };
const llm = await loadModule("src/modules/llmClient.ts");

test("an API key makes AI available without a separate enable preference", () => {
  assert.equal(llm.isLLMAvailable(), true);
});

test("CUNY requests use the gateway endpoint and app header", async () => {
  response = { selectedIndex: null, confidence: 0 };
  await llm.callOpenRouter([{ role: "user", content: "test" }]);
  assert.equal(
    lastRequest[1],
    "https://tools.ailab.gc.cuny.edu/v1/chat/completions",
  );
  assert.equal(
    lastRequest[2].headers["X-CAIL-App"],
    "zotero-metadata-assistant",
  );
});

test("missing CUNY key returns an actionable error", async () => {
  cailKey = "";
  const result = await llm.callOpenRouter([]);
  assert.equal(result.success, false);
  assert.match(result.error, /CUNY AI Lab Gateway API key is missing/);
  cailKey = "cail-test-key";
});

test("a legacy proprietary preference falls back to the open-weight default", () => {
  selectedModel = "openai/gpt-4o-mini";
  assert.equal(llm.getConfiguredModel(), "deepseek/deepseek-v4-flash");
  selectedModel = "deepseek/deepseek-v4-flash";
});

test("disambiguation rejects invalid indexes and confidence without selecting first", async () => {
  const candidates = [{ title: "A" }, { title: "B" }];
  for (const invalid of [
    { selectedIndex: "0", confidence: 0.9 },
    { selectedIndex: 3, confidence: 0.9 },
    { selectedIndex: 0 },
    { selectedIndex: 0, confidence: 2 },
  ]) {
    response = invalid;
    assert.equal(await llm.llmDisambiguate("A", "B", null, candidates), null);
  }
  response = { selectedIndex: null, confidence: 0 };
  assert.deepEqual(await llm.llmDisambiguate("A", "B", null, candidates), {
    selectedIndex: null,
    confidence: 0,
    reasoning: undefined,
  });
});

test("single candidate still needs assessment", async () => {
  response = { selectedIndex: null, confidence: 0 };
  assert.equal(
    (await llm.llmDisambiguate("A", "B", null, [{ title: "C" }])).selectedIndex,
    null,
  );
});

test("query cleanup rejects malformed types", async () => {
  response = { title: { text: "Book" }, author: "Name" };
  assert.equal(await llm.llmCleanupQuery("Book", "Name"), null);
});

test("bibliography maps reordered output and identifies omitted and duplicate entries", async () => {
  response = {
    items: [
      {
        sourceIndex: 2,
        type: "book",
        title: "三",
        author: [{ literal: "CUNY AI Lab" }],
      },
      { sourceIndex: 0, type: "book", title: "One" },
    ],
  };
  let result = await llm.parseBibliographyWithLLM(["one", "two", "three"]);
  assert.equal(result.entries[0].item.title, "One");
  assert.equal(result.entries[2].item.author[0].literal, "CUNY AI Lab");
  assert.equal(result.entries[2].item.sourceIndex, undefined);
  assert.deepEqual(result.failed, ["two"]);
  assert.match(result.entries[1].error, /omitted/);
  response = {
    items: [
      { sourceIndex: 0, type: "book", title: "A" },
      { sourceIndex: 0, type: "book", title: "B" },
    ],
  };
  result = await llm.parseBibliographyWithLLM(["one"]);
  assert.match(result.entries[0].error, /Duplicate/);
  assert.equal(result.items.length, 0);
});

test("bibliography rejects malformed CSL and untraceable responses", async () => {
  for (const items of [
    [{ type: "book", title: "A" }],
    [{ sourceIndex: 9, type: "book", title: "A" }],
    [{ sourceIndex: 0, type: "book", title: "A", author: "Name" }],
    [
      {
        sourceIndex: 0,
        type: "book",
        title: "A",
        issued: { "date-parts": [[2000, 13]] },
      },
    ],
  ]) {
    response = { items };
    const result = await llm.parseBibliographyWithLLM(["citation"]);
    assert.equal(result.items.length, 0);
    assert.equal(result.entries[0].original, "citation");
    assert.ok(result.entries[0].error);
  }
});
