export type AuthStatus = {
  loggedIn: boolean;
  hasSessionCookie: boolean;
};

export type LibraryBundle = {
  orderId: string;
  title: string;
  products: LibraryProduct[];
};

export type LibraryProduct = {
  orderId: string;
  bundleTitle: string;
  productTitle: string;
  downloads: DownloadableFile[];
};

export type DownloadableFile = {
  id: string;
  orderId: string;
  bundleTitle: string;
  productTitle: string;
  platform: string;
  filename: string;
  url: string;
};

export type DownloadJob = DownloadableFile & {
  status: "pending" | "active" | "completed" | "failed" | "skipped";
  error?: string;
  bytesDownloaded?: number;
  totalBytes?: number;
};

export type DownloadProgressEvent = {
  jobId: string;
  status: DownloadJob["status"];
  bytesDownloaded?: number;
  totalBytes?: number;
  error?: string;
  filename: string;
};

export type HumbleOrder = {
  product: { human_name: string };
  subproducts: HumbleSubproduct[];
};

export type HumbleSubproduct = {
  human_name: string;
  downloads: HumbleDownloadType[];
};

export type HumbleDownloadType = {
  platform: string;
  download_struct: HumbleDownloadStruct[];
};

export type HumbleDownloadStruct = {
  url?: { web?: string };
  external_link?: string;
  asm_config?: unknown;
};