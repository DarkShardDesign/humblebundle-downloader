import { cleanName } from "./names";
import type { DownloadableFile, LibraryBundle } from "./types";
import type { LibraryEntitlementRow } from "./library-rsc";
import { bundlesFromFlightPageText } from "./parse-flight-library-item";

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\//g, "/");
  }
}

export function normalizeWebUrl(web: string): string {
  let url = web.replace(/\\\//g, "/");
  if (url.startsWith("//")) {
    return `https:${url}`;
  }
  if (url.startsWith("/")) {
    return `https://www.humblebundle.com${url}`;
  }
  return url;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|ico|avif)(\?|$)/i;
const CONTENT_EXT =
  /\.(pdf|epub|mobi|prc|cbz|cbr|zip|7z|tar|gz|bz2|mp3|flac|wav|m4a|apk|dmg|exe|msi|deb|rpm|iso|chm|azw3?)(\?|$)/i;

function basenameFromUrl(url: string): string {
  return url.split("?")[0].split("/").pop() ?? "";
}

/** Reject avatars, marketing images, and Next static assets — keep real download endpoints. */
export function isLikelyContentDownloadUrl(
  url: string,
  filenameHint?: string,
): boolean {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return false;
  }
  if (
    /steampowered\.com|steamcommunity\.com|epicgames\.com|gog\.com/i.test(url)
  ) {
    return false;
  }
  if (
    /\/_next\/|\/static\/|gravatar|avatar|profile-image|optimizely|sentry/i.test(
      url,
    )
  ) {
    return false;
  }

  const name = filenameHint ?? basenameFromUrl(url);
  if (IMAGE_EXT.test(url) || IMAGE_EXT.test(name)) {
    return false;
  }

  if (/\/downloads(\/|\?)/i.test(url)) {
    return true;
  }
  if (CONTENT_EXT.test(url) || CONTENT_EXT.test(name)) {
    return true;
  }

  return false;
}

/** Only explicit /downloads/ URLs from flight text — no broad CDN scrape. */
export function extractExplicitDownloadUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const m of text.matchAll(
    /https?:\/\/[^"\\\s]+\.humblebundle\.com\/downloads\/[^"\\\s]+/gi,
  )) {
    const url = m[0];
    if (isLikelyContentDownloadUrl(url)) {
      urls.add(url);
    }
  }
  return [...urls];
}

function walkForDownloadStruct(
  node: unknown,
  onPart: (part: {
    name?: string;
    url?: { web?: string };
    platform?: string;
    key?: string;
  }) => void,
) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walkForDownloadStruct(item, onPart);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.downloadStruct)) {
    for (const part of obj.downloadStruct) {
      if (part && typeof part === "object") {
        onPart(part as { name?: string; url?: { web?: string } });
      }
    }
  }
  if (Array.isArray(obj.downloads)) {
    for (const dl of obj.downloads) {
      if (dl && typeof dl === "object") {
        const d = dl as {
          downloadStruct?: unknown[];
          platform?: string;
          key?: string;
        };
        for (const part of d.downloadStruct ?? []) {
          if (part && typeof part === "object") {
            onPart({
              ...(part as { name?: string; url?: { web?: string } }),
              platform: d.platform,
              key: d.key,
            });
          }
        }
      }
    }
  }
  for (const value of Object.values(obj)) {
    walkForDownloadStruct(value, onPart);
  }
}

function parseRscJsonPayloads(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) {
      continue;
    }
    const body = line.slice(colon + 1).trim();
    if (!body.startsWith("{") && !body.startsWith("[")) {
      continue;
    }
    try {
      out.push(JSON.parse(body));
    } catch {
      /* skip flight refs */
    }
  }
  return out;
}

function productTitleFromPageText(text: string, fallback: string): string {
  const titles = [
    ...text.matchAll(/"human_name"\s*:\s*"((?:\\.|[^"\\])*)"/g),
    ...text.matchAll(/"productName"\s*:\s*"((?:\\.|[^"\\])*)"/g),
  ].map((m) => decodeJsonString(m[1]));

  const skip = /account information|humble bundle|library/i;
  for (const t of titles) {
    if (t && !skip.test(t)) {
      return cleanName(t);
    }
  }

  const entitlementTitle = text.match(
    /"entitlements"[\s\S]{0,4000}?"title"\s*:\s*"((?:\\.|[^"\\])*)"/,
  )?.[1];
  if (entitlementTitle && !skip.test(entitlementTitle)) {
    return cleanName(decodeJsonString(entitlementTitle));
  }

  const pageTitle = text.match(
    /"title"\s*:\s*"((?:\\.|[^"\\])*)"/,
  )?.[1];
  if (pageTitle && !skip.test(pageTitle)) {
    return cleanName(decodeJsonString(pageTitle));
  }

  return cleanName(fallback);
}

function bundleTitleFromPageText(text: string, fallback: string): string {
  const sub = text.match(/"subTitle"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
  if (sub) {
    return cleanName(decodeJsonString(sub));
  }
  return cleanName(fallback);
}

function addDownload(
  downloads: DownloadableFile[],
  opts: {
    orderId: string;
    bundleTitle: string;
    productTitle: string;
    platform: string;
    filename: string;
    url: string;
  },
) {
  if (!isLikelyContentDownloadUrl(opts.url, opts.filename)) {
    return;
  }
  downloads.push({
    id: `${opts.orderId}:${opts.filename}:${opts.platform}`,
    ...opts,
  });
}

export function downloadsFromEntitlementRow(
  row: LibraryEntitlementRow,
  orderId: string,
): DownloadableFile[] {
  const bundleTitle = cleanName(row.subTitle ?? row.title ?? "Library");
  const productTitle = cleanName(row.title ?? "Item");
  const out: DownloadableFile[] = [];

  const blocks = row.entitlements?.downloads ?? [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const blockObj = block as {
      id?: string;
      downloads?: Array<{
        key?: string;
        platform?: string;
        downloadStruct?: Array<{
          name?: string;
          url?: { web?: string };
        }>;
      }>;
    };
    for (const dl of blockObj.downloads ?? []) {
      const platform = (dl.platform ?? dl.key ?? "download").toLowerCase();
      if (platform === "steam") {
        continue;
      }
      for (const part of dl.downloadStruct ?? []) {
        let web = part.url?.web;
        if (!web) {
          continue;
        }
        web = normalizeWebUrl(web);
        const filename =
          part.name?.split("/").pop() ??
          basenameFromUrl(web) ??
          "download";
        addDownload(out, {
          orderId,
          bundleTitle,
          productTitle,
          platform,
          filename,
          url: web,
        });
      }
    }
  }
  return out;
}

export function bundlesFromEntitlementRow(
  row: LibraryEntitlementRow,
): LibraryBundle | null {
  const orderId = row.productEntitlementId ?? row.id;
  if (!orderId) {
    return null;
  }
  const downloads = downloadsFromEntitlementRow(row, orderId);
  if (downloads.length === 0) {
    return null;
  }
  return {
    orderId,
    title: downloads[0].bundleTitle,
    products: [
      {
        orderId,
        bundleTitle: downloads[0].bundleTitle,
        productTitle: downloads[0].productTitle,
        downloads,
      },
    ],
  };
}

export function bundleFromPageText(
  path: string,
  text: string,
): LibraryBundle | null {
  const orderId =
    text.match(/"productEntitlementId"\s*:\s*"([^"]+)"/)?.[1] ??
    path.match(/[0-9a-f-]{36}/i)?.[0] ??
    path;

  const productTitle = productTitleFromPageText(text, "Item");
  const bundleTitle = bundleTitleFromPageText(text, "Library");

  const downloads: DownloadableFile[] = [];

  for (const payload of parseRscJsonPayloads(text)) {
    walkForDownloadStruct(payload, (part) => {
      const web = part.url?.web;
      if (!web) {
        return;
      }
      const normalized = normalizeWebUrl(web);
      const platform = (part.platform ?? part.key ?? "download").toLowerCase();
      const filename =
        part.name?.split("/").pop() ?? basenameFromUrl(normalized) ?? "download";
      addDownload(downloads, {
        orderId,
        bundleTitle,
        productTitle,
        platform,
        filename,
        url: normalized,
      });
    });
  }

  for (const web of extractExplicitDownloadUrls(text)) {
    const filename = basenameFromUrl(web) || "download";
    const platform = filename.split(".").pop()?.toLowerCase() ?? "download";
    addDownload(downloads, {
      orderId,
      bundleTitle,
      productTitle,
      platform,
      filename,
      url: web,
    });
  }

  const unique = new Map<string, DownloadableFile>();
  for (const d of downloads) {
    unique.set(d.id, d);
  }
  const list = [...unique.values()];
  if (list.length === 0) {
    return null;
  }

  return {
    orderId,
    title: bundleTitle,
    products: [
      {
        orderId,
        bundleTitle,
        productTitle,
        downloads: list,
      },
    ],
  };
}

/** Pull entitlement-shaped objects with downloads out of RSC / JSON text. */
export function parseEntitlementRowsFromText(
  text: string,
): LibraryEntitlementRow[] {
  const rows: LibraryEntitlementRow[] = [];
  const seen = new Set<string>();

  for (const payload of parseRscJsonPayloads(text)) {
    if (payload && typeof payload === "object") {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.results)) {
        for (const row of obj.results as LibraryEntitlementRow[]) {
          if (row.id && !seen.has(row.id)) {
            seen.add(row.id);
            rows.push(row);
          }
        }
      } else if (obj.entitlements || obj.title) {
        const id = (obj.id as string) ?? (obj.title as string);
        if (!seen.has(id)) {
          seen.add(id);
          rows.push(obj as LibraryEntitlementRow);
        }
      }
    }
  }

  return rows;
}

export function bundlesFromPageText(
  path: string,
  html: string,
  rsc: string,
): LibraryBundle[] {
  const combined = `${html}\n${rsc}`;
  const bundles: LibraryBundle[] = [];
  const seen = new Set<string>();

  for (const bundle of bundlesFromFlightPageText(path, html, rsc)) {
    if (!seen.has(bundle.orderId)) {
      seen.add(bundle.orderId);
      bundles.push(bundle);
    }
  }

  for (const row of parseEntitlementRowsFromText(combined)) {
    const bundle = bundlesFromEntitlementRow(row);
    if (bundle && !seen.has(bundle.orderId)) {
      seen.add(bundle.orderId);
      bundles.push(bundle);
    }
  }

  const direct = bundleFromPageText(path, combined);
  if (direct && !seen.has(direct.orderId)) {
    bundles.push(direct);
  }

  return bundles;
}

/** Debug helper for terminal logging on detail pages. */
export function countDownloadSignals(text: string): {
  downloadStructBlocks: number;
  webFields: number;
  explicitDownloads: number;
} {
  const downloadStructBlocks = (text.match(/downloadStruct/g) ?? []).length;
  let webFields = 0;
  for (const m of text.matchAll(/"web"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    const url = normalizeWebUrl(decodeJsonString(m[1]));
    if (isLikelyContentDownloadUrl(url)) {
      webFields += 1;
    }
  }
  return {
    downloadStructBlocks,
    webFields,
    explicitDownloads: extractExplicitDownloadUrls(text).length,
  };
}