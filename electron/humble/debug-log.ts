import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { countDownloadSignals } from "./parse-downloads";

type DownloadSignals = ReturnType<typeof countDownloadSignals>;

function isDevRun(): boolean {
  return Boolean(process.env.ELECTRON_DEV_SERVER_URL?.trim());
}

export function isLibraryDebugEnabled(): boolean {
  const v = (process.env.HUMBLE_DEBUG_LIBRARY ?? "").toLowerCase();
  if (v === "0" || v === "false" || v === "off") {
    return false;
  }
  if (v === "1" || v === "true" || v === "verbose" || v === "full" || v === "sample") {
    return true;
  }
  return isDevRun();
}

/** In dev, save full html/rsc for every detail page (set HUMBLE_DEBUG_LIBRARY=sample to trim). */
export function isLibraryDebugVerbose(): boolean {
  const v = (process.env.HUMBLE_DEBUG_LIBRARY ?? "").toLowerCase();
  if (v === "sample") {
    return false;
  }
  if (v === "full" || v === "verbose") {
    return true;
  }
  return isLibraryDebugEnabled() && isDevRun();
}

export function libraryDebugDir(): string {
  return (
    process.env.HUMBLE_DEBUG_DIR?.trim() ||
    path.join(os.homedir(), ".cache", "humble-library-debug")
  );
}

let sessionDir: string | null = null;
let metaLogPath: string | null = null;

export async function beginLibraryDebugSession(): Promise<string | null> {
  if (!isLibraryDebugEnabled()) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  sessionDir = path.join(libraryDebugDir(), `scan-${stamp}`);
  await fs.mkdir(sessionDir, { recursive: true });
  metaLogPath = path.join(sessionDir, "pages.jsonl");
  const mode = isLibraryDebugVerbose() ? "verbose (all detail payloads)" : "standard";
  console.info(`Humble library debug session (${mode}): ${sessionDir}`);
  await fs.writeFile(
    path.join(sessionDir, "README.txt"),
    [
      "Humble Library Downloader debug capture.",
      "Enabled automatically during npm run dev (ELECTRON_DEV_SERVER_URL).",
      "HUMBLE_DEBUG_LIBRARY=0 disables. sample = metadata only. verbose|full = every payload.",
      "Optional: HUMBLE_DEBUG_DIR=/path/to/folder",
      "",
      "discover.json — list pagination summary.",
      "pages.jsonl — one JSON object per detail page (metadata + struct previews).",
      "payloads/ — html, rsc, struct-snippets.json per saved page.",
      "summary.json — run totals.",
    ].join("\n"),
  );
  return sessionDir;
}

export async function logDiscoverDebug(payload: Record<string, unknown>) {
  if (!sessionDir) {
    return;
  }
  await fs.writeFile(
    path.join(sessionDir, "discover.json"),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

function slugFromPath(detailPath: string): string {
  return detailPath.replace(/^\//, "").replace(/\//g, "_");
}

export function snippetAroundDownloadStruct(
  text: string,
  radius = 1200,
): string[] {
  const out: string[] = [];
  let idx = 0;
  while (out.length < 8) {
    const at = text.indexOf("downloadStruct", idx);
    if (at < 0) {
      break;
    }
    out.push(
      text.slice(Math.max(0, at - radius), Math.min(text.length, at + radius)),
    );
    idx = at + 1;
  }
  return out;
}

export type DetailPageDebugMeta = {
  path: string;
  ok: boolean;
  htmlStatus?: number;
  rscStatus?: number;
  htmlLen: number;
  rscLen: number;
  signals: DownloadSignals;
  bundlesFound: number;
  savedFullPayload: boolean;
  structSnippetPreview?: string[];
  timestamp: string;
};

export async function logDetailPageDebug(meta: DetailPageDebugMeta): Promise<void> {
  if (!metaLogPath) {
    return;
  }
  const line = `${JSON.stringify(meta)}\n`;
  await fs.appendFile(metaLogPath, line);
}

export async function maybeSaveDetailPayloads(
  detailPath: string,
  html: string,
  rsc: string,
  meta: Omit<DetailPageDebugMeta, "savedFullPayload" | "timestamp">,
  options: { forceFull?: boolean; sampleIndex?: number },
): Promise<boolean> {
  if (!sessionDir) {
    return false;
  }

  const interesting =
    meta.signals.downloadStructBlocks > 0 &&
    meta.bundlesFound === 0;
  const sample = (options.sampleIndex ?? 999) < 3;
  const saveFull =
    isLibraryDebugVerbose() ||
    options.forceFull ||
    interesting ||
    sample;

  if (!saveFull) {
    return false;
  }

  const dir = path.join(sessionDir, "payloads");
  await fs.mkdir(dir, { recursive: true });
  const base = slugFromPath(detailPath);
  const combined = `${html}\n${rsc}`;
  const snippets = snippetAroundDownloadStruct(combined);

  await fs.writeFile(path.join(dir, `${base}.html.txt`), html, "utf8");
  await fs.writeFile(path.join(dir, `${base}.rsc.txt`), rsc, "utf8");
  await fs.writeFile(
    path.join(dir, `${base}.struct-snippets.json`),
    JSON.stringify(
      {
        ...meta,
        snippets,
      },
      null,
      2,
    ),
    "utf8",
  );
  return true;
}

export async function endLibraryDebugSession(summary: Record<string, unknown>) {
  if (!sessionDir) {
    return;
  }
  await fs.writeFile(
    path.join(sessionDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
}