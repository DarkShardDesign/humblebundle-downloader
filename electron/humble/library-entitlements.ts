import type { WebContents } from "electron";
import { cleanName } from "./names";
import type { DownloadableFile, LibraryBundle } from "./types";
import type { HumbleFetch } from "./http";
import {
  emptyLibraryPageState,
  parseBundleItemsFromFlight,
  postLibraryPageAction,
  postLibraryPageActionViaBrowser,
  resolveLibraryActionId,
  type LibraryEntitlementRow,
  type LibraryPagePayload,
} from "./library-rsc";
import {
  postLibraryPageFromWebContents,
  resolveLibraryActionIdFromWebContents,
} from "./browser-session";

const LIBRARY_URL = "https://www.humblebundle.com/home/library";

type EntitlementDownloadBlock = {
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

type LibraryPageReader = {
  readPage(
    page: number,
    requestId: number,
    prevState: LibraryPagePayload,
  ): Promise<LibraryPagePayload>;
};

async function createBrowserPageReader(
  webContents: WebContents,
): Promise<LibraryPageReader> {
  const actionId = await resolveLibraryActionIdFromWebContents(webContents);
  return {
    readPage: (page, requestId, prevState) =>
      postLibraryPageActionViaBrowser(
        (p, r, s, a) =>
          postLibraryPageFromWebContents(webContents, p, r, s, a),
        page,
        requestId,
        prevState,
        actionId,
      ),
  };
}

async function createFetchPageReader(
  hbFetch: HumbleFetch,
): Promise<LibraryPageReader> {
  await resolveLibraryActionId(hbFetch);
  return {
    readPage: (page, requestId, prevState) =>
      postLibraryPageAction(hbFetch, page, requestId, prevState),
  };
}

function downloadsFromRow(row: LibraryEntitlementRow): DownloadableFile[] {
  const bundleTitle = cleanName(row.subTitle ?? "Library");
  const productTitle = cleanName(row.title ?? "Item");
  const orderId = row.productEntitlementId ?? row.id ?? productTitle;
  const out: DownloadableFile[] = [];

  const blocks = (row.entitlements?.downloads ??
    []) as EntitlementDownloadBlock[];
  for (const block of blocks) {
    for (const dl of block.downloads ?? []) {
      const platform = (dl.platform ?? dl.key ?? "download").toLowerCase();
      if (platform === "steam") {
        continue;
      }
      for (const part of dl.downloadStruct ?? []) {
        const web = part.url?.web;
        if (!web) {
          continue;
        }
        const filename =
          part.name?.split("/").pop() ??
          web.split("?")[0].split("/").pop() ??
          "download";
        out.push({
          id: `${orderId}:${filename}:${platform}`,
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

export async function fetchAllEntitlementRows(
  hbFetch: HumbleFetch,
  onProgress?: (page: number, totalPages: number) => void,
  webContents?: WebContents | null,
): Promise<LibraryEntitlementRow[]> {
  const reader =
    webContents && !webContents.isDestroyed()
      ? await createBrowserPageReader(webContents)
      : await createFetchPageReader(hbFetch);

  const rows: LibraryEntitlementRow[] = [];
  let requestId = 1;
  let prevState = emptyLibraryPageState();

  const first = await reader.readPage(1, requestId++, prevState);
  const totalPages = Math.max(1, first.pagination?.totalPages ?? 1);
  rows.push(...(first.results ?? []));
  onProgress?.(1, totalPages);
  prevState = first;

  for (let page = 2; page <= totalPages; page++) {
    const payload = await reader.readPage(page, requestId++, prevState);
    rows.push(...(payload.results ?? []));
    prevState = payload;
    onProgress?.(page, totalPages);
  }

  return rows;
}

export function bundlesFromEntitlementRows(
  rows: LibraryEntitlementRow[],
): LibraryBundle[] {
  const byOrder = new Map<string, LibraryBundle>();

  for (const row of rows) {
    const downloads = downloadsFromRow(row);
    if (downloads.length === 0) {
      continue;
    }
    const orderId = downloads[0].orderId;
    const bundleTitle = downloads[0].bundleTitle;
    const product = {
      orderId,
      bundleTitle,
      productTitle: downloads[0].productTitle,
      downloads,
    };

    const existing = byOrder.get(orderId);
    if (existing) {
      existing.products.push(product);
    } else {
      byOrder.set(orderId, {
        orderId,
        title: bundleTitle,
        products: [product],
      });
    }
  }

  return [...byOrder.values()];
}

export async function fetchLibraryFromEntitlements(
  hbFetch: HumbleFetch,
  onProgress?: (page: number, totalPages: number) => void,
  webContents?: WebContents | null,
): Promise<LibraryBundle[]> {
  const rows = await fetchAllEntitlementRows(
    hbFetch,
    onProgress,
    webContents,
  );
  return bundlesFromEntitlementRows(rows);
}

export async function fetchBundleItemsFromLibraryShell(
  hbFetch: HumbleFetch,
): Promise<LibraryEntitlementRow[]> {
  const res = await hbFetch(LIBRARY_URL, {
    headers: { Accept: "text/x-component" },
  });
  if (!res.ok) {
    return [];
  }
  const text = await res.text();
  return parseBundleItemsFromFlight(text).map((item) => ({
    id: item.id,
    title: item.title,
    gameKey: item.gameKey,
    productEntitlementId: item.productEntitlementId,
    subTitle: item.title,
  }));
}