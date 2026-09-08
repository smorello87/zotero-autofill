/** Pure validation shared by the bibliography review UI and tests. */
export interface CSLItem {
  type?: string;
  title?: string;
  author?: Array<{ family?: string; given?: string; literal?: string }>;
  editor?: Array<{ family?: string; given?: string; literal?: string }>;
  issued?: { "date-parts"?: number[][] };
  [key: string]: unknown;
}

export function splitEntries(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  return normalized
    .split(/\n\s*\n/.test(normalized) ? /\n\s*\n+/ : /\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function reviewWarnings(item: CSLItem): string[] {
  const warnings: string[] = [];
  if (!item.title?.trim()) warnings.push("Title is required before importing.");
  if (!item.author?.length && !item.editor?.length)
    warnings.push("No author or editor; verify against the original.");
  if (!item.issued?.["date-parts"]?.[0]?.[0])
    warnings.push("No publication year; verify against the original.");
  return warnings;
}

export function escapeHTML(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

const normalized = (value: unknown) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
export function duplicateKeys(item: CSLItem): string[] {
  const keys: string[] = [];
  if (item.DOI)
    keys.push(
      `doi:${String(item.DOI)
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
        .replace(/^doi:\s*/i, "")
        .trim()
        .toLowerCase()}`,
    );
  if (item.ISBN) {
    const isbn = String(item.ISBN)
      .replace(/[^\dX]/gi, "")
      .toUpperCase();
    if (isbn.length === 10) {
      const body = `978${isbn.slice(0, 9)}`;
      const check =
        (10 -
          ([...body].reduce(
            (sum, char, i) => sum + Number(char) * (i % 2 ? 3 : 1),
            0,
          ) %
            10)) %
        10;
      keys.push(`isbn:${body}${check}`);
    } else if (isbn.length === 13) keys.push(`isbn:${isbn}`);
  }
  const author = item.author?.[0] || item.editor?.[0];
  const name = author?.family || author?.literal;
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  if (item.title && name && year)
    keys.push(`citation:${normalized(item.title)}:${normalized(name)}:${year}`);
  return keys;
}

export function validateEditedItem(value: unknown): CSLItem {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Metadata must be a CSL-JSON object.");
  const item = value as CSLItem;
  if (typeof item.title !== "string" || !item.title.trim())
    throw new Error("Title is required before importing.");
  for (const field of [
    "type",
    "publisher",
    "publisher-place",
    "container-title",
    "volume",
    "issue",
    "page",
    "ISBN",
    "DOI",
    "URL",
    "abstract",
    "note",
    "language",
  ]) {
    if (item[field] !== undefined && typeof item[field] !== "string")
      throw new Error(`${field} must be text.`);
  }
  for (const field of ["author", "editor"] as const) {
    if (
      item[field] !== undefined &&
      (!Array.isArray(item[field]) ||
        item[field]!.some(
          (name) =>
            !name ||
            typeof name !== "object" ||
            ![name.family, name.given, name.literal].some(
              (value) => typeof value === "string" && value.trim(),
            ) ||
            [name.family, name.given, name.literal].some(
              (value) => value !== undefined && typeof value !== "string",
            ),
        ))
    )
      throw new Error(`${field} must contain valid creator names.`);
  }
  if (item.issued !== undefined) {
    const parts = item.issued?.["date-parts"];
    if (
      !Array.isArray(parts) ||
      !parts.length ||
      parts.some(
        (date) =>
          !Array.isArray(date) ||
          !date.length ||
          date.length > 3 ||
          date.some((part) => !Number.isInteger(part)) ||
          (date[1] !== undefined && (date[1] < 1 || date[1] > 12)) ||
          (date[2] !== undefined && (date[2] < 1 || date[2] > 31)),
      )
    )
      throw new Error("Use numeric date parts such as [[2020, 6, 15]].");
  }
  return item;
}
