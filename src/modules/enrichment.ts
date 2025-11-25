/**
 * Enrichment module for Zotero Metadata Assistant
 * Searches Open Library and Google Books to fill missing metadata
 * Includes LLM-enhanced features: fuzzy matching fallback and disambiguation
 */

import { getPref } from "../utils/prefs";
import { isLLMAvailable, llmCleanupQuery, llmDisambiguate } from "./llmClient";

// ==================== Types ====================

interface EnrichmentResult {
  ISBN?: string;
  OCLC?: string;
  LCCN?: string;
  publisher?: string;
  place?: string;
  numPages?: number;
  date?: string;
  tags?: string[];
  abstractNote?: string;
}

interface APICandidate {
  title?: string;
  author?: string;
  year?: string;
  publisher?: string;
  isbn?: string;
  result: EnrichmentResult;
}

interface EnrichmentStats {
  found: number;
  notFound: number;
  preIsbn: number;
  skipped: number;
}

// ==================== Helper Functions ====================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get year from a Zotero item's date field
 */
function getYearFromItem(item: Zotero.Item): number | null {
  const date = item.getField("date") as string;
  if (date) {
    const match = date.match(/(\d{4})/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Get first author's last name from a Zotero item
 */
function getFirstAuthor(item: Zotero.Item): string {
  const creators = item.getCreators();
  if (creators && creators.length > 0) {
    // Find an author - creatorTypeID 1 is typically "author" in Zotero
    // Use getCreatorTypeID to check creator type properly
    const authorTypeID = Zotero.CreatorTypes.getID("author");
    const author = creators.find((c) => c.creatorTypeID === authorTypeID);
    if (author) {
      return author.lastName || "";
    }
    // Fall back to first creator
    return creators[0].lastName || "";
  }
  return "";
}

// ==================== API Search Functions ====================

/**
 * Fetch detailed edition data from Open Library using ISBN
 */
async function fetchOpenLibraryEdition(isbn: string): Promise<EnrichmentResult | null> {
  const url = `https://openlibrary.org/isbn/${isbn}.json`;

  try {
    const response = await Zotero.HTTP.request("GET", url, {
      timeout: 10000,
      responseType: "json",
    });

    const data = response.response as any;
    const result: EnrichmentResult = {};

    // Publisher
    if (data.publishers && data.publishers.length > 0) {
      result.publisher = data.publishers[0];
    }

    // Place
    if (data.publish_places && data.publish_places.length > 0) {
      result.place = data.publish_places[0];
    }

    // Number of pages
    if (data.number_of_pages) {
      result.numPages = data.number_of_pages;
    }

    // Publication date
    if (data.publish_date) {
      // Extract year from date string like "2020" or "January 2020"
      const yearMatch = data.publish_date.match(/(\d{4})/);
      if (yearMatch) {
        result.date = yearMatch[1];
      }
    }

    // Description/abstract
    if (data.description) {
      const desc = typeof data.description === "string"
        ? data.description
        : data.description.value || "";
      if (desc) {
        result.abstractNote = desc.length > 500 ? desc.substring(0, 497) + "..." : desc;
      }
    }

    // LCCN
    if (data.lccn && data.lccn.length > 0) {
      result.LCCN = data.lccn[0];
    }

    // OCLC from identifiers
    if (data.oclc_numbers && data.oclc_numbers.length > 0) {
      result.OCLC = data.oclc_numbers[0];
    }

    ztoolkit.log(`Open Library edition data for ISBN ${isbn}: publisher=${result.publisher}, place=${result.place}, pages=${result.numPages}`);

    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    ztoolkit.log(`Open Library edition fetch error for ISBN ${isbn}: ${error}`);
    return null;
  }
}

/**
 * Parse an Open Library search doc into EnrichmentResult
 */
function parseOpenLibraryDoc(doc: any): EnrichmentResult {
  const result: EnrichmentResult = {};

  // Get ISBNs (prefer ISBN-13)
  if (doc.isbn && doc.isbn.length > 0) {
    const isbn13 = doc.isbn.find((i: string) => i.length === 13);
    const isbn10 = doc.isbn.find((i: string) => i.length === 10);
    result.ISBN = isbn13 || isbn10;
  }

  // Get OCLC numbers
  if (doc.oclc && doc.oclc.length > 0) {
    result.OCLC = Array.isArray(doc.oclc) ? doc.oclc[0] : doc.oclc;
  }

  // Get LCCN
  if (doc.lccn && doc.lccn.length > 0) {
    result.LCCN = Array.isArray(doc.lccn) ? doc.lccn[0] : doc.lccn;
  }

  // Get page count (median across editions from search)
  if (doc.number_of_pages_median) {
    result.numPages = doc.number_of_pages_median;
  }

  // Get publisher (from search - may not always be present)
  if (doc.publisher && doc.publisher.length > 0) {
    result.publisher = Array.isArray(doc.publisher)
      ? doc.publisher[0]
      : doc.publisher;
  }

  // Get publisher place (from search - rarely present)
  if (doc.publish_place && doc.publish_place.length > 0) {
    result.place = Array.isArray(doc.publish_place)
      ? doc.publish_place[0]
      : doc.publish_place;
  }

  // Get publication year
  if (doc.first_publish_year) {
    result.date = doc.first_publish_year.toString();
  }

  // Get subjects/keywords (limit to first 5)
  if (doc.subject && doc.subject.length > 0) {
    result.tags = doc.subject.slice(0, 5);
  }

  return result;
}

/**
 * Merge two enrichment results, preferring non-empty values from the second
 */
function mergeEnrichmentResults(base: EnrichmentResult, additional: EnrichmentResult): EnrichmentResult {
  return {
    ISBN: base.ISBN || additional.ISBN,
    OCLC: base.OCLC || additional.OCLC,
    LCCN: base.LCCN || additional.LCCN,
    publisher: additional.publisher || base.publisher,
    place: additional.place || base.place,
    numPages: additional.numPages || base.numPages,
    date: additional.date || base.date,
    tags: base.tags || additional.tags,
    abstractNote: additional.abstractNote || base.abstractNote,
  };
}

/**
 * Search Open Library for book metadata
 * Returns multiple candidates for LLM disambiguation
 */
export async function searchOpenLibrary(
  title: string,
  author: string,
  year: number | null,
): Promise<{ candidates: APICandidate[]; bestResult: EnrichmentResult | null }> {
  const params = new URLSearchParams();
  params.set("title", title);
  if (author) params.set("author", author);
  if (year) params.set("first_publish_year", year.toString());
  params.set("limit", "5");

  const url = `https://openlibrary.org/search.json?${params.toString()}`;

  try {
    const response = await Zotero.HTTP.request("GET", url, {
      timeout: 10000,
      responseType: "json",
    });

    const data = response.response as any;

    if (data.numFound > 0 && data.docs && data.docs.length > 0) {
      const candidates: APICandidate[] = [];

      for (const doc of data.docs.slice(0, 5)) {
        const result = parseOpenLibraryDoc(doc);
        if (Object.keys(result).length > 0) {
          candidates.push({
            title: doc.title,
            author: doc.author_name?.[0],
            year: doc.first_publish_year?.toString(),
            publisher: doc.publisher?.[0],
            isbn: result.ISBN,
            result,
          });
        }
      }

      return {
        candidates,
        bestResult: candidates.length > 0 ? candidates[0].result : null,
      };
    }
  } catch (error) {
    ztoolkit.log(`Open Library search error: ${error}`);
  }

  return { candidates: [], bestResult: null };
}

/**
 * Parse Google Books volumeInfo into EnrichmentResult
 */
function parseGoogleBooksVolume(volumeInfo: any): EnrichmentResult {
  const result: EnrichmentResult = {};

  // Get ISBNs from industryIdentifiers
  const identifiers = volumeInfo.industryIdentifiers || [];
  for (const ident of identifiers) {
    if (ident.type === "ISBN_13") {
      result.ISBN = ident.identifier;
      break;
    } else if (ident.type === "ISBN_10" && !result.ISBN) {
      result.ISBN = ident.identifier;
    }
  }

  // Get page count
  if (volumeInfo.pageCount) {
    result.numPages = volumeInfo.pageCount;
  }

  // Get publisher
  if (volumeInfo.publisher) {
    result.publisher = volumeInfo.publisher;
  }

  // Get publication date/year
  if (volumeInfo.publishedDate) {
    const yearMatch = volumeInfo.publishedDate.match(/^(\d{4})/);
    if (yearMatch) {
      result.date = yearMatch[1];
    }
  }

  // Get categories/subjects
  if (volumeInfo.categories && volumeInfo.categories.length > 0) {
    result.tags = volumeInfo.categories.slice(0, 5);
  }

  // Get description/abstract (truncated)
  if (volumeInfo.description) {
    let desc = volumeInfo.description;
    if (desc.length > 500) {
      desc = desc.substring(0, 497) + "...";
    }
    result.abstractNote = desc;
  }

  return result;
}

/**
 * Search Google Books for book metadata (fallback)
 * Returns multiple candidates for LLM disambiguation
 */
export async function searchGoogleBooks(
  title: string,
  author: string,
): Promise<{ candidates: APICandidate[]; bestResult: EnrichmentResult | null }> {
  const queryParts: string[] = [];
  if (title) queryParts.push(`intitle:${title}`);
  if (author) queryParts.push(`inauthor:${author}`);

  const query = queryParts.join("+");
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;

  try {
    const response = await Zotero.HTTP.request("GET", url, {
      timeout: 10000,
      responseType: "json",
    });

    const data = response.response as any;

    if (data.totalItems > 0 && data.items && data.items.length > 0) {
      const candidates: APICandidate[] = [];

      for (const item of data.items.slice(0, 5)) {
        const volumeInfo = item.volumeInfo || {};
        const result = parseGoogleBooksVolume(volumeInfo);

        if (Object.keys(result).length > 0) {
          const yearMatch = volumeInfo.publishedDate?.match(/^(\d{4})/);
          candidates.push({
            title: volumeInfo.title,
            author: volumeInfo.authors?.[0],
            year: yearMatch ? yearMatch[1] : undefined,
            publisher: volumeInfo.publisher,
            isbn: result.ISBN,
            result,
          });
        }
      }

      return {
        candidates,
        bestResult: candidates.length > 0 ? candidates[0].result : null,
      };
    }
  } catch (error) {
    ztoolkit.log(`Google Books search error: ${error}`);
  }

  return { candidates: [], bestResult: null };
}

// ==================== Main Enrichment Functions ====================

/**
 * Apply enrichment result to a Zotero item (only fill missing fields)
 */
async function applyEnrichmentToItem(
  item: Zotero.Item,
  result: EnrichmentResult,
): Promise<boolean> {
  let modified = false;

  // ISBN
  if (result.ISBN && !item.getField("ISBN")) {
    item.setField("ISBN", result.ISBN);
    modified = true;
  }

  // Publisher
  if (result.publisher && !item.getField("publisher")) {
    item.setField("publisher", result.publisher);
    modified = true;
  }

  // Place
  if (result.place && !item.getField("place")) {
    item.setField("place", result.place);
    modified = true;
  }

  // Number of pages
  if (result.numPages && !item.getField("numPages")) {
    item.setField("numPages", result.numPages.toString());
    modified = true;
  }

  // Date
  if (result.date && !item.getField("date")) {
    item.setField("date", result.date);
    modified = true;
  }

  // Abstract
  if (result.abstractNote && !item.getField("abstractNote")) {
    item.setField("abstractNote", result.abstractNote);
    modified = true;
  }

  // Call number (LCCN)
  if (result.LCCN && !item.getField("callNumber")) {
    item.setField("callNumber", result.LCCN);
    modified = true;
  }

  // Extra field for OCLC
  if (result.OCLC) {
    const extra = item.getField("extra") as string;
    if (!extra || !extra.includes("OCLC:")) {
      const newExtra = extra ? `${extra}\nOCLC: ${result.OCLC}` : `OCLC: ${result.OCLC}`;
      item.setField("extra", newExtra);
      modified = true;
    }
  }

  // Tags
  if (result.tags && result.tags.length > 0) {
    const existingTags = item.getTags().map((t) => t.tag.toLowerCase());
    for (const tag of result.tags) {
      if (!existingTags.includes(tag.toLowerCase())) {
        item.addTag(tag);
        modified = true;
      }
    }
  }

  if (modified) {
    await item.saveTx();
  }

  return modified;
}

/**
 * Select the best result from candidates, using LLM disambiguation if available
 */
async function selectBestCandidate(
  title: string,
  author: string,
  year: number | null,
  candidates: APICandidate[],
): Promise<EnrichmentResult | null> {
  if (candidates.length === 0) {
    return null;
  }

  // If only one candidate or LLM not available, use first result
  if (candidates.length === 1 || !isLLMAvailable()) {
    return candidates[0].result;
  }

  // Use LLM to disambiguate
  const disambResult = await llmDisambiguate(title, author, year, candidates);

  if (disambResult && disambResult.selectedIndex < candidates.length) {
    ztoolkit.log(`LLM selected result ${disambResult.selectedIndex} with confidence ${disambResult.confidence}`);
    if (disambResult.reasoning) {
      ztoolkit.log(`Reasoning: ${disambResult.reasoning}`);
    }
    return candidates[disambResult.selectedIndex].result;
  }

  // Fall back to first result
  return candidates[0].result;
}

/**
 * Enrich a single Zotero item with metadata from online sources
 * Includes LLM-enhanced fuzzy matching and disambiguation
 */
export async function enrichItem(item: Zotero.Item): Promise<boolean> {
  // Only enrich books
  if (item.itemType !== "book") {
    return false;
  }

  let title = item.getField("title") as string;
  let author = getFirstAuthor(item);
  const year = getYearFromItem(item);

  if (!title) {
    return false;
  }

  const isPreIsbn = year !== null && year < 1970;
  const enrichPreIsbn = getPref("enrichPreIsbn") as boolean;
  const delayMs = (getPref("apiDelayMs") as number) || 200;

  // Search Open Library first
  let openLibResult = await searchOpenLibrary(title, author, year);
  let result: EnrichmentResult | null = null;

  if (openLibResult.candidates.length > 0) {
    // Use LLM disambiguation if multiple candidates
    result = await selectBestCandidate(title, author, year, openLibResult.candidates);
  }

  // If not found, try Google Books as fallback
  if (!result && !isPreIsbn) {
    await sleep(delayMs);
    const googleResult = await searchGoogleBooks(title, author);

    if (googleResult.candidates.length > 0) {
      result = await selectBestCandidate(title, author, year, googleResult.candidates);
    }
  }

  // If still not found and LLM is available, try fuzzy matching
  if (!result && isLLMAvailable()) {
    ztoolkit.log("No results found, trying LLM cleanup for fuzzy matching...");

    const cleaned = await llmCleanupQuery(title, author);
    if (cleaned && (cleaned.title !== title || cleaned.author !== author)) {
      ztoolkit.log(`LLM cleaned: "${title}" -> "${cleaned.title}", "${author}" -> "${cleaned.author}"`);

      await sleep(delayMs);

      // Retry Open Library with cleaned query
      const retryOpenLib = await searchOpenLibrary(cleaned.title, cleaned.author, year);
      if (retryOpenLib.candidates.length > 0) {
        result = await selectBestCandidate(cleaned.title, cleaned.author, year, retryOpenLib.candidates);
      }

      // If still not found, try Google Books with cleaned query
      if (!result && !isPreIsbn) {
        await sleep(delayMs);
        const retryGoogle = await searchGoogleBooks(cleaned.title, cleaned.author);
        if (retryGoogle.candidates.length > 0) {
          result = await selectBestCandidate(cleaned.title, cleaned.author, year, retryGoogle.candidates);
        }
      }
    }
  }

  // If we have a result with ISBN but missing detailed metadata, fetch edition details
  if (result && result.ISBN && (!result.publisher || !result.place || !result.numPages)) {
    ztoolkit.log(`Fetching detailed edition data for ISBN ${result.ISBN}...`);
    await sleep(delayMs);
    const editionData = await fetchOpenLibraryEdition(result.ISBN);
    if (editionData) {
      result = mergeEnrichmentResults(result, editionData);
    }
  }

  // Handle pre-ISBN books
  if (isPreIsbn && enrichPreIsbn) {
    // Add note about pre-ISBN status
    const extra = item.getField("extra") as string;
    if (!extra || !extra.includes("Pre-ISBN")) {
      const note = "[Pre-ISBN publication (before 1970)]";
      const newExtra = extra ? `${extra}\n${note}` : note;
      item.setField("extra", newExtra);
      await item.saveTx();
    }
  }

  // Apply results
  if (result) {
    return await applyEnrichmentToItem(item, result);
  }

  return false;
}

/**
 * Enrich multiple Zotero items with progress callback
 */
export async function enrichItems(
  items: Zotero.Item[],
  progressCallback?: (current: number, total: number, title: string) => void,
): Promise<EnrichmentStats> {
  const stats: EnrichmentStats = {
    found: 0,
    notFound: 0,
    preIsbn: 0,
    skipped: 0,
  };

  // Filter to books only
  const books = items.filter((item) => item.itemType === "book");

  if (books.length === 0) {
    ztoolkit.log("No books to enrich");
    return stats;
  }

  ztoolkit.log(`Enriching ${books.length} books with metadata...`);

  const delayMs = (getPref("apiDelayMs") as number) || 200;

  for (let i = 0; i < books.length; i++) {
    const item = books[i];
    const title = (item.getField("title") as string) || "Untitled";

    if (progressCallback) {
      progressCallback(i + 1, books.length, title);
    }

    const year = getYearFromItem(item);
    const isPreIsbn = year !== null && year < 1970;

    if (isPreIsbn) {
      stats.preIsbn++;
    }

    const enriched = await enrichItem(item);

    if (enriched) {
      stats.found++;
    } else {
      stats.notFound++;
    }

    // Rate limiting
    if (i < books.length - 1) {
      await sleep(delayMs);
    }
  }

  // Count skipped non-books
  stats.skipped = items.length - books.length;

  ztoolkit.log(
    `Enrichment complete: ${stats.found} enriched, ${stats.notFound} not found, ${stats.preIsbn} pre-ISBN, ${stats.skipped} skipped`,
  );

  return stats;
}

export class EnrichmentFactory {
  /**
   * Enrich selected items from the context menu
   */
  static async enrichSelectedItems(): Promise<void> {
    const items = Zotero.getActiveZoteroPane().getSelectedItems();

    if (!items || items.length === 0) {
      new ztoolkit.ProgressWindow(addon.data.config.addonName)
        .createLine({
          text: "No items selected",
          type: "fail",
        })
        .show();
      return;
    }

    const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: false,
      closeTime: -1,
    })
      .createLine({
        text: `Enriching ${items.length} item(s)...`,
        type: "default",
        progress: 0,
      })
      .show();

    const stats = await enrichItems(items, (current, total, title) => {
      const progress = Math.round((current / total) * 100);
      popup.changeLine({
        text: `[${current}/${total}] ${title.substring(0, 40)}...`,
        progress,
      });
    });

    popup.changeLine({
      text: `Done! ${stats.found} enriched, ${stats.notFound} not found`,
      type: stats.found > 0 ? "success" : "default",
      progress: 100,
    });
    popup.startCloseTimer(5000);
  }
}
