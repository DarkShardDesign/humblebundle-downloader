import type { WebContents } from "electron";
import type { HumbleOrder } from "./types";

const ORDERS_BATCH_IN_BROWSER = `(async function (gamekeys) {
  const params = new URLSearchParams();
  params.set("all_tpkds", "true");
  for (const key of gamekeys) {
    params.append("gamekeys", key);
  }
  const res = await fetch("/api/v1/orders?" + params.toString(), {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Requested-By": "hb_android_app",
    },
  });
  if (!res.ok) {
    return { ok: false, status: res.status, data: null };
  }
  const text = await res.text();
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, data: null };
  }
})`;

const ORDER_DETAIL_IN_BROWSER = `(async function (gamekey) {
  const res = await fetch(
    "/api/v1/order/" + encodeURIComponent(gamekey) + "?all_tpkds=true",
    {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Requested-By": "hb_android_app",
      },
    },
  );
  if (!res.ok) {
    return { ok: false, status: res.status, data: null };
  }
  try {
    return { ok: true, status: res.status, data: await res.json() };
  } catch {
    return { ok: false, status: res.status, data: null };
  }
})`;

export async function fetchOrdersBatchInBrowser(
  webContents: WebContents,
  gamekeys: string[],
): Promise<Record<string, HumbleOrder | null> | null> {
  if (webContents.isDestroyed() || gamekeys.length === 0) {
    return null;
  }
  try {
    const result = (await webContents.executeJavaScript(
      `(${ORDERS_BATCH_IN_BROWSER})(${JSON.stringify(gamekeys)})`,
      true,
    )) as {
      ok: boolean;
      status: number;
      data: Record<string, HumbleOrder | null> | null;
    };
    if (!result.ok) {
      console.warn("browser orders batch HTTP", result.status);
      return null;
    }
    return result.data;
  } catch (err) {
    console.warn("fetchOrdersBatchInBrowser failed", err);
    return null;
  }
}

export async function fetchOrderInBrowser(
  webContents: WebContents,
  gamekey: string,
): Promise<HumbleOrder | null> {
  if (webContents.isDestroyed()) {
    return null;
  }
  try {
    const result = (await webContents.executeJavaScript(
      `(${ORDER_DETAIL_IN_BROWSER})(${JSON.stringify(gamekey)})`,
      true,
    )) as { ok: boolean; status: number; data: HumbleOrder | null };
    if (!result.ok) {
      return null;
    }
    return result.data;
  } catch (err) {
    console.warn(`fetchOrderInBrowser ${gamekey} failed`, err);
    return null;
  }
}