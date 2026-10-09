# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
