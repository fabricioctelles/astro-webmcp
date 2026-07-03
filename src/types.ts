/** Configuration options for astro-webmcp */
export interface WebMCPOptions {
  /** Collections to expose (default: all that have pages) */
  collections?: string[];
  /** Additional custom tools */
  customTools?: CustomTool[];
  /** Security options */
  security?: SecurityOptions;
  /** Search backend configuration for search_content tool */
  search?: SearchOptions;
  /**
   * Generate /.well-known/skills/index.json for Agent Skills Discovery.
   * Set to false to disable. Default: true.
   * Only generated at build time (static output).
   */
  skills?: boolean;
  /** Name for the skills index (default: "WebMCP Tools") */
  skillsName?: string;
  /** Description for the skills index */
  skillsDescription?: string;
}

/**
 * Search backend options for the search_content tool.
 * Inspired by @freshjuice/astro-webmcp.
 */
export interface SearchOptions {
  /**
   * Search backend for search_content.
   * - 'manifest': substring search on the generated manifest (default, always works)
   * - 'pagefind': full-text search via window.pagefind (requires astro-pagefind or pagefind)
   * - 'orama': full-text search via @orama/orama with a pre-built index
   *
   * All backends fall back to manifest search if the primary backend fails.
   */
  backend?: 'manifest' | 'pagefind' | 'orama';
  /** URL of the serialized Orama index JSON (required when backend='orama') */
  oramaIndexUrl?: string;
  /** Pagefind bundle path (default: '/pagefind/') */
  pagefindBundlePath?: string;
}

/**
 * Security options per Chrome Agent Security Guidelines.
 * @see https://developer.chrome.com/docs/ai/webmcp/secure-tools
 */
export interface SecurityOptions {
  /**
   * Origins allowed to access tools via exposedTo.
   * Default: undefined (same-origin only, most secure).
   */
  exposedTo?: string[];
  /**
   * Maximum character limit per tool output.
   * Prevents context window overflow and reduces prompt injection surface.
   * Default: 1500 (Chrome recommendation)
   */
  maxOutputLength?: number;
  /**
   * Enables output sanitization to mitigate indirect prompt injection.
   * Strips patterns that resemble LLM instructions from content.
   * Default: true
   */
  sanitizeOutputs?: boolean;
}

/** User-defined custom tool */
export interface CustomTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Optional output schema (spec draft, Issue #9).
   * Declares the structure of the tool's return value for agent validation.
   * Not yet enforced by Chrome — included for forward compatibility.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * Serialized execute function body (runs in browser).
   * Receives `params` (tool arguments) and `safeOutput` (sanitize+truncate helper).
   * Must return data or a Promise.
   *
   * @example
   * executeBody: `return fetch('/api/search?q=' + encodeURIComponent(params.query))
   *   .then(r => r.json())
   *   .then(d => safeOutput(d));`
   */
  executeBody: string;
  /** Security annotations */
  annotations?: ToolAnnotations;
}

/** Security annotations for WebMCP tools */
export interface ToolAnnotations {
  /** Tool does not mutate state (default: true for built-in tools) */
  readOnlyHint?: boolean;
  /** Output may contain untrusted content (UGC, external data) */
  untrustedContentHint?: boolean;
}

/**
 * Structured content response per WebMCP spec.
 * Tools return content as typed parts (currently only "text").
 */
export interface ToolContentResponse {
  content: Array<{ type: string; text: string }>;
}

/** Entry in the generated manifest */
export interface ManifestEntry {
  slug: string;
  url: string;
  title: string;
  description?: string;
  collection?: string;
  tags?: string[];
  /** Heading IDs extracted from built HTML (for deep-linking) */
  headings?: Array<{ id: string; text: string; level: number }>;
  /** OpenGraph title (if different from <title>) */
  ogTitle?: string;
  /** OpenGraph description */
  ogDescription?: string;
  /** Canonical URL */
  canonical?: string;
  /** Page language (from <html lang>) */
  lang?: string;
  /** Approximate word count of main content */
  wordCount?: number;
}

/** Full manifest generated at build time */
export interface WebMCPManifest {
  generatedAt: string;
  site?: string;
  collections: Array<{ name: string; count: number }>;
  entries: ManifestEntry[];
}
