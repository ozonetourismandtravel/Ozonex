// Shared SEO helpers for the two market sites served by this one codebase:
//   ozonextravel.com -> India (en-IN, x-default)
//   ozonextravel.ae  -> UAE   (en-AE)
//
// Route head() functions write .com URLs. On the .ae host, src/server.ts rewrites
// them to .ae in the server-rendered HTML, so each domain gets self-referencing
// canonicals. siteOrigin() keeps client-side navigation consistent with that.

export const COM_ORIGIN = "https://ozonextravel.com";
export const AE_ORIGIN = "https://ozonextravel.ae";

// Google Tag Manager container for ozonextravel.ae
export const AE_GTM_ID = "GTM-MVBFJJCH";

export function isUaeHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".ae");
}

export function originForHost(hostname: string): string {
  return isUaeHost(hostname) ? AE_ORIGIN : COM_ORIGIN;
}

export function siteOrigin(): string {
  if (typeof window === "undefined") return COM_ORIGIN;
  return originForHost(window.location.hostname);
}

export function siteUrl(path: string): string {
  if (path === "/" || path === "") return `${siteOrigin()}/`;
  const clean = path.replace(/\/+$/, "");
  return `${siteOrigin()}${clean.startsWith("/") ? clean : `/${clean}`}`;
}

// Public, indexable routes. Used for sitemap.xml.
export const STATIC_PATHS = [
  "/",
  "/product",
  "/solutions",
  "/pricing",
  "/about",
  "/blogs",
  "/mice-events",
  "/b2b",
  "/b2e",
  "/cbt",
  "/register",
  "/privacy",
] as const;

// City landing pages are India-only content, so they are listed only in the .com sitemap.
export const INDIA_ONLY_PATHS = [
  "/corporate-travel-management-bangalore",
  "/corporate-travel-management-chennai",
  "/corporate-travel-management-delhi",
] as const;
