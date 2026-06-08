# Changelog

## 2026-06-07

### Added
- Added BOM import and DigiKey lookup/export workflow for tab-delimited BOM input.
- Added direct Google Drive upload support for generated CSV output.
- Added Google Drive browser sign-in and Drive file picker support in the local preview app.
- Added DigiKey API credentials dialog that reads and writes live settings to `.env`.
- Added a progress bar that shows BOM line processing progress during lookup/export.
- Added input and output filename fields with browse actions and per-field Google Drive / local source selection.
- Added function-level purpose comments throughout `src/server.mjs` and architecture comments in the widget/server boundary code.

### Changed
- Switched DigiKey live auth to the 2-legged client-credentials token flow.
- Added 1-second pacing between live DigiKey API requests.
- Changed export output from TSV to CSV.
- Changed the default export filename to `Digikey costed BOM YYYY-MM-DD.csv`.
- Simplified the control panel UI to the lighter single-panel layout.
- Changed the main action label from `Lookup and export` to `Start`.

### DigiKey Parsing
- Improved keyword-search candidate parsing to inspect the full response instead of stopping at the first array.
- Added support for `ExactMatches` so exact manufacturer part number matches can outrank earlier near matches.
- Improved candidate scoring so exact `ManufacturerProductNumber` matches win over close family variants.
- Improved price extraction for exact matches by preferring `StandardPricing` rows with `BreakQuantity = 1`.
- Added best-effort active-product pricing fallback across available pricing fields before declaring price unavailable.
- Added support for decoding stock from both product-level and variation-level quantity fields.
- Preserved `ProductStatus.Status` exactly as returned by DigiKey.

### Output
- Added `Quantity Available` and `Product Status` to the export.
- Removed `Product Status Id` from the export.

### Debugging
- Added `debug.log` generation for DigiKey request/response tracing per BOM run.
- Updated local DigiKey skill documentation to capture the current parsing and pricing rules.

### Fixed
- Fixed Google Drive upload flow so the app can upload successfully from the local environment.
- Fixed local preview initialization so missing `notifications/initialized` support no longer breaks the app.
- Fixed the `TSW-110-07-G-S` exact-match pricing case by selecting the exact DigiKey match from the full response.
- Restored the simplified control panel, progress bar, DigiKey parser fixes, and CSV/export behavior after an accidental rollback.
