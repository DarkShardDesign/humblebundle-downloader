import fs from "node:fs";
import path from "node:path";
import type { DownloadableFile, DownloadJob, DownloadProgressEvent } from "./types";
import type { HumbleFetch } from "./http";

type ProgressSink = (event: DownloadProgressEvent) => void;

export class DownloadManager {
  private queue: DownloadJob[] = [];
  private running = false;
  private cancelRequested = false;
  private hbFetch: HumbleFetch;
  private libraryPath: string;
  private onProgress: ProgressSink;

  constructor(
    libraryPath: string,
    hbFetch: HumbleFetch,
    onProgress: ProgressSink,
  ) {
    this.libraryPath = libraryPath;
    this.hbFetch = hbFetch;
    this.onProgress = onProgress;
    this.loadCache();
  }

  private cachePath = "";
  private cacheData: Record<string, { url_last_modified?: string }> = {};

  private loadCache() {
    this.cachePath = path.join(this.libraryPath, ".cache.json");
    try {
      this.cacheData = JSON.parse(
        fs.readFileSync(this.cachePath, "utf8"),
      ) as Record<string, { url_last_modified?: string }>;
    } catch {
      this.cacheData = {};
    }
  }

  private saveCache() {
    fs.mkdirSync(this.libraryPath, { recursive: true });
    fs.writeFileSync(
      this.cachePath,
      JSON.stringify(this.cacheData, null, 2),
      "utf8",
    );
  }

  getState(): DownloadJob[] {
    return [...this.queue];
  }

  enqueue(files: DownloadableFile[], skipCached = true): DownloadJob[] {
    const added: DownloadJob[] = [];
    for (const file of files) {
      const cacheKey = `${file.orderId}:${file.filename}`;
      if (skipCached && this.cacheData[cacheKey]) {
        continue;
      }
      if (this.queue.some((j) => j.id === file.id)) {
        continue;
      }
      const job: DownloadJob = { ...file, status: "pending" };
      this.queue.push(job);
      added.push(job);
    }
    return added;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.cancelRequested = false;

    while (this.queue.length > 0 && !this.cancelRequested) {
      const job = this.queue.find((j) => j.status === "pending");
      if (!job) {
        break;
      }
      job.status = "active";
      this.emit(job);
      try {
        await this.downloadOne(job);
        job.status = "completed";
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      }
      this.emit(job);
    }

    this.running = false;
  }

  stop() {
    this.cancelRequested = true;
  }

  private emit(job: DownloadJob) {
    this.onProgress({
      jobId: job.id,
      status: job.status,
      bytesDownloaded: job.bytesDownloaded,
      totalBytes: job.totalBytes,
      error: job.error,
      filename: job.filename,
    });
  }

  private async downloadOne(job: DownloadJob): Promise<void> {
    const res = await this.hbFetch(job.url, {
      headers: { Accept: "*/*" },
    });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (${res.status})`);
    }

    const destDir = path.join(
      this.libraryPath,
      job.bundleTitle,
      job.productTitle,
    );
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, job.filename);

    const total = Number(res.headers.get("content-length") ?? 0);
    job.totalBytes = total || undefined;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let downloaded = 0;

    while (true) {
      if (this.cancelRequested) {
        throw new Error("Download cancelled");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        downloaded += value.length;
        job.bytesDownloaded = downloaded;
        this.emit(job);
      }
    }

    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(destFile, buffer);

    const cacheKey = `${job.orderId}:${job.filename}`;
    const lastModified = res.headers.get("last-modified");
    this.cacheData[cacheKey] = {
      url_last_modified:
        lastModified ??
        new Date().toUTCString().replace("GMT", "GMT"),
    };
    this.saveCache();
  }
}