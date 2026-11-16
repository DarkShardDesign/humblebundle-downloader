import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export type AppSettings = {
  downloadPath?: string;
  cachedGamekeys?: string[];
};

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function readSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as AppSettings;
  } catch {
    return {};
  }
}

export function writeSettings(patch: AppSettings): AppSettings {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function defaultDownloadPath(): string {
  return path.join(app.getPath("documents"), "Humble Library");
}