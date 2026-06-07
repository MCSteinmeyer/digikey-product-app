import http from 'node:http';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const WIDGET_URI = 'ui://bom-quote-widget/v1/index.html';
const WIDGET_HTML = readFileSync(new URL('./widget.html', import.meta.url), 'utf8');
const ENV_URL = new URL('../.env', import.meta.url);
const GOOGLE_DRIVE_SESSION_URL = new URL('../.google-drive-session.json', import.meta.url);
const DEBUG_LOG_URL = new URL('../debug.log', import.meta.url);
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
let digikeyRequestChain = Promise.resolve();
let digikeyTokenCache = null;
const googleDriveAuthStates = new Map();
let lookupProgressState = createLookupProgressState();

loadDotEnv();

const server = new McpServer(
  {
    name: 'digikey-product-app',
    version: '0.2.0'
  },
  {
    instructions:
      'Use the BOM quote tool to paste a tab-delimited BOM, look up DigiKey stock and price for each line, and export a Drive-ready CSV. Use the query tools for ad hoc lookup. Treat tool results as read-only unless explicitly uploading a file to Google Drive.'
  }
);

server.registerResource(
  'bom-quote-widget',
  WIDGET_URI,
  {
    title: 'BOM Quote Widget',
    description: 'Paste a tab-delimited BOM, choose an output filename, and export DigiKey stock and pricing results.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        csp: {
          connectDomains: ['https://api.digikey.com', 'https://www.googleapis.com'],
          resourceDomains: []
        },
        prefersBorder: true
      },
      'openai/widgetDescription':
        'Paste a tab-delimited BOM, choose an output filename, and export a DigiKey quote as a CSV that can be uploaded to Google Drive.'
    }
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/html;profile=mcp-app',
        text: WIDGET_HTML
      }
    ]
  })
);

server.registerTool(
  'bom.lookup_and_export',
  {
    title: 'Lookup BOM and Export Quote',
    description:
      'Use this when you have a tab-delimited BOM and want DigiKey stock and price lookup for each row plus an export file name for Google Drive.',
    inputSchema: z.object({
      bomText: z.string().min(1).describe('Tab-delimited BOM text including a header row.'),
      outputFilename: z.string().min(1).describe('Output filename for the exported CSV file.'),
      lookupLimit: z.number().int().min(1).max(10).default(5).describe('Maximum number of DigiKey search hits to inspect per BOM row.')
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true
    },
    _meta: {
      'openai/outputTemplate': WIDGET_URI,
      ui: {
        resourceUri: WIDGET_URI,
        prefersBorder: true
      }
    }
  },
  async ({ bomText, outputFilename, lookupLimit }) => {
    resetDebugLog();
    const rows = parseBomText(bomText);
    const preparedRows = [];
    lookupProgressState = {
      active: true,
      totalRows: rows.length,
      completedRows: 0,
      currentItem: rows[0]?.item ?? '',
      currentManufacturerPartNumber: rows[0]?.manufacturerPartNumber ?? '',
      startedAt: new Date().toISOString(),
      finishedAt: null
    };

    try {
      for (const row of rows) {
        lookupProgressState.currentItem = row.item ?? '';
        lookupProgressState.currentManufacturerPartNumber = row.manufacturerPartNumber ?? '';
        const result = await lookupBomRow(row, lookupLimit);
        preparedRows.push(result);
        lookupProgressState.completedRows = preparedRows.length;
      }

      const exportText = buildExportCsv(preparedRows);
      const normalizedFilename = normalizeOutputFilename(outputFilename);
      const driveUpload = await uploadToGoogleDriveIfConfigured(normalizedFilename, exportText);
      lookupProgressState = {
        ...lookupProgressState,
        active: false,
        completedRows: preparedRows.length,
        finishedAt: new Date().toISOString()
      };

      const summaryLines = [
        `Processed ${preparedRows.length} BOM rows.`,
        driveUpload.status === 'uploaded'
          ? `Uploaded to Google Drive as ${driveUpload.file?.name ?? normalizedFilename}.`
          : driveUpload.status === 'not_configured'
            ? 'Google Drive upload is not configured, so the export was prepared locally.'
            : `Google Drive upload failed: ${driveUpload.error ?? 'unknown error'}.`
      ];

      return {
        content: [
          {
            type: 'text',
            text: summaryLines.join('\n')
          }
        ],
        structuredContent: {
          kind: 'bom_quote_export',
          outputFilename: normalizedFilename,
          rowCount: preparedRows.length,
          rows: preparedRows,
          exportText,
          driveUpload
        }
      };
    } catch (error) {
      lookupProgressState = {
        ...lookupProgressState,
        active: false,
        finishedAt: new Date().toISOString()
      };
      throw error;
    }
  }
);

server.registerTool(
  'digikey.search_keywords',
  {
    title: 'Search DigiKey Keywords',
    description:
      'Use this when you need to search DigiKey by keyword, manufacturer part number, DigiKey part number, manufacturer name, or description.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search text or part number to send to DigiKey.'),
      limit: z.number().int().min(1).max(20).default(10).describe('Maximum number of products to return.'),
      manufacturerIds: z.array(z.string()).optional().describe('Optional DigiKey manufacturer IDs to restrict the search.'),
      categoryIds: z.array(z.string()).optional().describe('Optional DigiKey category IDs to restrict the search.')
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true
    }
  },
  async ({ query, limit, manufacturerIds, categoryIds }) => {
    const data = await fetchDigiKey('POST', '/products/v4/search/keyword', {
      Keywords: query,
      RecordCount: limit,
      ManufacturerIds: manufacturerIds,
      CategoryIds: categoryIds
    });

    const items = extractProductItems(data).slice(0, limit);
    const summary = items.map(formatProductSummary);

    return {
      content: [
        {
          type: 'text',
          text: renderSummary('DigiKey keyword search', query, summary, data)
        }
      ],
      structuredContent: {
        kind: 'search_keywords',
        request: {
          query,
          limit,
          manufacturerIds: manufacturerIds ?? [],
          categoryIds: categoryIds ?? []
        },
        count: items.length,
        items: summary,
        raw: data
      }
    };
  }
);

server.registerTool(
  'digikey.get_product_details',
  {
    title: 'Get DigiKey Product Details',
    description:
      'Use this when you already have a DigiKey product number and need expanded product details for that single item.',
    inputSchema: z.object({
      productNumber: z.string().min(1).describe('DigiKey product number or manufacturer part number.'),
      localeLanguage: z.string().optional().describe('Override the locale language code for this request.'),
      localeCurrency: z.string().optional().describe('Override the locale currency code for this request.'),
      localeSite: z.string().optional().describe('Override the locale site code for this request.')
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true
    }
  },
  async ({ productNumber, localeLanguage, localeCurrency, localeSite }) => {
    const data = await fetchDigiKey('GET', `/products/v4/search/${encodeURIComponent(productNumber)}/productdetails`, null, {
      localeLanguage,
      localeCurrency,
      localeSite,
      accountId: readEnv('DIGIKEY_ACCOUNT_ID', '').trim()
    });

    const details = extractBestObject(data);

    return {
      content: [
        {
          type: 'text',
          text: renderDetails('DigiKey product details', productNumber, details, data)
        }
      ],
      structuredContent: {
        kind: 'product_details',
        productNumber,
        details,
        raw: data
      }
    };
  }
);

server.registerTool(
  'digikey.get_product_pricing',
  {
    title: 'Get DigiKey Pricing',
    description:
      'Use this when you already have a DigiKey product number and need pricing for that product, optionally filtered by quantity or stock preferences.',
    inputSchema: z.object({
      productNumber: z.string().min(1).describe('DigiKey product number or manufacturer part number.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum number of pricing rows to return.'),
      offset: z.number().int().min(0).optional().describe('Number of pricing rows to skip before collecting results.'),
      inStock: z.boolean().optional().describe('Prefer in-stock pricing if the API supports it.'),
      excludeMarketplace: z.boolean().optional().describe('Exclude marketplace pricing if the API supports it.'),
      excludeTariff: z.boolean().optional().describe('Exclude tariff pricing if the API supports it.'),
      localeLanguage: z.string().optional().describe('Override the locale language code for this request.'),
      localeCurrency: z.string().optional().describe('Override the locale currency code for this request.'),
      localeSite: z.string().optional().describe('Override the locale site code for this request.')
    }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true
    }
  },
  async ({ productNumber, limit, offset, inStock, excludeMarketplace, excludeTariff, localeLanguage, localeCurrency, localeSite }) => {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', String(limit));
    if (offset !== undefined) query.set('offset', String(offset));
    if (inStock !== undefined) query.set('inStock', String(inStock));
    if (excludeMarketplace !== undefined) query.set('excludeMarketplace', String(excludeMarketplace));
    if (excludeTariff !== undefined) query.set('excludeTariff', String(excludeTariff));

    const data = await fetchDigiKey(
      'GET',
      `/products/v4/search/${encodeURIComponent(productNumber)}/pricing${query.size ? `?${query}` : ''}`,
      null,
      {
        localeLanguage,
        localeCurrency,
        localeSite,
        accountId: readEnv('DIGIKEY_ACCOUNT_ID', '').trim()
      }
    );

    const pricing = extractPricingRows(data).slice(0, limit ?? 10);

    return {
      content: [
        {
          type: 'text',
          text: renderPricing('DigiKey pricing', productNumber, pricing, data)
        }
      ],
      structuredContent: {
        kind: 'product_pricing',
        productNumber,
        count: pricing.length,
        pricing,
        raw: data
      }
    };
  }
);

async function lookupBomRow(row, lookupLimit) {
  const lookupQuery = String(row.manufacturerPartNumber || '').trim();
  const searchRequestBody = {
    Keywords: lookupQuery,
    RecordCount: lookupLimit,
    ManufacturerIds: [],
    CategoryIds: []
  };
  const debugSearchRequestText = stringifyDebugPayload({
    method: 'POST',
    path: '/products/v4/search/keyword',
    body: searchRequestBody
  });
  const searchResponse = lookupQuery
    ? await fetchDigiKey('POST', '/products/v4/search/keyword', searchRequestBody)
    : { results: [] };

  const candidates = extractProductItems(searchResponse);
  const selected = chooseBestCandidate(candidates, row);
  const matchedPartNumber = extractDigiKeyProductNumber(selected) || '';
  const matchedManufacturerPartNumber = firstText(selected, [
    'manufacturerProductNumber',
    'ManufacturerProductNumber',
    'manufacturerPartNumber',
    'ManufacturerPartNumber'
  ]) || '';
  const exactManufacturerPartMatch =
    String(matchedManufacturerPartNumber || '').trim().toLowerCase() === String(lookupQuery || '').trim().toLowerCase();

  const details = matchedPartNumber
    ? await fetchDigiKey('GET', `/products/v4/search/${encodeURIComponent(matchedPartNumber)}/productdetails`, null, {
        accountId: readEnv('DIGIKEY_ACCOUNT_ID', '').trim()
      })
    : {};
  const pricing = matchedPartNumber
    ? await fetchDigiKey('GET', `/products/v4/search/${encodeURIComponent(matchedPartNumber)}/pricing`, null, {
        accountId: readEnv('DIGIKEY_ACCOUNT_ID', '').trim()
      })
    : {};
  const selectedPricingRows = extractPricingRows(selected);
  const remotePricingRows = extractPricingRows(pricing);
  const productStatusInfo = extractProductStatusInfo(selected, details);
  const pricingRows = remotePricingRows.length ? remotePricingRows : selectedPricingRows;
  const pricingSelection = resolvePricingSelection({
    exactManufacturerPartMatch,
    selected,
    details,
    pricing,
    selectedPricingRows,
    remotePricingRows,
    qty: row.qty,
    productStatusInfo
  });
  const selectedTier = pricingSelection.selectedTier;
  const stock = extractStock(selectedTier, selected, details, searchResponse, pricing);
  const quantityAvailable = extractQuantityAvailable(selectedTier, selected, details, pricing);
  const unitPrice = pricingSelection.unitPrice;
  const currency = pricingSelection.currency;
  const extendedPrice = isFiniteNumber(unitPrice) && Number.isFinite(row.qty) ? Number(unitPrice) * row.qty : '';
  const notes = buildLookupNotes(row, selected, details, pricingRows, stock, unitPrice, productStatusInfo);
  const lookupStatus = matchedPartNumber || exactManufacturerPartMatch ? 'matched' : 'not_found';

  appendDebugLog({
    item: row.item,
    manufacturerPartNumber: row.manufacturerPartNumber,
    lookupStatus,
    query: debugSearchRequestText,
    responseText: stringifyDebugPayload(searchResponse)
  });

  return {
    item: row.item,
    referenceDesignators: row.referenceDesignators,
    qty: row.qty,
    manufacturer: row.manufacturer,
    manufacturerPartNumber: row.manufacturerPartNumber,
    description: row.description,
    package: row.package,
    matchedDigiKeyPartNumber: matchedPartNumber,
    matchedManufacturerPartNumber,
    stock,
    quantityAvailable,
      productStatus: productStatusInfo.status,
    unitPrice: unitPrice ?? '',
    extendedPrice,
    currency,
    lookupStatus,
    notes,
    searchResults: candidates.slice(0, lookupLimit).map(formatProductSummary),
    lastQueryString: debugSearchRequestText,
    lastQueryResponseText: matchedPartNumber ? '' : stringifyDebugPayload(searchResponse)
  };
}

function stringifyDebugPayload(payload) {
  try {
    return JSON.stringify(payload ?? null, null, 2);
  } catch {
    return String(payload);
  }
}

function appendDebugLog({ item, manufacturerPartNumber, lookupStatus, query, responseText }) {
  const lines = [
    `=== ${new Date().toISOString()} ===`,
    `Item: ${item || ''}`,
    `Manufacturer Part Number: ${manufacturerPartNumber || ''}`,
    `Lookup Status: ${lookupStatus || ''}`,
    `Query: ${query || ''}`,
    '----- DIGIKEY RESPONSE -----',
    responseText || '',
    ''
  ];

  appendFileSync(DEBUG_LOG_URL, `${lines.join('\n')}\n`, 'utf8');
}

function resetDebugLog() {
  writeFileSync(DEBUG_LOG_URL, '', 'utf8');
}

async function uploadToGoogleDriveIfConfigured(filename, content) {
  const token = await getGoogleDriveAccessToken();
  const folderId = readEnv('GOOGLE_DRIVE_FOLDER_ID', '').trim();

  if (!token) {
    return {
      status: 'not_configured'
    };
  }

  const boundary = `boundary-${randomUUID()}`;
  const metadata = {
    name: filename,
    mimeType: 'text/csv'
  };

  if (folderId) {
    metadata.parents = [folderId];
  }

  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/csv; charset=UTF-8',
    '',
    content,
    `--${boundary}--`,
    ''
  ].join('\r\n');

  let response;
  try {
    response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });
  } catch (error) {
    return {
      status: 'error',
      error: `Google Drive request failed before HTTP response: ${describeError(error)}`
    };
  }

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text if Drive returns HTML or plain text.
  }

  if (!response.ok) {
    return {
      status: 'error',
      error: `Google Drive upload failed with HTTP ${response.status} ${response.statusText}`,
      body: parsed
    };
  }

  return {
    status: 'uploaded',
    file: parsed
  };
}

async function getGoogleDriveAccessToken() {
  const session = readGoogleDriveSession();
  const directToken = readEnv('GOOGLE_DRIVE_ACCESS_TOKEN', '').trim();
  const refreshToken = readEnv('GOOGLE_REFRESH_TOKEN', '').trim();
  const clientId = readEnv('GOOGLE_CLIENT_ID', '').trim();
  const clientSecret = readEnv('GOOGLE_CLIENT_SECRET', '').trim();

  if (session?.refreshToken && clientId && clientSecret) {
    try {
      return await refreshGoogleDriveAccessToken({
        clientId,
        clientSecret,
        refreshToken: session.refreshToken,
        persistSession: true,
        priorSession: session
      });
    } catch {
      // Fall through to env-based credentials when the saved session is stale.
    }
  }

  if (refreshToken && clientId && clientSecret) {
    try {
      return await refreshGoogleDriveAccessToken({
        clientId,
        clientSecret,
        refreshToken,
        persistSession: false
      });
    } catch (error) {
      if (directToken) {
        return directToken;
      }
      throw error;
    }
  }

  if (directToken) {
    return directToken;
  }

  return '';
}

async function listGoogleDriveImportFiles(searchQuery = '') {
  const token = await getGoogleDriveAccessToken();
  if (!token) {
    throw new Error('Google Drive is not connected.');
  }

  const q = buildGoogleDriveImportQuery(searchQuery);
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size,webViewLink)');
  url.searchParams.set('pageSize', '25');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('q', q);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');

  const { response, parsed } = await fetchGoogleDriveJson(url, token);
  if (!response.ok) {
    throw new Error(`Google Drive file list failed with HTTP ${response.status} ${response.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }

  return Array.isArray(parsed?.files) ? parsed.files : [];
}

async function readGoogleDriveImportFile(fileId) {
  const token = await getGoogleDriveAccessToken();
  if (!token) {
    throw new Error('Google Drive is not connected.');
  }

  const metadataUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  metadataUrl.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size');
  metadataUrl.searchParams.set('supportsAllDrives', 'true');
  const metadataResult = await fetchGoogleDriveJson(metadataUrl, token);
  if (!metadataResult.response.ok) {
    throw new Error(`Google Drive metadata fetch failed with HTTP ${metadataResult.response.status} ${metadataResult.response.statusText}: ${typeof metadataResult.parsed === 'string' ? metadataResult.parsed : JSON.stringify(metadataResult.parsed)}`);
  }

  const metadata = metadataResult.parsed ?? {};
  const mimeType = String(metadata?.mimeType ?? '').trim();
  const name = String(metadata?.name ?? '').trim() || 'Imported BOM';
  let contentUrl;

  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    contentUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
    contentUrl.searchParams.set('mimeType', 'text/tab-separated-values');
  } else if (isImportableDriveMimeType(mimeType)) {
    contentUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    contentUrl.searchParams.set('alt', 'media');
    contentUrl.searchParams.set('supportsAllDrives', 'true');
  } else {
    throw new Error(`Unsupported Drive file type for BOM import: ${mimeType || 'unknown type'}. Use a plain text, CSV, TSV, or Google Sheets file.`);
  }

  const contentResponse = await fetch(contentUrl, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const text = await contentResponse.text();
  if (!contentResponse.ok) {
    throw new Error(`Google Drive file download failed with HTTP ${contentResponse.status} ${contentResponse.statusText}: ${text}`);
  }

  return {
    id: String(metadata?.id ?? fileId),
    name,
    mimeType,
    text
  };
}

async function fetchGoogleDriveJson(url, token) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
  } catch (error) {
    throw new Error(`Google Drive request failed before HTTP response: ${describeError(error)}`);
  }

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text for non-JSON error payloads.
  }

  return { response, parsed, text };
}

function buildGoogleDriveImportQuery(searchQuery = '') {
  const clauses = [
    'trashed = false',
    "mimeType != 'application/vnd.google-apps.folder'",
    "(" + [
      "mimeType = 'text/plain'",
      "mimeType = 'text/csv'",
      "mimeType = 'text/tab-separated-values'",
      "mimeType = 'application/vnd.google-apps.spreadsheet'"
    ].join(' or ') + ")"
  ];

  const trimmed = String(searchQuery || '').trim();
  if (trimmed) {
    clauses.push(`name contains '${escapeGoogleDriveQueryValue(trimmed)}'`);
  }

  return clauses.join(' and ');
}

function escapeGoogleDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isImportableDriveMimeType(mimeType) {
  return [
    'text/plain',
    'text/csv',
    'text/tab-separated-values'
  ].includes(String(mimeType || '').trim());
}

async function refreshGoogleDriveAccessToken({ clientId, clientSecret, refreshToken, persistSession, priorSession = null }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  let response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
  } catch (error) {
    throw new Error(`Google token refresh failed before HTTP response: ${describeError(error)}`);
  }

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text when Google returns non-JSON.
  }

  if (!response.ok) {
    throw new Error(`Google token refresh failed with HTTP ${response.status} ${response.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }

  const accessToken = String(parsed?.access_token ?? '').trim();
  if (!accessToken) {
    throw new Error('Google token refresh response did not include an access_token.');
  }

  if (persistSession) {
    const expiresIn = Number(parsed?.expires_in);
    writeGoogleDriveSession({
      ...(priorSession ?? {}),
      refreshToken,
      accessToken,
      expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
      updatedAt: new Date().toISOString()
    });
  }

  return accessToken;
}

function readGoogleDriveSession() {
  try {
    const text = readFileSync(GOOGLE_DRIVE_SESSION_URL, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeGoogleDriveSession(session) {
  writeFileSync(GOOGLE_DRIVE_SESSION_URL, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

function clearGoogleDriveSession() {
  if (existsSync(GOOGLE_DRIVE_SESSION_URL)) {
    rmSync(GOOGLE_DRIVE_SESSION_URL);
  }
}

function getGoogleDriveStatus() {
  const session = readGoogleDriveSession();
  const envRefreshToken = readEnv('GOOGLE_REFRESH_TOKEN', '').trim();
  const envAccessToken = readEnv('GOOGLE_DRIVE_ACCESS_TOKEN', '').trim();
  const hasStoredSession = Boolean(session?.refreshToken || session?.accessToken);
  const hasEnvRefreshToken = Boolean(envRefreshToken);
  const hasEnvAccessToken = Boolean(envAccessToken);

  return {
    connected: hasStoredSession,
    ready: Boolean(hasStoredSession || hasEnvRefreshToken || hasEnvAccessToken),
    hasStoredSession,
    hasEnvRefreshToken,
    hasEnvAccessToken
  };
}

function buildGoogleDriveRedirectBase(req, port) {
  const configuredBase = readEnv('GOOGLE_OAUTH_REDIRECT_BASE_URL', '').trim();
  if (configuredBase) {
    return configuredBase.replace(/\/+$/, '');
  }

  const host = req.headers.host?.trim();
  if (host) {
    return `http://${host}`;
  }

  return `http://127.0.0.1:${port}`;
}

function renderGoogleAuthResultPage({ success, message }) {
  const safeMessage = JSON.stringify(message);
  const closeDelayMs = success ? 10000 : 1200;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Google Drive Sign-In</title>
  <style>
    body {
      font-family: "Segoe UI", system-ui, sans-serif;
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: linear-gradient(180deg, #0f172a 0%, #1e293b 100%);
      color: #e2e8f0;
    }
    main {
      width: min(92vw, 480px);
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35);
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; line-height: 1.55; }
  </style>
</head>
<body>
  <main>
    <h1>${success ? 'Google Drive connected' : 'Google Drive sign-in failed'}</h1>
    <p>${message}</p>
  </main>
  <script>
    const payload = { type: 'google-drive-auth-result', success: ${success ? 'true' : 'false'}, message: ${safeMessage} };
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, window.location.origin);
      }
    } catch {}
    setTimeout(() => window.close(), ${closeDelayMs});
  </script>
</body>
</html>`;
}

function parseBomText(bomText) {
  const lines = String(bomText)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = splitTabDelimitedLine(lines[0]).map(normalizeBomHeader);
  const rows = [];

  for (const line of lines.slice(1)) {
    const values = splitTabDelimitedLine(line);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = (values[index] ?? '').trim();
    });

    rows.push({
      item: row.item || '',
      referenceDesignators: row.referenceDesignators || '',
      qty: parseInteger(row.qty),
      manufacturer: row.manufacturer || '',
      manufacturerPartNumber: row.manufacturerPartNumber || '',
      description: row.description || '',
      package: row.package || ''
    });
  }

  return rows.filter((row) => row.manufacturerPartNumber || row.description || row.manufacturer);
}

function buildExportCsv(rows) {
  const headers = [
    'Item',
    'Reference Designators',
    'Qty',
    'Manufacturer',
    'Manufacturer Part Number',
    'Description',
    'Package',
    'Matched DigiKey Part Number',
    'Matched Manufacturer Part Number',
    'Stock',
    'Quantity Available',
    'Product Status',
    'Unit Price',
    'Extended Price',
    'Currency',
    'Lookup Status',
    'Notes'
  ];

  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(
      [
        row.item,
        row.referenceDesignators,
        row.qty,
        row.manufacturer,
        row.manufacturerPartNumber,
        row.description,
        row.package,
        row.matchedDigiKeyPartNumber,
        row.matchedManufacturerPartNumber,
        row.stock,
        row.quantityAvailable,
        row.productStatus,
        row.unitPrice,
        row.extendedPrice,
        row.currency,
        row.lookupStatus,
        row.notes
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  return lines.join('\r\n');
}

function normalizeOutputFilename(filename) {
  const trimmed = String(filename || '').trim();
  if (!trimmed) {
    return `Digikey costed BOM ${getDateCode()}.csv`;
  }
  const base = trimmed.replace(/\.[^.]+$/, '');
  return `${base}.csv`;
}

function getDateCode(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function chooseBestCandidate(candidates, row) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {};
  }

  const target = String(row.manufacturerPartNumber || '').trim().toLowerCase();
  if (!target) {
    return candidates[0] || {};
  }
  let bestCandidate = candidates[0] || {};
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const manufacturerPartNumber =
      firstText(candidate, ['manufacturerProductNumber', 'ManufacturerProductNumber', 'manufacturerPartNumber', 'ManufacturerPartNumber'])
        ?.trim()
        .toLowerCase() || '';
    const digiKeyPartNumber =
      firstText(candidate, ['productNumber', 'ProductNumber', 'digiKeyPartNumber', 'DigiKeyPartNumber'])?.trim().toLowerCase() || '';
    const haystack = [
      manufacturerPartNumber,
      digiKeyPartNumber,
      extractDigiKeyDescription(candidate)?.toLowerCase() || '',
      extractDigiKeyManufacturerName(candidate)?.toLowerCase() || ''
    ]
      .filter(Boolean)
      .join(' ');

    let score = 0;
    if (manufacturerPartNumber === target) score += 1000;
    if (digiKeyPartNumber === target) score += 900;
    if (manufacturerPartNumber.includes(target)) score += 120;
    if (haystack.includes(target)) score += 40;

    const breakOneTier = pickBreakQuantityOneTier(extractPricingRows(candidate));
    const breakOneUnitPrice = Number(firstValue(breakOneTier, ['unitPrice', 'UnitPrice', 'price', 'Price']));
    if (Number.isFinite(breakOneUnitPrice) && breakOneUnitPrice > 0) {
      score += 25;
    }

    const quantityAvailable = Number(extractQuantityAvailable(candidate));
    if (Number.isFinite(quantityAvailable) && quantityAvailable > 0) {
      score += 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function pickPricingTier(pricingRows, qty) {
  if (!Array.isArray(pricingRows) || pricingRows.length === 0) {
    return {};
  }

  const normalized = pricingRows
    .map((row) => ({
      row,
      breakQty: parseInteger(firstValue(row, ['quantity', 'Quantity', 'breakQuantity', 'BreakQuantity'])) || 1,
      unitPrice: Number(firstValue(row, ['unitPrice', 'UnitPrice', 'price', 'Price']))
    }))
    .filter((entry) => Number.isFinite(entry.unitPrice));

  if (normalized.length === 0) {
    return pricingRows[0] || {};
  }

  normalized.sort((a, b) => a.breakQty - b.breakQty);
  const targetQty = Number.isFinite(qty) && qty > 0 ? qty : 1;

  let chosen = normalized[0];
  for (const entry of normalized) {
    if (entry.breakQty <= targetQty) {
      chosen = entry;
    } else {
      break;
    }
  }

  return chosen.row;
}

function pickBreakQuantityOneTier(pricingRows) {
  if (!Array.isArray(pricingRows) || pricingRows.length === 0) {
    return {};
  }

  const exact = pricingRows.find((row) => {
    const breakQty = parseInteger(firstValue(row, ['breakQuantity', 'BreakQuantity', 'quantity', 'Quantity']));
    return breakQty === 1;
  });

  return exact || {};
}

function resolvePricingSelection({
  exactManufacturerPartMatch,
  selected,
  details,
  pricing,
  selectedPricingRows,
  remotePricingRows,
  qty,
  productStatusInfo
}) {
  const pricingRows = remotePricingRows.length ? remotePricingRows : selectedPricingRows;
  const candidates = [];

  if (exactManufacturerPartMatch) {
    candidates.push(pickBreakQuantityOneTier(selectedPricingRows));
    candidates.push(pickBreakQuantityOneTier(remotePricingRows));
  }

  candidates.push(pickPricingTier(pricingRows, qty));
  candidates.push(pickPricingTier(selectedPricingRows, qty));
  candidates.push(pickPricingTier(remotePricingRows, qty));

  const isActiveProduct = String(productStatusInfo?.status || '').trim().toLowerCase() === 'active';
  if (isActiveProduct) {
    candidates.push(selected);
    candidates.push(details);
    candidates.push(pricing);
  }

  candidates.push(selected);
  candidates.push(details);
  candidates.push(pricing);

  for (const candidate of candidates) {
    const unitPrice = firstValue(candidate, ['unitPrice', 'UnitPrice', 'price', 'Price']);
    if (isFiniteNumber(unitPrice) && Number(unitPrice) > 0) {
      return {
        selectedTier: candidate && typeof candidate === 'object' ? candidate : {},
        unitPrice,
        currency:
          firstText(candidate, ['currency', 'Currency']) ||
          firstText(details, ['currency', 'Currency']) ||
          firstText(selected, ['currency', 'Currency']) ||
          ''
      };
    }
  }

  return {
    selectedTier: candidates.find((candidate) => candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0) || {},
    unitPrice: '',
    currency:
      firstText(details, ['currency', 'Currency']) ||
      firstText(selected, ['currency', 'Currency']) ||
      ''
  };
}

function extractStock(...objects) {
  const keys = [
    'quantityAvailable',
    'QuantityAvailable',
    'availableQuantity',
    'AvailableQuantity',
    'quantityAvailableforPackageType',
    'QuantityAvailableforPackageType',
    'stock',
    'Stock',
    'availability',
    'Availability'
  ];

  for (const object of objects) {
    const value = firstValue(object, keys);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  return '';
}

function extractQuantityAvailable(...objects) {
  const value = extractStock(...objects);
  return value === '' ? '' : value;
}

function extractProductStatusInfo(...objects) {
  for (const object of objects) {
    const statusObject = firstValue(object, ['productStatus', 'ProductStatus']);
    if (statusObject && typeof statusObject === 'object') {
      return {
        id: firstValue(statusObject, ['id', 'Id']) ?? '',
        status: firstText(statusObject, ['status', 'Status']) ?? ''
      };
    }
  }

  return {
    id: '',
    status: ''
  };
}

function buildLookupNotes(row, selected, details, pricingRows, stock, unitPrice, productStatusInfo) {
  const notes = [];

  if (!row.manufacturerPartNumber) {
    notes.push('No manufacturer part number supplied.');
  }

  if (!selected || Object.keys(selected).length === 0) {
    notes.push('No DigiKey candidate matched cleanly.');
  }

  if (!pricingRows.length) {
    notes.push('No pricing rows returned.');
  }

  const statusText = String(productStatusInfo?.status || '').trim();
  const isActiveProduct = statusText.toLowerCase() === 'active';

  if (!isFiniteNumber(unitPrice)) {
    if (isActiveProduct) {
      notes.push('No unit price was found after checking the available pricing fields for this active product.');
    } else if (statusText) {
      notes.push(`No unit price was found. Product status is ${statusText}, which may explain the missing price.`);
    } else {
      notes.push('No unit price parsed from the pricing response.');
    }
  }

  if (stock === '') {
    notes.push('Stock quantity was not present in the available responses.');
  }

  const manufacturerName = firstText(details, ['manufacturerName', 'ManufacturerName', 'manufacturer']);
  if (manufacturerName) {
    notes.push(`Matched manufacturer: ${manufacturerName}.`);
  }

  return notes.join(' ');
}

function extractProductItems(data) {
  const arrays = [
    data?.exactMatches,
    data?.ExactMatches,
    data?.products,
    data?.Products,
    data?.results,
    data?.Results,
    data?.items,
    data?.Items,
    data?.data,
    Array.isArray(data) ? data : null
  ].filter(Array.isArray);

  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && !arrays.includes(value)) {
        arrays.push(value);
      }
    }
  }

  if (arrays.length === 0) {
    return [];
  }

  const seen = new Set();
  const combined = [];

  for (const array of arrays) {
    for (const candidate of array) {
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }

      const dedupeKey =
        [
          firstText(candidate, ['manufacturerProductNumber', 'ManufacturerProductNumber', 'manufacturerPartNumber', 'ManufacturerPartNumber']),
          extractDigiKeyProductNumber(candidate),
          firstText(candidate, ['productUrl', 'ProductUrl', 'url'])
        ]
          .filter(Boolean)
          .join('||') || JSON.stringify(candidate);

      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      combined.push(candidate);
    }
  }

  return combined;
}

function extractPricingRows(data) {
  const arrays = [
    data?.pricing,
    data?.Pricing,
    data?.results,
    data?.Results,
    data?.items,
    data?.Items,
    Array.isArray(data) ? data : null
  ].filter(Array.isArray);

  if (arrays.length > 0) {
    return arrays[0];
  }

  const variations = firstValue(data, ['productVariations', 'ProductVariations']);
  if (Array.isArray(variations) && variations.length > 0) {
    const rows = [];
    for (const variation of variations) {
      const standardPricing = firstValue(variation, ['standardPricing', 'StandardPricing']);
      if (!Array.isArray(standardPricing)) {
        continue;
      }

      for (const priceRow of standardPricing) {
        rows.push({
          quantity: firstValue(priceRow, ['breakQuantity', 'BreakQuantity', 'quantity', 'Quantity']),
          unitPrice: firstValue(priceRow, ['unitPrice', 'UnitPrice', 'price', 'Price']),
          extendedPrice: firstValue(priceRow, ['totalPrice', 'TotalPrice', 'extendedPrice', 'ExtendedPrice']),
          currency: firstValue(priceRow, ['currency', 'Currency']) ?? firstValue(data, ['searchLocaleUsed', 'SearchLocaleUsed'])?.Currency ?? '',
          quantityAvailableforPackageType: firstValue(variation, ['quantityAvailableforPackageType', 'QuantityAvailableforPackageType']),
          minimumOrderQuantity: firstValue(variation, ['minimumOrderQuantity', 'MinimumOrderQuantity']),
          digiKeyProductNumber: firstValue(variation, ['digiKeyProductNumber', 'DigiKeyProductNumber'])
        });
      }
    }

    if (rows.length > 0) {
      return rows;
    }
  }

  if (data && typeof data === 'object') {
    const nested = Object.values(data).find(Array.isArray);
    if (nested) return nested;
  }

  return [];
}

function extractBestObject(data) {
  if (Array.isArray(data)) {
    return data[0] ?? {};
  }

  if (data && typeof data === 'object') {
    const directCandidates = [
      data.product,
      data.Product,
      data.data,
      data.result,
      data.Result,
      data.details,
      data.Details
    ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));

    if (directCandidates.length > 0) {
      return directCandidates[0];
    }

    return data;
  }

  return {};
}

function formatProductSummary(product) {
  return {
    productNumber: extractDigiKeyProductNumber(product),
    manufacturerProductNumber: firstText(product, [
      'manufacturerProductNumber',
      'ManufacturerProductNumber',
      'manufacturerPartNumber',
      'ManufacturerPartNumber'
    ]),
    description: extractDigiKeyDescription(product),
    manufacturerName: extractDigiKeyManufacturerName(product),
    minimumOrderQuantity: firstValue(product, ['minimumOrderQuantity', 'MinimumOrderQuantity', 'moq']),
    productUrl: firstText(product, ['productUrl', 'ProductUrl', 'url'])
  };
}

function renderSummary(label, query, items, raw) {
  const lines = [`${label}: ${query}`, `Results: ${items.length}`];

  for (const item of items.slice(0, 10)) {
    lines.push(
      `- ${item.manufacturerName ?? 'unknown'} | ${item.productNumber ?? 'unknown'} | ${item.manufacturerProductNumber ?? 'n/a'} | ${item.description ?? 'n/a'}`
    );
  }

  if (items.length === 0) {
    lines.push('No item array was detected in the API response. The raw response is included in structuredContent.');
  }

  if (raw?.error) {
    lines.push(`API error: ${raw.error}`);
  }

  return lines.join('\n');
}

function renderDetails(label, productNumber, details, raw) {
  const lines = [
    `${label}: ${productNumber}`,
    `Manufacturer: ${extractDigiKeyManufacturerName(details) ?? 'n/a'}`,
    `Description: ${extractDigiKeyDescription(details) ?? 'n/a'}`,
    `MOQ: ${firstValue(details, ['minimumOrderQuantity', 'MinimumOrderQuantity', 'moq']) ?? 'n/a'}`
  ];

  if (raw?.error) {
    lines.push(`API error: ${raw.error}`);
  }

  return lines.join('\n');
}

function renderPricing(label, productNumber, pricing, raw) {
  const lines = [`${label}: ${productNumber}`, `Pricing rows: ${pricing.length}`];

  for (const row of pricing.slice(0, 10)) {
    lines.push(
      `- qty ${firstValue(row, ['quantity', 'Quantity']) ?? 'n/a'} | unit ${firstValue(row, ['unitPrice', 'UnitPrice']) ?? 'n/a'} | total ${firstValue(row, ['extendedPrice', 'ExtendedPrice']) ?? 'n/a'}`
    );
  }

  if (pricing.length === 0) {
    lines.push('No pricing array was detected in the API response. The raw response is included in structuredContent.');
  }

  if (raw?.error) {
    lines.push(`API error: ${raw.error}`);
  }

  return lines.join('\n');
}

function firstText(object, keys) {
  const value = firstValue(object, keys);
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    return extractDigiKeyDescription(value) ?? String(value);
  }
  return value == null ? undefined : String(value);
}

function firstValue(object, keys) {
  if (!object || typeof object !== 'object') return undefined;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined && object[key] !== null) {
      return object[key];
    }
  }

  return undefined;
}

function extractDigiKeyDescription(object) {
  if (!object || typeof object !== 'object') {
    return undefined;
  }

  const description = firstValue(object, ['description', 'Description']);
  if (typeof description === 'string') {
    return description;
  }

  if (description && typeof description === 'object') {
    const nested = firstText(description, ['ProductDescription', 'DetailedDescription', 'ShortDescription', 'LongDescription']);
    if (nested) {
      return nested;
    }
  }

  return firstText(object, ['productDescription', 'ProductDescription', 'detailedDescription', 'DetailedDescription']);
}

function extractDigiKeyProductNumber(object) {
  const direct = firstText(object, ['productNumber', 'ProductNumber', 'DigiKeyPartNumber', 'digiKeyPartNumber']);
  if (direct) {
    return direct;
  }

  const variations = firstValue(object, ['productVariations', 'ProductVariations']);
  if (Array.isArray(variations)) {
    for (const variation of variations) {
      const variationNumber = firstText(variation, ['digiKeyProductNumber', 'DigiKeyProductNumber', 'productNumber', 'ProductNumber']);
      if (variationNumber) {
        return variationNumber;
      }
    }
  }

  return undefined;
}

function extractDigiKeyManufacturerName(object) {
  if (!object || typeof object !== 'object') {
    return undefined;
  }

  const direct = firstText(object, ['manufacturerName', 'ManufacturerName', 'manufacturer']);
  if (direct) {
    return direct;
  }

  const nestedManufacturer = firstValue(object, ['Manufacturer', 'manufacturer']);
  if (nestedManufacturer && typeof nestedManufacturer === 'object') {
    return firstText(nestedManufacturer, ['Name', 'name', 'ManufacturerName', 'manufacturerName']);
  }

  return undefined;
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function describeError(error) {
  if (error instanceof Error) {
    const cause = error.cause && typeof error.cause === 'object' ? error.cause : null;
    const parts = [error.message];
    if (cause) {
      if (typeof cause.code === 'string') parts.push(`code=${cause.code}`);
      if (typeof cause.message === 'string' && cause.message !== error.message) parts.push(`cause=${cause.message}`);
    }
    return parts.join(' | ');
  }

  return String(error);
}

function splitTabDelimitedLine(line) {
  return String(line)
    .replace(/\r/g, '')
    .split('\t')
    .map((cell) => cell.trim());
}

function createLookupProgressState() {
  return {
    active: false,
    totalRows: 0,
    completedRows: 0,
    currentItem: '',
    currentManufacturerPartNumber: '',
    startedAt: null,
    finishedAt: null
  };
}

function normalizeBomHeader(header) {
  const normalized = String(header).trim().toLowerCase().replace(/\s+/g, ' ');

  switch (normalized) {
    case 'item':
      return 'item';
    case 'reference designators':
      return 'referenceDesignators';
    case 'qty':
    case 'quantity':
      return 'qty';
    case 'manufacturer':
      return 'manufacturer';
    case 'manufacturer part number':
      return 'manufacturerPartNumber';
    case 'description':
      return 'description';
    case 'package':
      return 'package';
    default:
      return normalized.replace(/[^a-z0-9]+([a-z0-9])/g, (_, char) => char.toUpperCase()).replace(/[^a-z0-9]/g, '');
  }
}

function escapeCsvCell(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function readEnv(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function getDigiKeySettings() {
  return {
    clientId: readEnv('DIGIKEY_CLIENT_ID', '').trim(),
    customerId: readEnv('DIGIKEY_CUSTOMER_ID', '0').trim() || '0',
    accountId: readEnv('DIGIKEY_ACCOUNT_ID', '').trim(),
    apiBaseUrl: readEnv('DIGIKEY_API_BASE_URL', 'https://api.digikey.com').trim(),
    demoMode: isDemoMode(),
    hasClientSecret: Boolean(readEnv('DIGIKEY_CLIENT_SECRET', '').trim())
  };
}

function updateEnvFile(updates) {
  let text = '';
  try {
    text = readFileSync(ENV_URL, 'utf8');
  } catch {
    text = '';
  }

  const lines = text ? text.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const nextLines = [];

  for (const line of lines) {
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      nextLines.push(line);
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!pending.has(key)) {
      nextLines.push(line);
      continue;
    }

    nextLines.push(`${key}=${pending.get(key) ?? ''}`);
    pending.delete(key);
  }

  for (const [key, value] of pending.entries()) {
    nextLines.push(`${key}=${value ?? ''}`);
  }

  const normalizedText = `${nextLines.join('\n').replace(/\n*$/, '')}\n`;
  writeFileSync(ENV_URL, normalizedText, 'utf8');

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value ?? '';
  }

  clearDigiKeyAccessTokenCache();
}

function loadDotEnv() {
  let text = '';
  try {
    text = readFileSync(ENV_URL, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

async function fetchDigiKey(method, path, body = null, overrides = {}) {
  if (isDemoMode()) {
    return mockResponse(method, path, body, overrides);
  }

  return scheduleDigiKeyRequest(() => fetchDigiKeyOnce(method, path, body, overrides));
}

async function fetchDigiKeyOnce(method, path, body = null, overrides = {}, retryOnAuthFailure = true) {
  const baseUrl = readEnv('DIGIKEY_API_BASE_URL', 'https://api.digikey.com').replace(/\/+$/, '');
  const clientId = readEnv('DIGIKEY_CLIENT_ID', '').trim();
  const language = overrides.localeLanguage ?? readEnv('DIGIKEY_LOCALE_LANGUAGE', 'en');
  const currency = overrides.localeCurrency ?? readEnv('DIGIKEY_LOCALE_CURRENCY', 'USD');
  const site = overrides.localeSite ?? readEnv('DIGIKEY_LOCALE_SITE', 'US');
  const customerId = overrides.customerId ?? (readEnv('DIGIKEY_CUSTOMER_ID', '0').trim() || '0');
  const accountId = overrides.accountId ?? readEnv('DIGIKEY_ACCOUNT_ID', '').trim();

  if (!clientId) {
    return {
      error: 'DIGIKEY_CLIENT_ID is required for live requests. Set MCP_ALLOW_DEMO=true to test without credentials.'
    };
  }

  const accessToken = await getDigiKeyAccessToken();
  if (!accessToken) {
    return {
      error:
        'DIGIKEY_CLIENT_SECRET is required for live DigiKey requests. The app now uses DigiKey client_credentials to obtain a bearer token.'
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-DIGIKEY-Client-Id': clientId,
    'X-DIGIKEY-Customer-Id': customerId,
    'X-DIGIKEY-Locale-Language': language,
    'X-DIGIKEY-Locale-Currency': currency,
    'X-DIGIKEY-Locale-Site': site,
    Authorization: `Bearer ${accessToken}`
  };

  if (accountId && (path.includes('/productdetails') || path.includes('/pricing'))) {
    headers['X-DIGIKEY-Account-Id'] = accountId;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text when the response is not JSON.
  }

  if (!response.ok) {
    const result = {
      error: `DigiKey API returned HTTP ${response.status} ${response.statusText}`,
      status: response.status,
      body: parsed
    };

    if (response.status === 401 && retryOnAuthFailure) {
      clearDigiKeyAccessTokenCache();
      return fetchDigiKeyOnce(method, path, body, overrides, false);
    }

    return result;
  }

  return parsed;
}

async function scheduleDigiKeyRequest(task) {
  const previous = digikeyRequestChain;
  let release;
  digikeyRequestChain = new Promise((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    await delay(1000);
    release();
  }
}

async function getDigiKeyAccessToken() {
  const cached = digikeyTokenCache;
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.accessToken;
  }

  const clientId = readEnv('DIGIKEY_CLIENT_ID', '').trim();
  const clientSecret = readEnv('DIGIKEY_CLIENT_SECRET', '').trim();
  if (!clientId || !clientSecret) {
    return '';
  }

  const baseUrl = readEnv('DIGIKEY_API_BASE_URL', 'https://api.digikey.com').replace(/\/+$/, '');
  const tokenUrl = new URL('/v1/oauth2/token', new URL(baseUrl).origin).toString();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials'
  });

  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
  } catch (error) {
    throw new Error(`DigiKey token request failed before HTTP response: ${describeError(error)}`);
  }

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text when DigiKey returns non-JSON.
  }

  if (!response.ok) {
    throw new Error(`DigiKey token request failed with HTTP ${response.status} ${response.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }

  const accessToken = String(parsed?.access_token ?? '').trim();
  const expiresIn = Number(parsed?.expires_in);
  if (!accessToken) {
    throw new Error('DigiKey token response did not include an access_token.');
  }

  const expiresAt = now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) * 1000 - 30_000;
  digikeyTokenCache = {
    accessToken,
    expiresAt: Math.max(expiresAt, now + 30_000)
  };

  return accessToken;
}

function clearDigiKeyAccessTokenCache() {
  digikeyTokenCache = null;
}

function isDemoMode() {
  const value = readEnv('MCP_ALLOW_DEMO', 'true').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockResponse(method, path, body, overrides) {
  if (path.includes('/productdetails')) {
    const productNumber = decodeURIComponent(path.split('/').at(-2) ?? 'unknown');
    return {
      productNumber,
      description: `Mock details for ${productNumber}`,
      manufacturerName: 'Demo Components',
      manufacturerProductNumber: productNumber,
      minimumOrderQuantity: 1,
      quantityAvailable: 1000,
      productUrl: `https://www.digikey.com/en/products/detail/demo/${encodeURIComponent(productNumber)}`
    };
  }

  if (path.includes('/pricing')) {
    const productNumber = decodeURIComponent(path.split('/').at(-2) ?? 'unknown');
    return {
      productNumber,
      pricing: [
        { quantity: 1, unitPrice: 1.23, extendedPrice: 1.23, currency: overrides.localeCurrency ?? 'USD' },
        { quantity: 10, unitPrice: 1.1, extendedPrice: 11.0, currency: overrides.localeCurrency ?? 'USD' }
      ]
    };
  }

  if (path.includes('/search/keyword')) {
    const query = typeof body?.Keywords === 'string' ? body.Keywords : 'demo';
    return {
      results: [
        {
          productNumber: `DK-${slugify(query)}-001`,
          manufacturerProductNumber: `MPN-${slugify(query)}-001`,
          description: `Mock search result for ${query}`,
          manufacturerName: 'Demo Components',
          minimumOrderQuantity: 1,
          quantityAvailable: 1000,
          productUrl: `https://www.digikey.com/en/products/detail/demo/${encodeURIComponent(query)}`
        },
        {
          productNumber: `DK-${slugify(query)}-002`,
          manufacturerProductNumber: `MPN-${slugify(query)}-002`,
          description: `Second mock search result for ${query}`,
          manufacturerName: 'Demo Components',
          minimumOrderQuantity: 5,
          quantityAvailable: 350,
          productUrl: `https://www.digikey.com/en/products/detail/demo/${encodeURIComponent(query)}-2`
        }
      ]
    };
  }

  return {};
}

function slugify(value) {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'demo'
  );
}

async function main() {
  const mode = (process.argv[2] ?? process.env.MCP_TRANSPORT ?? 'http').toLowerCase();

  if (mode === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const port = Number(readEnv('PORT', '3000'));
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`);

    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, mode: 'http' }));
      return;
    }

    if (req.url === '/preview') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(WIDGET_HTML);
      return;
    }

    if (requestUrl.pathname === '/auth/google/status') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getGoogleDriveStatus()));
      return;
    }

    if (requestUrl.pathname === '/lookup-progress') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(lookupProgressState));
      return;
    }

    if (requestUrl.pathname === '/auth/digikey/settings' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getDigiKeySettings()));
      return;
    }

    if (requestUrl.pathname === '/auth/digikey/settings' && req.method === 'POST') {
      let bodyText = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        bodyText += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = bodyText ? JSON.parse(bodyText) : {};
          const clientId = String(parsed.clientId ?? '').trim();
          const customerId = String(parsed.customerId ?? '0').trim() || '0';
          const accountId = String(parsed.accountId ?? '').trim();
          const apiBaseUrl = String(parsed.apiBaseUrl ?? 'https://api.digikey.com').trim() || 'https://api.digikey.com';
          const demoMode = Boolean(parsed.demoMode);
          const updates = {
            DIGIKEY_CLIENT_ID: clientId,
            DIGIKEY_CUSTOMER_ID: customerId,
            DIGIKEY_ACCOUNT_ID: accountId,
            DIGIKEY_API_BASE_URL: apiBaseUrl,
            MCP_ALLOW_DEMO: demoMode ? 'true' : 'false'
          };

          if (Object.prototype.hasOwnProperty.call(parsed, 'clientSecret')) {
            const clientSecret = String(parsed.clientSecret ?? '');
            if (clientSecret.trim()) {
              updates.DIGIKEY_CLIENT_SECRET = clientSecret.trim();
            }
          }

          updateEnvFile(updates);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, settings: getDigiKeySettings() }));
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    if (requestUrl.pathname === '/auth/google/disconnect') {
      clearGoogleDriveSession();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, status: getGoogleDriveStatus() }));
      return;
    }

    if (requestUrl.pathname === '/auth/google/files') {
      listGoogleDriveImportFiles(requestUrl.searchParams.get('q') ?? '')
        .then((files) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ files }));
        })
        .catch((error) => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }

    if (requestUrl.pathname === '/auth/google/file-content') {
      const fileId = requestUrl.searchParams.get('id') ?? '';
      if (!fileId.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'A Drive file id is required.' }));
        return;
      }

      readGoogleDriveImportFile(fileId)
        .then((file) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(file));
        })
        .catch((error) => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }

    if (requestUrl.pathname === '/auth/google/start') {
      const clientId = readEnv('GOOGLE_CLIENT_ID', '').trim();
      const clientSecret = readEnv('GOOGLE_CLIENT_SECRET', '').trim();
      if (!clientId || !clientSecret) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured before starting Google Drive sign-in.');
        return;
      }

      const state = randomUUID();
      const redirectBase = buildGoogleDriveRedirectBase(req, port);
      const redirectUri = `${redirectBase}/auth/google/callback`;
      googleDriveAuthStates.set(state, {
        redirectUri,
        createdAt: Date.now()
      });

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', GOOGLE_DRIVE_SCOPE);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('state', state);

      res.statusCode = 302;
      res.setHeader('Location', authUrl.toString());
      res.end();
      return;
    }

    if (requestUrl.pathname === '/auth/google/callback') {
      const state = requestUrl.searchParams.get('state') ?? '';
      const code = requestUrl.searchParams.get('code') ?? '';
      const error = requestUrl.searchParams.get('error') ?? '';
      const authState = googleDriveAuthStates.get(state);

      if (!authState) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderGoogleAuthResultPage({ success: false, message: 'The Google sign-in session could not be validated. Please start the sign-in flow again.' }));
        return;
      }

      googleDriveAuthStates.delete(state);

      if (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderGoogleAuthResultPage({ success: false, message: `Google returned an error: ${error}.` }));
        return;
      }

      const clientId = readEnv('GOOGLE_CLIENT_ID', '').trim();
      const clientSecret = readEnv('GOOGLE_CLIENT_SECRET', '').trim();
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: authState.redirectUri
      });

      fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      })
        .then(async (response) => {
          const text = await response.text();
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // Keep raw text for non-JSON Google responses.
          }

          if (!response.ok) {
            throw new Error(`Google token exchange failed with HTTP ${response.status} ${response.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
          }

          const refreshToken = String(parsed?.refresh_token ?? '').trim();
          const accessToken = String(parsed?.access_token ?? '').trim();
          const expiresIn = Number(parsed?.expires_in);

          if (!refreshToken && !readGoogleDriveSession()?.refreshToken) {
            throw new Error('Google did not return a refresh token. Make sure the OAuth client is configured for offline access and prompt=consent.');
          }

          writeGoogleDriveSession({
            refreshToken: refreshToken || readGoogleDriveSession()?.refreshToken || '',
            accessToken,
            expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
            updatedAt: new Date().toISOString()
          });

          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(renderGoogleAuthResultPage({ success: true, message: 'Google Drive access is ready. You can return to the BOM app and run the export again.' }));
        })
        .catch((exchangeError) => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(renderGoogleAuthResultPage({ success: false, message: exchangeError instanceof Error ? exchangeError.message : String(exchangeError) }));
        });
      return;
    }

    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    transport.handleRequest(req, res).catch((error) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`DigiKey MCP server listening on http://127.0.0.1:${port}/mcp`);
  });

  const shutdown = async () => {
    await transport.close().catch(() => {});
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
