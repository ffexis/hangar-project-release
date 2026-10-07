# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/ffexis/hangar-project-release/releases/tag/v1.0.0
