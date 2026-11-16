import type {
  AuthStatus,
  DownloadableFile,
  DownloadJob,
  LibraryBundle,
} from "../../electron/humble/types";

export type HumbleAppApi = {
  openLogin: () => Promise<void>;
  getAuthStatus: () => Promise<AuthStatus>;
  syncAuth: () => Promise<AuthStatus>;
  logout: () => Promise<AuthStatus>;
  fetchLibrary: () => Promise<LibraryBundle[]>;
  getDownloadPath: () => Promise<string | null>;
  chooseDownloadPath: () => Promise<string | null>;
  setDownloadPath: (dir: string) => Promise<void>;
  enqueueDownloads: (files: DownloadableFile[]) => Promise<DownloadJob[]>;
  startDownloads: () => Promise<void>;
  stopDownloads: () => Promise<void>;
  getDownloadQueue: () => Promise<DownloadJob[]>;
  onDownloadProgress: (listener: (payload: unknown) => void) => () => void;
  onLibraryProgress: (
    listener: (payload: {
      loaded: number;
      total: number;
      phase?: string;
    }) => void,
  ) => () => void;
  onAuthChanged: (listener: () => void) => () => void;
  isElectron: true;
};

declare global {
  interface Window {
    humbleApp?: HumbleAppApi;
  }
}

export {};