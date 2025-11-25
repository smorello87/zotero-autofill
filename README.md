# Zotero Metadata Assistant

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

A Zotero 7 plugin that auto-fills missing metadata for books by searching Open Library and Google Books APIs, with optional AI-powered features for improved accuracy and bibliography import.

## Features

### Enrich Metadata from Online Sources
- **Right-click** on one or more items in your library
- Select **"Enrich Metadata from Online Sources"**
- Plugin searches Open Library (primary) and Google Books (fallback)
- Missing fields are automatically filled in:
  - ISBN
  - Publisher
  - Publication place
  - Number of pages
  - Abstract/description
  - Subject tags
  - OCLC/LCCN numbers

### Auto-Enrich on Import
- Enable in **Preferences → Metadata Assistant**
- New books are automatically enriched when added to your library

### AI-Enhanced Enrichment (Optional)
When an OpenRouter API key is configured:
- **Fuzzy matching**: If standard searches fail, AI cleans up title/author queries and retries
- **Disambiguation**: When multiple results are found, AI selects the best match based on context

### Import Bibliography Text
- **Tools → Import Bibliography Text...**
- Paste raw bibliography entries (one per paragraph)
- AI parses entries into structured Zotero items
- Optionally auto-enriches imported items

### Pre-ISBN Book Handling
- Books published before 1970 (when ISBN was introduced) are handled specially
- Searches for OCLC and Library of Congress Control Numbers instead
- Adds a note indicating pre-ISBN publication

## Installation

### From Release
1. Download the latest `.xpi` file from [Releases](https://github.com/smorello87/zotero-autofill/releases)
2. In Zotero: **Tools → Add-ons → ⚙️ → Install Add-on From File...**
3. Select the downloaded `.xpi` file

### For Development
```bash
# Clone the repository
git clone https://github.com/smorello87/zotero-autofill.git
cd zotero-autofill

# Install dependencies
npm install

# Start development server
npm start
```

Then create an extension proxy file:
1. Find your Zotero profile directory
2. Create a file named `zotero-metadata-assistant@smorello.org` in the `extensions` folder
3. File contents: the absolute path to your cloned repo (e.g., `/Users/you/zotero-autofill`)
4. Restart Zotero

## Settings

Open **Zotero → Preferences → Metadata Assistant**:

| Setting | Description |
|---------|-------------|
| **OpenRouter API Key** | Required for AI-powered features (bibliography import, fuzzy matching, disambiguation) |
| **Auto-enrich on import** | Automatically enrich new items when added |
| **Search OCLC/LCCN for pre-1970** | Enable special handling for older books |
| **LLM Model** | Model to use for AI features (GPT-4o Mini recommended) |
| **API delay** | Milliseconds between API requests (default: 200ms) |

## How It Works

1. Extracts title, author, and year from the Zotero item
2. Searches Open Library's search API with these parameters
3. If no results or missing ISBN, falls back to Google Books API
4. When ISBN is found, fetches detailed edition data from Open Library
5. Merges found metadata into the item (only fills empty fields)
6. For pre-1970 books, prioritizes OCLC/LCCN lookup
7. With AI enabled: uses fuzzy matching for failed searches and disambiguates multiple results

## Data Sources

- **[Open Library](https://openlibrary.org/)** - Primary source for book metadata
- **[Google Books](https://books.google.com/)** - Fallback source
- **[OpenRouter](https://openrouter.ai/)** - AI model access for enhanced features

## Roadmap

- [ ] Support for other item types (journal articles, etc.)
- [ ] Batch enrichment for entire collections
- [ ] Additional metadata sources

## License

GPL-3.0-or-later

## Author

Stefano Morello

## Acknowledgments

- Built with [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
- Inspired by [biblio-zotero](https://github.com/smorello87/biblio-zotero)
