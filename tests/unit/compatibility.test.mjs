import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("addon/manifest.json", "utf8"));
const zotero = manifest.applications.zotero;

test("manifest declares Zotero 9 compatibility", () => {
  assert.equal(zotero.strict_min_version, "6.999");
  assert.equal(zotero.strict_max_version, "9.0.*");
});
