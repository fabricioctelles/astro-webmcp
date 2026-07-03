import type { AstroIntegration } from 'astro';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomTool, SearchOptions, SecurityOptions, WebMCPManifest, WebMCPOptions } from './types.js';

export type { WebMCPOptions, CustomTool, ManifestEntry, WebMCPManifest, SecurityOptions, SearchOptions, ToolAnnotations, ToolContentResponse } from './types.js';

/**
 * Astro integration que expõe conteúdo do site via WebMCP.
 *
 * No build: gera /_webmcp/manifest.json com metadados das páginas.
 * No browser: injeta script que registra tools via document.modelContext.
 *
 * v7 features (auto-detected, inactive on v6):
 * - Route caching on manifest endpoint (if cache provider configured)
 * - Heading IDs extraction (Sätteri generates them by default)
 * - Agent Skills Discovery (/.well-known/skills/index.json)
 *
 * @see https://developer.chrome.com/docs/ai/webmcp/secure-tools
 * @see https://developer.chrome.com/docs/agents/security
 */
export default function astroWebMCP(options: WebMCPOptions = {}): AstroIntegration {
  let siteUrl: string | undefined;
  let hasRouteCaching = false;
  let isSSR = false;

  const security: Required<SecurityOptions> = {
    exposedTo: options.security?.exposedTo ?? [],
    maxOutputLength: options.security?.maxOutputLength ?? 1500,
    sanitizeOutputs: options.security?.sanitizeOutputs ?? true,
  };

  const clientPath = join(dirname(fileURLToPath(import.meta.url)), 'client.js');

  return {
    name: 'astro-webmcp',

    hooks: {
      'astro:config:setup': ({ config, injectScript, logger, addMiddleware }) => {
        siteUrl = config.site;

        // Feature detection: route caching (v7 stable, v6 experimental)
        const cfg = config as unknown as Record<string, unknown>;
        hasRouteCaching = !!(cfg.cache && typeof cfg.cache === 'object');
        isSSR = config.output !== 'static';

        // v7: register middleware for dynamic manifest in SSR mode
        if (isSSR && typeof addMiddleware === 'function') {
          addMiddleware({
            entrypoint: fileURLToPath(new URL('./middleware.mjs', import.meta.url)),
            order: 'pre',
          });
        }

        const customTools = options.customTools ?? [];
        const search: SearchOptions = {
          backend: options.search?.backend ?? 'manifest',
          oramaIndexUrl: options.search?.oramaIndexUrl,
          pagefindBundlePath: options.search?.pagefindBundlePath ?? '/pagefind/',
        };

        const configScript = `globalThis.__WEBMCP_CONFIG__=${JSON.stringify({
          ...security,
          customTools,
          search,
        })};`;

        let clientCode: string;
        try {
          clientCode = readFileSync(clientPath, 'utf-8');
        } catch {
          clientCode = getInlineClient();
        }

        injectScript('head-inline', configScript + clientCode);

        const features: string[] = [];
        if (hasRouteCaching) features.push('route-caching');
        if (isSSR) features.push('ssr-manifest');
        logger.info(`WebMCP registered${features.length ? ` [${features.join(', ')}]` : ''}`);
      },

      'astro:server:setup': ({ server, logger }) => {
        server.middlewares.use('/_webmcp/manifest.json', (_req, res) => {
          const manifest: WebMCPManifest = {
            generatedAt: new Date().toISOString(),
            site: siteUrl,
            collections: [],
            entries: [
              { slug: '/', url: '/', title: 'Home', description: 'Homepage' },
            ],
          };
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify(manifest));
        });
        logger.info('WebMCP dev manifest at /_webmcp/manifest.json');
      },

      'astro:build:done': async ({ dir, pages, logger }) => {
        const collectionsFilter = options.collections;
        const collectionMap = new Map<string, number>();
        const entries: WebMCPManifest['entries'] = [];

        for (const page of pages) {
          const pathname = page.pathname;
          const segments = pathname.split('/').filter(Boolean);
          const collection = segments[0] || '_root';

          if (collectionsFilter && segments.length > 0 && !collectionsFilter.includes(collection)) {
            continue;
          }

          collectionMap.set(collection, (collectionMap.get(collection) ?? 0) + 1);

          const slug = pathname.replace(/\/$/, '') || '/';
          const url = '/' + pathname;
          const meta = extractMeta(dir, pathname);

          entries.push({
            slug,
            url,
            ...meta,
            collection: segments.length > 0 ? collection : undefined,
          });
        }

        const manifest: WebMCPManifest = {
          generatedAt: new Date().toISOString(),
          site: siteUrl,
          collections: Array.from(collectionMap.entries())
            .filter(([name]) => name !== '_root')
            .map(([name, count]) => ({ name, count })),
          entries,
        };

        const outDir = fileURLToPath(dir);

        // Write manifest
        const manifestPath = join(outDir, '_webmcp', 'manifest.json');
        await mkdir(dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

        // Agent Skills Discovery: generate /.well-known/skills/index.json
        if (options.skills !== false) {
          const skillsIndex = buildSkillsIndex(siteUrl, manifest, options);
          const skillsPath = join(outDir, '.well-known', 'skills', 'index.json');
          await mkdir(dirname(skillsPath), { recursive: true });
          await writeFile(skillsPath, JSON.stringify(skillsIndex, null, 2));
          logger.info(`Agent Skills Discovery: /.well-known/skills/index.json`);
        }

        logger.info(`WebMCP manifest: ${entries.length} entries, ${manifest.collections.length} collections`);
      },
    },
  };
}

/** Builds /.well-known/skills/index.json for Agent Skills Discovery RFC */
function buildSkillsIndex(
  siteUrl: string | undefined,
  manifest: WebMCPManifest,
  options: WebMCPOptions,
) {
  const base = siteUrl?.replace(/\/$/, '') ?? '';
  const skills: Array<Record<string, unknown>> = [
    {
      name: 'search-site-content',
      description: `Search articles and pages on ${base || 'this site'} by keyword. Returns title, URL, and description.`,
      url: `${base}/_webmcp/manifest.json`,
      transport: 'webmcp',
      annotations: { readOnlyHint: true },
    },
    {
      name: 'browse-site-sections',
      description: `List content sections available: ${manifest.collections.map(c => c.name).join(', ') || 'all pages'}.`,
      url: `${base}/_webmcp/manifest.json`,
      transport: 'webmcp',
      annotations: { readOnlyHint: true },
    },
  ];

  // Add custom skills from options
  if (options.customTools) {
    for (const tool of options.customTools) {
      skills.push({
        name: tool.name,
        description: tool.description,
        url: `${base}/_webmcp/manifest.json`,
        transport: 'webmcp',
        annotations: tool.annotations,
      });
    }
  }

  return {
    version: '1.0',
    name: options.skillsName ?? 'WebMCP Tools',
    description: options.skillsDescription ?? `AI-accessible tools for ${base || 'this site'}`,
    skills,
  };
}

/**
 * Extracts title, description, headings, tags, OG metadata, canonical, lang, and word count
 * from generated HTML. Enhanced metadata inspired by @freshjuice/astro-webmcp.
 */
function extractMeta(dir: URL, pathname: string): {
  title: string;
  description: string;
  headings?: Array<{ id: string; text: string; level: number }>;
  tags?: string[];
  ogTitle?: string;
  ogDescription?: string;
  canonical?: string;
  lang?: string;
  wordCount?: number;
} {
  try {
    const htmlPath = join(fileURLToPath(dir), pathname, 'index.html');
    const html = readFileSync(htmlPath, 'utf-8');

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);

    // OpenGraph metadata
    const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);

    // Canonical URL
    const canonicalMatch = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);

    // Language
    const langMatch = html.match(/<html[^>]*\slang=["']([^"']+)["']/i);

    // Tags from <meta name="keywords"> and <a rel="tag">
    const tags: string[] = [];
    const keywordsMatch = html.match(/<meta\s+name=["']keywords["']\s+content=["']([^"']+)["']/i);
    if (keywordsMatch?.[1]) {
      tags.push(...keywordsMatch[1].split(',').map(t => t.trim()).filter(Boolean));
    }
    const articleTagRegex = /<a[^>]+rel=["']tag["'][^>]*>([^<]+)<\/a>/gi;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = articleTagRegex.exec(html)) !== null) {
      const tag = tagMatch[1].trim();
      if (tag && !tags.includes(tag)) tags.push(tag);
    }

    // Heading IDs for deep-linking
    const headings: Array<{ id: string; text: string; level: number }> = [];
    const headingRegex = /<h([1-3])\s+id=["']([^"']+)["'][^>]*>([^<]+)<\/h\1>/gi;
    let hMatch: RegExpExecArray | null;
    while ((hMatch = headingRegex.exec(html)) !== null) {
      headings.push({ level: parseInt(hMatch[1]), id: hMatch[2], text: hMatch[3].trim() });
    }

    // Word count from <main> content
    let wordCount: number | undefined;
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch?.[1]) {
      const text = mainMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      wordCount = text.split(/\s+/).length;
    }

    return {
      title: titleMatch?.[1]?.trim() ?? pathname.split('/').filter(Boolean).pop() ?? 'Home',
      description: descMatch?.[1]?.trim() ?? '',
      ...(headings.length > 0 ? { headings } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ogTitle: ogTitleMatch?.[1]?.trim() || undefined,
      ogDescription: ogDescMatch?.[1]?.trim() || undefined,
      canonical: canonicalMatch?.[1]?.trim() || undefined,
      lang: langMatch?.[1]?.trim() || undefined,
      wordCount,
    };
  } catch {
    return {
      title: pathname.split('/').filter(Boolean).pop() ?? 'Home',
      description: '',
    };
  }
}

/** Client inline mínimo como fallback */
function getInlineClient(): string {
  return `(async()=>{const C=globalThis.__WEBMCP_CONFIG__||{maxOutputLength:1500,sanitizeOutputs:true};const mc=document.modelContext||navigator.modelContext;if(!mc?.registerTool)return;let m;try{const r=await fetch("/_webmcp/manifest.json");if(!r.ok)return;m=await r.json()}catch{return}function sn(t){if(!C.sanitizeOutputs)return t;return t.replace(/ignore\\s+(all\\s+)?(previous|above|prior)\\s+(instructions?|prompts?|rules?)/gi,"[filtered]").replace(/you\\s+are\\s+(now|a)\\s+/gi,"[filtered]").replace(/(system|assistant|user)\\s*:\\s*/gi,"[filtered]").replace(/<\\/?(?:system|instruction|prompt|command)[^>]*>/gi,"[filtered]")}function so(d){let s=JSON.stringify(d);s=sn(s);if(s.length>C.maxOutputLength)s=s.slice(0,C.maxOutputLength-13)+"...[truncated]";return{content:[{type:"text",text:s}]}}const ac=new AbortController();const opts={signal:ac.signal,...(C.exposedTo?.length?{exposedTo:C.exposedTo}:{})};const tools=[{name:"search_content",description:"Search articles and pages on this site by keyword.",annotations:{readOnlyHint:true,untrustedContentHint:true},inputSchema:{type:"object",properties:{query:{type:"string",description:"Search term"},collection:{type:"string",description:"Filter by collection (optional)"},limit:{type:"number",description:"Max results (default: 5)"}},required:["query"]},execute:async({query:q,collection:c,limit:l=5})=>{const t=q.toLowerCase();let r=m.entries.filter(e=>e.title.toLowerCase().includes(t)||(e.description||"").toLowerCase().includes(t)||(e.tags||[]).some(tg=>tg.toLowerCase().includes(t)));if(c)r=r.filter(e=>e.collection===c);return so(r.slice(0,Math.min(l,20)))}},{name:"list_sections",description:"List content sections available on this site.",annotations:{readOnlyHint:true},inputSchema:{type:"object",properties:{}},execute:async()=>so(m.collections)},{name:"go_to",description:"Navigate to a page by slug.",annotations:{readOnlyHint:false},inputSchema:{type:"object",properties:{slug:{type:"string",description:"Page slug or path"}},required:["slug"]},execute:async({slug:s})=>{const e=m.entries.find(x=>x.slug===s||x.url===s||x.url==="/"+s+"/");if(!e)return so({error:"Page not found. Use search_content to find available pages."});if(mc.requestUserInteraction){const ok=await mc.requestUserInteraction({message:"Navigate to \\""+e.title+"\\" ("+e.url+")?"});if(!ok)return so({cancelled:true,message:"Navigation cancelled by user."})}window.location.href=e.url;return null}},{name:"get_page_info",description:"Get current page metadata.",annotations:{readOnlyHint:true,untrustedContentHint:true},inputSchema:{type:"object",properties:{}},execute:async()=>{const h=Array.from(document.querySelectorAll("h1,h2,h3")).map(x=>({level:parseInt(x.tagName[1]),text:x.textContent?.trim()||"",...(x.id?{id:x.id}:{})}));return so({title:document.title,description:document.querySelector('meta[name="description"]')?.getAttribute("content")||"",headings:h,url:location.pathname,lang:document.documentElement.lang||undefined,canonical:document.querySelector('link[rel="canonical"]')?.getAttribute("href")||undefined})}}];if(mc.provideContext){mc.provideContext({tools},opts)}else{for(const t of tools)mc.registerTool(t,opts)}globalThis.__WEBMCP_ABORT__=()=>ac.abort()})();`;
}
