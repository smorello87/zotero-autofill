import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";
globalThis.Zotero = {
  Prefs: { get: () => false },
  CreatorTypes: { getID: () => 1 },
};
globalThis.ztoolkit = { log: () => {} };
const mod = await loadModule("src/modules/enrichment.ts");
test("ambiguous search results do not become automatic metadata", async () => {
  const candidates = [
    {
      title: "Wrong book",
      author: "Other",
      year: "2001",
      result: { publisher: "Wrong" },
    },
  ];
  assert.equal(
    await mod.selectBestCandidate("Actual book", "Smith", 2001, candidates),
    null,
  );
});
test("matching requires exact edition year", async () => {
  const candidates = [
    {
      title: "Actual book",
      author: "Smith",
      year: "1999",
      result: { publisher: "Wrong" },
    },
  ];
  assert.equal(
    await mod.selectBestCandidate("Actual book", "Smith", 2001, candidates),
    null,
  );
});
test("a single exact result can repair a missing author", async () => {
  const result = await mod.selectBestCandidate("Love and Theft", "", 1993, [
    {
      title: "Love and Theft",
      author: "Eric Lott",
      year: "1993",
      result: { publisher: "Oxford University Press" },
    },
  ]);
  assert.equal(result.author, "Eric Lott");
});
test("academic article lookup uses Crossref and returns author and journal fields", async () => {
  const urls = [];
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      urls.push(url);
      return {
        response: {
          message: {
            items: [
              {
                DOI: "10.1234/example",
                URL: "https://doi.org/10.1234/example",
                title: ["A scholarly article"],
                author: [
                  { given: "Ana", family: "Ortiz" },
                  { given: "Luis", family: "Chen" },
                ],
                publisher: "Example Press",
                "container-title": ["Example Journal"],
                volume: "12",
                issue: "3",
                page: "44-59",
                "published-print": { "date-parts": [[2020]] },
              },
            ],
          },
        },
      };
    },
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({ title: "A scholarly article", date: "2020" })[field] || "",
    getCreators: () => [],
  });
  assert.equal(proposal.author, "Ana Ortiz");
  assert.deepEqual(proposal.authors, [
    { given: "Ana", family: "Ortiz" },
    { given: "Luis", family: "Chen" },
  ]);
  assert.equal(proposal.containerTitle, "Example Journal");
  assert.equal(proposal.pages, "44-59");
  assert.match(urls[0], /api\.crossref\.org\/works/);
});

test("academic article matching tolerates Crossref online and print year differences", async () => {
  globalThis.Zotero.HTTP = {
    request: async () => ({
      response: {
        message: {
          items: [
            {
              DOI: "10.1234/online-first",
              URL: "https://doi.org/10.1234/online-first",
              title: ["A scholarly article"],
              author: [{ given: "Ana", family: "Ortiz" }],
              "published-online": { "date-parts": [[2021]] },
            },
          ],
        },
      },
    }),
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({ title: "A scholarly article", date: "2020" })[field] || "",
    getCreators: () => [{ creatorTypeID: 1, lastName: "Ortiz", fieldMode: 0 }],
  });
  assert.equal(proposal.DOI, "10.1234/online-first");
});

test("academic article matching handles abbreviated titles and unaccented author names", async () => {
  globalThis.Zotero.HTTP = {
    request: async () => ({
      response: {
        message: {
          items: [
            {
              DOI: "10.1215/01642472-2152855",
              title: [
                "Gimme Gimme This... Gimme Gimme That: Annihilation and Innovation in the Punk Rock Commons",
              ],
              author: [{ given: "José Esteban", family: "Muñoz" }],
              "published-print": { "date-parts": [[2013]] },
            },
          ],
        },
      },
    }),
  };
  const proposal = await mod.lookupItem({
    itemType: "journalArticle",
    getField: (field) =>
      ({
        title: "Gimme gimme this Gimme gimme that",
        date: "2013",
      })[field] || "",
    getCreators: () => [{ creatorTypeID: 1, lastName: "Munoz", fieldMode: 1 }],
  });
  assert.equal(proposal.DOI, "10.1215/01642472-2152855");
});
test("existing ISBN anchors lookup without title search", async () => {
  const urls = [];
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      urls.push(url);
      return {
        response: {
          isbn_13: ["9780140328721"],
          publishers: ["Puffin"],
          publish_date: "1988",
          title: "Matilda",
        },
      };
    },
  };
  const item = {
    itemType: "book",
    getField: (f) =>
      ({ ISBN: "9780140328721", title: "Matilda", date: "1988" })[f] || "",
    getCreators: () => [],
  };
  const proposal = await mod.lookupItem(item);
  assert.equal(proposal.publisher, "Puffin");
  assert.equal(urls.length, 1);
  assert.match(urls[0], /isbn\/9780140328721/);
});

test("ISBN lookup resolves an Open Library author reference", async () => {
  const urls = [];
  globalThis.Zotero.HTTP = {
    request: async (method, url) => {
      urls.push(url);
      if (url.includes("/authors/")) return { response: { name: "Eric Lott" } };
      return {
        response: {
          isbn_10: ["0195078322"],
          title: "Love and theft",
          authors: [{ key: "/authors/OL2630029A" }],
        },
      };
    },
  };
  const proposal = await mod.lookupItem({
    itemType: "book",
    getField: (field) =>
      ({ ISBN: "0-19-507832-2", title: "Love and Theft", date: "1993" })[
        field
      ] || "",
    getCreators: () => [],
  });

  assert.equal(proposal.author, "Eric Lott");
  assert.deepEqual(proposal.authors, [{ name: "Eric Lott" }]);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /openlibrary\.org\/authors\/OL2630029A\.json$/);
});

test("manual enrichment closes progress before opening and focusing review", async () => {
  const events = [];
  globalThis.addon = {
    data: {
      config: {
        addonName: "Zotero Metadata Assistant",
        addonRef: "zotero-metadata-assistant",
      },
    },
  };
  globalThis.Zotero.Prefs.get = () => false;
  globalThis.Zotero.HTTP = {
    request: async () => ({
      response: {
        isbn_13: ["9780140328721"],
        publishers: ["Puffin"],
        publish_date: "1988",
        title: "Matilda",
      },
    }),
  };
  globalThis.Zotero.getActiveZoteroPane = () => ({
    getSelectedItems: () => [
      {
        id: 42,
        itemType: "book",
        getField: (field) =>
          ({ ISBN: "9780140328721", title: "Matilda", date: "1988" })[field] ||
          "",
        getCreators: () => [],
      },
    ],
  });
  globalThis.Zotero.getMainWindow = () => ({
    openDialog: () => {
      events.push("dialog:open");
      return { focus: () => events.push("dialog:focus") };
    },
  });
  globalThis.ztoolkit.ProgressWindow = class {
    createLine() {
      return this;
    }
    show() {
      events.push("popup:show");
      return this;
    }
    changeLine() {
      return this;
    }
    startCloseTimer() {
      events.push("popup:timer");
      return this;
    }
    close() {
      events.push("popup:close");
      return this;
    }
  };

  await mod.EnrichmentFactory.enrichSelectedItems();

  assert.deepEqual(events, [
    "popup:show",
    "popup:close",
    "dialog:open",
    "dialog:focus",
  ]);
});
