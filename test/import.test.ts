import { assert } from "chai";
import { cslToZoteroItem } from "../src/modules/bibliographyImport";

describe("bibliography item conversion", function () {
  it("maps chapter fields and corporate creators with the Zotero item API", function () {
    const item = cslToZoteroItem(
      {
        type: "chapter",
        title: "A chapter",
        "container-title": "Collected essays",
        publisher: "CUNY Press",
        "publisher-place": "New York",
        page: "12–24",
        author: [{ literal: "CUNY AI Lab" }],
        issued: { "date-parts": [[1965, 6, 15]] },
      },
      Zotero.Libraries.userLibraryID,
    );
    assert.equal(item.itemTypeID, Zotero.ItemTypes.getID("bookSection"));
    assert.equal(item.getField("bookTitle"), "Collected essays");
    assert.equal(item.getField("publisher"), "CUNY Press");
    assert.equal(item.getField("date"), "1965-06-15");
    assert.equal(item.getCreators()[0].lastName, "CUNY AI Lab");
    assert.equal(item.getCreators()[0].fieldMode, 1);
    assert.include(
      String(item.getField("extra")),
      "CUNY AI Lab bibliography import",
    );
  });

  it("maps newspaper containers and preserves unsupported metadata", function () {
    const item = cslToZoteroItem(
      {
        type: "article-newspaper",
        title: "A report",
        "container-title": "The City Paper",
        publisher: "Archive Press",
        DOI: "10.1234/example",
        author: [{ family: "Ortiz", given: "Ana" }],
      },
      Zotero.Libraries.userLibraryID,
    );
    assert.equal(item.itemTypeID, Zotero.ItemTypes.getID("newspaperArticle"));
    assert.equal(item.getField("publicationTitle"), "The City Paper");
    assert.equal(item.getCreators()[0].lastName, "Ortiz");
    assert.isTrue(
      item.getField("publisher") === "Archive Press" ||
        String(item.getField("extra")).includes("publisher: Archive Press"),
      "publisher is preserved in its native field or Extra",
    );
  });

  it("maps conference proceedings title", function () {
    const item = cslToZoteroItem(
      {
        type: "paper-conference",
        title: "Methods",
        "container-title": "Annual meeting proceedings",
      },
      Zotero.Libraries.userLibraryID,
    );
    assert.equal(item.itemTypeID, Zotero.ItemTypes.getID("conferencePaper"));
    assert.equal(
      item.getField("proceedingsTitle"),
      "Annual meeting proceedings",
    );
  });
});
