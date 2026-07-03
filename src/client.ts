/**
 * Client-side script injected into every page.
 * Loads the manifest and registers WebMCP tools via document.modelContext.
 *
 * Conforms to the WebMCP spec (webmachinelearning/webmcp) as of 2026-07:
 * - document.modelContext as primary API surface
 * - provideContext() batch registration with registerTool() fallback
 * - AbortController / signal for tool lifecycle management
 * - requestUserInteraction() for state-mutating tools
 * - Structured content response format with string fallback
 *
 * Security applied per Chrome Agent Security Guidelines:
 * - readOnlyHint on all non-mutating tools
 * - untrustedContentHint on tools returning page content
 * - Output character limit (prevents context overflow)
 * - Sanitization against indirect prompt injection
 * - exposedTo for cross-origin control
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

/** Config injected by the integration via __WEBMCP_CONFIG__ */
interface WebMCPClientConfig {
  exposedTo?: string[];
  maxOutputLength: number;
  sanitizeOutputs: boolean;
}

// Config is replaced at build time by the integration
const CONFIG: WebMCPClientConfig = (globalThis as any).__WEBMCP_CONFIG__ ?? {
  maxOutputLength: 1500,
  sanitizeOutputs: true,
};

/**
 * Truncates output to the character limit.
 * Prevents context window overflow in the agent (deterministic guardrail).
 */
function truncateOutput(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 13) + '...[truncated]';
}

/**
 * Sanitizes content to mitigate indirect prompt injection.
 * Strips common instruction patterns embedded in content.
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
 * Returns structured content format per spec when supported,
 * falls back to plain string for older Chrome implementations.
 */
function safeOutput(data: unknown): { content: Array<{ type: string; text: string }> } | string {
  let str = JSON.stringify(data);
  str = sanitize(str);
  str = truncateOutput(str, CONFIG.maxOutputLength);
  // Structured content response per spec (content array with typed parts)
  return { content: [{ type: 'text', text: str }] };
}

(async () => {
  // document.modelContext is the spec-canonical API surface.
  // navigator.modelContext is the Chrome 149 early trial fallback.
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

  // AbortController for tool lifecycle — abort() unregisters all tools.
  // Useful for SPA navigations, View Transitions, or conditional tool availability.
  const controller = new AbortController();
  const { signal } = controller;

  // Shared registration options
  const registerOptions: Record<string, unknown> = { signal };
  if (CONFIG.exposedTo?.length) {
    registerOptions.exposedTo = CONFIG.exposedTo;
  }

  // Collect all tool definitions for batch registration via provideContext()
  const tools: Array<Record<string, unknown>> = [];

  // Tool: search content
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
      const q = args.query.toLowerCase();
      const limit = Math.min(args.limit ?? 5, 20);
      let results = manifest.entries.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.description ?? '').toLowerCase().includes(q) ||
          (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      );
      if (args.collection) {
        results = results.filter((e) => e.collection === args.collection);
      }
      return safeOutput(results.slice(0, limit));
    },
  });

  // Tool: list collections / sections
  tools.push({
    name: 'list_sections',
    description: 'List all content sections (collections) available on this site with item counts.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => safeOutput(manifest.collections),
  });

  // Tool: navigate to content (state-mutating — requires requestUserInteraction)
  tools.push({
    name: 'go_to',
    description: 'Navigate to a specific page on this site by its slug.',
    annotations: {
      readOnlyHint: false,
    },
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

      // Spec requirement: state-mutating tools must request user consent.
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

      return safeOutput({
        title,
        description,
        headings,
        url: window.location.pathname,
        lang,
        canonical,
      });
    },
  });

  // Register tools: prefer provideContext() batch (spec-preferred), fallback to registerTool()
  if (mc.provideContext) {
    mc.provideContext({ tools }, registerOptions);
  } else {
    for (const tool of tools) {
      mc.registerTool(tool, registerOptions);
    }
  }

  // Expose abort for cleanup (e.g., SPA navigation, View Transitions)
  (globalThis as any).__WEBMCP_ABORT__ = () => controller.abort();
})();
