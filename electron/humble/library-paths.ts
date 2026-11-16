import type { LibraryEntitlementRow } from "./library-rsc";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOSTED_DELIVERY = new Set([
  "download_drm",
  "ebook",
  "pdf",
  "audio",
  "comic",
  "zip",
  "image",
  "video",
  "other-download",
]);

type RowMeta = LibraryEntitlementRow & {
  itemType?: string;
  deliveryMethods?: string[];
  type?: string;
};

function rowHasInlineDownloads(row: RowMeta): boolean {
  const blocks = row.entitlements?.downloads ?? [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const downloads = (block as { downloads?: unknown[] }).downloads ?? [];
    for (const dl of downloads) {
      if (!dl || typeof dl !== "object") {
        continue;
      }
      const struct = (dl as { downloadStruct?: unknown[] }).downloadStruct ?? [];
      if (struct.length > 0) {
        return true;
      }
    }
  }
  return false;
}

function rowLikelyHostedFiles(row: RowMeta): boolean {
  if (rowHasInlineDownloads(row)) {
    return true;
  }
  const methods = row.deliveryMethods ?? [];
  return methods.some((m) => HOSTED_DELIVERY.has(m));
}

/** Map list rows → detail URLs (groups, bundles, per-title pages). */
export function detailPathsFromLibraryRows(
  rows: LibraryEntitlementRow[],
): string[] {
  const paths = new Set<string>();

  for (const row of rows as RowMeta[]) {
    if (row.itemType === "entitlement-group" && row.id && UUID.test(row.id)) {
      paths.add(`/home/library/group/${row.id}`);
    }
  }

  for (const row of rows as RowMeta[]) {
    if (row.itemType === "entitlement-group") {
      continue;
    }
    const peid = row.productEntitlementId;
    if (peid && UUID.test(peid) && rowLikelyHostedFiles(row)) {
      paths.add(`/home/library/${peid}`);
    }
    if (row.type === "bundle" && peid && UUID.test(peid)) {
      paths.add(`/home/library/${peid}`);
    }
    if (
      row.id &&
      UUID.test(row.id) &&
      rowLikelyHostedFiles(row) &&
      !peid
    ) {
      paths.add(`/home/library/${row.id}`);
    }
  }

  return [...paths];
}

export function childDetailPathsFromGroupText(text: string): string[] {
  const paths = new Set<string>();
  for (const m of text.matchAll(/\/home\/library\/([0-9a-f-]{36})/gi)) {
    if (!m[0].includes("/group/")) {
      paths.add(m[0].toLowerCase());
    }
  }
  for (const m of text.matchAll(
    /"productEntitlementId"\s*:\s*"([0-9a-f-]{36})"/gi,
  )) {
    paths.add(`/home/library/${m[1].toLowerCase()}`);
  }
  return [...paths];
}

/** One detail page per unique product entitlement (dedupes Choice months). */
export function uniqueProductEntitlementDetailPaths(
  rows: LibraryEntitlementRow[],
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const peid = row.productEntitlementId;
    if (peid && UUID.test(peid)) {
      ids.add(peid.toLowerCase());
    }
  }
  return [...ids].map((id) => `/home/library/${id}`);
}