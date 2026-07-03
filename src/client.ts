/**
 * Client-side script injected into every page.
 * Loads the manifest and registers WebMCP tools via document.modelContext.
 *
 * Conforms to the WebMCP spec (webmachinelearning/webmcp) as of 2026-07:
 * - document.modelContext as primary API surface
 * - provideContext() batch registration with registerTool() fallback
 * - AbortController / signal for tool lifecycle management
 * - requestUserInteraction() for state-mutating tools
 * - Structured content response format
 *
 * Features inspired by @freshjuice/astro-webmcp:
 * - Custom tools API (executeBody from astro.config)
 * - Search backends (Pagefind, Orama) with manifest fallback
 *
 * @see https://webmachinelearning.github.io/webmcp/
 * @see https://developer.chrome.com/docs/ai/webmcp/secure-tools
 */

interface ManifestEntry {
  slug: string;
  url: string;
  title: string;
  description?: string;
  collection?: string;
  tags?: string[];
}

interface Manifest {
  collections: Array<{ name: string; count: number }>;
  entries: ManifestEntry[];
}

interface SearchConfig {
  backend: 'manifest' | 'pagefind' | 'orama';
  oramaIndexUrl?: string;
  pagefindBundlePath?: string;
}

interface CustomToolConfig {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executeBody: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
}

/** Config injected by the integration via __WEBMCP_CONFIG__ */
interface WebMCPClientConfig {
  exposedTo?: string[];
  maxOutputLength: number;
  sanitizeOutputs: boolean;
  customTools?: CustomToolConfig[];
  search?: SearchConfig;
}

// Config is replaced at build time by the integration
const CONFIG: WebMCPClientConfig = (globalThis as any).__WEBMCP_CONFIG__ ?? {
  maxOutputLength: 1500,
  sanitizeOutputs: true,
};

/**
 * Truncates output to the character limit.
 */
function truncateOutput(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 13) + '...[truncated]';
}

/**
 * Sanitizes content to mitigate indirect prompt injection.
 */
function sanitize(text: string): string {
  if (!CONFIG.sanitizeOutputs) return text;
  return text
    .replace(/ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi, '[filtered]')
    .replace(/you\s+are\s+(now|a)\s+/gi, '[filtered]')
    .replace(/(system|assistant|user)\s*:\s*/gi, '[filtered]')
    .replace(/<\/?(?:system|instruction|prompt|command)[^>]*>/gi, '[filtered]');
}

/**
 * Wraps output with sanitization and truncation.
 * Returns structured content response per spec.
 */
function safeOutput(data: unknown): { content: Array<{ type: string; text: string }> } {
  let str = JSON.stringify(data);
  str = sanitize(str);
  str = truncateOutput(str, CONFIG.maxOutputLength);
  return { content: [{ type: 'text', text: str }] };
}

// =============================================================================
// Search backends (inspired by @freshjuice/astro-webmcp)
// =============================================================================

/** Manifest-based substring search (default, always works). */
function searchManifest(
  manifest: Manifest,
  query: string,
  collection?: string,
  limit = 5,
): ManifestEntry[] {
  const q = query.toLowerCase();
  let results = manifest.entries.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
  );
  if (collection) {
    results = results.filter((e) => e.collection === collection);
  }
  return results.slice(0, Math.min(limit, 20));
}

/** Pagefind full-text search (requires pagefind loaded on the page). */
async function searchPagefind(query: string, limit = 5): Promise<ManifestEntry[]> {
  const pf = (window as any).pagefind;
  if (!pf) return [];
  try {
    const search = await pf.search(query);
    const results = search.results.slice(0, limit);
    return results.map((r: any) => ({
      slug: r.url?.replace(/\/$/, '') || r.meta?.url || '',
      url: r.url || r.meta?.url || '',
      title: r.meta?.title || '',
      description: r.excerpt || r.meta?.description || '',
    }));
  } catch {
    return [];
  }
}

/** Orama full-text search (dynamic import, optional peer dep). */
async function searchOrama(query: string, limit = 5): Promise<ManifestEntry[]> {
  const oramaIndexUrl = CONFIG.search?.oramaIndexUrl;
  if (!oramaIndexUrl) return [];
  try {
    // @ts-ignore — @orama/orama is an optional peer dep, not bundled
    const orama = await import(/* @vite-ignore */ '@orama/orama');
    const res = await fetch(oramaIndexUrl);
    if (!res.ok) return [];
    const indexData = await res.json();
    const db = await orama.create({ schema: { __placeholder: 'string' as any } });
    await orama.load(db, indexData);
    const result = await orama.search(db, { term: query, limit });
    return (result.hits ?? []).map((hit: any) => ({
      slug: hit.document.url?.replace(/\/$/, '') || '',
      url: hit.document.url || '',
      title: hit.document.title || '',
      description: hit.document.desc || hit.document.description || '',
    }));
  } catch {
    return [];
  }
}

/** Unified search dispatcher — picks backend, falls back to manifest. */
async function searchContent(
  manifest: Manifest,
  query: string,
  collection?: string,
  limit = 5,
): Promise<ManifestEntry[]> {
  const backend = CONFIG.search?.backend ?? 'manifest';

  if (backend === 'pagefind') {
    const results = await searchPagefind(query, limit);
    if (results.length > 0) return results;
  }

  if (backend === 'orama') {
    const results = await searchOrama(query, limit);
    if (results.length > 0) return results;
  }

  // Fallback: always works
  return searchManifest(manifest, query, collection, limit);
}

// =============================================================================
// Main initialization
// =============================================================================

(async () => {
  const mc = (document as any).modelContext ?? (navigator as any).modelContext;
  if (!mc?.registerTool) return;

  let manifest: Manifest;
  try {
    const res = await fetch('/_webmcp/manifest.json');
    if (!res.ok) return;
    manifest = await res.json();
  } catch {
    return;
  }

  // AbortController for tool lifecycle
  const controller = new AbortController();
  const { signal } = controller;

  // Shared registration options
  const registerOptions: Record<string, unknown> = { signal };
  if (CONFIG.exposedTo?.length) {
    registerOptions.exposedTo = CONFIG.exposedTo;
  }

  const tools: Array<Record<string, unknown>> = [];

  // Tool: search content (with backend dispatch)
  tools.push({
    name: 'search_content',
    description: 'Search articles and pages on this site by keyword. Returns title, URL, and description of matching results.',
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' },
        collection: { type: 'string', description: 'Filter by collection name (optional)' },
        limit: { type: 'number', description: 'Max results to return (default: 5)' },
      },
      required: ['query'],
    },
    execute: async (args: { query: string; collection?: string; limit?: number }) => {
      const results = await searchContent(manifest, args.query, args.collection, args.limit);
      return safeOutput(results);
    },
  });

  // Tool: list collections / sections
  tools.push({
    name: 'list_sections',
    description: 'List all content sections (collections) available on this site with item counts.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => safeOutput(manifest.collections),
  });

  // Tool: navigate (state-mutating — requires requestUserInteraction)
  tools.push({
    name: 'go_to',
    description: 'Navigate to a specific page on this site by its slug.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug or path' },
      },
      required: ['slug'],
    },
    execute: async (args: { slug: string }) => {
      const entry = manifest.entries.find(
        (e) => e.slug === args.slug || e.url === args.slug || e.url === `/${args.slug}/`,
      );
      if (!entry) {
        return safeOutput({ error: 'Page not found. Use search_content to find available pages.' });
      }
      if (mc.requestUserInteraction) {
        const approved = await mc.requestUserInteraction({
          message: `Navigate to "${entry.title}" (${entry.url})?`,
        });
        if (!approved) {
          return safeOutput({ cancelled: true, message: 'Navigation cancelled by user.' });
        }
      }
      window.location.href = entry.url;
      return null;
    },
  });

  // Tool: get current page metadata
  tools.push({
    name: 'get_page_info',
    description: 'Get metadata about the current page (title, description, headings, language, word count, canonical URL).',
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: true,
    },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const title = document.title;
      const description =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) => ({
        level: parseInt(h.tagName[1]),
        text: h.textContent?.trim() ?? '',
        ...(h.id ? { id: h.id } : {}),
      }));
      const lang = document.documentElement.lang || undefined;
      const canonical =
        document.querySelector('link[rel="canonical"]')?.getAttribute('href') || undefined;
      // Approximate word count from main content
      let wordCount: number | undefined;
      const main = document.querySelector('main');
      if (main) {
        const text = (main.textContent ?? '').replace(/\s+/g, ' ').trim();
        wordCount = text.split(/\s+/).length;
      }
      return safeOutput({ title, description, headings, url: window.location.pathname, lang, canonical, wordCount });
    },
  });

  // Custom tools (user-defined via astro.config — inspired by @freshjuice/astro-webmcp)
  if (CONFIG.customTools?.length) {
    for (const tool of CONFIG.customTools) {
      try {
        // eslint-disable-next-line no-new-func
        const executeFn = new Function('params', 'safeOutput', tool.executeBody) as (
          params: Record<string, unknown>,
          so: typeof safeOutput,
        ) => unknown;

        tools.push({
          name: tool.name,
          description: tool.description,
          annotations: tool.annotations ?? { readOnlyHint: true },
          inputSchema: tool.inputSchema,
          execute: async (params: Record<string, unknown>) => {
            const result = executeFn(params, safeOutput);
            return result instanceof Promise ? await result : result;
          },
        });
      } catch (err) {
        console.warn(`[astro-webmcp] Failed to register custom tool "${tool.name}":`, err);
      }
    }
  }

  // Register: prefer provideContext() batch, fallback to registerTool()
  if (mc.provideContext) {
    mc.provideContext({ tools }, registerOptions);
  } else {
    for (const tool of tools) {
      mc.registerTool(tool, registerOptions);
    }
  }

  // Expose abort for cleanup (SPA navigation, View Transitions)
  (globalThis as any).__WEBMCP_ABORT__ = () => controller.abort();
})();
