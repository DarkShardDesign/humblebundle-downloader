import fs from "node:fs";
import path from "node:path";
import { bundlesFromFlightPageText } from "../electron/humble/parse-flight-library-item.ts";

const dir = process.argv[2];
let pages = 0;
let files = 0;
let products = 0;

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".html.txt")) continue;
  const html = fs.readFileSync(path.join(dir, f), "utf8");
  if (!html.includes("download_drm_free")) continue;
  const peid = f.replace("home_library_", "").replace(".html.txt", "");
  const b = bundlesFromFlightPageText(`/home/library/${peid}`, html, "");
  if (!b.length) continue;
  pages += 1;
  for (const p of b[0].products) {
    products += 1;
    files += p.downloads.length;
  }
}

console.log(JSON.stringify({ pages, products, files }));