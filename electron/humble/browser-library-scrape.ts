import type { WebContents } from "electron";
import { LOGIN_START_URL } from "./client";
import type { LibraryBundle } from "./types";
import {
  bundlesFromEntitlementRow,
  bundlesFromPageText,
  countDownloadSignals,
} from "./parse-downloads";
import {
  beginLibraryDebugSession,
  endLibraryDebugSession,
  isLibraryDebugEnabled,
  logDetailPageDebug,
  logDiscoverDebug,
  maybeSaveDetailPayloads,
  snippetAroundDownloadStruct,
} from "./debug-log";
import {
  childDetailPathsFromGroupText,
  detailPathsFromLibraryRows,
  uniqueProductEntitlementDetailPaths,
} from "./library-paths";
import {
  emptyLibraryPageState,
  parseBundleItemsFromFlight,
  parseLibraryActionResponse,
  type LibraryEntitlementRow,
} from "./library-rsc";
import {
  postLibraryPageFromWebContents,
  prepareLibraryListPage,
  resolveLibraryActionIdFromWebContents,
  safeLoadURL,
} from "./browser-session";

const LIBRARY_ORIGIN = "https://www.humblebundle.com";
const DETAIL_BATCH_SIZE = 6;

const FETCH_LIBRARY_SHELL_RSC = `(async function () {
  const res = await fetch("/home/library", {
    credentials: "include",
    headers: {
      Accept: "text/x-component",
      RSC: "1",
      "Next-Router-Prefetch": "1",
    },
  });
  if (!res.ok) {
    return { ok: false, status: res.status, text: "" };
  }
  return { ok: true, status: res.status, text: await res.text() };
})()`;

const SCRAPE_LIBRARY_LINKS = `(function () {
  const links = new Set();
  for (const a of document.querySelectorAll('a[href*="/home/library/"]')) {
    const href = (a.getAttribute("href") || "").split("?")[0];
    if (/^\\/home\\/library\\/(?:group\\/)?[0-9a-f-]{36}$/i.test(href)) {
      links.add(href.toLowerCase());
    }
  }
  return [...links];
})()`;

const CLICK_BUNDLES_TAB = `(function () {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const tab = tabs.find((el) => /bundles/i.test(el.textContent || ""));
  if (tab) {
    tab.click();
    return true;
  }
  return false;
})()`;

const FETCH_DETAIL_BATCH = `(async function (paths) {
  const out = [];
  for (const path of paths) {
    try {
      const htmlRes = await fetch(path, {
        credentials: "include",
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const rscRes = await fetch(path, {
        credentials: "include",
        headers: {
          Accept: "text/x-component",
          RSC: "1",
          "Next-Router-Prefetch": "1",
          "Next-Url": path,
        },
      });
      out.push({
        path,
        ok: htmlRes.ok || rscRes.ok,
        html: htmlRes.ok ? await htmlRes.text() : "",
        rsc: rscRes.ok ? await rscRes.text() : "",
        htmlStatus: htmlRes.status,
        rscStatus: rscRes.status,
      });
    } catch (e) {
      out.push({
        path,
        ok: false,
        html: "",
        rsc: "",
        error: String(e && e.message ? e.message : e),
      });
    }
  }
  return out;
})`;

export async function collectEntitlementDetailPaths(
  webContents: WebContents,
  onProgress?: (page: number, totalPages: number) => void,
): Promise<{ paths: string[]; listRows: LibraryEntitlementRow[] }> {
  await prepareLibraryListPage(webContents, LOGIN_START_URL);

  const listRows: LibraryEntitlementRow[] = [];
  const paths = new Set<string>();

  try {
    const shell = (await webContents.executeJavaScript(
      FETCH_LIBRARY_SHELL_RSC,
      true,
    )) as { ok: boolean; text: string };
    if (shell.ok) {
      for (const row of parseBundleItemsFromFlight(shell.text)) {
        listRows.push({
          id: row.id,
          title: row.title,
          gameKey: row.gameKey,
          productEntitlementId: row.productEntitlementId,
          itemType: "bundle",
          type: "bundle",
        } as LibraryEntitlementRow);
      }
      console.info(`Bundles tab items from shell: ${listRows.length}`);
    }
  } catch (err) {
    console.warn("library shell RSC failed", err);
  }

  const actionId = await resolveLibraryActionIdFromWebContents(webContents);
  let prevState = emptyLibraryPageState();
  let requestId = 1;

  const page1Text = await postLibraryPageFromWebContents(
    webContents,
    1,
    requestId++,
    prevState,
    actionId,
  );

  if (!page1Text) {
    throw new Error(
      "Could not read your Purchased library (in-browser list request failed). Stay on humblebundle.com/home/library and try Refresh again.",
    );
  }

  const page1 = parseLibraryActionResponse(page1Text);
  if (!page1?.results) {
    throw new Error(
      "Library list response was empty. Sync sign-in, wait until your purchases show on humblebundle.com, then Refresh.",
    );
  }

  listRows.push(...page1.results);
  const totalPages = Math.max(1, page1.pagination?.totalPages ?? 1);
  onProgress?.(1, totalPages);
  prevState = page1;
  console.info(
    `Purchased library: ${totalPages} pages (~${page1.pagination?.totalDocs ?? "?"} items)`,
  );

  for (let page = 2; page <= totalPages; page++) {
    const text = await postLibraryPageFromWebContents(
      webContents,
      page,
      requestId++,
      prevState,
      actionId,
    );
    if (!text) {
      console.warn("library page", page, "failed — stopping pagination");
      break;
    }
    const payload = parseLibraryActionResponse(text);
    if (!payload?.results) {
      break;
    }
    listRows.push(...payload.results);
    prevState = payload;
    onProgress?.(page, totalPages);
    if (page % 20 === 0 || page === totalPages) {
      console.info(`Library discover: page ${page}/${totalPages}, rows ${listRows.length}`);
    }
  }

  for (const p of detailPathsFromLibraryRows(listRows)) {
    paths.add(p);
  }
  for (const p of uniqueProductEntitlementDetailPaths(listRows)) {
    paths.add(p);
  }

  const bundleTabLinks = await scrapeBundlesTabLinks(webContents);
  for (const p of bundleTabLinks) {
    paths.add(p);
  }
  console.info(`Bundles tab DOM links: ${bundleTabLinks.length} (reload skipped if already on library)`);

  const groupCount = [...paths].filter((p) => p.includes("/group/")).length;
  console.info(
    `Detail paths: ${paths.size} total (${groupCount} groups, ${paths.size - groupCount} title/group ids)`,
  );

  return { paths: [...paths], listRows };
}

async function scrapeBundlesTabLinks(
  webContents: WebContents,
): Promise<string[]> {
  try {
    const url = webContents.getURL();
    if (!url.includes("/home/library")) {
      console.info("Bundles tab: library not active, skipping tab scrape");
      return [];
    }
    const clicked = (await webContents.executeJavaScript(
      CLICK_BUNDLES_TAB,
      true,
    )) as boolean;
    if (!clicked) {
      console.info("Bundles tab not present in library UI");
      return [];
    }
    await sleep(1200);
    return (await webContents.executeJavaScript(
      SCRAPE_LIBRARY_LINKS,
      true,
    )) as string[];
  } catch (err) {
    console.warn("Bundles tab scrape failed (non-fatal)", err);
    return [];
  }
}

type GroupExpandResult = {
  childPaths: string[];
  bundles: LibraryBundle[];
};

async function expandGroupPathsInBrowser(
  webContents: WebContents,
  groupPaths: string[],
  onProgress?: (loaded: number, total: number, phase: string) => void,
): Promise<GroupExpandResult> {
  const child = new Set<string>();
  const bundles: LibraryBundle[] = [];
  const seen = new Set<string>();
  let i = 0;

  for (const path of groupPaths) {
    i += 1;
    onProgress?.(i, groupPaths.length, "groups");
    try {
      await safeLoadURL(webContents, `${LIBRARY_ORIGIN}${path}`);
      await sleep(700);
      const links = (await webContents.executeJavaScript(
        SCRAPE_LIBRARY_LINKS,
        true,
      )) as string[];
      const html = (await webContents.executeJavaScript(
        "document.documentElement.outerHTML",
        true,
      )) as string;
      let titleLinks = 0;
      for (const link of links) {
        if (link.includes("/group/")) {
          continue;
        }
        child.add(link);
        titleLinks += 1;
      }
      for (const p of childDetailPathsFromGroupText(html)) {
        child.add(p);
      }
      for (const bundle of bundlesFromPageText(path, html, "")) {
        if (!seen.has(bundle.orderId)) {
          seen.add(bundle.orderId);
          bundles.push(bundle);
        }
      }
      console.info(
        `Group ${path}: domLinks=${links.length} titleLinks=${titleLinks} parsedFiles=${bundles.length}`,
      );
    } catch (err) {
      console.warn("group page failed", path, err);
    }
  }

  await safeLoadURL(webContents, LOGIN_START_URL);
  return { childPaths: [...child], bundles };
}

export async function fetchDrmFreeLibraryFromBrowser(
  webContents: WebContents,
  onProgress?: (loaded: number, total: number, phase: string) => void,
): Promise<LibraryBundle[]> {
  if (webContents.isDestroyed()) {
    return [];
  }

  await beginLibraryDebugSession();

  const { paths: initialPaths, listRows } =
    await collectEntitlementDetailPaths(webContents, (page, total) => {
      onProgress?.(page, total, "discover");
    });

  const bundles: LibraryBundle[] = [];
  const seen = new Set<string>();

  for (const row of listRows) {
    const bundle = bundlesFromEntitlementRow(row);
    if (bundle && !seen.has(bundle.orderId)) {
      seen.add(bundle.orderId);
      bundles.push(bundle);
    }
  }
  if (bundles.length > 0) {
    console.info(`Inline list downloads: ${bundles.length} items`);
  }

  const groupPaths = initialPaths.filter((p) => p.includes("/group/"));
  const detailPaths = new Set(
    initialPaths.filter((p) => !p.includes("/group/")),
  );

  if (groupPaths.length > 0) {
    const expandGroupsInBrowser = process.env.HUMBLE_EXPAND_GROUPS === "1";
    if (expandGroupsInBrowser) {
      console.info(
        `Opening ${groupPaths.length} bundle group pages in browser (HUMBLE_EXPAND_GROUPS=1)…`,
      );
      const expanded = await expandGroupPathsInBrowser(
        webContents,
        groupPaths,
        onProgress,
      );
      for (const p of expanded.childPaths) {
        detailPaths.add(p);
      }
      for (const bundle of expanded.bundles) {
        if (!seen.has(bundle.orderId)) {
          seen.add(bundle.orderId);
          bundles.push(bundle);
        }
      }
    } else {
      console.info(
        `Skipping in-browser group navigation (${groupPaths.length} groups) — set HUMBLE_EXPAND_GROUPS=1 to enable; using list + title URLs only`,
      );
      for (let i = 0; i < groupPaths.length; i += DETAIL_BATCH_SIZE) {
        const batch = groupPaths.slice(i, i + DETAIL_BATCH_SIZE);
        const results = (await webContents.executeJavaScript(
          `(${FETCH_DETAIL_BATCH})(${JSON.stringify(batch)})`,
          true,
        )) as Array<{ path: string; html: string; rsc: string; ok: boolean }>;
        for (const row of results) {
          if (!row.ok) {
            continue;
          }
          const text = `${row.html}\n${row.rsc}`;
          for (const p of childDetailPathsFromGroupText(text)) {
            detailPaths.add(p);
          }
          for (const bundle of bundlesFromPageText(row.path, row.html, row.rsc)) {
            if (!seen.has(bundle.orderId)) {
              seen.add(bundle.orderId);
              bundles.push(bundle);
            }
          }
        }
      }
    }
    console.info(`After group expansion: ${detailPaths.size} title pages`);
  }

  const paths = [...detailPaths];
  console.info(`Library entitlements to inspect: ${paths.length}`);

  await logDiscoverDebug({
    listRowCount: listRows.length,
    initialPathCount: initialPaths.length,
    groupPathCount: groupPaths.length,
    titlePathCount: paths.length,
    samplePaths: paths.slice(0, 20),
  });

  const total = paths.length;
  if (total === 0) {
    console.warn(
      "No title URLs queued — check list metadata. Unique productEntitlement count may still be in discover logs.",
    );
  } else {
    console.info(`Starting detail fetch for ${total} URLs (no extra page reloads)`);
  }

  for (let i = 0; i < paths.length; i += DETAIL_BATCH_SIZE) {
    const batch = paths.slice(i, i + DETAIL_BATCH_SIZE);
    const loaded = Math.min(i + batch.length, total);
    onProgress?.(loaded, total, "details");

    if (loaded % 40 === 0 || loaded === total) {
      console.info(
        `Detail fetch: ${loaded}/${total}, ${bundles.length} items with files`,
      );
    }

    try {
      const results = (await webContents.executeJavaScript(
        `(${FETCH_DETAIL_BATCH})(${JSON.stringify(batch)})`,
        true,
      )) as Array<{
        path: string;
        ok: boolean;
        html: string;
        rsc: string;
        htmlStatus?: number;
        rscStatus?: number;
      }>;

      let batchIdx = 0;
      for (const result of results) {
        const combined = `${result.html}\n${result.rsc}`;
        const signals = countDownloadSignals(combined);
        if (i === 0 && batchIdx === 0) {
          console.info(
            `Detail sample ${result.path}: ok=${result.ok} html=${result.htmlStatus} rsc=${result.rscStatus} len=${combined.length} structBlocks=${signals.downloadStructBlocks} contentWeb=${signals.webFields} /downloads/=${signals.explicitDownloads}${isLibraryDebugEnabled() ? " (debug payloads on disk)" : ""}`,
          );
        }

        if (!result.ok) {
          batchIdx += 1;
          continue;
        }

        const found: LibraryBundle[] = [];
        for (const bundle of bundlesFromPageText(
          result.path,
          result.html,
          result.rsc,
        )) {
          if (!seen.has(bundle.orderId)) {
            seen.add(bundle.orderId);
            bundles.push(bundle);
            found.push(bundle);
          }
        }

        const bundlesFound = found.reduce(
          (n, b) =>
            n + b.products.reduce((m, p) => m + p.downloads.length, 0),
          0,
        );

        const savedFull = await maybeSaveDetailPayloads(
          result.path,
          result.html,
          result.rsc,
          {
            path: result.path,
            ok: result.ok,
            htmlStatus: result.htmlStatus,
            rscStatus: result.rscStatus,
            htmlLen: result.html.length,
            rscLen: result.rsc.length,
            signals,
            bundlesFound,
          },
          { sampleIndex: i === 0 ? batchIdx : 999 },
        );

        const structSnippetPreview =
          signals.downloadStructBlocks > 0
            ? snippetAroundDownloadStruct(combined, 800).map((s) =>
                s.length > 600 ? `${s.slice(0, 600)}…` : s,
              )
            : undefined;

        await logDetailPageDebug({
          path: result.path,
          ok: result.ok,
          htmlStatus: result.htmlStatus,
          rscStatus: result.rscStatus,
          htmlLen: result.html.length,
          rscLen: result.rsc.length,
          signals,
          bundlesFound,
          savedFullPayload: savedFull,
          structSnippetPreview,
          timestamp: new Date().toISOString(),
        });

        batchIdx += 1;
      }
    } catch (err) {
      console.warn("detail batch failed", err);
    }
  }

  const fileCount = bundles.reduce(
    (n, b) => n + b.products.reduce((m, p) => m + p.downloads.length, 0),
    0,
  );
  console.info(
    `Library scan done: ${bundles.length} items with DRM-free files (${fileCount} files)`,
  );

  await endLibraryDebugSession({
    pathsQueued: total,
    itemsWithFiles: bundles.length,
    fileCount,
  });

  return bundles;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}