# Humble Library Downloader

One-shot desktop app to back up **DRM-free files** from your [Humble Bundle](https://www.humblebundle.com) library (PDF, EPUB, ZIP, game installers, etc.). It is **not** for bulk-exporting Steam keys or other redemption links.

Inspired by the community [humblebundle-downloader](https://github.com/ckolos/humblebundle-downloader) Python CLI, with an embedded browser for Google / SSO login so you do not paste cookies by hand.

**Unofficial.** Not affiliated with Humble Bundle. Use only for content you own. Respect their terms and be gentle on their servers.

---

## For end users (pre-built app)

1. Download the build for your OS from [Releases](../../releases) (or build locally — see below).
2. **Linux:** run the `.AppImage` (you may need `chmod +x` first). `.deb` is optional.
3. **Windows:** run the installer (`.exe`) or the **portable** `.exe` (no install).
4. **macOS:** open the `.dmg` and drag the app to Applications (first launch: right-click → Open if Gatekeeper blocks unsigned builds).

### How to use

1. Launch **Humble Library Downloader**.
2. Click **Sign in with Humble Bundle** and complete login in the window that opens (SSO / 2FA as usual).
3. If the app still says signed out, finish login until you see your library, then click **Sync sign-in** **once** — do not hammer it.
4. Click **Refresh library** **once** and wait. Large libraries can take several minutes (listing pages, then reading each item’s download page). Progress appears **near the top** of the main area while loading.
5. Optionally **Choose folder…** (default: `Documents/Humble Library` on each OS).
6. Use the table to filter, select checkboxes, then **Download selected**, or **Download all** **once** when you are ready.

### Download queue — read this

- After you click **Download all** or **Download selected**, the app adds jobs to a **serial queue**.
- **Scroll to the bottom of the window** to see the **Queue** section. That is where per-file status appears (`queued`, `downloading`, `done`, `error`, etc.).
- **Do not click Download all repeatedly.** One click is enough; duplicates clog the queue and stress Humble’s servers.
- **Stop queue** cancels work in progress; already-finished files stay on disk.
- Files are saved as: `Download folder / Bundle name / Item name / filename`
- A `.cache.json` in the download folder skips re-downloading files that already succeeded (safe to resume after a restart).

### What is not supported

- Trove-only streaming
- In-browser playable builds (asm.js, etc.)
- Bulk export of external redemption links (Steam, GOG keys, etc.) when they are not direct files
- Automatic updates (this is a grab-your-files-and-go tool)

---

## For developers

### Requirements

- **Node.js** 20+ and npm
- OS packages for building native apps are only needed when you run `dist:*` on that OS (see [Building installers](#building-installers)).

### Run from source (Linux)

```bash
npm install
npm run dev
```

This starts the Next.js UI on port **3456** and opens Electron. Do not open `http://localhost:3456` in Chrome — login and downloads only work inside Electron.

**Windows / macOS dev:** `dev:kill-port` uses `fuser` (Linux). On other OSes, if port 3456 is busy, close the old process or change the port in `package.json` / `ELECTRON_DEV_SERVER_URL`.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev: Next.js + Electron |
| `npm run compile:electron` | Compile `electron/` → `electron-dist/` |
| `npm run pack:prepare` | Compile Electron + static Next export (`out/`) |
| `npm run dist` | Build installers for **current** OS |
| `npm run dist:linux` | Linux AppImage + `.deb` → `release/` |
| `npm run dist:win` | Windows NSIS installer + portable → `release/` |
| `npm run dist:mac` | macOS `.dmg` + `.zip` → `release/` |

### Building installers

Always run `npm install` first (devDependencies include Next, Electron, and electron-builder).

```bash
npm run dist:linux    # on Linux
npm run dist:win      # on Windows (or cross-build; see below)
npm run dist:mac      # on macOS
```

Artifacts land in **`release/`** (gitignored).

| OS | Typical outputs |
| --- | --- |
| Linux | `Humble Library Downloader-0.1.0.AppImage`, `.deb` |
| Windows | `Humble Library Downloader Setup 0.1.0.exe`, `Humble Library Downloader-0.1.0-portable.exe` |
| macOS | `.dmg` and `.zip` |

**Cross-compiling:** The reliable approach is to run each `dist:*` command **on that OS** (or use CI with Linux + Windows + macOS runners). Building Windows installers from Linux may work for portable targets but often needs extra setup (Wine) for NSIS. macOS `.dmg` builds require macOS (or CI).

**Code signing:** Builds are unsigned. Windows may show SmartScreen; macOS may require “Open” from context menu. Fine for a personal backup tool.

### Architecture

| Piece | Role |
| --- | --- |
| **Electron** | Login window, cookie session, library scrape in hidden/visible browser, downloads, folder picker |
| **Next.js (static `out/`)** | Library table, filters, queue UI |
| **`electron/`** | Main process, Humble parsing, download manager |

Production loads `out/index.html` via `file://` (relative assets via `assetPrefix: './'` in `next.config.ts`).

### Debug

In dev, verbose library scan logs can go to `~/.cache/humble-library-debug/` when `HUMBLE_DEBUG_LIBRARY=verbose` (set in `dev:electron`).

---

## Legal

Unofficial tool, not affiliated with Humble Bundle. Use only to download content you are entitled to. Respect Humble’s terms of service and rate limits.