const ALLOWED = new Set([" ", "_", ".", "-", "[", "]"]);

export function cleanName(dirty: string): string {
  const out: string[] = [];
  for (const c of dirty.replaceAll("+", "_").replaceAll(":", " -")) {
    if (c.match(/[a-zA-Z0-9]/) || ALLOWED.has(c)) {
      out.push(c);
    }
  }
  return out.join("").trim().replace(/\.+$/, "");
}