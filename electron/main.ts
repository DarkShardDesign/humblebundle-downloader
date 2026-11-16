import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AUTH_COOKIE,
  LOGIN_START_URL,
  SESSION_PARTITION,
  fetchPurchaseKeys,
  verifySession,
} from "./humble/client";
import { fetchDrmFreeLibraryFromBrowser } from "./humble/browser-library-scrape";
import {
  detectLoggedInWebContents,
  fetchGamekeysFromBrowserOrderApi,
  postLibraryPageFromWebContents,
  probeHumbleSession,
  readEmbeddedGamekeysFromWebContents,
  scrapeLibraryActionIdFromWebContents,
  safeLoadURL,
  waitForWebContentsReady,
} from "./humble/browser-session";
import {
  emptyLibraryPageState,
  FALLBACK_LIBRARY_ACTION_ID,
  gamekeysFromEntitlementRows,
  gamekeysFromRscText,
  parseBundleItemsFromFlight,
  parseLibraryActionResponse,
} from "./humble/library-rsc";
import { createSessionFetch } from "./humble/http";
import {
  defaultDownloadPath,
  readSettings,
  writeSettings,
} from "./settings";
import { DownloadManager } from "./humble/download-manager";
import type { DownloadableFile, DownloadJob } from "./humble/types";

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let downloadManager: DownloadManager | null = null;
let humbleSession: Electron.Session | null = null;
let humbleFetch: ReturnType<typeof createSessionFetch> | null = null;
let browserSessionActive = false;
let cachedGamekeys: string[] | null = null;

type LoginWindowOptions = {
  focus?: boolean;
  show?: boolean;
};

function getHumbleFetch() {
  if (!humbleFetch) {
    humbleFetch = createSessionFetch(getHumbleSession());
  }
  return humbleFetch;
}

function getHumbleSession(): Electron.Session {
  if (!humbleSession) {
    humbleSession = session.fromPartition(SESSION_PARTITION);
  }
  return humbleSession;
}

const devServerUrl =
  process.env.ELECTRON_DEV_SERVER_URL ?? "http://localhost:3456";

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const url = isDev
    ? devServerUrl
    : pathToFileURL(path.join(__dirname, "../out/index.html")).href;

  void mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function isHumbleAuthCookie(name: string): boolean {
  return (
    name === AUTH_COOKIE ||
    name.includes("ory_kratos") ||
    name === "csrf_cookie" ||
    name.startsWith("ory_session")
  );
}

async function readAuthStatus() {
  const sess = getHumbleSession();
  const all = await sess.cookies.get({});
  const humble = all.filter((c) =>
    (c.domain ?? "").includes("humblebundle.com"),
  );
  const hasCookie = humble.some((c) => isHumbleAuthCookie(c.name));

  if (hasCookie) {
    browserSessionActive = true;
    return { loggedIn: true, hasSessionCookie: true };
  }

  browserSessionActive = false;
  return { loggedIn: false, hasSessionCookie: false };
}

async function ensureLoginWindowForProbe(
  options: LoginWindowOptions = {},
): Promise<void> {
  const focus = options.focus ?? false;
  const show = options.show ?? true;

  if (loginWindow && !loginWindow.isDestroyed()) {
    if (focus) {
      loginWindow.focus();
    }
    return;
  }

  openLoginWindow({ focus, show });
  if (!loginWindow) {
    throw new Error("Could not open Humble window");
  }
  await waitForWebContentsReady(loginWindow.webContents);
}

function rememberGamekeys(keys: string[] | null | undefined) {
  if (keys && keys.length > 0) {
    cachedGamekeys = keys;
    writeSettings({ cachedGamekeys: keys });
  }
}

async function bootstrapPersistedSession(): Promise<void> {
  const settings = readSettings();
  if (settings.cachedGamekeys && settings.cachedGamekeys.length > 0) {
    cachedGamekeys = settings.cachedGamekeys;
  }

  const sess = getHumbleSession();
  const cookies = await sess.cookies.get({
    url: "https://www.humblebundle.com",
  });
  if (cookies.some((c) => c.name === AUTH_COOKIE)) {
    browserSessionActive = true;
    return;
  }

  if (await verifySession(getHumbleFetch())) {
    browserSessionActive = true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureHumbleLibraryReady(): Promise<Electron.WebContents | null> {
  await ensureLoginWindowForProbe({ focus: true, show: true });
  if (!loginWindow || loginWindow.isDestroyed()) {
    return null;
  }
  const wc = loginWindow.webContents;
  if (!wc.getURL().includes("/home/library")) {
    await safeLoadURL(wc, LOGIN_START_URL);
  }
  for (let i = 0; i < 40; i++) {
    if (await detectLoggedInWebContents(wc)) {
      return wc;
    }
    await sleep(500);
  }
  return wc;
}

async function pullGamekeysFromSession(): Promise<string[] | null> {
  const wc = await ensureHumbleLibraryReady();
  if (!wc) {
    return null;
  }

  const cookies = await getHumbleSession().cookies.get({
    url: "https://www.humblebundle.com",
  });
  console.info(
    `Humble session cookies: ${cookies.length}, _simpleauth_sess=${cookies.some((c) => c.name === AUTH_COOKIE)}`,
  );

  const fromBrowser = await fetchGamekeysFromBrowserOrderApi(wc);
  if (fromBrowser?.length) {
    return fromBrowser;
  }

  const viaLibrary = await fetchGamekeysViaLoginBrowser();
  if (viaLibrary?.length) {
    return viaLibrary;
  }

  try {
    return await fetchPurchaseKeys(getHumbleFetch());
  } catch (err) {
    console.warn("fetchPurchaseKeys", err);
    return null;
  }
}

async function syncBrowserSession(): Promise<boolean> {
  await ensureLoginWindowForProbe({ focus: true, show: true });
  if (!loginWindow || loginWindow.isDestroyed()) {
    return false;
  }
  const probe = await probeHumbleSession(loginWindow.webContents);
  browserSessionActive = probe.loggedIn;
  if (probe.loggedIn) {
    let keys = probe.gamekeys;
    if (!keys?.length) {
      keys = await readEmbeddedGamekeysFromWebContents(loginWindow.webContents);
    }
    if (!keys?.length) {
      keys = await pullGamekeysFromSession();
    }
    rememberGamekeys(keys ?? undefined);
  }
  return probe.loggedIn;
}

async function resolveGamekeys(): Promise<string[]> {
  if (cachedGamekeys && cachedGamekeys.length > 0 && browserSessionActive) {
    return cachedGamekeys;
  }

  let keys = await pullGamekeysFromSession();
  if (keys?.length) {
    rememberGamekeys(keys);
    return keys;
  }

  if (
    loginWindow &&
    !loginWindow.isDestroyed() &&
    loginWindow.webContents.getURL().includes("humblebundle.com")
  ) {
    keys = await readEmbeddedGamekeysFromWebContents(loginWindow.webContents);
    if (keys?.length) {
      rememberGamekeys(keys);
      return keys;
    }

    keys = await fetchGamekeysViaLoginBrowser();
    if (keys?.length) {
      rememberGamekeys(keys);
      return keys;
    }
  }

  throw new Error(
    "Could not read purchase keys. In the Humble window open https://www.humblebundle.com/home/library, wait for your list to load, Sync sign-in, then Refresh.",
  );
}

async function fetchGamekeysViaLoginBrowser(): Promise<string[] | null> {
  if (!loginWindow || loginWindow.isDestroyed()) {
    return null;
  }
  const wc = loginWindow.webContents;
  const keys = new Set<string>();

  let actionId =
    (await scrapeLibraryActionIdFromWebContents(wc)) ??
    FALLBACK_LIBRARY_ACTION_ID;

  let requestId = 1;
  let prevState = emptyLibraryPageState();

  const page1Text = await postLibraryPageFromWebContents(
    wc,
    1,
    requestId++,
    prevState,
    actionId,
  );
  if (!page1Text) {
    return null;
  }

  for (const key of gamekeysFromRscText(page1Text)) {
    keys.add(key);
  }

  const page1 = parseLibraryActionResponse(page1Text);
  if (page1?.results) {
    for (const key of gamekeysFromEntitlementRows(page1.results)) {
      keys.add(key);
    }
  }
  if (!page1) {
    return keys.size > 0 ? [...keys] : null;
  }

  prevState = page1;
  const totalPages = page1.pagination?.totalPages ?? 1;

  for (let page = 2; page <= totalPages; page++) {
    const text = await postLibraryPageFromWebContents(
      wc,
      page,
      requestId++,
      prevState,
      actionId,
    );
    if (!text) {
      break;
    }
    const payload = parseLibraryActionResponse(text);
    if (payload?.results) {
      for (const key of gamekeysFromEntitlementRows(payload.results)) {
        keys.add(key);
      }
      prevState = payload;
    }
    for (const key of gamekeysFromRscText(text)) {
      keys.add(key);
    }
  }

  return keys.size > 0 ? [...keys] : null;
}

async function requireSession(): Promise<void> {
  const { loggedIn } = await readAuthStatus();
  if (!loggedIn) {
    throw new Error("Not signed in. Use Sign in with Humble Bundle first.");
  }
}

function openLoginWindow(options: LoginWindowOptions = {}) {
  const focus = options.focus ?? true;
  const show = options.show ?? true;

  if (loginWindow && !loginWindow.isDestroyed()) {
    if (focus) {
      loginWindow.focus();
    }
    return;
  }

  loginWindow = new BrowserWindow({
    width: 960,
    height: 800,
    show,
    title: "Sign in — Humble Bundle",
    webPreferences: {
      partition: SESSION_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  void loginWindow.loadURL(LOGIN_START_URL);

  const notifyAuth = () => {
    mainWindow?.webContents.send("auth:changed");
  };

  const checkCookie = async () => {
    const status = await readAuthStatus();
    if (status.loggedIn) {
      notifyAuth();
    }
  };

  loginWindow.webContents.on("did-navigate", () => {
    void checkCookie();
  });
  loginWindow.webContents.on("did-navigate-in-page", () => {
    void checkCookie();
  });

  loginWindow.on("closed", () => {
    loginWindow = null;
    notifyAuth();
  });
}

function resolveDownloadPath(): string {
  return readSettings().downloadPath ?? defaultDownloadPath();
}

function ensureDownloadManager(): DownloadManager {
  const downloadPath = resolveDownloadPath();

  if (!downloadManager) {
    downloadManager = new DownloadManager(
      downloadPath,
      getHumbleFetch(),
      (event) => {
        mainWindow?.webContents.send("download:progress", event);
      },
    );
  }
  return downloadManager;
}

function registerIpc() {
  ipcMain.handle("auth:openLogin", async () => {
    openLoginWindow();
  });

  ipcMain.handle("auth:status", () => readAuthStatus());

  ipcMain.handle("auth:sync", async () => {
    const loggedIn = await syncBrowserSession();
    mainWindow?.webContents.send("auth:changed");
    return { loggedIn, hasSessionCookie: loggedIn };
  });

  ipcMain.handle("auth:logout", async () => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.destroy();
    }
    loginWindow = null;

    const sess = getHumbleSession();
    await sess.clearStorageData();
    await sess.clearAuthCache();
    const cookies = await sess.cookies.get({});
    for (const cookie of cookies) {
      if (!(cookie.domain ?? "").includes("humblebundle.com")) {
        continue;
      }
      const host = (cookie.domain ?? "").replace(/^\./, "");
      const scheme = cookie.secure ? "https" : "http";
      const url = `${scheme}://${host}${cookie.path ?? "/"}`;
      try {
        await sess.cookies.remove(url, cookie.name);
      } catch {
        /* ignore */
      }
    }

    downloadManager = null;
    humbleFetch = null;
    browserSessionActive = false;
    cachedGamekeys = null;
    writeSettings({ cachedGamekeys: [] });
    mainWindow?.webContents.send("auth:changed");
    return { loggedIn: false, hasSessionCookie: false };
  });

  ipcMain.handle("library:fetch", async () => {
    const status = await readAuthStatus();
    if (!status.loggedIn) {
      throw new Error(
        "No saved Humble session. Click Sign in with Humble Bundle, finish login in the Humble window, then Sync sign-in.",
      );
    }

    await ensureLoginWindowForProbe({ focus: true, show: true });

    const libraryWebContents =
      loginWindow && !loginWindow.isDestroyed()
        ? loginWindow.webContents
        : null;

    if (!libraryWebContents) {
      throw new Error("Open the Humble window and sign in first.");
    }

    const bundles = await fetchDrmFreeLibraryFromBrowser(
      libraryWebContents,
      (loaded, total, phase) => {
        mainWindow?.webContents.send("library:progress", {
          loaded,
          total,
          phase,
        });
      },
    );
    const fileCount = bundles.reduce(
      (n, b) =>
        n + b.products.reduce((m, p) => m + p.downloads.length, 0),
      0,
    );

    if (fileCount === 0) {
      throw new Error(
        "No DRM-free download links found. Keep the Humble window on Library, click Sync sign-in, then Refresh — the app scans every purchased item’s detail page (ZIP/EPUB/PDF), not legacy order keys.",
      );
    }
    return bundles;
  });

  ipcMain.handle("settings:getDownloadPath", () => resolveDownloadPath());

  ipcMain.handle("settings:setDownloadPath", (_e, dir: string) => {
    writeSettings({ downloadPath: dir });
    downloadManager = null;
  });

  ipcMain.handle("settings:chooseDownloadPath", async () => {
    const dialogOptions = {
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    };
    const parent = mainWindow ?? BrowserWindow.getFocusedWindow();
    const result =
      parent && !parent.isDestroyed()
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const dir = result.filePaths[0];
    writeSettings({ downloadPath: dir });
    downloadManager = null;
    return dir;
  });

  ipcMain.handle("download:enqueue", async (_e, files: DownloadableFile[]) => {
    await requireSession();
    const manager = ensureDownloadManager();
    return manager.enqueue(files);
  });

  ipcMain.handle("download:start", async () => {
    await requireSession();
    const manager = ensureDownloadManager();
    await manager.start();
  });

  ipcMain.handle("download:stop", async () => {
    downloadManager?.stop();
  });

  ipcMain.handle("download:queue", () => {
    return (downloadManager?.getState() ?? []) as DownloadJob[];
  });
}

function watchAuthCookies() {
  const humbleCookies = getHumbleSession().cookies;
  humbleCookies.on("changed", (_event, cookie) => {
    const domain = cookie.domain?.replace(/^\./, "") ?? "";
    if (!domain.includes("humblebundle.com")) {
      return;
    }
    mainWindow?.webContents.send("auth:changed");
  });
}

app.whenReady().then(() => {
  registerIpc();
  void bootstrapPersistedSession().then(() => {
    mainWindow?.webContents.send("auth:changed");
  });
  watchAuthCookies();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});