import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";
const {
  splitEntries,
  duplicateKeys,
  validateEditedItem,
  escapeHTML,
  reviewWarnings,
} = await loadModule("src/modules/bibliographyValidation.ts");

test("segmentation retains short citations and titles starting with navigation words", () => {
  assert.deepEqual(
    splitEntries("Home.\r\n\r\nContact zones.\r\nPratt, 1991.\r\n\r\n短文。"),
    ["Home.", "Contact zones.\nPratt, 1991.", "短文。"],
  );
  assert.deepEqual(splitEntries("A\nB"), ["A", "B"]);
});
test("duplicate identifiers normalize DOI URLs and equivalent ISBN editions", () => {
  assert.deepEqual(
    duplicateKeys({ DOI: "https://doi.org/10.1000/ABC" }),
    duplicateKeys({ DOI: "doi:10.1000/abc" }),
  );
  assert.deepEqual(
    duplicateKeys({ ISBN: "0-306-40615-2" }),
    duplicateKeys({ ISBN: "9780306406157" }),
  );
});
test("citation duplicates preserve multilingual distinctions and require title author year", () => {
  const a = {
    title: "Contact Zones!",
    author: [{ family: "Pratt" }],
    issued: { "date-parts": [[1991]] },
  };
  assert.deepEqual(
    duplicateKeys(a),
    duplicateKeys({ ...a, title: "Contact zones" }),
  );
  assert.notDeepEqual(
    duplicateKeys({ ...a, title: "漢字" }),
    duplicateKeys({ ...a, title: "文字" }),
  );
  assert.deepEqual(duplicateKeys({ title: "A title" }), []);
});
test("review requires a title and validates edited creator/date structures", () => {
  assert.throws(() => validateEditedItem({ title: " " }), /Title is required/);
  assert.throws(
    () => validateEditedItem({ title: "Book", author: "Smith" }),
    /author/,
  );
  assert.throws(
    () => validateEditedItem({ title: "Book", editor: [null] }),
    /editor/,
  );
  assert.throws(
    () =>
      validateEditedItem({
        title: "Book",
        issued: { "date-parts": [[2020, 13]] },
      }),
    /date parts/,
  );
  assert.throws(
    () =>
      validateEditedItem({ title: "Book", issued: { "date-parts": [[NaN]] } }),
    /date parts/,
  );
  assert.equal(
    validateEditedItem({ title: "Book", author: [{ literal: "CUNY AI Lab" }] })
      .title,
    "Book",
  );
  assert.equal(reviewWarnings({ title: "Book" }).length, 2);
});
test("provenance text cannot create active note markup", () => {
  assert.equal(
    escapeHTML("<script>\"&'</script>"),
    "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;",
  );
});
