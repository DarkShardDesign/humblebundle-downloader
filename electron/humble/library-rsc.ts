import type { HumbleFetch } from "./http";
import { isLikelyGamekey } from "./purchase-keys";

const LIBRARY_PATH = "/home/library";
const LIBRARY_ORIGIN = "https://www.humblebundle.com";
const PAGE_LIMIT = 5;
const LIBRARY_URL = `${LIBRARY_ORIGIN}${LIBRARY_PATH}`;

/** Next.js server action for UserLibraryList (ro). Rotates on deploy — scraped from chunk when possible. */
export const FALLBACK_LIBRARY_ACTION_ID =
  "60adb75b9d1ac0c62b83ad275b3ea563c4a2042e25";

/** Same value the browser sends on POST /home/library */
const NEXT_ROUTER_STATE_TREE =
  "%5B%22%22%2C%7B%22children%22%3A%5B%22(default)%22%2C%7B%22children%22%3A%5B%22(account)%22%2C%7B%22children%22%3A%5B%22home%22%2C%7B%22children%22%3A%5B%22library%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C4%5D%7D%2Cnull%2Cnull%2C8%5D%7D%2Cnull%2Cnull%2C8%5D%7D%2Cnull%2Cnull%2C8%5D%7D%2Cnull%2Cnull%2C24%5D";

export type LibraryEntitlementRow = {
  id?: string;
  title?: string;
  subTitle?: string;
  gameKey?: string | null;
  productEntitlementId?: string;
  itemType?: string;
  type?: string;
  deliveryMethods?: string[];
  entitlements?: {
    keys?: Array<{ gameKey?: string | null }>;
    downloads?: unknown[];
  };
};

export type LibraryPagePayload = {
  results?: LibraryEntitlementRow[];
  pagination?: { page?: number; totalPages?: number; totalDocs?: number };
  success?: boolean;
  requestId?: string;
};

export type BundleLibraryRow = {
  id?: string;
  title?: string;
  gameKey?: string | null;
  productEntitlementId?: string;
};

export function emptyLibraryPageState(): LibraryPagePayload {
  return {
    results: [],
    pagination: { page: 1, totalPages: 1, totalDocs: 0 },
    success: true,
  };
}

let cachedActionId: string | null = null;

export async function resolveLibraryActionId(
  hbFetch: HumbleFetch,
): Promise<string> {
  if (cachedActionId) {
    return cachedActionId;
  }

  const shell = await hbFetch(LIBRARY_URL, { headers: { Accept: "text/html" } });
  if (shell.ok) {
    const html = await shell.text();
    const chunks = [
      ...new Set(
        [...html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)].map(
          (m) => m[0],
        ),
      ),
    ];
    for (const chunk of chunks) {
      const res = await hbFetch(`${LIBRARY_ORIGIN}${chunk}`);
      if (!res.ok) {
        continue;
      }
      const js = await res.text();
      const match = js.match(
        /let ro=\(0,\w+\.createServerReference\)\("([a-f0-9]+)"/,
      );
      if (match?.[1]) {
        cachedActionId = match[1];
        return cachedActionId;
      }
    }
  }

  cachedActionId = FALLBACK_LIBRARY_ACTION_ID;
  return cachedActionId;
}

export function parseLibraryActionResponse(
  text: string,
): LibraryPagePayload | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("1:")) {
      try {
        return JSON.parse(trimmed.slice(2)) as LibraryPagePayload;
      } catch {
        return null;
      }
    }
  }

  return parseLibraryPagePayload(text);
}

/** Legacy / embedded flight shapes. */
export function parseLibraryPagePayload(text: string): LibraryPagePayload | null {
  const needle = '[{"results"';
  let start = text.indexOf(needle);
  if (start < 0) {
    const alt = text.indexOf('{"results":');
    if (alt >= 0) {
      start = alt;
    } else {
      return null;
    }
  }

  if (text[start] === "{") {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1)) as LibraryPagePayload;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown[];
          const first = parsed[0] as LibraryPagePayload;
          return first?.results ? first : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function buildLibraryActionFormData(
  page: number,
  requestId: number,
  prevState: LibraryPagePayload,
): FormData {
  const form = new FormData();
  form.set("_1_requestId", String(requestId));
  form.set("_1_query", "");
  form.set("_1_sort", "mostRecent");
  form.set("_1_cursor", String(PAGE_LIMIT * page));
  form.set("_1_page", String(page));
  form.set("_1_limit", String(PAGE_LIMIT));
  form.set("_1_hideRevealed", "false");
  form.set("_1_hideExpired", "false");
  form.set("_1_dateExpires", "");
  form.set("0", JSON.stringify([prevState, "$K1"]));
  return form;
}

export async function postLibraryPageAction(
  hbFetch: HumbleFetch,
  page: number,
  requestId: number,
  prevState: LibraryPagePayload,
): Promise<LibraryPagePayload> {
  const actionId = await resolveLibraryActionId(hbFetch);
  const form = buildLibraryActionFormData(page, requestId, prevState);

  const res = await hbFetch(LIBRARY_URL, {
    method: "POST",
    headers: {
      Accept: "text/x-component",
      "Next-Action": actionId,
      "Next-Router-State-Tree": NEXT_ROUTER_STATE_TREE,
      Referer: LIBRARY_URL,
      Origin: LIBRARY_ORIGIN,
    },
    body: form,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Session expired. Sign in again in the Humble window.");
  }
  if (!res.ok) {
    throw new Error(`Library action failed (HTTP ${res.status})`);
  }

  const text = await res.text();
  const payload = parseLibraryActionResponse(text);
  if (payload?.results) {
    return payload;
  }
  const snippet = text.replace(/\s+/g, " ").slice(0, 200);
  throw new Error(
    `Library response did not include purchase data. Snippet: ${snippet}`,
  );
}

export async function postLibraryPageActionViaBrowser(
  postPage: (
    page: number,
    requestId: number,
    prevState: LibraryPagePayload,
    actionId: string,
  ) => Promise<string | null>,
  page: number,
  requestId: number,
  prevState: LibraryPagePayload,
  actionId: string,
): Promise<LibraryPagePayload> {
  const text = await postPage(page, requestId, prevState, actionId);
  if (!text) {
    throw new Error("In-browser library request failed");
  }
  const payload = parseLibraryActionResponse(text);
  if (payload?.results) {
    return payload;
  }
  throw new Error("In-browser library response had no results");
}

export function gamekeysFromEntitlementRows(
  rows: LibraryEntitlementRow[],
): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.gameKey) {
      keys.add(row.gameKey);
    }
    for (const keyRow of row.entitlements?.keys ?? []) {
      if (keyRow.gameKey) {
        keys.add(keyRow.gameKey);
      }
    }
  }
  return [...keys];
}

export function productEntitlementIdsFromRows(
  rows: LibraryEntitlementRow[],
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.productEntitlementId) {
      ids.add(row.productEntitlementId);
    }
  }
  return [...ids];
}

/** Scan raw text for any non-null gameKey values (fallback). */
export function gamekeysFromRscText(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(/"gameKey":"([^"]+)"/g)) {
    const value = match[1];
    if (value && isLikelyGamekey(value)) {
      keys.add(value);
    }
  }
  return [...keys];
}

export function parseBundleItemsFromFlight(text: string): BundleLibraryRow[] {
  const marker = '"bundleItems":';
  const idx = text.indexOf(marker);
  if (idx < 0) {
    return [];
  }
  const arrStart = text.indexOf("[", idx);
  if (arrStart < 0) {
    return [];
  }
  let depth = 0;
  for (let i = arrStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(arrStart, i + 1)) as BundleLibraryRow[];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

export async function fetchAllGamekeysFromLibraryRsc(
  hbFetch: HumbleFetch,
  onProgress?: (page: number, totalPages: number) => void,
): Promise<string[]> {
  const allKeys = new Set<string>();

  const shell = await hbFetch(LIBRARY_URL, {
    headers: { Accept: "text/x-component" },
  });
  if (shell.ok) {
    const shellText = await shell.text();
    for (const row of parseBundleItemsFromFlight(shellText)) {
      if (row.gameKey) {
        allKeys.add(row.gameKey);
      }
    }
    for (const key of gamekeysFromRscText(shellText)) {
      allKeys.add(key);
    }
  }

  let requestId = 1;
  let prevState = emptyLibraryPageState();

  const first = await postLibraryPageAction(hbFetch, 1, requestId++, prevState);
  const totalPages = Math.max(1, first.pagination?.totalPages ?? 1);
  onProgress?.(1, totalPages);

  for (const key of gamekeysFromEntitlementRows(first.results ?? [])) {
    allKeys.add(key);
  }

  prevState = first;

  for (let page = 2; page <= totalPages; page++) {
    const payload = await postLibraryPageAction(
      hbFetch,
      page,
      requestId++,
      prevState,
    );
    for (const key of gamekeysFromEntitlementRows(payload.results ?? [])) {
      allKeys.add(key);
    }
    prevState = payload;
    onProgress?.(page, totalPages);
  }

  return [...allKeys];
}

export async function probeLibraryRscSession(
  hbFetch: HumbleFetch,
): Promise<boolean> {
  try {
    await postLibraryPageAction(
      hbFetch,
      1,
      1,
      emptyLibraryPageState(),
    );
    return true;
  } catch {
    return false;
  }
}

/** Must be a real template literal — String.raw broke Next-Router-State-Tree interpolation. */
export const LIBRARY_PAGE_ACTION_IN_BROWSER = `(async function (page, prevState, requestId, actionId) {
  const form = new FormData();
  form.set("_1_requestId", String(requestId));
  form.set("_1_query", "");
  form.set("_1_sort", "mostRecent");
  form.set("_1_cursor", String(5 * page));
  form.set("_1_page", String(page));
  form.set("_1_limit", "5");
  form.set("_1_hideRevealed", "false");
  form.set("_1_hideExpired", "false");
  form.set("_1_dateExpires", "");
  form.set("0", JSON.stringify([prevState, "$K1"]));
  const res = await fetch("/home/library", {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "text/x-component",
      "Next-Action": actionId,
      "Next-Router-State-Tree": ${JSON.stringify(NEXT_ROUTER_STATE_TREE)},
      Origin: "https://www.humblebundle.com",
      Referer: "https://www.humblebundle.com/home/library",
    },
    body: form,
  });
  if (!res.ok) return { ok: false, status: res.status, text: "" };
  return { ok: true, status: res.status, text: await res.text() };
})`;