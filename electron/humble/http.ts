import { net, type Session } from "electron";
import { AUTH_COOKIE } from "./client";

const CHROME_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type HumbleFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

async function cookieHeaderForSite(session: Session): Promise<string> {
  const bySite = await session.cookies.get({
    url: "https://www.humblebundle.com",
  });
  const all = await session.cookies.get({});
  const humble = all.filter((c) =>
    (c.domain ?? "").replace(/^\./, "").includes("humblebundle.com"),
  );

  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of [...bySite, ...humble]) {
    if (seen.has(c.name)) {
      continue;
    }
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

/** Appspot rejects bloated Cookie headers; Playnite sends `_simpleauth_sess` only. */
async function cookieHeaderForLegacyApi(session: Session): Promise<string> {
  const cookies = await session.cookies.get({
    url: "https://www.humblebundle.com",
  });
  const parts: string[] = [];
  for (const name of [AUTH_COOKIE, "csrf_cookie"] as const) {
    const match = cookies.find((c) => c.name === name);
    if (match) {
      parts.push(`${match.name}=${match.value}`);
    }
  }
  return parts.join("; ");
}

export function createSessionFetch(session: Session): HumbleFetch {
  return async (url, init) => {
    const isLegacy = url.includes("hr-humblebundle.appspot.com");
    const cookieHeader = isLegacy
      ? await cookieHeaderForLegacyApi(session)
      : await cookieHeaderForSite(session);

    const headers = new Headers(init?.headers);
    if (!headers.has("X-Requested-By")) {
      headers.set("X-Requested-By", "hb_android_app");
    }
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", CHROME_USER_AGENT);
    }
    if (isLegacy && !headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    if (cookieHeader && !headers.has("Cookie")) {
      headers.set("Cookie", cookieHeader);
    }

    return net.fetch(url, {
      ...init,
      headers,
      session,
    } as RequestInit & { session: Session });
  };
}