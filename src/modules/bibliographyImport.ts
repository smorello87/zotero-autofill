/**
 * Bibliography Import module for Zotero Metadata Assistant
 * Handles importing bibliography text via LLM parsing
 */

import { getPref } from "../utils/prefs";
import { isLLMAvailable, parseBibliographyWithLLM } from "./llmClient";
import { enrichItems } from "./enrichment";

// ==================== Types ====================

interface CSLItem {
  type?: string;
  title?: string;
  author?: Array<{ family?: string; given?: string }>;
  editor?: Array<{ family?: string; given?: string }>;
  issued?: { "date-parts"?: number[][] };
  publisher?: string;
  "publisher-place"?: string;
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  ISBN?: string;
  DOI?: string;
  URL?: string;
  abstract?: string;
  note?: string;
  language?: string;
}

interface DialogState {
  window: Window | null;
  parsedItems: CSLItem[];
  failedEntries: string[];
}

// ==================== State ====================

const state: DialogState = {
  window: null,
  parsedItems: [],
  failedEntries: [],
};

// ==================== Helper Functions ====================

// Valid Zotero item types
type ZoteroItemType =
  | "book" | "bookSection" | "journalArticle" | "magazineArticle"
  | "newspaperArticle" | "thesis" | "report" | "manuscript"
  | "document" | "webpage" | "conferencePaper";

/**
 * Map CSL type to Zotero item type
 */
function cslTypeToZotero(cslType: string): ZoteroItemType {
  const typeMap: { [key: string]: ZoteroItemType } = {
    book: "book",
    chapter: "bookSection",
    "article-journal": "journalArticle",
    "article-magazine": "magazineArticle",
    "article-newspaper": "newspaperArticle",
    thesis: "thesis",
    report: "report",
    manuscript: "manuscript",
    pamphlet: "document",
    webpage: "webpage",
    paper: "conferencePaper",
  };
  return typeMap[cslType] || "book";
}

/**
 * Convert CSL-JSON item to Zotero item
 */
async function cslToZoteroItem(csl: CSLItem, libraryID: number): Promise<Zotero.Item | null> {
  try {
    const itemType = cslTypeToZotero(csl.type || "book");
    const item = new Zotero.Item(itemType);
    item.libraryID = libraryID;

    // Title
    if (csl.title) {
      item.setField("title", csl.title);
    }

    // Authors
    if (csl.author && Array.isArray(csl.author)) {
      for (const auth of csl.author) {
        if (auth.family || auth.given) {
          item.setCreator(item.getCreators().length, {
            firstName: auth.given || "",
            lastName: auth.family || "",
            creatorType: "author",
          });
        }
      }
    }

    // Editors
    if (csl.editor && Array.isArray(csl.editor)) {
      for (const ed of csl.editor) {
        if (ed.family || ed.given) {
          item.setCreator(item.getCreators().length, {
            firstName: ed.given || "",
            lastName: ed.family || "",
            creatorType: "editor",
          });
        }
      }
    }

    // Date
    if (csl.issued && csl.issued["date-parts"] && csl.issued["date-parts"][0]) {
      const dateParts = csl.issued["date-parts"][0];
      const year = dateParts[0];
      const month = dateParts[1];
      const day = dateParts[2];

      let dateStr = year?.toString() || "";
      if (month) dateStr += `-${month.toString().padStart(2, "0")}`;
      if (day) dateStr += `-${day.toString().padStart(2, "0")}`;

      if (dateStr) {
        item.setField("date", dateStr);
      }
    }

    // Publisher
    if (csl.publisher) {
      item.setField("publisher", csl.publisher);
    }

    // Place
    if (csl["publisher-place"]) {
      item.setField("place", csl["publisher-place"]);
    }

    // Container title (journal name, book title for chapters)
    if (csl["container-title"]) {
      if (itemType === "journalArticle" || itemType === "magazineArticle") {
        item.setField("publicationTitle", csl["container-title"]);
      } else if (itemType === "bookSection") {
        item.setField("bookTitle", csl["container-title"]);
      }
    }

    // Volume, Issue, Pages
    if (csl.volume) {
      item.setField("volume", csl.volume);
    }
    if (csl.issue) {
      item.setField("issue", csl.issue);
    }
    if (csl.page) {
      item.setField("pages", csl.page);
    }

    // ISBN
    if (csl.ISBN) {
      item.setField("ISBN", csl.ISBN);
    }

    // DOI
    if (csl.DOI) {
      item.setField("DOI", csl.DOI);
    }

    // URL
    if (csl.URL) {
      item.setField("url", csl.URL);
    }

    // Abstract
    if (csl.abstract) {
      item.setField("abstractNote", csl.abstract);
    }

    // Language
    if (csl.language) {
      item.setField("language", csl.language);
    }

    // Note (add to extra field)
    if (csl.note) {
      const extra = item.getField("extra") as string;
      const newExtra = extra ? `${extra}\n${csl.note}` : csl.note;
      item.setField("extra", newExtra);
    }

    return item;
  } catch (error) {
    ztoolkit.log(`Error converting CSL to Zotero item: ${error}`);
    return null;
  }
}

/**
 * Split bibliography text into individual entries
 */
function splitEntries(text: string): string[] {
  // Normalize line endings
  let normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Detect format: if there are blank lines, split on them
  // Otherwise split on single newlines
  let entries: string[];

  if (normalized.includes("\n\n")) {
    // Has blank lines - split on them (Omeka format)
    entries = normalized.split(/\n\n+/);
  } else {
    // No blank lines - each line is an entry
    entries = normalized.split(/\n/);
  }

  // Clean up and filter
  return entries
    .map((e) => e.trim())
    .filter((e) => e.length > 10) // Filter out very short entries
    .filter((e) => !e.match(/^(prev|next|page|home|search|contact)/i)); // Filter navigation
}

// ==================== Dialog Functions ====================

/**
 * Open the bibliography import dialog
 */
export function openImportDialog(): void {
  if (!isLLMAvailable()) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: "Please configure OpenRouter API key in preferences first",
        type: "fail",
      })
      .show();
    return;
  }

  const dialogArgs = {
    onLoad: (win: Window) => {
      state.window = win;
      state.parsedItems = [];
      state.failedEntries = [];

      // Set up input listener for entry count
      const input = win.document.getElementById("bibliography-input") as HTMLTextAreaElement;
      if (input) {
        input.addEventListener("input", () => {
          const entries = splitEntries(input.value);
          const countLabel = win.document.getElementById("entry-count");
          if (countLabel) {
            countLabel.setAttribute("value", `${entries.length} entries detected`);
          }
        });
      }

      // Store args on window for button handlers
      (win as any).dialogArgs = dialogArgs;
    },

    onParse: async () => {
      if (!state.window) return;

      const win = state.window;
      const input = win.document.getElementById("bibliography-input") as HTMLTextAreaElement;
      const parseButton = win.document.getElementById("parse-button") as XULButtonElement;
      const importButton = win.document.getElementById("import-button") as XULButtonElement;
      const progressArea = win.document.getElementById("progress-area");
      const progressLabel = win.document.getElementById("progress-label");
      const progressMeter = win.document.getElementById("progress-meter") as XULProgressMeterElement;
      const resultsArea = win.document.getElementById("results-area");
      const resultsText = win.document.getElementById("results-text");

      const text = input?.value?.trim();
      if (!text) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: "Please enter bibliography text", type: "fail" })
          .show();
        return;
      }

      const entries = splitEntries(text);
      if (entries.length === 0) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: "No valid entries found", type: "fail" })
          .show();
        return;
      }

      // Disable buttons, show progress
      parseButton?.setAttribute("disabled", "true");
      progressArea?.removeAttribute("hidden");
      resultsArea?.setAttribute("hidden", "true");

      try {
        const result = await parseBibliographyWithLLM(entries, 25, (current, total) => {
          const percent = Math.round((current / total) * 100);
          progressLabel?.setAttribute("value", `Processing ${current}/${total} entries...`);
          progressMeter?.setAttribute("value", percent.toString());
        });

        state.parsedItems = result.items;
        state.failedEntries = result.failed;

        // Show results
        progressArea?.setAttribute("hidden", "true");
        resultsArea?.removeAttribute("hidden");

        const successCount = result.items.length;
        const failCount = result.failed.length;
        let resultMsg = `Successfully parsed: ${successCount} items\n`;
        if (failCount > 0) {
          resultMsg += `Failed to parse: ${failCount} entries\n\n`;
          resultMsg += `Failed entries:\n${result.failed.slice(0, 5).map((e) => `- ${e.substring(0, 60)}...`).join("\n")}`;
          if (failCount > 5) {
            resultMsg += `\n... and ${failCount - 5} more`;
          }
        }
        resultsText?.setAttribute("value", resultMsg);
        if (resultsText) {
          resultsText.textContent = resultMsg;
        }

        // Enable import button if we have items
        if (successCount > 0) {
          importButton?.removeAttribute("disabled");
        }
      } catch (error) {
        ztoolkit.log(`Parse error: ${error}`);
        progressArea?.setAttribute("hidden", "true");
        resultsArea?.removeAttribute("hidden");
        if (resultsText) {
          resultsText.textContent = `Error: ${error}`;
        }
      }

      parseButton?.removeAttribute("disabled");
    },

    onImport: async () => {
      if (!state.window || state.parsedItems.length === 0) return;

      const win = state.window;
      const importButton = win.document.getElementById("import-button") as XULButtonElement;
      const autoEnrichCheckbox = win.document.getElementById("auto-enrich") as XULCheckboxElement;
      const resultsText = win.document.getElementById("results-text");

      importButton?.setAttribute("disabled", "true");

      try {
        // Get current library
        const libraryID = Zotero.Libraries.userLibraryID;

        // Convert and save items
        const createdItems: Zotero.Item[] = [];

        for (const cslItem of state.parsedItems) {
          const item = await cslToZoteroItem(cslItem, libraryID);
          if (item) {
            await item.saveTx();
            createdItems.push(item);
          }
        }

        // Auto-enrich if checked
        const shouldEnrich = autoEnrichCheckbox?.checked;
        if (shouldEnrich && createdItems.length > 0) {
          if (resultsText) {
            resultsText.textContent = `Imported ${createdItems.length} items. Enriching metadata...`;
          }

          const stats = await enrichItems(createdItems);

          if (resultsText) {
            resultsText.textContent = `Done! Imported ${createdItems.length} items.\nEnriched: ${stats.found}, Not found: ${stats.notFound}`;
          }
        } else {
          if (resultsText) {
            resultsText.textContent = `Done! Imported ${createdItems.length} items.`;
          }
        }

        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({
            text: `Imported ${createdItems.length} items`,
            type: "success",
          })
          .show();

        // Clear state
        state.parsedItems = [];
      } catch (error) {
        ztoolkit.log(`Import error: ${error}`);
        if (resultsText) {
          resultsText.textContent = `Import error: ${error}`;
        }
        importButton?.removeAttribute("disabled");
      }
    },
  };

  // Open dialog
  const mainWindow = Zotero.getMainWindow();
  mainWindow.openDialog(
    `chrome://${addon.data.config.addonRef}/content/importDialog.xhtml`,
    "zotero-metadata-assistant-import",
    "chrome,dialog,centerscreen,resizable",
    dialogArgs,
  );
}

export class BibliographyImportFactory {
  static openDialog(): void {
    openImportDialog();
  }
}
