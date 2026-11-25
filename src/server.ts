import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import {
  AE_GTM_ID,
  AE_ORIGIN,
  COM_GA4_ID,
  COM_ORIGIN,
  INDIA_ONLY_PATHS,
  STATIC_PATHS,
  isUaeHost,
  originForHost,
} from "./lib/seo";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => ((m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry)),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

// ---- SEO: robots.txt, sitemap.xml, canonicals, hreflang, GTM ------------------

const SANITY_QUERY_URL =
  "https://zaa8em17.apicdn.sanity.io/v2026-06-11/data/query/production?query=" +
  encodeURIComponent(
    `*[_type=="blog" && defined(slug.current)]{"slug": slug.current, "updated": _updatedAt}`,
  );

function isIndiaOnlyPath(pathname: string): boolean {
  return (INDIA_ONLY_PATHS as readonly string[]).includes(pathname);
}

function robotsTxt(origin: string): Response {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sitemapXml(origin: string, uae: boolean): Promise<Response> {
  const paths: string[] = [...STATIC_PATHS];
  if (!uae) paths.push(...INDIA_ONLY_PATHS);

  const entries: { loc: string; lastmod?: string }[] = paths.map((p) => ({
    loc: p === "/" ? `${origin}/` : `${origin}${p}`,
  }));

  try {
    const res = await fetch(SANITY_QUERY_URL);
    if (res.ok) {
      const data = (await res.json()) as { result?: { slug?: string; updated?: string }[] };
      for (const post of data.result ?? []) {
        if (!post.slug) continue;
        entries.push({
          loc: `${origin}/blogs/${encodeURIComponent(post.slug)}`,
          lastmod: post.updated ? post.updated.slice(0, 10) : undefined,
        });
      }
    }
  } catch (error) {
    console.error("sitemap: failed to load blog slugs", error);
  }

  const urls = entries
    .map(
      (e) =>
        `  <url><loc>${xmlEscape(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`,
    )
    .join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    },
  );
}

function gtmHeadSnippet(id: string): string {
  return `<!-- Google Tag Manager -->
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');
</script>
<!-- End Google Tag Manager -->`;
}

function ga4Snippet(id: string): string {
  return `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${id}');
</script>`;
}

function gtmBodySnippet(id: string): string {
  return `<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${id}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->`;
}

// Rewrites server-rendered HTML so each domain is self-consistent:
//  - .ae pages point their canonical / og:url / schema URLs at ozonextravel.ae
//    (India-only city pages keep their .com canonical)
//  - any leftover ozonex.com URLs are corrected
//  - pages without a canonical get a self-referencing one
//  - hreflang alternates link the India and UAE versions
//  - GTM is injected on ozonextravel.ae
async function rewriteHtml(response: Response, url: URL): Promise<Response> {
  const uae = isUaeHost(url.hostname);
  const indiaOnly = isIndiaOnlyPath(url.pathname);
  const origin = uae && !indiaOnly ? AE_ORIGIN : COM_ORIGIN;
  const path = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  const selfUrl = path === "/" ? `${origin}/` : `${origin}${path}`;

  let html = await response.text();

  html = html.replace(/https:\/\/(www\.)?ozonex\.com/g, COM_ORIGIN);
  html = html.replace(/https:\/\/www\.ozonextravel\.com/g, COM_ORIGIN);
  if (uae && !indiaOnly) {
    html = html.split(COM_ORIGIN).join(AE_ORIGIN);
  }

  const headExtras: string[] = [];

  if (!/<link[^>]+rel=["']canonical["']/i.test(html)) {
    headExtras.push(`<link rel="canonical" href="${xmlEscape(selfUrl)}"/>`);
  }
  if (!/<meta[^>]+property=["']og:url["']/i.test(html)) {
    headExtras.push(`<meta property="og:url" content="${xmlEscape(selfUrl)}"/>`);
  }

  if (!url.pathname.startsWith("/admin")) {
    const comUrl = path === "/" ? `${COM_ORIGIN}/` : `${COM_ORIGIN}${path}`;
    const aeUrl = path === "/" ? `${AE_ORIGIN}/` : `${AE_ORIGIN}${path}`;
    headExtras.push(`<link rel="alternate" hreflang="en-IN" href="${xmlEscape(comUrl)}"/>`);
    if (!indiaOnly) {
      headExtras.push(`<link rel="alternate" hreflang="en-AE" href="${xmlEscape(aeUrl)}"/>`);
    }
    headExtras.push(`<link rel="alternate" hreflang="x-default" href="${xmlEscape(comUrl)}"/>`);
  } else {
    headExtras.push(`<meta name="robots" content="noindex, nofollow"/>`);
  }

  if (uae) {
    // GTM goes as high in <head> as possible, per Google's install guidance.
    // (after <meta charset> when present, so the charset stays in the first bytes).
    const charset = /<meta[^>]+charset=[^>]*>/i;
    html = charset.test(html)
      ? html.replace(charset, (m) => `${m}${gtmHeadSnippet(AE_GTM_ID)}`)
      : html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${gtmHeadSnippet(AE_GTM_ID)}`);
    html = html.replace(/<body(\s[^>]*)?>/i, (m) => `${m}${gtmBodySnippet(AE_GTM_ID)}`);
  } else if (!url.pathname.startsWith("/admin")) {
    // Google tag (GA4) on ozonextravel.com, right after <meta charset> / <head>.
    const charset = /<meta[^>]+charset=[^>]*>/i;
    html = charset.test(html)
      ? html.replace(charset, (m) => `${m}${ga4Snippet(COM_GA4_ID)}`)
      : html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${ga4Snippet(COM_GA4_ID)}`);
  }

  if (headExtras.length) {
    html = html.replace(/<\/head>/i, `${headExtras.join("")}</head>`);
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const url = new URL(request.url);
      const host = url.hostname.toLowerCase();

      // www -> apex (only takes effect once www DNS points at this Worker)
      if (host === "www.ozonextravel.com" || host === "www.ozonextravel.ae") {
        url.hostname = host.slice(4);
        url.protocol = "https:";
        return Response.redirect(url.toString(), 301);
      }

      const origin = originForHost(host);
      if (url.pathname === "/robots.txt") return robotsTxt(origin);
      if (url.pathname === "/sitemap.xml") return await sitemapXml(origin, isUaeHost(host));

      const handler = await getServerEntry();
      const response = await normalizeCatastrophicSsrResponse(
        await handler.fetch(request, env, ctx),
      );

      const contentType = response.headers.get("content-type") ?? "";
      if (request.method === "GET" && contentType.includes("text/html")) {
        return await rewriteHtml(response, url);
      }
      return response;
    } catch (error) {
      console.error(error);
      return brandedErrorResponse();
    }
  },
};
