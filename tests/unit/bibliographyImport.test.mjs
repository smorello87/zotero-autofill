import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers.mjs";
class Element {
  children = [];
  attributes = new Map();
  value = "";
  checked = false;
  textContent = "";
  style = {};
  listeners = {};
  setAttribute(key, value) {
    this.attributes.set(key, value);
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  hasAttribute(key) {
    return this.attributes.has(key);
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }
}
function windowMock() {
  const elements = new Map();
  return {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElementNS() {
        return new Element();
      },
      createTextNode(text) {
        return text;
      },
      querySelectorAll() {
        return [];
      },
    },
    addEventListener() {},
  };
}
const windows = [];
const items = [];
let failSecond = true;
let requestGate;
class Item {
  fields = {};
  creators = [];
  itemTypeID = 1;
  constructor(type) {
    this.type = type;
  }
  setField(field, value) {
    this.fields[field] = value;
  }
  setCreator(index, value) {
    this.creators[index] = value;
  }
  getCreators() {
    return this.creators;
  }
  addToCollection(id) {
    this.collectionID = id;
  }
  setNote(value) {
    this.note = value;
  }
  async save() {
    if (this.fields.title === "Second" && failSecond)
      throw new Error("simulated disk error");
    this.id = items.length + 1;
    items.push(this);
    return this.id;
  }
}
globalThis.addon = { data: { config: { addonRef: "test" } } };
globalThis.ztoolkit = { log() {} };
globalThis.Zotero = {
  Prefs: {
    get(key) {
      return key.endsWith("openrouterApiKey")
        ? "key"
        : "deepseek/deepseek-v4.1-flash";
    },
  },
  getActiveZoteroPane() {
    return {
      getSelectedLibraryID: () => 42,
      getSelectedCollection: () => ({ id: 7, libraryID: 42, name: "Research" }),
    };
  },
  Libraries: {
    userLibraryID: 1,
    get() {
      return { name: "Lab group", editable: true };
    },
  },
  getMainWindow() {
    return {
      openDialog(_url, _name, _features, args) {
        const win = windowMock();
        windows.push({ win, args });
        args.onLoad(win);
      },
    };
  },
  Item,
  ItemFields: { getID: () => 1, isValidForType: () => true },
  CreatorTypes: { getID: () => 1 },
  Items: {
    async getAll() {
      return [];
    },
  },
  DB: {
    async executeTransaction(callback) {
      const count = items.length;
      try {
        await callback();
      } catch (error) {
        items.splice(count);
        throw error;
      }
    },
  },
  HTTP: {
    async request() {
      if (requestGate) await requestGate;
      return {
        response: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    { sourceIndex: 0, type: "book", title: "First" },
                    { sourceIndex: 1, type: "book", title: "Second" },
                  ],
                }),
              },
            },
          ],
        },
      };
    },
  },
};
const { openImportDialog } = await loadModule(
  "src/modules/bibliographyImport.ts",
);
test("dialog saves destination and provenance; retry does not duplicate committed entries", async () => {
  openImportDialog();
  const { win, args } = windows.at(-1);
  win.document.getElementById("bibliography-input").value =
    "<original first>\n\noriginal second";
  await args.onParse();
  await args.onImport();
  assert.equal(items.filter((item) => item.type === "book").length, 1);
  assert.equal(items[0].libraryID, 42);
  assert.equal(items[0].collectionID, 7);
  assert.match(items[1].note, /&lt;original first&gt;/);
  assert.match(items[1].note, /deepseek\/deepseek-v4.1-flash/);
  failSecond = false;
  await args.onImport();
  await args.onImport();
  assert.deepEqual(
    items
      .filter((item) => item.type === "book")
      .map((item) => item.fields.title),
    ["First", "Second"],
  );
  assert.equal(items.filter((item) => item.type === "note").length, 2);
});
test("independent windows cannot import another dialog state; parsing blocks import races", async () => {
  openImportDialog();
  const { win, args } = windows.at(-1);
  const count = items.length;
  await args.onImport();
  assert.equal(items.length, count);
  win.document.getElementById("bibliography-input").value = "one\n\ntwo";
  let release;
  requestGate = new Promise((resolve) => (release = resolve));
  const pending = args.onParse();
  await args.onImport();
  assert.equal(items.length, count);
  release();
  await pending;
  requestGate = undefined;
  assert.match(
    win.document.getElementById("results-text").textContent,
    /Review all 2/,
  );
});
