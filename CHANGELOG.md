# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.4.0]

### Added

- **MCP server** (Streamable HTTP): a FastMCP layer mounted on the same app
  and port, so AI agents can operate the hangar through typed tools instead
  of raw `curl`. Endpoint: **`http://<host>:8333/mcp`** (exact URL, no
  trailing slash needed — a path-normalize middleware handles both).
  13 hand-written tools: `hangar_list_models` / `hangar_get_model` /
  `hangar_search_models` / `hangar_create_model` / `hangar_update_model` /
  `hangar_delete_model` / `hangar_list_photos` / `hangar_upload_photo` /
  `hangar_reorder_photos` / `hangar_delete_photo` / `hangar_photo_meta` /
  `hangar_values` / `hangar_status`. Deliberately **not** exposed:
  setup, auth-check, import/export and any generic escape-hatch tool.
- **MCP auth model**: tools proxy through the REST API with the instance
  token read in-process (single source of truth, never a tool parameter and
  never echoed in results/errors). `/mcp` itself is guarded by an
  `X-API-Key` check (constant-time compare) — the deployment is LAN-reachable,
  so an unguarded MCP endpoint would be an anonymous write door.
- Photos over MCP are capped at 5 MB (base64 in); larger files keep using
  the chunked upload REST path.

### Changed

- Dependencies: added `fastmcp==2.14.7`; `httpx` pin raised to `0.28.*` and
  `uvicorn` to `0.35.*` (required by fastmcp; no behavior change for existing
  code paths).
- App startup moved from `@app.on_event("startup")` to a combined
  `lifespan` (required to run the mounted MCP app's session manager).

## [1.3.6]

### Added

- **Device alias normalization**: EXIF `Model` codes (e.g. `M2102K1C`) are now
  mapped to human-readable device names via a new `device_alias` SQLite table.
  Generic cleaning (parenthesis stripping, known ROM-variant suffixes such as
  `P2XL`/`PXL`/`N6P`) runs before the lookup, so dirty strings still normalize
  without a table entry. The photo meta endpoint additionally returns
  `device_raw` — the untouched raw EXIF `Model` (no Make prefix), so copying
  it into the alias API always matches ("what you see is what you look up");
  `device` keeps its meaning, so the WebUI needs no changes.
- **Alias maintenance API** (self-use, no UI): `GET` (public) /
  `POST` (upsert, `X-API-Key`) / `DELETE` (`X-API-Key`)
  on `/api/v1/device-aliases`. POST rejects empty values and any raw the
  cleaning layer would alter (non-fixed-point keys could never match; the
  400 message shows the cleaned value to register instead).
- `device_alias` rows are carried by export/import as `device_aliases`
  (`format_version` stays 1; old packages without the field import cleanly).

### Fixed

- **Make/model redundancy**: `device` is now Make + normalized Model joined
  with dedup — `Xiaomi` + `Xiaomi 14 Ultra` renders as `Xiaomi 14 Ultra`
  instead of `Xiaomi Xiaomi 14 Ultra`.
- Photos whose EXIF Make/Model are both `--` now report `device: null`
  instead of the literal `"-- --"`.

## [1.3.5]

### Added

- **`designation` field (机设番号)**: optional, editable in the form
  right next to the name. The list and detail views show "designation name"
  as a single combined title (no separate row); search now matches
  designation as well as name.
- **`main_color` field (机体颜色)**: soft enum with built-in presets
  (高达/红/白/蓝/黄/橙/粉红/黑/灰/金/银), editable freely, placed after
  the scale field. Old databases automatically fall back to the built-in
  presets; the setup page pre-fills them for new installs.
- **Color filter** in the header filter menu.
- **KO badge**: records whose origin is "KO" show a KO stamp badge next to
  the name, and their grade logo renders grayscale to distinguish
  third-party kits from official ones.

### Changed

- **List columns**: removed the "来源" (origin) and "展示" (display)
  columns; both fields remain editable and filterable.
- **FAB placement**: the add-button now sits lower, its bottom third
  overlapping the fixed footer; it is hidden while the add/edit form is
  open.
- **Edit form**: the photo-upload control is hidden when editing an
  existing record (photo management lives in the detail dialog).

### Fixed

- **Mobile card layout**: the KO badge no longer gets pushed to the far
  edge away from the name (name text and badge are wrapped as one flex
  item).

## [1.3.4]

### Added

- **Photo drag-to-reorder** in the detail dialog: mouse drag (movement
  threshold) and touch long-press (500 ms, with vibration feedback on
  supported devices). Pointer Events based, no new dependencies; the drop
  order is persisted through the existing `PUT /photos/order` endpoint.
- **Chunked resumable uploads for the add/edit form**: photos attached to a
  record are now uploaded through the same 1 MB-chunk / 3-concurrent /
  retry engine the detail view already used (extracted into a shared
  `upload.js`), making slow relays (e.g. DERP) far more robust.
- **Upload progress UI in the form**: save/cancel buttons lock while
  submitting and uploading (save button shows a spinner), an embedded
  progress bar reports per-chunk byte progress, and an "中断" (abort)
  button stops the upload mid-flight — already-uploaded photos are kept
  and the rest can be finished later from the detail view.

## [1.3.3]

### Changed

- **Header-first toolbar**: search and filters moved into the sticky header
  as icon dropdown menus (search panel auto-focuses; filter menu applies on
  change and shows an active-count badge). The refresh button and the whole
  toolbar row are gone.
- **Auth state unified**: logged-out users see a single "只读模式（点击以登录）"
  chip in the header that opens the login dialog; the separate read-only
  hint line was removed.
- **Add button is now a floating action button** (round, bottom-right,
  visible only when logged in).
- **Row actions as icon buttons**: edit/delete use inline boxicons SVGs
  (tooltips on hover) instead of text links.
- **Table header always visible on desktop**: the table area scrolls
  internally (`max-height` + sticky `thead`), with a custom overlay
  scrollbar whose travel starts below the header — the native vertical
  scrollbar is hidden and replaced by a themed overlay thumb (drag +
  scroll sync), so it never overlaps the header and keeps the container
  corner radius intact.

### Fixed

- **Dialog buttons left-aligned**: login and form action rows combined
  `flex-direction: row-reverse` with `justify-content: flex-end`, which
  pushed buttons to the left; now correctly right-aligned with the
  primary action farthest right.
- **Header right-edge gap**: the global `scrollbar-gutter: stable`
  reservation left a blank strip beside the header once the page itself
  stopped scrolling; removed.
- **Unsaved changes guard**: clicking back/cancel on the add/edit form
  with unsaved edits now asks "放弃填写？" via the dialog component;
  an untouched form still closes immediately.

## [1.3.2]

### Fixed

- **Large-archive import**: the fixed 200 MB cap (both the merged-zip check
  and the inner-photos check) is replaced by a pre-merge disk-space check —
  the data volume must fit `2 × package + 500 MB` margin (merged zip + photo
  staging peak), and the photos volume is checked separately when it lives
  on a different disk.

### Added

- **Export as a background job with progress**: `POST /export/jobs` packs the
  ZIP in a worker thread (one job at a time; 409 returns the running job id
  so a second client keeps polling it), `GET /export/jobs/{id}` reports byte
  progress via a counting file wrapper, `GET /export/jobs/{id}/download`
  serves the finished package with an exact `Content-Length`, and `DELETE`
  cleans up (30-min TTL sweep as backstop). The export dialog now shows an
  estimated package size (`GET /export/preview`) with a >2 GB warning, a
  progress bar while packing, and auto-download on completion. The legacy
  synchronous `GET /export` remains for scripts/smoke tests.
- **HDR badge in lightbox**: `read_exif` now returns `hdr` (detects the
  `GainMap` XMP marker in the first 64 KB — Ultra HDR / gain-map JPEGs);
  the lightbox shows a gold "HDR" badge with an explanatory tooltip so
  users know a dark-looking image is an HDR original, not a bug.

## [1.3.1]

### Fixed

- **Backup/restore dialogs**: checkbox/radio rows no longer stack vertically
  and center (the global `label { flex-direction: column }` rule leaked into
  `.dlg-check`/`.dlg-radio`); controls now sit inline, left-aligned.
- **Dialog buttons**: all dialog actions are right-aligned at the bottom with
  the confirm/primary button farthest right (export, import mode, login).
- **Scrollbar shift**: opening any modal no longer nudges the page sideways —
  `scrollbar-gutter: stable` keeps the gutter reserved.
- **Header menus**: the import/export and theme dropdowns are now mutually
  exclusive (opening one closes the other).
- **Photo overlay buttons**: delete/up/down icons now fill their circular
  badges (the icons' built-in circles match the badge size), use a softer
  white tint, and the delete badge matches the move buttons' size.

## [1.3.0]

### Added

- **Data export/import (backup & migration)**: full archive export as a ZIP
  (`GET /api/v1/export`) containing `hangar-export.json` + optional `photos/`
  originals, assembled via streaming temp files (no large in-memory buffers).
  `include_photos=0|1` toggles photos; `include_amap=0|1` produces an AES-256
  encrypted package (pyzipper) that additionally carries the amap key — the
  password is derived from a timestamp `.seed` filename inside the archive
  (salt + SHA256 → base64 → mid-16), never transmitted or logged. Requesting
  encryption on an instance without an amap key falls back to a plain package
  with an `X-Export-Note` header. The token is never exported; `geo_cache` is
  treated as derived data and excluded.
- **Chunked resumable import**: `POST /imports/chunk|complete` reuse the 1.2.1
  parallel chunk mechanism (1 MB chunks, 3-worker pool, byte progress,
  resume-on-missing) so 50–150 MB archives survive slow DERP links; `POST
  /imports` executes the import with `mode=replace` (wipe + rebuild, CHECK
  constraints regenerated from the archive's enums, all in one transaction) or
  `mode=merge` (per-id upsert, current enums untouched). Structural validation
  rejects the whole archive with a 400 error list and zero side effects;
  missing photos are recorded as `photos_missing` without failing the import.
  ZIP extraction is zip-slip safe (basename + extension whitelist).
- **WebUI**: an import/export icon button in the header toolbar (left of the
  theme picker) opens a menu; a reusable dialog component (`dialog.js`) carries
  the export options, import mode choice (with a hard confirmation gate for
  replace), and upload progress. An empty library imports directly in replace
  mode without confirmation. All new icons (backup/restore entry, photo delete,
  photo move up/down) are inlined SVGs — no external icon files.
- New dependency `pyzipper` (pulls `pycryptodome`).

## [1.2.1]

### Performance

- **Parallel chunk upload**: files are now split into 1 MB chunks (was 2 MB)
  and sent through a 3-worker pool per file, greatly improving throughput on
  high-latency (DERP) links. Files are still uploaded one at a time. A chunk
  that fails retries with the same 1s/2s/4s backoff; if it exhausts retries the
  file pauses while already-succeeded chunks are kept — resuming only re-sends
  the missing chunks (server-side idempotency). Progress text switched from
  chunk counters to aggregated bytes (`已传 x/y MB（z%）`, monotonic).

## [1.2.0]

### Added

- **Chunked resumable photo upload** for slow links: the WebUI now splits each
  file into 2 MB chunks (`POST /photos/chunk` + `POST /photos/complete`), with
  per-chunk retry (exponential backoff), text progress (`上传中 k/n · 块 i/c（xx%）`),
  pause-on-network-drop with in-session resume, and server-side merge that
  produces the same `M{id}_{n}.ext` naming and `photos` array semantics as the
  existing single-shot upload. The original `POST /photos` endpoint is kept
  unchanged for scripts / local curl uploads.
- **Photo reordering**: dedicated `PUT /photos/order` endpoint (validates the
  order is a permutation of the current array) plus up/down buttons on each
  detail-grid photo.
- **Photos array consistency**: every write path (`POST /models`,
  `PATCH /models/{id}`, reorder) now rejects entries whose files are missing
  on disk, malformed, or duplicated; startup logs orphaned photo files and
  garbage-collects upload temp sessions older than 24 h.

### Changed

- `crypto.randomUUID` is no longer required — a `crypto.getRandomValues`-based
  UUID fallback makes chunked uploads work over plain HTTP (insecure contexts).

## [1.1.1]

### Added

- **PWA support & site icon**: a web app manifest (`display: standalone`),
  favicon / apple-touch-icon set, and `theme-color` meta. Desktop browsers can
  now install Hangar as an app; mobile browsers require a secure context
  (HTTPS) for installation, so on plain-HTTP LAN deployments the manifest
  mainly serves icons there.

## [1.1.0]

### Added

- **Swipe-to-navigate lightbox** on touch screens: images now follow the finger
  while dragging, with rubber-band resistance and bounce-back at the first /
  last photo; neighbors are preloaded so slides never flash blank. Paging is no
  longer circular — reaching either end clamps and the nav arrows grey out.

### Changed

- **Frontend split into ES modules** (`core / list / form / detail / lightbox /
  main`): `app.js` (~950 lines) was broken apart by concern for maintainability.
  No behavior change beyond the items below.
- Detail view: the comment field renders as a full-width block (label on its own
  line, content below with line breaks preserved); the update timestamp is no
  longer displayed (the field remains in the API).
- Form buttons: desktop actions are right-aligned with Save on the far right and
  Cancel to its left; mobile stacks Save above Cancel.
- Lightbox: the image is strictly centered in the viewport with EXIF info
  pinned below; the GPS entry is now a single tappable address/coordinate link
  (the "位置" / "在地图查看" labels were removed).
- Detail modal scrollbars now follow the light / dark theme.
- Smaller upload and delete controls in the mobile photo gallery.

### Fixed

- Thumbnails ignored EXIF orientation and produced rotated images. Generation
  now applies `exif_transpose` before scaling; the disk cache is versioned
  (`.thumb-v2.jpg`) and the client URL carries `?v=2` so stale caches are
  bypassed.
- Lightbox slide-in direction was reversed after a swipe (the new image entered
  from the side the old one exited); a forced style flush before the slide-in
  transition fixes it.

## [1.0.1]

### Added

- **On-demand photo thumbnails** (`GET /thumbs/{filename}`): list rows and the
  detail gallery now load lazily-generated 400px JPEG thumbnails instead of full
  originals, cutting page weight and browser decode cost. Thumbnails are cached
  on disk (default `<DATA_DIR>/thumbs`, on the named volume), generated on first
  request, and removed when a photo is deleted. GIFs keep their animation and
  fall back to the original; any generation error falls back to the original so
  images never break. The full-screen lightbox still shows the original.

## [1.0.0]

First open-source release. MVP: functional but not polished.

### Added

- **First-run setup wizard** (`/setup`): choose the login token (with random
  generation), define hard enums (category / status), fill soft-enum suggestions
  (grade / limited / origin / storage / owner), and set an optional Amap key.
  Token is written to `token.txt` for recovery via `cat /data/token.txt`.
- **Persistent configuration** in a single-row JSON `settings` table (atomic
  writes, no half-initialized state); runtime config cached in memory.
- **`GET /api/v1/status`** reports whether the instance is initialized.
- **Legacy env-bootstrap**: setting `API_TOKEN` skips the wizard and uses the
  built-in default enums, preserving existing deployments.
- **Dynamic CHECK constraints**: the `models` table's category / status
  constraints are generated from the setup-time enum configuration.
- **Done date field** (`done_date`) per record, shown in the list/card and
  detail view (not used for filtering).
- **Date inputs** normalized to `YYYY-MM-DD` with auto-inserted separators and
  auto-advance to the next field.
- **Tags**: up to 3 per record, colored badges, exact-match filter, suggestions.
- **Grade logos** for common gunpla grades in list and detail views.
- **Photo EXIF metadata** endpoint + full-screen lightbox showing capture time,
  device, exposure, aperture, focal length, ISO, and GPS.
- **GPS → address** via Amap reverse geocoding (WGS-84 → GCJ-02 conversion
  built in) with a persistent local cache; falls back to raw coordinates when
  no key is configured.
- **Responsive layout**: desktop table / mobile card views with an auto breakpoint.
- **Light / dark theme** picker that follows system preference.
- **Version footer** displayed on the page.

### Changed

- Detail view is now a modal dialog; its title shows the record name.
- Detail-view upload button becomes icon-only on small screens.
- List/card column switched from purchase date to done date.
- Owner field default is now empty (was a hardcoded personal default).

### Fixed

- EXIF read crash on invalid GPS rationals (0/0, NaN).
- Mobile tag alignment in cards and form input overflow.
- Container port bound to IPv4 only.

### Security note

- Designed for **LAN / intranet deployment only**. The login token is stored in
  plaintext by design; reads are unauthenticated; no HTTPS / rate limiting /
  multi-user support. Do not expose to the public internet.

[1.1.0]: https://github.com/ffexis/hangar-project-release/releases/tag/v1.1.0
[1.0.0]: https://github.com/ffexis/hangar-project-release/releases/tag/v1.0.0
