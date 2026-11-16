import type { WebContents } from "electron";
import {
  FALLBACK_LIBRARY_ACTION_ID,
  LIBRARY_PAGE_ACTION_IN_BROWSER,
  type LibraryPagePayload,
} from "./library-rsc";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LOGGED_IN_SCRIPT = `(function () {
  const path = location.pathname || "";
  if (
    path.startsWith("/home/") &&
    !/sign\\s*in|log\\s*in/i.test(document.body?.innerText?.slice(0, 2000) ?? "")
  ) {
    return true;
  }
  if (document.querySelector('a[href*="logout"], a[href*="sign-out"]')) {
    return true;
  }
  const text = document.body?.innerText ?? "";
  return /\\blog\\s*out\\b/i.test(text);
})()`;

/** Playnite-style: read embedded JSON from library HTML (no DOM scraping). */
const EMBEDDED_GAMEKEYS_SCRIPT = `(function () {
  try {
    if (typeof gamekeys !== "undefined" && Array.isArray(gamekeys) && gamekeys.length) {
      return gamekeys;
    }
    const raw = document.getElementById("user-home-json-data")?.textContent?.trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    return Array.isArray(data.gamekeys) && data.gamekeys.length ? data.gamekeys : null;
  } catch {
    return null;
  }
})()`;

const SCRAPE_LIBRARY_ACTION_SCRIPT = `(function () {
  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean);
  return scripts;
})()`;

const LEGACY_ORDER_LIST_SCRIPT = `(async function () {
  const origins = [
    "https://www.humblebundle.com",
    "https://hr-humblebundle.appspot.com",
  ];
  const paths = ["/api/v1/user/order", "/api/v1/user/orders"];
  let lastStatus = 0;
  for (const origin of origins) {
    for (const path of paths) {
      try {
        const res = await fetch(origin + path, {
          credentials: "include",
          headers: {
            Accept: "application/json",
            "X-Requested-By": "hb_android_app",
          },
        });
        lastStatus = res.status;
        if (!res.ok) {
          continue;
        }
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          const keys = data
            .map((row) => row && row.gamekey)
            .filter((k) => typeof k === "string" && k.length >= 12);
          if (keys.length) {
            return { keys, lastStatus: res.status, origin };
          }
        }
      } catch {
        /* next */
      }
    }
  }
  return { keys: null, lastStatus, origin: null };
})()`;

export async function fetchGamekeysFromBrowserOrderApi(
  webContents: WebContents,
): Promise<string[] | null> {
  if (webContents.isDestroyed()) {
    return null;
  }
  if (!(webContents.getURL() || "").includes("humblebundle.com")) {
    console.warn("fetchGamekeysFromBrowserOrderApi: not on humblebundle.com yet");
    return null;
  }
  try {
    const result = (await webContents.executeJavaScript(
      LEGACY_ORDER_LIST_SCRIPT,
      true,
    )) as {
      keys: string[] | null;
      lastStatus?: number;
      origin?: string | null;
    };
    if (result.keys?.length) {
      console.info(
        `Browser order list: ${result.keys.length} keys via ${result.origin}`,
      );
      return result.keys;
    }
    console.warn(
      "Browser order list empty",
      result.lastStatus ?? "unknown status",
    );
    return null;
  } catch (err) {
    console.warn("fetchGamekeysFromBrowserOrderApi failed", err);
    return null;
  }
}

export async function readEmbeddedGamekeysFromWebContents(
  webContents: WebContents,
): Promise<string[] | null> {
  if (webContents.isDestroyed()) {
    return null;
  }
  try {
    const keys = (await webContents.executeJavaScript(
      EMBEDDED_GAMEKEYS_SCRIPT,
      true,
    )) as string[] | null;
    if (Array.isArray(keys) && keys.length > 0) {
      return keys;
    }
  } catch (err) {
    console.warn("readEmbeddedGamekeysFromWebContents failed", err);
  }
  return null;
}

export async function detectLoggedInWebContents(
  webContents: WebContents,
): Promise<boolean> {
  try {
    return Boolean(await webContents.executeJavaScript(LOGGED_IN_SCRIPT, true));
  } catch {
    return false;
  }
}

export async function probeHumbleSession(
  loginWebContents?: WebContents,
): Promise<{ loggedIn: boolean; gamekeys: string[] | null }> {
  if (!loginWebContents || loginWebContents.isDestroyed()) {
    return { loggedIn: false, gamekeys: null };
  }

  for (let i = 0; i < 20; i++) {
    if (await detectLoggedInWebContents(loginWebContents)) {
      const gamekeys = await readEmbeddedGamekeysFromWebContents(loginWebContents);
      return { loggedIn: true, gamekeys };
    }
    await sleep(300);
  }
  return { loggedIn: false, gamekeys: null };
}

export async function postLibraryPageFromWebContents(
  webContents: WebContents,
  page: number,
  requestId: number,
  prevState: LibraryPagePayload,
  actionId: string,
): Promise<string | null> {
  if (webContents.isDestroyed()) {
    return null;
  }
  try {
    const result = (await webContents.executeJavaScript(
      `(${LIBRARY_PAGE_ACTION_IN_BROWSER})(${page}, ${JSON.stringify(prevState)}, ${requestId}, ${JSON.stringify(actionId)})`,
      true,
    )) as { ok: boolean; status?: number; text: string };
    if (!result.ok) {
      console.warn("library POST in browser HTTP", result.status);
      return null;
    }
    return result.text;
  } catch (err) {
    console.warn("postLibraryPageFromWebContents failed", err);
    return null;
  }
}

export async function resolveLibraryActionIdFromWebContents(
  webContents: WebContents,
): Promise<string> {
  const scraped = await scrapeLibraryActionIdFromWebContents(webContents);
  return scraped ?? FALLBACK_LIBRARY_ACTION_ID;
}

export async function scrapeLibraryActionIdFromWebContents(
  webContents: WebContents,
): Promise<string | null> {
  if (webContents.isDestroyed()) {
    return null;
  }
  try {
    const sources = (await webContents.executeJavaScript(
      SCRAPE_LIBRARY_ACTION_SCRIPT,
      true,
    )) as string[];
    for (const src of sources) {
      if (!src.includes("/_next/static/chunks/")) {
        continue;
      }
      try {
        const res = await fetch(src);
        if (!res.ok) {
          continue;
        }
        const js = await res.text();
        const match = js.match(/let ro=\(0,\w+\.createServerReference\)\("([a-f0-9]+)"/);
        if (match?.[1]) {
          return match[1];
        }
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn("scrapeLibraryActionIdFromWebContents failed", err);
  }
  return null;
}

export function waitForWebContentsReady(
  webContents: WebContents,
  timeoutMs = 25_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (webContents.isDestroyed()) {
      reject(new Error("Humble window closed"));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for Humble page"));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    if (!webContents.isLoading()) {
      finish();
      return;
    }
    webContents.once("did-finish-load", finish);
    webContents.once("did-stop-loading", () => {
      if (!webContents.isLoading()) {
        finish();
      }
    });
  });
}

/** Never rejects — avoids killing library scan on slow SPA navigations. */
export async function waitForNavigationSettled(
  webContents: WebContents,
  timeoutMs = 45_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (webContents.isDestroyed()) {
      return;
    }
    if (!webContents.isLoading()) {
      await sleep(350);
      if (!webContents.isLoading()) {
        return;
      }
    }
    await sleep(200);
  }
  console.warn(
    "Humble page still loading after",
    timeoutMs,
    "ms — continuing anyway",
  );
}

function isLoadAbortedError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { code?: string; errno?: number; message?: string };
  return (
    e.code === "ERR_ABORTED" ||
    e.errno === -3 ||
    (e.message?.includes("ERR_ABORTED") ?? false)
  );
}

/** loadURL throws ERR_ABORTED when Ory redirects; wait for the navigation to settle. */
export async function safeLoadURL(
  webContents: WebContents,
  url: string,
): Promise<void> {
  if (webContents.isDestroyed()) {
    throw new Error("Humble window closed");
  }
  try {
    await webContents.loadURL(url);
  } catch (err) {
    if (!isLoadAbortedError(err)) {
      throw err;
    }
    console.warn("Humble navigation aborted (redirect):", url);
  }
  await waitForNavigationSettled(webContents, 90_000);
}

export async function waitUntilLibraryReady(
  webContents: WebContents,
  loginUrl: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  if (webContents.isDestroyed()) {
    return false;
  }
  const current = webContents.getURL();
  if (
    current.includes("/home/library") &&
    (await detectLoggedInWebContents(webContents))
  ) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (webContents.isDestroyed()) {
      return false;
    }
    const url = webContents.getURL();
    if (url.includes("auth.humblebundle.com")) {
      await sleep(800);
      continue;
    }
    if (url.includes("/home/library")) {
      if (await detectLoggedInWebContents(webContents)) {
        return true;
      }
    } else if (url.includes("humblebundle.com")) {
      await safeLoadURL(webContents, loginUrl);
    } else {
      await safeLoadURL(webContents, loginUrl);
    }
    await sleep(500);
  }
  return (
    webContents.getURL().includes("/home/library") &&
    (await detectLoggedInWebContents(webContents))
  );
}

export async function isLibraryWebContentsReady(
  webContents: WebContents,
): Promise<boolean> {
  if (webContents.isDestroyed()) {
    return false;
  }
  const url = webContents.getURL();
  return (
    url.includes("/home/library") &&
    (await detectLoggedInWebContents(webContents))
  );
}

/** Load library in the Humble window and wait until list API can run in-page. */
export async function prepareLibraryListPage(
  webContents: WebContents,
  loginUrl: string,
): Promise<void> {
  if (webContents.isDestroyed()) {
    throw new Error("Humble window closed — keep the Sign in window open during Refresh.");
  }

  if (!(await isLibraryWebContentsReady(webContents))) {
    await safeLoadURL(webContents, loginUrl);
  }

  for (let i = 0; i < 120; i++) {
    if (webContents.isDestroyed()) {
      throw new Error("Humble window was closed during library load.");
    }
    const url = webContents.getURL();
    if (url.includes("auth.humblebundle.com")) {
      throw new Error(
        "Humble wants you to sign in again. Finish login in the Humble window, then click Refresh library once.",
      );
    }
    if (await isLibraryWebContentsReady(webContents)) {
      await waitForNavigationSettled(webContents, 20_000);
      const scripts = await webContents.executeJavaScript(
        `document.querySelectorAll('script[src*="_next/static/chunks"]').length`,
        true,
      );
      if (typeof scripts === "number" && scripts > 0) {
        return;
      }
    }
    await sleep(500);
  }

  throw new Error(
    "Could not open your Humble library in the sign-in window. Click Sync sign-in, wait until purchases appear, then Refresh.",
  );
}