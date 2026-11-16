import fs from "node:fs";
import path from "node:path";

const RELEASE_DIR = "release";
const OUT_DIR = "release-upload";
const INSTALLER_EXT = new Set([
  ".appimage",
  ".deb",
  ".exe",
  ".dmg",
  ".zip",
]);
const SKIP_NAMES = new Set([
  "builder-debug.yml",
  "builder-effective-config.yaml",
  "latest.yml",
]);

fs.mkdirSync(OUT_DIR, { recursive: true });

let copied = 0;

for (const name of fs.readdirSync(RELEASE_DIR)) {
  if (SKIP_NAMES.has(name)) {
    continue;
  }
  const full = path.join(RELEASE_DIR, name);
  if (!fs.statSync(full).isFile()) {
    continue;
  }
  const ext = path.extname(name).toLowerCase();
  if (!INSTALLER_EXT.has(ext)) {
    continue;
  }
  fs.copyFileSync(full, path.join(OUT_DIR, name));
  copied += 1;
  console.log("include", name);
}

if (copied === 0) {
  console.error("No installer files found in", RELEASE_DIR);
  process.exit(1);
}