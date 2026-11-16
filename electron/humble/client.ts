import { load as loadHtml } from "cheerio";
import type {
  DownloadableFile,
  HumbleOrder,
  LibraryBundle,
  LibraryProduct,
} from "./types";
import { cleanName } from "./names";
import type { WebContents } from "electron";
import type { HumbleFetch } from "./http";
import {
  fetchOrderInBrowser,
  fetchOrdersBatchInBrowser,
} from "./browser-orders";
import {
  orderDetailCandidates,
  ordersBatchCandidates,
} from "./api-host";
import {
  ORDER_LIST_URLS,
  parseGamekeyList,
  parseGamekeyListFromBody,
} from "./purchase-keys";
import {
  fetchAllGamekeysFromLibraryRsc,
  gamekeysFromEntitlementRows,
  gamekeysFromRscText,
  parseBundleItemsFromFlight,
  parseLibraryActionResponse,
  parseLibraryPagePayload,
  probeLibraryRscSession,
} from "./library-rsc";

const SESSION_PARTITION = "persist:humblebundle";
const AUTH_COOKIE = "_simpleauth_sess";
const LIBRARY_URL = "https://www.humblebundle.com/home/library";
export const LOGIN_START_URL = LIBRARY_URL;

export { SESSION_PARTITION, AUTH_COOKIE, ORDER_LIST_URLS };

type CookieLike = { name: string; value: string };

export async function getSessionCookieHeader(
  cookiesGet: (filter: {
    name?: string;
    url?: string;
  }) => Promise<CookieLike[]>,
): Promise<string | null> {
  const forSite = await cookiesGet({ url: "https://www.humblebundle.com" });
  const cookies =
    forSite.length > 0
      ? forSite
      : await cookiesGet({ name: AUTH_COOKIE });

  if (cookies.length === 0) {
    return null;
  }

  const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  if (cookies.some((c) => c.name === AUTH_COOKIE)) {
    return header;
  }

  if (cookies.length >= 3) {
    return header;
  }

  return null;
}

function gamekeysFromLibraryHtml(html: string): string[] | null {
  const $ = loadHtml(html);
  const raw = $("#user-home-json-data").text().trim();
  if (!raw) {
    return null;
  }
  try {
    const data = JSON.parse(raw) as { gamekeys?: string[] };
    return data.gamekeys?.length ? data.gamekeys : null;
  } catch {
    return null;
  }
}

async function fetchGamekeysFromLegacyList(
  hbFetch: HumbleFetch,
): Promise<string[] | null> {
  let lastStatus = 0;
  for (const url of ORDER_LIST_URLS) {
    const res = await hbFetch(url);
    lastStatus = res.status;
    if (res.status === 401) {
      throw new Error("Session expired. Sign in again in the Humble window.");
    }
    if (!res.ok) {
      console.warn(`Legacy order list ${url} HTTP ${res.status}`);
      continue;
    }
    const raw = await res.text();
    const keys =
      parseGamekeyListFromBody(raw) ??
      (() => {
        try {
          return parseGamekeyList(JSON.parse(raw));
        } catch {
          return null;
        }
      })();
    if (keys?.length) {
      return keys;
    }
  }
  if (lastStatus) {
    console.warn(`Legacy order list HTTP ${lastStatus}`);
  }
  return null;
}

/** Appspot order list, modern library action, legacy embed. */
export async function fetchPurchaseKeys(hbFetch: HumbleFetch): Promise<string[]> {
  const fromList = await fetchGamekeysFromLegacyList(hbFetch);
  if (fromList?.length) {
    return fromList;
  }

  try {
    const fromRsc = await fetchAllGamekeysFromLibraryRsc(hbFetch);
    if (fromRsc.length > 0) {
      return fromRsc;
    }
  } catch (err) {
    console.warn("fetchAllGamekeysFromLibraryRsc", err);
  }

  const pageRes = await hbFetch(LIBRARY_URL, {
    headers: { Accept: "text/html" },
  });
  if (pageRes.status === 401 || pageRes.status === 403) {
    throw new Error("Session expired. Sign in again in the Humble window.");
  }
  if (pageRes.ok) {
    const html = await pageRes.text();
    const fromEmbed = gamekeysFromLibraryHtml(html);
    if (fromEmbed?.length) {
      return fromEmbed;
    }
    const bundleKeys = parseBundleItemsFromFlight(html)
      .map((row) => row.gameKey)
      .filter((key): key is string => Boolean(key));
    if (bundleKeys.length > 0) {
      return bundleKeys;
    }
    const scanned = gamekeysFromRscText(html);
    if (scanned.length > 0) {
      return scanned;
    }
    const pagePayload =
      parseLibraryActionResponse(html) ?? parseLibraryPagePayload(html);
    if (pagePayload?.results?.length) {
      const keys = gamekeysFromEntitlementRows(pagePayload.results);
      if (keys.length > 0) {
        return keys;
      }
    }
  }

  throw new Error(
    "Could not read purchase keys. Open /home/library in the Humble window, Sync, then Refresh.",
  );
}

export async function verifySession(hbFetch: HumbleFetch): Promise<boolean> {
  if (await probeLibraryRscSession(hbFetch)) {
    return true;
  }
  try {
    await fetchPurchaseKeys(hbFetch);
    return true;
  } catch {
    return false;
  }
}

async function fetchOrdersBatch(
  gamekeys: string[],
  hbFetch: HumbleFetch,
): Promise<HumbleOrder[]> {
  const orders: HumbleOrder[] = [];
  const batchSize = 40;

  for (let i = 0; i < gamekeys.length; i += batchSize) {
    const slice = gamekeys.slice(i, i + batchSize);
    let page: Record<string, HumbleOrder | null> | null = null;
    for (const url of ordersBatchCandidates(slice)) {
      const res = await hbFetch(url);
      if (!res.ok) {
        continue;
      }
      try {
        page = (await res.json()) as Record<string, HumbleOrder | null>;
        break;
      } catch {
        /* try next host */
      }
    }
    if (!page) {
      throw new Error("Orders batch failed on all hosts");
    }
    for (const order of Object.values(page)) {
      if (order) {
        orders.push(order);
      }
    }
  }

  return orders;
}

export async function fetchOrder(
  orderId: string,
  hbFetch: HumbleFetch,
): Promise<HumbleOrder> {
  let lastStatus = 0;
  for (const url of orderDetailCandidates(orderId)) {
    const res = await hbFetch(url, {
      headers: {
        Accept: "application/json",
      },
    });
    lastStatus = res.status;
    if (!res.ok) {
      continue;
    }
    try {
      return (await res.json()) as HumbleOrder;
    } catch {
      continue;
    }
  }
  throw new Error(`Order ${orderId} failed (${lastStatus})`);
}

const DRM_FREE_PLATFORMS = new Set([
  "windows",
  "mac",
  "linux",
  "android",
  "audio",
  "ebook",
  "comedy",
  "soundtrack",
]);

function filesFromOrder(orderId: string, order: HumbleOrder): LibraryProduct {
  const bundleTitle = cleanName(order.product.human_name);
  const downloads: DownloadableFile[] = [];

  for (const product of order.subproducts) {
    const productTitle = cleanName(product.human_name);
    for (const downloadType of product.downloads) {
      const platform = downloadType.platform;
      if (!DRM_FREE_PLATFORMS.has(platform.toLowerCase())) {
        continue;
      }
      for (const fileType of downloadType.download_struct) {
        const web = fileType.url?.web;
        if (!web) {
          continue;
        }
        const url = web.split("?")[0];
        const filename = url.split("/").pop() ?? "download";
        const id = `${orderId}:${filename}:${platform}`;
        downloads.push({
          id,
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

  const productTitle =
    downloads.length === 1
      ? downloads[0].productTitle
      : `${downloads.length} items`;

  return {
    orderId,
    bundleTitle,
    productTitle,
    downloads,
  };
}

function orderGamekey(order: HumbleOrder): string {
  return (order as HumbleOrder & { gamekey?: string }).gamekey ?? "";
}

export async function fetchLibraryFromKeys(
  keys: string[],
  hbFetch: HumbleFetch,
  onProgress?: (loaded: number, total: number) => void,
  webContents?: WebContents | null,
): Promise<LibraryBundle[]> {
  const bundles: LibraryBundle[] = [];
  let orders: HumbleOrder[] = [];
  const batchSize = 40;

  if (webContents && !webContents.isDestroyed()) {
    let loaded = 0;
    for (let i = 0; i < keys.length; i += batchSize) {
      const slice = keys.slice(i, i + batchSize);
      const page = await fetchOrdersBatchInBrowser(webContents, slice);
      if (page) {
        for (const order of Object.values(page)) {
          if (order) {
            orders.push(order);
          }
        }
      } else {
        for (const gamekey of slice) {
          const order = await fetchOrderInBrowser(webContents, gamekey);
          if (order) {
            orders.push(order);
          }
        }
      }
      loaded += slice.length;
      onProgress?.(loaded, keys.length);
    }
  }

  if (orders.length === 0) {
    try {
      orders = await fetchOrdersBatch(keys, hbFetch);
      onProgress?.(keys.length, keys.length);
    } catch (batchErr) {
      console.warn("Batch orders fetch failed, falling back per key", batchErr);
      let loaded = 0;
      const total = keys.length;
      for (const orderId of keys) {
        try {
          orders.push(await fetchOrder(orderId, hbFetch));
        } catch (err) {
          console.error(`Skipping order ${orderId}`, err);
        }
        loaded += 1;
        onProgress?.(loaded, total);
      }
    }
  }

  const seen = new Set<string>();
  for (const order of orders) {
    const orderId =
      orderGamekey(order) ||
      keys.find((k) => !seen.has(k)) ||
      order.product.human_name;
    seen.add(orderId);
    const product = filesFromOrder(orderId, order);
    bundles.push({
      orderId,
      title: product.bundleTitle,
      products: [product],
    });
  }

  return bundles;
}

export function mergeLibraryBundles(
  ...groups: LibraryBundle[][]
): LibraryBundle[] {
  const byId = new Map<string, LibraryBundle>();
  for (const bundles of groups) {
    for (const bundle of bundles) {
      const existing = byId.get(bundle.orderId);
      if (!existing) {
        byId.set(bundle.orderId, bundle);
        continue;
      }
      const productIds = new Set(
        existing.products.map((p) => p.productTitle + p.orderId),
      );
      for (const product of bundle.products) {
        const key = product.productTitle + product.orderId;
        if (!productIds.has(key)) {
          existing.products.push(product);
          productIds.add(key);
        }
      }
    }
  }
  return [...byId.values()];
}