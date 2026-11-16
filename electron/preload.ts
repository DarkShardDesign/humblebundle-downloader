import { contextBridge, ipcRenderer } from "electron";
import type {
  AuthStatus,
  DownloadableFile,
  DownloadJob,
  LibraryBundle,
} from "./humble/types";

const api = {
  openLogin: (): Promise<void> => ipcRenderer.invoke("auth:openLogin"),
  getAuthStatus: (): Promise<AuthStatus> => ipcRenderer.invoke("auth:status"),
  syncAuth: (): Promise<AuthStatus> => ipcRenderer.invoke("auth:sync"),
  logout: (): Promise<AuthStatus> => ipcRenderer.invoke("auth:logout"),
  fetchLibrary: (): Promise<LibraryBundle[]> =>
    ipcRenderer.invoke("library:fetch"),
  getDownloadPath: (): Promise<string | null> =>
    ipcRenderer.invoke("settings:getDownloadPath"),
  chooseDownloadPath: (): Promise<string | null> =>
    ipcRenderer.invoke("settings:chooseDownloadPath"),
  setDownloadPath: (dir: string): Promise<void> =>
    ipcRenderer.invoke("settings:setDownloadPath", dir),
  enqueueDownloads: (files: DownloadableFile[]): Promise<DownloadJob[]> =>
    ipcRenderer.invoke("download:enqueue", files),
  startDownloads: (): Promise<void> => ipcRenderer.invoke("download:start"),
  stopDownloads: (): Promise<void> => ipcRenderer.invoke("download:stop"),
  getDownloadQueue: (): Promise<DownloadJob[]> =>
    ipcRenderer.invoke("download:queue"),
  onDownloadProgress: (
    listener: (payload: unknown) => void,
  ): (() => void) => {
    const handler = (_: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("download:progress", handler);
    return () => ipcRenderer.removeListener("download:progress", handler);
  },
  onLibraryProgress: (
    listener: (payload: {
      loaded: number;
      total: number;
      phase?: string;
    }) => void,
  ): (() => void) => {
    const handler = (
      _: unknown,
      payload: { loaded: number; total: number; phase?: string },
    ) => listener(payload);
    ipcRenderer.on("library:progress", handler);
    return () => ipcRenderer.removeListener("library:progress", handler);
  },
  onAuthChanged: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("auth:changed", handler);
    return () => ipcRenderer.removeListener("auth:changed", handler);
  },
  isElectron: true as const,
};

contextBridge.exposeInMainWorld("humbleApp", api);