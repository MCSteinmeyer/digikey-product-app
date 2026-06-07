# DigiKey BOM Quote App

A ChatGPT app that imports a tab-delimited BOM, looks up stock and pricing through DigiKey Product Information V4, and exports a CSV file that can be uploaded directly to Google Drive.

## What it does

- `bom.lookup_and_export` parses the BOM, looks up each line item, and builds a Drive-ready CSV export.
- `digikey.search_keywords` searches DigiKey parts by keyword, part number, manufacturer, or description.
- `digikey.get_product_details` fetches expanded details for one DigiKey product number.
- `digikey.get_product_pricing` fetches pricing for one product number, with optional quantity filters.

The server supports two modes:

- `MCP_ALLOW_DEMO=true` returns mock results so you can test the app plumbing without DigiKey credentials.
- Real API mode obtains a DigiKey bearer token with `DIGIKEY_CLIENT_ID` + `DIGIKEY_CLIENT_SECRET` using the DigiKey 2-legged client-credentials flow.
- `DIGIKEY_CUSTOMER_ID` defaults to `0` and is sent on live requests with DigiKey's `X-DIGIKEY-Customer-Id` header.
- If DigiKey expects an account-scoped request, set `DIGIKEY_ACCOUNT_ID` so product details and pricing requests include `X-DIGIKEY-Account-Id`.
- Google Drive upload prefers `GOOGLE_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` when present, and falls back to `GOOGLE_DRIVE_ACCESS_TOKEN`.
- In the local preview, use the `Sign in to Google Drive` button to run Google OAuth in a popup and store a fresh refresh token locally for this app.
- `GOOGLE_OAUTH_REDIRECT_BASE_URL` is optional; use it if your Google OAuth client is configured for a specific host instead of the app's current local origin.
- `GOOGLE_DRIVE_FOLDER_ID` optionally targets a specific folder.
- If the filename field is left blank, the export defaults to `Digikey costed BOM YYYY-MM-DD.csv`.

## Why this shape

- Primary archetype: `interactive-decoupled`
- Reason: the app has a persistent widget, repeated lookup interactions, and a form-like workflow that should stay mounted while the tool runs.

## Current docs used

- [Apps SDK MCP server guide](https://developers.openai.com/apps-sdk/build/mcp-server)
- [Apps SDK ChatGPT UI guide](https://developers.openai.com/apps-sdk/build/chatgpt-ui)
- [Apps SDK tools guide](https://developers.openai.com/apps-sdk/plan/tools)
- [Apps SDK reference](https://developers.openai.com/apps-sdk/reference)
- [Apps SDK quickstart](https://developers.openai.com/apps-sdk/quickstart)
- [DigiKey ProductSearch portal](https://developer.digikey.com/products/product-information-v4/productsearch)
- [DigiKey KeywordSearch portal page](https://developer.digikey.com/products/product-information-v4/productsearch/keywordsearch)
- [Google Drive API upload files](https://developers.google.com/drive/api/guides/manage-uploads)

## File tree

- `package.json`
- `package-lock.json`
- `.env.example`
- `README.md`
- `src/server.mjs`
- `src/widget.html`

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and edit it. The server loads `.env` automatically on startup.

3. Run the server in HTTP mode:

   ```bash
   npm run start:http
   ```

4. Open the MCP endpoint at `http://localhost:3000/mcp`.

5. For a local browser preview of the widget, open `http://localhost:3000/preview`.
6. If you want browser-based Google Drive sign-in, add the callback URL `http://127.0.0.1:3000/auth/google/callback` or `http://localhost:3000/auth/google/callback` to your Google OAuth client, then click `Sign in to Google Drive` in the preview.

## ChatGPT developer mode

1. Expose the local server with an HTTPS tunnel.
2. In ChatGPT, enable Developer Mode.
3. Add a new app using the public `https://.../mcp` URL.
4. Refresh the app after changing tools or metadata.

## Validation

- `node --check src/server.mjs`

The BOM exporter is currently validated in demo mode. Google Drive upload is validated with the current Google OAuth credentials in `.env`.

## Next steps

1. Set `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET`, and optionally the Google Drive env vars.
2. Open `http://localhost:3000/preview` to test the BOM dialog and filename textbox locally.
3. Connect the app in ChatGPT Developer Mode with the tunneled `/mcp` URL.
