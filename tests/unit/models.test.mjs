import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const preferences = await readFile("addon/content/preferences.xhtml", "utf8");
const defaults = await readFile("addon/prefs.js", "utf8");

test("the model menu contains only the approved open-weight models", () => {
  for (const model of [
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4-pro",
  ]) {
    assert.match(preferences, new RegExp(model.replaceAll("/", "\\/")));
  }
  assert.doesNotMatch(
    preferences,
    /openai\/|anthropic\/|google\/|mistralai\/|qwen\//i,
  );
});

test("AI has no disable preference and uses DeepSeek V4.1 Flash by default", () => {
  assert.doesNotMatch(preferences, /preference="aiEnabled"/);
  assert.doesNotMatch(defaults, /\.aiEnabled/);
  assert.match(defaults, /llmModel"[\s\S]*?"deepseek\/deepseek-v4.1-flash"/);
});
