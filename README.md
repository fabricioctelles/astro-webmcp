# astro-webmcp

[![npm version](https://img.shields.io/npm/v/astro-webmcp?color=blue)](https://www.npmjs.com/package/astro-webmcp)
[![npm downloads](https://img.shields.io/npm/dm/astro-webmcp)](https://www.npmjs.com/package/astro-webmcp)
[![Astro](https://img.shields.io/badge/Astro-6+-ff5d01?logo=astro&logoColor=white)](https://astro.build)
[![WebMCP](https://img.shields.io/badge/WebMCP-Chrome_149+-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/ai/webmcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Built--in_types-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

> 🤖 Make your Astro site AI-agent ready in one line of code.

Astro integration that automatically exposes your site's content via [WebMCP](https://developer.chrome.com/docs/ai/webmcp) — allowing AI agents to discover, search, and navigate your content directly in the browser.

## What is WebMCP?

WebMCP is a proposed web standard by Chrome that lets websites declare structured "tools" for AI agents. Instead of an agent visually interpreting each page element, the site explicitly declares what can be done — search articles, navigate to sections, get page metadata.

- **Spec:** https://webmachinelearning.github.io/webmcp/
- **Chrome docs:** https://developer.chrome.com/docs/ai/webmcp
- **GitHub:** https://github.com/webmachinelearning/webmcp

## Installation

```bash
npm install astro-webmcp
```

## Basic usage

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import webmcp from 'astro-webmcp';

export default defineConfig({
  integrations: [webmcp()],
});
```

That's it. All your site content is now exposed via WebMCP automatically.

## Configuration options

```js
webmcp({
  collections: ['blog', 'docs'], // filter which collections to expose (default: all)

  // Custom tools — expose your own domain-specific functionality
  customTools: [
    {
      name: 'search_products',
      description: 'Search the product catalog by name or keyword.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' },
        },
        required: ['query'],
      },
      executeBody: `return fetch('/api/search?q=' + encodeURIComponent(params.query))
        .then(r => r.json())
        .then(d => safeOutput(d));`,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    },
  ],

  // Search backend for search_content tool (default: 'manifest')
  search: {
    backend: 'pagefind',       // 'manifest' | 'pagefind' | 'orama'
    pagefindBundlePath: '/pagefind/',
    // oramaIndexUrl: '/search-index.json',  // required for 'orama'
  },

  security: {
    exposedTo: [],          // origins allowed cross-origin access (default: none)
    maxOutputLength: 1500,  // max chars per tool output (default: 1500)
    sanitizeOutputs: true,  // strip prompt injection patterns (default: true)
  },
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `collections` | `string[]` | `undefined` (all) | List of collections to include in the manifest |
| `customTools` | `CustomTool[]` | `[]` | Domain-specific tools registered alongside built-in ones |
| `search.backend` | `'manifest' \| 'pagefind' \| 'orama'` | `'manifest'` | Search backend for `search_content` |
| `search.pagefindBundlePath` | `string` | `'/pagefind/'` | Pagefind bundle path |
| `search.oramaIndexUrl` | `string` | — | URL of pre-built Orama index (required for `'orama'`) |
| `security.exposedTo` | `string[]` | `[]` | Origins allowed to access tools cross-origin |
| `security.maxOutputLength` | `number` | `1500` | Character limit per tool output |
| `security.sanitizeOutputs` | `boolean` | `true` | Strip patterns that resemble prompt injection |

### Custom tools

Each custom tool needs: `name`, `description`, `inputSchema` (JSON Schema), `executeBody` (function body as string), and optional `annotations`. The `executeBody` runs in the browser and receives `params` (tool arguments) and `safeOutput` (sanitization helper). Must return data or a Promise.

### Search backends

`search_content` supports three backends with automatic fallback to manifest:

| Backend | Description | Requires |
|---------|-------------|----------|
| `manifest` (default) | Substring search on the generated manifest | Nothing — always works |
| `pagefind` | Full-text search via Pagefind | `astro-pagefind` or `pagefind` loaded on the page |
| `orama` | Full-text search via Orama | `@orama/orama` + pre-built index at `oramaIndexUrl` |

If the configured backend returns no results or fails, it falls back to manifest search automatically.

## Registered tools

| Tool | Description |
|------|-------------|
| `search_content` | Search articles and pages by keyword (supports manifest, Pagefind, or Orama backends) |
| `list_sections` | List available content sections with item counts |
| `go_to` | Navigate to a specific page by slug (prompts user consent via `requestUserInteraction`) |
| `get_page_info` | Get current page metadata (title, description, headings, language, word count, canonical URL) |
| *your custom tools* | Whatever you define via `customTools` |

### Tool schemas

#### `search_content`

```json
{
  "name": "search_content",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search term" },
      "collection": { "type": "string", "description": "Filter by collection (optional)" },
      "limit": { "type": "number", "description": "Max results (default: 5)" }
    },
    "required": ["query"]
  }
}
```

#### `list_sections`

```json
{
  "name": "list_sections",
  "inputSchema": { "type": "object", "properties": {} }
}
```

#### `go_to`

```json
{
  "name": "go_to",
  "inputSchema": {
    "type": "object",
    "properties": {
      "slug": { "type": "string", "description": "Page slug or path" }
    },
    "required": ["slug"]
  }
}
```

#### `get_page_info`

```json
{
  "name": "get_page_info",
  "inputSchema": { "type": "object", "properties": {} }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      BUILD TIME                          │
│                                                         │
│  Astro pages ────→ Hook astro:build:done                │
│                         │                               │
│                         ▼                               │
│                   /_webmcp/manifest.json                 │
│                   (titles, slugs, descriptions)          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    RUNTIME (Browser)                     │
│                                                         │
│  Injected script (head-inline)                          │
│       │                                                 │
│       ├─ fetch('/_webmcp/manifest.json')                │
│       │                                                 │
│       └─ document.modelContext.provideContext({ tools }) │
│            ├── search_content                           │
│            ├── list_sections                            │
│            ├── go_to (+requestUserInteraction)           │
│            └── get_page_info                            │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                      AI AGENT                           │
│                                                         │
│  Chrome 149+ discovers tools via WebMCP protocol        │
│  Agent can search, list, and navigate site content      │
└─────────────────────────────────────────────────────────┘
```

### Components

**Integration (`src/index.ts`)** — implements `AstroIntegration` with three hooks:

- `astro:config:setup` — injects the client-side script into every page via `injectScript`
- `astro:server:setup` — serves a dynamic manifest during development
- `astro:build:done` — generates `/_webmcp/manifest.json` by extracting titles and descriptions from built HTML

**Client script (`src/client.ts`)** — runs in the browser on every page:

1. Feature detection: `document.modelContext ?? navigator.modelContext`
2. Fetches the manifest from `/_webmcp/manifest.json`
3. Registers 4 tools with JSON Schema input definitions

**Manifest (`/_webmcp/manifest.json`)** — static JSON generated at build time:

```json
{
  "generatedAt": "2026-06-07T00:45:30.260Z",
  "site": "https://example.com",
  "collections": [
    { "name": "blog", "count": 42 },
    { "name": "docs", "count": 15 }
  ],
  "entries": [
    {
      "slug": "blog/my-article",
      "url": "/blog/my-article/",
      "title": "My Article",
      "description": "Article summary",
      "collection": "blog"
    }
  ]
}
```

### Design decisions

| Decision | Rationale |
|----------|-----------|
| Static JSON manifest (not virtual module) | Works for both SSG and SSR, CDN-cacheable, no complex Vite plugin needed |
| Client-side search | No server endpoint needed for small/medium sites (<1000 pages) |
| Imperative API (not Declarative) | Search and navigation aren't forms — they need JS logic |
| Feature detection with fallback | `document.modelContext` (spec) with `navigator.modelContext` fallback for Chrome 149 |

## Spec conformance

This integration tracks the [WebMCP spec](https://webmachinelearning.github.io/webmcp/) as it evolves. As of v0.4.0:

| Spec feature | Status | Notes |
|---|---|---|
| `document.modelContext` (primary API) | ✅ | Falls back to `navigator.modelContext` for Chrome 149 |
| `provideContext()` batch registration | ✅ | Falls back to `registerTool()` if unavailable |
| `signal` / `AbortController` lifecycle | ✅ | Tools deregistered on `abort()` — ready for SPA navigation |
| `requestUserInteraction()` | ✅ | Used in `go_to` before navigation (spec requirement for mutating tools) |
| Structured content response | ✅ | Returns `{ content: [{ type: "text", text }] }` per spec |
| `exposedTo` cross-origin control | ✅ | Same-origin by default |
| `outputSchema` (Issue #9) | 🔄 | Type placeholder in `CustomTool` — not enforced yet by Chrome |
| Declarative API (`toolname` attr) | ❌ | Not yet — will track spec's `SubmitEvent#respondWith()` |
| Service Worker tools (Issue #212) | ❌ | Monitoring — relates to SSR middleware approach |
| Progress reporting (Issue #196) | ❌ | Will integrate when API stabilizes |
| Skills Integration (Issue #161) | 🔄 | `/.well-known/skills/index.json` already generated (prior art) |

### `head-inline` script injection

The client script is injected via `injectScript('head-inline')` which bypasses Vite bundling. This is more reliable than `'page'` on Astro 6.4.2+ where Vite could silently drop the script in certain build configurations.

## Testing

### 1. Enable WebMCP in Chrome

Navigate to `chrome://flags/#enable-webmcp-testing` → **Enabled** → Relaunch.

### 2. Install the test extension

[Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd)

### 3. Verify tools in DevTools Console

```js
// Chrome 149
const tools = await navigator.modelContext.getTools();
console.table(tools.map(t => ({ name: t.name, description: t.description })));

// Chrome 150+
const tools = await document.modelContext.getTools();
console.table(tools.map(t => ({ name: t.name, description: t.description })));
```

### 4. Execute a tool manually

```js
const tools = await navigator.modelContext.getTools();
const search = tools.find(t => t.name === 'search_content');
const result = await navigator.modelContext.executeTool(search, '{"query": "astro"}');
console.log(JSON.parse(result));
```

## Combining with Declarative API

This plugin uses the Imperative API for search and navigation. For existing forms on your site, you can add the Declarative API manually — both coexist:

```html
<form toolname="send_message"
      tooldescription="Send a contact message."
      toolautosubmit
      action="/api/contact">
  <label for="email">Email</label>
  <input type="email" name="email" required>
  <label for="message">Message</label>
  <textarea name="message" required></textarea>
  <button type="submit">Send</button>
</form>
```

The agent will see **both** the integration tools + declarative form tools.

## Browser support

| Browser | Status |
|---------|--------|
| Chrome 149+ | ✅ Supported (flag or origin trial) |
| Edge | 🔄 Expected H2 2026 (Microsoft actively collaborating on the spec) |
| Other browsers | ❌ Script exits silently, zero overhead |

The integration is a progressive enhancement. On unsupported browsers, the injected script detects the absence of `navigator.modelContext` / `document.modelContext` and exits immediately. No errors thrown, no extra bytes parsed.

### Enabling WebMCP

WebMCP requires explicit opt-in. There are two paths depending on your use case:

#### Local development: Chrome flag

For testing on your own machine:

1. Open `chrome://flags/#enable-webmcp-testing`
2. Set to **Enabled**
3. Restart Chrome

Tools will appear for any localhost site that registers them. No token needed.

#### Production: Origin Trial

For deployed sites where real visitors should have WebMCP active (without requiring them to flip a flag), Chrome offers an [Origin Trial](https://developer.chrome.com/origintrials/#/register_trial/4163014905550602241).

**Step 1 — Register your origin**

Go to the [WebMCP Origin Trial registration page](https://developer.chrome.com/origintrials/#/register_trial/4163014905550602241) and register the domain(s) where your Astro site is deployed (e.g. `https://mysite.com`). You'll receive a trial token — a long Base64 string.

**Step 2 — Store the token**

Add the token to your `.env` file:

```bash
# .env
WEBMCP_ORIGIN_TRIAL_TOKEN=AjfC0e...your-long-token-here...Qw==
```

Never hardcode the token in source. It's tied to a specific origin and has an expiration date — keeping it in `.env` makes rotation easy.

**Step 3 — Inject the meta tag**

In your base layout (typically `src/layouts/Layout.astro` or `src/layouts/Base.astro`), add the origin trial meta tag inside `<head>`:

```astro
---
// src/layouts/Layout.astro
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    {/* WebMCP Origin Trial — enables navigator.modelContext for visitors */}
    {import.meta.env.WEBMCP_ORIGIN_TRIAL_TOKEN && (
      <meta
        http-equiv="origin-trial"
        content={import.meta.env.WEBMCP_ORIGIN_TRIAL_TOKEN}
      />
    )}

    <title>My Site</title>
  </head>
  <body>
    <slot />
  </body>
</html>
```

The conditional (`&&`) means the tag only renders when the token exists — development builds without the env var won't emit an empty meta tag.

**Step 4 — Verify**

After deploying, open DevTools → Application → Frames → top → Origin Trials. You should see "WebMCP" listed as active. Alternatively, check the Console:

```js
// Should return the registered tools if everything works
const tools = await navigator.modelContext.getTools();
console.log(tools.length, 'WebMCP tools active');
```

#### Origin trial caveats

- Tokens are **origin-bound** — `https://mysite.com` and `https://staging.mysite.com` need separate tokens.
- Tokens **expire** (typically 6-12 weeks). Chrome will email you before expiration. Renew and update your `.env`.
- The trial is available starting Chrome 149. Users on older Chrome versions simply won't have `modelContext` — the integration handles this gracefully.
- Native support (no flag or token) is targeted for H2 2026.

## Security

This plugin implements security measures aligned with the [Chrome Agent Security Guidelines](https://developer.chrome.com/docs/agents/security) and [WebMCP Tool Security](https://developer.chrome.com/docs/ai/webmcp/secure-tools) recommendations.

### Security configuration

```js
webmcp({
  security: {
    // Origins allowed to access tools cross-origin (default: none — same-origin only)
    exposedTo: ['https://trusted-partner.com'],

    // Max characters per tool output (default: 1500, per Chrome recommendation)
    maxOutputLength: 1500,

    // Sanitize outputs against indirect prompt injection (default: true)
    sanitizeOutputs: true,
  },
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `exposedTo` | `string[]` | `[]` | Origins allowed to access tools cross-origin |
| `maxOutputLength` | `number` | `1500` | Character limit per tool output |
| `sanitizeOutputs` | `boolean` | `true` | Strip patterns that resemble prompt injection |

### What is exposed

The plugin only exposes information that is **already publicly accessible** on your site:

| Data | Source | Equivalent to |
|------|--------|---------------|
| Page URLs | Built HTML files | `sitemap.xml` |
| Page titles | `<title>` tag | View source / search engines |
| Descriptions | `<meta name="description">` | View source / search engines |
| Headings (h1-h3) | DOM elements | Visible on page |

**The manifest (`/_webmcp/manifest.json`) contains no more information than your `sitemap.xml` already provides to every crawler.**

### What is NOT exposed

- ❌ No server-side data, APIs, or endpoints
- ❌ No authentication tokens or credentials
- ❌ No admin routes or private pages
- ❌ No user data (the plugin is fully static/client-side)
- ❌ No environment variables or build secrets

### Tool annotations

All built-in tools include [security annotations](https://developer.chrome.com/docs/ai/webmcp/secure-tools) to help agents make safe decisions:

| Tool | `readOnlyHint` | `untrustedContentHint` | Rationale |
|------|:-:|:-:|-----------|
| `search_content` | ✅ | ✅ | Read-only; results may contain UGC in titles/descriptions |
| `list_sections` | ✅ | — | Read-only; static collection names controlled by site owner |
| `go_to` | — | — | Mutates state (navigation); agent should confirm with user |
| `get_page_info` | ✅ | ✅ | Read-only; DOM content may include user-generated text |

### Defenses against prompt injection

The plugin implements multiple layers of defense per Chrome's [defense-in-depth](https://security.googleblog.com/2025/12/architecting-security-for-agentic.html) strategy:

#### 1. Deterministic guardrails

- **Output character limits** — All tool outputs are truncated to `maxOutputLength` (default 1.5K chars). This prevents context window overflow and limits the surface area for sophisticated prompt injection attacks.
- **Cross-origin isolation** — Tools are only accessible same-origin by default. Use `exposedTo` to explicitly allowlist trusted origins.
- **Result cap** — `search_content` enforces a maximum of 20 results regardless of the `limit` parameter.

#### 2. Output sanitization

When `sanitizeOutputs: true` (default), the plugin strips common prompt injection patterns from tool outputs:

- `"ignore previous instructions"` patterns
- Role-play injection (`"you are now..."`)
- Fake system/assistant/user message delimiters
- XML-style instruction tags (`<system>`, `<instruction>`, etc.)

This acts as a lightweight classifier for indirect prompt injection embedded in page content (e.g., malicious text in blog comments that gets indexed in titles/descriptions).

#### 3. Annotations as signals

The `readOnlyHint` and `untrustedContentHint` annotations signal to the agent:
- **Which tools are safe to call without user confirmation** (read-only tools)
- **Which outputs need heightened scrutiny** (untrusted content that could contain injected instructions)

### Character budgets

Following [Chrome's recommendations](https://developer.chrome.com/docs/ai/webmcp/secure-tools):

| Element | Limit | Status |
|---------|-------|--------|
| Tool name | 30 chars | ✅ All built-in tools comply |
| Tool description | 500 chars | ✅ All built-in tools comply |
| Parameter description | 150 chars | ✅ All parameters comply |
| Tool output | 1,500 chars | ✅ Enforced via `maxOutputLength` |

### Design principles

- **No arbitrary code execution** — tools only read static data or navigate
- **No `innerHTML`** — all output is `JSON.stringify`, no XSS vector
- **No external requests** — the manifest is fetched from same-origin only
- **Progressive enhancement** — on unsupported browsers, the script exits immediately with zero side effects
- **Origin-isolated** — WebMCP requires origin isolation; cross-origin iframes cannot access tools unless explicitly allowed
- **Annotations-first** — all tools declare their security posture via `readOnlyHint` and `untrustedContentHint`
- **Defense-in-depth** — multiple independent layers (limits, sanitization, annotations, origin control)

### For agent developers consuming this plugin

If you are building an agent that consumes tools registered by `astro-webmcp`, follow these additional recommendations from [Chrome Agent Security](https://developer.chrome.com/docs/agents/security):

1. **Respect `untrustedContentHint`** — Apply [spotlighting](https://arxiv.org/abs/2403.14720) (delimiting or Base64-encoding) to outputs from tools marked with this annotation.
2. **Set token limits** — Implement agent-level token limits on all inbound tool responses.
3. **Verify intent alignment** — Use a critic/validator to ensure tool calls align with the user's original request.
4. **Confirm state-changing actions** — Tools without `readOnlyHint: true` (like `go_to`) should trigger user confirmation.
5. **Restrict origins** — Only interact with origins relevant to the user's task.

## Troubleshooting

### Tools don't appear

1. Check that `chrome://flags/#enable-webmcp-testing` is enabled
2. Verify in the Network tab that `/_webmcp/manifest.json` returns 200
3. In Console, check `navigator.modelContext` (Chrome 149) or `document.modelContext` (150+)

### Empty manifest

- Confirm the build completed without errors
- The manifest is generated from built HTML pages — ensure `astro build` succeeds

### Search returns no results

- Search is case-insensitive across `title`, `description`, and `tags` fields
- If your pages have no `<meta name="description">`, search only matches on `title`

## Requirements

- Astro 6+
- Chrome 149+ with WebMCP enabled — see [Browser support](#browser-support) for setup options
- Origin-isolated document (Astro default)

## Status

🚧 Early development — WebMCP is an evolving standard (developer trial in Chrome 149+).

## Acknowledgments

The custom tools API, search backends (Pagefind/Orama), and enhanced metadata extraction were inspired by the [`@freshjuice/astro-webmcp`](https://github.com/freshjuice-dev/astro-webmcp) fork maintained by [Alex Zappa](https://alex.zappa.dev/) at [FreshJuice](https://freshjuice.dev). Their work identified the `head-inline` injection fix and explored extensibility patterns that informed v0.5.0 of this package.

## License

MIT

## Author

Contact the author: https://ft.ia.br
