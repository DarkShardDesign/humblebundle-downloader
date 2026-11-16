/** Legacy JSON API (Playnite, hbd, Lutris). Next.js on www returns HTML 404 for these paths. */
export const HUMBLE_LEGACY_API_ORIGIN = "https://hr-humblebundle.appspot.com";

export const orderListUrl = (path: "user/order" | "user/orders") =>
  `${HUMBLE_LEGACY_API_ORIGIN}/api/v1/${path}`;

export const orderDetailUrl = (gamekey: string) =>
  `${HUMBLE_LEGACY_API_ORIGIN}/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`;

export const orderDetailUrlWww = (gamekey: string) =>
  `https://www.humblebundle.com/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`;

export const orderDetailCandidates = (gamekey: string) => [
  orderDetailUrl(gamekey),
  orderDetailUrlWww(gamekey),
];

export const ordersBatchUrl = (gamekeys: string[]) => {
  const qs = gamekeys
    .map((key) => `gamekeys=${encodeURIComponent(key)}`)
    .join("&");
  return `${HUMBLE_LEGACY_API_ORIGIN}/api/v1/orders?all_tpkds=true&${qs}`;
};

export const ordersBatchUrlWww = (gamekeys: string[]) => {
  const qs = gamekeys
    .map((key) => `gamekeys=${encodeURIComponent(key)}`)
    .join("&");
  return `https://www.humblebundle.com/api/v1/orders?all_tpkds=true&${qs}`;
};

export const ordersBatchCandidates = (gamekeys: string[]) => [
  ordersBatchUrl(gamekeys),
  ordersBatchUrlWww(gamekeys),
];