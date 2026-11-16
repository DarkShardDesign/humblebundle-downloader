import { orderListUrl } from "./api-host";

export const ORDER_LIST_URLS = [
  orderListUrl("user/order"),
  orderListUrl("user/orders"),
  "https://www.humblebundle.com/api/v1/user/order",
  "https://www.humblebundle.com/api/v1/user/orders",
] as const;

type UserOrderRow = { gamekey?: string };

const GAMEKEY_RE = /^[A-Za-z0-9]{12,24}$/;

export function isLikelyGamekey(value: string): boolean {
  return GAMEKEY_RE.test(value) && !value.includes("-");
}

export function parseGamekeyListFromBody(body: string): string[] | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return null;
  }
  try {
    return parseGamekeyList(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function parseGamekeyList(data: unknown): string[] | null {
  if (Array.isArray(data)) {
    const keys = (data as UserOrderRow[])
      .map((row) => row.gamekey)
      .filter((key): key is string => Boolean(key && isLikelyGamekey(key)));
    return keys.length > 0 ? keys : null;
  }
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { gamekeys?: string[] }).gamekeys)
  ) {
    const keys = (data as { gamekeys: string[] }).gamekeys.filter(
      (key) => key && isLikelyGamekey(key),
    );
    return keys.length > 0 ? keys : null;
  }
  return null;
}