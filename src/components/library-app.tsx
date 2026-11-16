"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { HumbleAppApi } from "@/types/humble-app";
import type {
  DownloadableFile,
  DownloadJob,
  LibraryBundle,
} from "../../electron/humble/types";

function readHumbleApi(): HumbleAppApi | null {
  return typeof window === "undefined" ? null : (window.humbleApp ?? null);
}

function subscribeApi(onStoreChange: () => void) {
  window.addEventListener("focus", onStoreChange);
  return () => window.removeEventListener("focus", onStoreChange);
}

export function LibraryApp() {
  const api = useSyncExternalStore(subscribeApi, readHumbleApi, () => null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [downloadPath, setDownloadPath] = useState("");
  const [bundles, setBundles] = useState<LibraryBundle[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [libraryProgress, setLibraryProgress] = useState<{
    loaded: number;
    total: number;
    phase?: string;
  } | null>(null);
  const [queue, setQueue] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [syncingAuth, setSyncingAuth] = useState(false);

  const refreshAuth = useCallback(async () => {
    if (!api) {
      return;
    }
    const status = await api.getAuthStatus();
    setLoggedIn(status.loggedIn);
    return status.loggedIn;
  }, [api]);

  const syncSignIn = useCallback(async () => {
    if (!api) {
      return;
    }
    setSyncingAuth(true);
    setError(null);
    try {
      const status = await (api.syncAuth ?? api.getAuthStatus)();
      setLoggedIn(status.loggedIn);
      if (!status.loggedIn) {
        setError(
          "Still not connected. Use the Humble window that opens, wait until you see your library (Logout visible), then Sync sign-in once more — do not click Sync repeatedly.",
        );
      }
    } finally {
      setSyncingAuth(false);
    }
  }, [api]);

  useEffect(() => {
    if (!api) {
      return;
    }
    let cancelled = false;
    const boot = async () => {
      const status = await api.getAuthStatus();
      if (!cancelled) {
        setLoggedIn(status.loggedIn);
      }
      const p = await api.getDownloadPath();
      if (p && !cancelled) {
        setDownloadPath(p);
      }
    };
    void boot();
    const offProgress = api.onDownloadProgress(() => {
      void api.getDownloadQueue().then(setQueue);
    });
    const offLibrary = api.onLibraryProgress((p) => setLibraryProgress(p));
    const offAuth = api.onAuthChanged(() => {
      void refreshAuth();
    });
    return () => {
      cancelled = true;
      offProgress();
      offLibrary();
      offAuth();
    };
  }, [api, refreshAuth]);

  const allFiles = useMemo(() => {
    const files: DownloadableFile[] = [];
    for (const bundle of bundles) {
      for (const product of bundle.products) {
        files.push(...product.downloads);
      }
    }
    return files;
  }, [bundles]);

  const visibleFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) {
      return allFiles;
    }
    return allFiles.filter(
      (f) =>
        f.bundleTitle.toLowerCase().includes(q) ||
        f.productTitle.toLowerCase().includes(q) ||
        f.filename.toLowerCase().includes(q) ||
        f.platform.toLowerCase().includes(q),
    );
  }, [allFiles, filter]);

  if (!api) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-amber-200 bg-amber-50 p-8 text-amber-950">
        <h1 className="text-xl font-semibold">Desktop shell required</h1>
        <p className="mt-2 text-sm leading-relaxed">
          Run <code className="rounded bg-amber-100 px-1">npm run dev</code> to
          start Next.js and Electron together. The browser-only dev server cannot
          access Humble login or file downloads.
        </p>
      </div>
    );
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected(new Set(visibleFiles.map((f) => f.id)));
  };

  const clearSelection = () => setSelected(new Set());

  const loadLibrary = async () => {
    setError(null);
    setLoadingLibrary(true);
    setLibraryProgress(null);
    try {
      const data = await api.fetchLibrary();
      setBundles(data);
      if (data.length === 0) {
        setError(
          "Library loaded but nothing to show. Purchases with only Steam/subscription keys have no files to download here.",
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoadingLibrary(false);
      setLibraryProgress(null);
    }
  };

  const enqueueSelected = async (files: DownloadableFile[]) => {
    if (files.length === 0) {
      return;
    }
    setError(null);
    try {
      await api.enqueueDownloads(files);
      setQueue(await api.getDownloadQueue());
      await api.startDownloads();
      setQueue(await api.getDownloadQueue());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectedFiles = allFiles.filter((f) => selected.has(f.id));

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/80 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Humble Library
            </h1>
            <p className="text-sm text-zinc-400">
              Sign in once, browse purchases, download one file or queue many.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {loggedIn ? (
              <>
                <span
                  className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300"
                  title="Humble session cookies saved on this machine — Refresh library does not require Google SSO again unless Sign out or cookies expire."
                >
                  Signed in (saved session)
                </span>
                <button
                  type="button"
                  className="rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700"
                  onClick={() => void loadLibrary()}
                  disabled={loadingLibrary}
                >
                  {loadingLibrary
                    ? "Loading purchases…"
                    : "Refresh library"}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800"
                  onClick={() =>
                    void api.logout().then((status) => {
                      setLoggedIn(status.loggedIn);
                      setBundles([]);
                      setError(null);
                    })
                  }
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="rounded-lg bg-[#cc5533] px-4 py-2 text-sm font-medium text-white hover:bg-[#b84a2d]"
                  onClick={() => void api.openLogin().then(refreshAuth)}
                >
                  Sign in with Humble Bundle
                </button>
                <button
                  type="button"
                  disabled={syncingAuth}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50"
                  onClick={() => void syncSignIn()}
                  title="Use after signing in in the login window"
                >
                  {syncingAuth ? "Syncing…" : "Sync sign-in"}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <section className="mb-6 grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 md:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              Download folder
            </p>
            <p className="mt-1 break-all font-mono text-sm text-zinc-300">
              {downloadPath || "—"}
            </p>
          </div>
          <div className="flex items-end justify-end">
            <button
              type="button"
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800"
              onClick={() =>
                void api.chooseDownloadPath().then((p) => {
                  if (p) {
                    setDownloadPath(p);
                  }
                })
              }
            >
              Choose folder…
            </button>
          </div>
        </section>

        {libraryProgress && (
          <p className="mb-4 text-sm text-zinc-400">
            {libraryProgress.phase === "discover"
              ? "Listing library"
              : libraryProgress.phase === "groups"
                ? "Opening bundle groups"
                : libraryProgress.phase === "details"
                  ? "Reading download links"
                  : "Loading purchases"}{" "}
            {libraryProgress.loaded} / {libraryProgress.total}
            {libraryProgress.phase === "discover" && libraryProgress.total >= 50
              ? " (this can take a couple of minutes for large libraries)"
              : null}
          </p>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Filter by title, file, platform…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="min-w-[240px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none ring-0 focus:border-zinc-500"
          />
          <button
            type="button"
            className="rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700"
            onClick={selectAllVisible}
          >
            Select visible
          </button>
          <button
            type="button"
            className="rounded-lg border border-zinc-700 px-3 py-2 text-sm"
            onClick={clearSelection}
          >
            Clear
          </button>
          <button
            type="button"
            disabled={selectedFiles.length === 0}
            className="rounded-lg bg-[#cc5533] px-4 py-2 text-sm font-medium disabled:opacity-40"
            onClick={() => void enqueueSelected(selectedFiles)}
          >
            Download selected ({selectedFiles.length})
          </button>
          <button
            type="button"
            disabled={allFiles.length === 0}
            className="rounded-lg border border-[#cc5533] px-4 py-2 text-sm text-[#f0a78c]"
            onClick={() => void enqueueSelected(allFiles)}
          >
            Download all
          </button>
          <button
            type="button"
            className="rounded-lg border border-zinc-700 px-3 py-2 text-sm"
            onClick={() => void api.stopDownloads()}
          >
            Stop queue
          </button>
        </div>

        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2 w-10" />
                <th className="px-3 py-2">Bundle</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Platform</th>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {visibleFiles.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-zinc-500"
                  >
                    {loggedIn
                      ? "Refresh library to load your purchases."
                      : "Sign in to load your Humble library."}
                  </td>
                </tr>
              ) : (
                visibleFiles.map((file) => (
                  <tr
                    key={file.id}
                    className="border-t border-zinc-800/80 hover:bg-zinc-900/40"
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(file.id)}
                        onChange={() => toggle(file.id)}
                        className="rounded border-zinc-600"
                      />
                    </td>
                    <td className="px-3 py-2 text-zinc-300">{file.bundleTitle}</td>
                    <td className="px-3 py-2">{file.productTitle}</td>
                    <td className="px-3 py-2 text-zinc-400">{file.platform}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                      {file.filename}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="text-xs text-[#f0a78c] hover:underline"
                        onClick={() => void enqueueSelected([file])}
                      >
                        Download
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {queue.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-2 text-sm font-medium text-zinc-300">Queue</h2>
            <ul className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs font-mono">
              {queue.map((job) => (
                <li key={job.id} className="flex justify-between gap-4">
                  <span className="truncate text-zinc-400">{job.filename}</span>
                  <span className="shrink-0 text-zinc-500">{job.status}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}