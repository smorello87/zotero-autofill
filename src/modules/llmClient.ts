/**
 * LLM Client module for Zotero Metadata Assistant
 * Handles OpenRouter API calls for LLM-enhanced features
 */

import { getPref } from "../utils/prefs";

// ==================== Types ====================

export interface LLMResponse {
  success: boolean;
  content?: string;
  error?: string;
}

export interface CleanedQuery {
  title: string;
  author: string;
}

export interface DisambiguationResult {
  selectedIndex: number;
  confidence: number;
  reasoning?: string;
}

// ==================== Prompts ====================

const CLEANUP_SYSTEM_PROMPT =
  "You are a bibliographic query cleaner. Your task is to normalize book titles and author names for API searches. " +
  "Output ONLY valid JSON. NO commentary, NO explanations. " +
  "Fix common issues: normalize case, remove extra punctuation, fix obvious typos, expand abbreviations, " +
  "remove subtitle clutter that might hurt search accuracy. Keep diacritics. " +
  "For authors, use 'LastName, FirstName' format if possible.";

const CLEANUP_USER_TEMPLATE =
  'Clean up this book query for API searching:\n' +
  'Title: "{title}"\n' +
  'Author: "{author}"\n\n' +
  'Return JSON: {"title": "cleaned title", "author": "cleaned author"}';

const DISAMBIGUATION_SYSTEM_PROMPT =
  "You are a bibliographic disambiguation expert. Given a book being searched and multiple API results, " +
  "select the BEST matching result. Consider: title similarity, author name match, publication year accuracy, " +
  "publisher reputation, and edition appropriateness. " +
  "Output ONLY valid JSON. NO commentary, NO explanations.";

const DISAMBIGUATION_USER_TEMPLATE =
  "Original item:\n" +
  "- Title: {title}\n" +
  "- Author: {author}\n" +
  "- Year: {year}\n\n" +
  "API results (pick the best match by index, 0-based):\n{results}\n\n" +
  'Return JSON: {"selectedIndex": 0, "confidence": 0.95, "reasoning": "brief reason"}';

// Bibliography parsing prompts (for import feature)
export const BIBLIOGRAPHY_SYSTEM_PROMPT =
  "You are a bibliography parser that outputs ONLY valid JSON. " +
  "You convert free-text bibliographic entries (English/Italian) into CSL-JSON items. " +
  "CRITICAL: Your response must be ONLY a JSON object starting with { and ending with }. NO commentary, NO explanations, NO analysis. " +
  "The JSON object must have an 'items' key with an array of bibliography entries. " +
  "If data is missing, omit the field. " +
  "Always set a plausible 'type' (e.g., 'book', 'chapter', 'article-journal', 'article-magazine', 'thesis', 'pamphlet', 'manuscript', 'report'). " +
  "Map editors to the 'editor' array, and authors to the 'author' array with objects {\"family\", \"given\"}. " +
  "For dates like '1940a' set issued.date-parts to [[1940]] and put the suffix 'a' into 'note' (e.g., 'year-suffix: a'). " +
  "For bracketed/uncertain dates like '[1903]' or 'n.d.' use the best available year in 'issued' when possible and add a clarifying note. " +
  "Use 'publisher' and 'publisher-place' for books; 'container-title', 'volume', 'issue', 'page' for articles; use 'title' for work title. " +
  "Keep diacritics; don't invent DOIs/URLs. If multiple places/publishers are separated by ';', you may keep the first and add the rest to 'note'.";

export const BIBLIOGRAPHY_USER_TEMPLATE =
  "Convert the following bibliographic entries into CSL-JSON. Return a JSON object with an 'items' key containing an array of CSL-JSON objects, in the SAME order as the input.\n\n" +
  "Entries:\n{entries}\n\n" +
  "Your response must be in this format:\n" +
  '{\n  "items": [\n    {\n      "type": "book",\n      "title": "...",\n      "author": [{"family": "...", "given": "..."}],\n      "editor": [...],\n      "issued": {"date-parts": [[1999]]},\n      "publisher": "...",\n      "publisher-place": "...",\n      "container-title": "...",\n      "volume": "...",\n      "issue": "...",\n      "page": "...",\n      "language": "it"\n    }\n  ]\n}';

// ==================== Helper Functions ====================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if LLM features are available (API key is set)
 */
export function isLLMAvailable(): boolean {
  const apiKey = getPref("openrouterApiKey") as string;
  return !!apiKey && apiKey.trim().length > 0;
}

// ==================== Core LLM Functions ====================

/**
 * Call OpenRouter API with retry logic
 */
export async function callOpenRouter(
  messages: Array<{ role: string; content: string }>,
  options?: {
    model?: string;
    temperature?: number;
    timeout?: number;
    maxRetries?: number;
  },
): Promise<LLMResponse> {
  const apiKey = getPref("openrouterApiKey") as string;
  if (!apiKey) {
    return { success: false, error: "OpenRouter API key not configured" };
  }

  const model = options?.model || (getPref("llmModel") as string) || "openai/gpt-4o-mini";
  const temperature = options?.temperature ?? 0;
  const timeout = options?.timeout ?? 60000;
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = 2000;

  const url = "https://openrouter.ai/api/v1/chat/completions";
  const payload = {
    model,
    messages,
    temperature,
    response_format: { type: "json_object" },
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await Zotero.HTTP.request("POST", url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        timeout,
        responseType: "json",
      });

      const data = response.response as any;

      if (data.error) {
        throw new Error(data.error.message || "API error");
      }

      if (data.choices && data.choices[0]?.message?.content) {
        return {
          success: true,
          content: data.choices[0].message.content,
        };
      }

      throw new Error("Invalid response structure");
    } catch (error: any) {
      const isRateLimit = error.status === 429;
      const isTimeout = error.message?.includes("timeout");

      if ((isRateLimit || isTimeout) && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        ztoolkit.log(`LLM request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }

      return {
        success: false,
        error: error.message || "Unknown error",
      };
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

// ==================== LLM-Enhanced Enrichment Functions ====================

/**
 * Clean up a book query using LLM for better API search results
 * (Fuzzy matching fallback - scenario 1)
 */
export async function llmCleanupQuery(
  title: string,
  author: string,
): Promise<CleanedQuery | null> {
  if (!isLLMAvailable()) {
    return null;
  }

  const userPrompt = CLEANUP_USER_TEMPLATE
    .replace("{title}", title)
    .replace("{author}", author);

  const messages = [
    { role: "system", content: CLEANUP_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const response = await callOpenRouter(messages, { timeout: 30000 });

  if (!response.success || !response.content) {
    ztoolkit.log(`LLM cleanup failed: ${response.error}`);
    return null;
  }

  try {
    const parsed = JSON.parse(response.content);
    return {
      title: parsed.title || title,
      author: parsed.author || author,
    };
  } catch (e) {
    ztoolkit.log(`Failed to parse LLM cleanup response: ${e}`);
    return null;
  }
}

/**
 * Disambiguate between multiple API results using LLM
 * (Disambiguation - scenario 2)
 */
export async function llmDisambiguate(
  originalTitle: string,
  originalAuthor: string,
  originalYear: number | null,
  candidates: Array<{
    title?: string;
    author?: string;
    year?: string;
    publisher?: string;
    isbn?: string;
  }>,
): Promise<DisambiguationResult | null> {
  if (!isLLMAvailable() || candidates.length === 0) {
    return null;
  }

  // If only one candidate, no need to disambiguate
  if (candidates.length === 1) {
    return { selectedIndex: 0, confidence: 1.0 };
  }

  const resultsText = candidates
    .map((c, i) => {
      const parts = [`[${i}]`];
      if (c.title) parts.push(`Title: "${c.title}"`);
      if (c.author) parts.push(`Author: ${c.author}`);
      if (c.year) parts.push(`Year: ${c.year}`);
      if (c.publisher) parts.push(`Publisher: ${c.publisher}`);
      if (c.isbn) parts.push(`ISBN: ${c.isbn}`);
      return parts.join(" | ");
    })
    .join("\n");

  const userPrompt = DISAMBIGUATION_USER_TEMPLATE
    .replace("{title}", originalTitle)
    .replace("{author}", originalAuthor)
    .replace("{year}", originalYear?.toString() || "unknown")
    .replace("{results}", resultsText);

  const messages = [
    { role: "system", content: DISAMBIGUATION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const response = await callOpenRouter(messages, { timeout: 30000 });

  if (!response.success || !response.content) {
    ztoolkit.log(`LLM disambiguation failed: ${response.error}`);
    return null;
  }

  try {
    const parsed = JSON.parse(response.content);
    const index = parseInt(parsed.selectedIndex, 10);

    if (isNaN(index) || index < 0 || index >= candidates.length) {
      return { selectedIndex: 0, confidence: 0.5 };
    }

    return {
      selectedIndex: index,
      confidence: parsed.confidence || 0.8,
      reasoning: parsed.reasoning,
    };
  } catch (e) {
    ztoolkit.log(`Failed to parse LLM disambiguation response: ${e}`);
    return null;
  }
}

/**
 * Parse bibliography text entries using LLM
 * Returns CSL-JSON items
 */
export async function parseBibliographyWithLLM(
  entries: string[],
  batchSize = 25,
  progressCallback?: (current: number, total: number) => void,
): Promise<{ items: any[]; failed: string[] }> {
  if (!isLLMAvailable()) {
    return { items: [], failed: entries };
  }

  const results: any[] = [];
  const failed: string[] = [];

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(entries.length / batchSize);

    if (progressCallback) {
      progressCallback(i, entries.length);
    }

    ztoolkit.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} entries)`);

    const entriesText = batch.map((x) => `- ${x}`).join("\n");
    const userPrompt = BIBLIOGRAPHY_USER_TEMPLATE.replace("{entries}", entriesText);

    const messages = [
      { role: "system", content: BIBLIOGRAPHY_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    const response = await callOpenRouter(messages, { timeout: 180000 });

    if (!response.success || !response.content) {
      ztoolkit.log(`Batch ${batchNum} failed: ${response.error}`);
      failed.push(...batch);
      continue;
    }

    try {
      const parsed = JSON.parse(response.content);
      let items: any[] = [];

      if (Array.isArray(parsed)) {
        items = parsed;
      } else if (parsed.items && Array.isArray(parsed.items)) {
        items = parsed.items;
      } else if (typeof parsed === "object") {
        // Try to find any array in the response
        for (const key of Object.keys(parsed)) {
          if (Array.isArray(parsed[key])) {
            items = parsed[key];
            break;
          }
        }
      }

      if (items.length > 0) {
        results.push(...items);
      } else {
        failed.push(...batch);
      }
    } catch (e) {
      ztoolkit.log(`Failed to parse batch ${batchNum}: ${e}`);
      failed.push(...batch);
    }

    // Delay between batches to avoid rate limiting
    if (i + batchSize < entries.length) {
      await sleep(1000);
    }
  }

  return { items: results, failed };
}
