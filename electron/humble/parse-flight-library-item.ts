import { cleanName } from "./names";
import type { DownloadableFile, LibraryBundle } from "./types";
import {
  isLikelyContentDownloadUrl,
  normalizeWebUrl,
} from "./parse-downloads";

const CONTENT_EXT =
  /\.(pdf|epub|mobi|prc|cbz|cbr|zip|7z|tar|gz|bz2|mp3|flac|wav|m4a|apk|dmg|exe|msi|deb|rpm|iso|chm|azw3?)$/i;

function unescapeFlightText(text: string): string {
  return text
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\u0026/g, "&");
}

export function resolveHumbleRelativeDownloadUrl(
  productEntitlementId: string,
  downloadKey: string,
  relativeWeb: string,
): string {
  const web = relativeWeb.split("?")[0];
  const params = new URLSearchParams({
    key: productEntitlementId,
    download: web,
    name: downloadKey,
  });
  return `https://www.humblebundle.com/downloads?${params.toString()}`;
}

type FlightFile = {
  productEntitlementId: string;
  productTitle: string;
  bundleTitle: string;
  platform: string;
  filename: string;
  relativeWeb: string;
  downloadKey: string;
};

function webUrlsFromDownloadStruct(structBlob: string): string[] {
  const urls: string[] = [];
  const webPatterns = [
    /\\"web\\":\\"([^"\\]+)\\"/g,
    /"web":"([^"]+)"/g,
    /\\"url\\":\{[^}]*?\\"web\\":\\"([^"\\]+)\\"/g,
    /"url":\{[^}]*?"web":"([^"]+)"/g,
  ];
  for (const re of webPatterns) {
    for (const m of structBlob.matchAll(re)) {
      urls.push(m[1]);
    }
  }
  return [...new Set(urls)];
}

function parseDownloadChunk(chunk: string): {
  downloadKey: string;
  platform: string;
  structBlob: string;
} | null {
  const downloadKey =
    chunk.match(/\\"key\\":\\"([^"\\]+)\\"/)?.[1] ??
    chunk.match(/"key":"([^"]+)"/)?.[1];
  const platform = (
    chunk.match(/\\"platform\\":\\"([^"\\]+)\\"/)?.[1] ??
    chunk.match(/"platform":"([^"]+)"/)?.[1] ??
    ""
  ).toLowerCase();
  const structBlob =
    chunk.match(/\\"downloadStruct\\":\[([\s\S]*?)\],\\"updatedAt\\"/)?.[1] ??
    chunk.match(/"downloadStruct":\[([\s\S]*?)\],"updatedAt"/)?.[1] ??
    "";
  if (!downloadKey || !platform || !structBlob) {
    return null;
  }
  return { downloadKey, platform, structBlob };
}

function parseDrmFreeBlocks(text: string): Omit<
  FlightFile,
  "productEntitlementId" | "bundleTitle"
>[] {
  const out: Omit<FlightFile, "productEntitlementId" | "bundleTitle">[] = [];

  const markers = [
    /\\"title\\":\\"([^"\\]+)\\",\\"type\\":\\"download_drm_free\\",\\"redemptionData\\":\{\},\\"downloads\\":\[\{/g,
    /"id":"[0-9a-f-]{36}","title":"([^"]+)","type":"download_drm_free","redemptionData":\{\},"downloads":\[\{/g,
  ];

  for (const markerRe of markers) {
    const hits: { title: string; sliceStart: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = markerRe.exec(text)) !== null) {
      hits.push({ title: match[1], sliceStart: markerRe.lastIndex });
    }
    for (let i = 0; i < hits.length; i++) {
      const sliceEnd =
        i + 1 < hits.length
          ? hits[i + 1].sliceStart - 200
          : hits[i].sliceStart + 12_000;
      const chunk = text.slice(hits[i].sliceStart, sliceEnd);
      const parsed = parseDownloadChunk(chunk);
      if (!parsed) {
        continue;
      }
      const productTitle = cleanName(unescapeFlightText(hits[i].title));
      for (const relativeWeb of webUrlsFromDownloadStruct(parsed.structBlob)) {
        addFile(
          out,
          productTitle,
          parsed.downloadKey,
          parsed.platform,
          relativeWeb,
        );
      }
    }
    if (out.length > 0) {
      break;
    }
  }

  return out;
}

function addFile(
  out: Omit<FlightFile, "productEntitlementId" | "bundleTitle">[],
  productTitle: string,
  downloadKey: string,
  platform: string,
  relativeWeb: string,
) {
  if (!CONTENT_EXT.test(relativeWeb)) {
    return;
  }
  out.push({
    productTitle,
    downloadKey,
    platform,
    filename: relativeWeb.split("/").pop() ?? relativeWeb,
    relativeWeb,
  });
}

/** Parse Next.js flight `userLibraryItem` blobs (escaped JSON in HTML). */
export function extractFlightDownloads(
  text: string,
  pagePath: string,
): FlightFile[] {
  const raw = text;

  const productEntitlementId =
    raw.match(/productEntitlementId\\":\\"([^"\\]+)\\"/)?.[1] ??
    raw.match(/"productEntitlementId":"([^"]+)"/)?.[1] ??
    pagePath.match(/[0-9a-f-]{36}/i)?.[0] ??
    "library";

  const bundleTitle = cleanName(
    unescapeFlightText(
      raw.match(
        /\\"title\\":\\"([^"\\]+)\\",\\"itemType\\":\\"content-entitlement\\"/,
      )?.[1] ??
        raw.match(
          /\\"title\\":\\"([^"\\]+)\\",\\"type\\":\\"bundle\\"/,
        )?.[1] ??
        raw.match(
          /"title":"([^"]+)","itemType":"content-entitlement"/,
        )?.[1] ??
        "Library",
    ),
  );

  const partials = parseDrmFreeBlocks(raw);
  return partials.map((p) => ({
    ...p,
    productEntitlementId,
    bundleTitle,
  }));
}

export function bundlesFromFlightPageText(
  pagePath: string,
  html: string,
  rsc: string,
): LibraryBundle[] {
  const combined = `${html}\n${rsc}`;
  const extracted = extractFlightDownloads(combined, pagePath);

  const byProduct = new Map<string, DownloadableFile[]>();
  const bundleTitle = extracted[0]?.bundleTitle ?? "Library";

  for (const row of extracted) {
    const peid = row.productEntitlementId;
    const url = resolveHumbleRelativeDownloadUrl(
      peid,
      row.downloadKey,
      row.relativeWeb,
    );
    if (!isLikelyContentDownloadUrl(url, row.filename)) {
      continue;
    }
    const file: DownloadableFile = {
      id: `${peid}:${row.filename}:${row.platform}`,
      orderId: peid,
      bundleTitle: row.bundleTitle || bundleTitle,
      productTitle: row.productTitle,
      platform: row.platform,
      filename: row.filename,
      url,
    };
    const list = byProduct.get(row.productTitle) ?? [];
    list.push(file);
    byProduct.set(row.productTitle, list);
  }

  if (byProduct.size === 0) {
    return [];
  }

  const peid =
    extracted[0]?.productEntitlementId ??
    pagePath.match(/[0-9a-f-]{36}/i)?.[0] ??
    "library";

  return [
    {
      orderId: peid,
      title: bundleTitle,
      products: [...byProduct.entries()].map(([productTitle, downloads]) => ({
        orderId: peid,
        bundleTitle,
        productTitle,
        downloads,
      })),
    },
  ];
}