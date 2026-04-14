const HELPER_URL = "http://127.0.0.1:9876";
const DEBUGGER_VERSION = "1.3";
const MUSIC_ORIGIN = "https://music.yandex.ru/";
const OVERRIDE_MEDIA_ORIGIN = "https://ym-local-override.invalid";
const OVERRIDE_MEDIA_PREFIX = `${OVERRIDE_MEDIA_ORIGIN}/media/`;
const FORCE_FULL_MEDIA_RESPONSE = true;
const FETCH_PATTERNS = [
  { urlPattern: "https://api.music.yandex.ru/get-file-info*", requestStage: "Response" },
  { urlPattern: "https://api.music.yandex.ru/get-file-info/batch*", requestStage: "Response" },
  { urlPattern: `${OVERRIDE_MEDIA_PREFIX}*`, requestStage: "Request" },
  { urlPattern: "https://*/*", requestStage: "Request" },
];
const pendingUploads = new Map();
const attachedTabs = new Set();
const attachedChildSessions = new Map();
const originalMediaOverrides = new Map();

let replacementCache = {
  fetchedAt: 0,
  items: new Map(),
};
const replacementMediaCache = new Map();
const debugState = {
  attachAttempts: [],
  pausedRequests: [],
  fulfilledRequests: [],
  continueRequests: [],
  registeredOverrides: [],
  seenMediaLikeRequests: [],
  apiPayloads: [],
  errors: [],
};

self.__ymLocalOverrideBackgroundDebug = {
  getAttachedTabs() {
    return Array.from(attachedTabs);
  },
  getReplacementKeys() {
    return Array.from(replacementCache.items.keys());
  },
  getState() {
    return {
      attachedTabs: Array.from(attachedTabs),
      replacementKeys: Array.from(replacementCache.items.keys()),
      mediaCacheKeys: Array.from(replacementMediaCache.keys()),
      originalMediaOverrides: Array.from(originalMediaOverrides.entries())
        .slice(-20)
        .map(([url, replacement]) => ({
          url,
          trackId: replacement && replacement.trackId ? replacement.trackId : null,
          storedName: replacement && replacement.storedName ? replacement.storedName : null,
        })),
      attachAttempts: debugState.attachAttempts.slice(-20),
      pausedRequests: debugState.pausedRequests.slice(-20),
      fulfilledRequests: debugState.fulfilledRequests.slice(-20),
      continueRequests: debugState.continueRequests.slice(-20),
      registeredOverrides: debugState.registeredOverrides.slice(-20),
      seenMediaLikeRequests: debugState.seenMediaLikeRequests.slice(-20),
      apiPayloads: debugState.apiPayloads.slice(-10),
      errors: debugState.errors.slice(-20),
    };
  },
  async refreshReplacements() {
    const items = await loadReplacementMap(true);
    return Array.from(items.keys());
  },
  resetState() {
    for (const key of Object.keys(debugState)) {
      if (Array.isArray(debugState[key])) {
        debugState[key] = [];
      }
    }
    originalMediaOverrides.clear();
    replacementMediaCache.clear();
    replacementCache.fetchedAt = 0;
  },
};

function pushDebugEvent(bucket, payload) {
  if (!Array.isArray(debugState[bucket])) {
    return;
  }
  debugState[bucket].push({
    at: Date.now(),
    ...payload,
  });
  if (debugState[bucket].length > 50) {
    debugState[bucket].splice(0, debugState[bucket].length - 50);
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    json,
  };
}

async function parseBinaryResponse(response) {
  const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    bytes,
  };
}

function decodeBase64(base64) {
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(value) {
  let binary = "";
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function encodeTextBase64(text) {
  return encodeBase64(new TextEncoder().encode(text));
}

function decodeTextBase64(value) {
  return new TextDecoder().decode(decodeBase64(value));
}

function normalizeUploadBytes(payload) {
  if (typeof payload.fileBase64 === "string" && payload.fileBase64) {
    return decodeBase64(payload.fileBase64);
  }

  if (Array.isArray(payload.bytes)) {
    return Uint8Array.from(payload.bytes);
  }

  if (typeof payload.bytes === "string" && payload.bytes.includes(",")) {
    const parts = payload.bytes.split(",").map((item) => Number(item.trim()));
    if (parts.length && parts.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      return Uint8Array.from(parts);
    }
  }

  if (payload.bytes instanceof ArrayBuffer) {
    return new Uint8Array(payload.bytes);
  }

  return new Uint8Array();
}

function randomUploadId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isMusicTabUrl(url) {
  return typeof url === "string" && url.startsWith(MUSIC_ORIGIN);
}

function parseTrackIdsFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const singleTrackId = parsed.searchParams.get("trackId");
    const batchTrackIds = parsed.searchParams.get("trackIds");
    if (singleTrackId) {
      return [String(singleTrackId)];
    }
    if (!batchTrackIds) {
      return [];
    }
    return batchTrackIds
      .split(",")
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

function normalizeStreamUrl(item) {
  const rawUrl = String(item.stream_url || "");
  if (!rawUrl) {
    return "";
  }
  const absoluteUrl = rawUrl.startsWith("http") ? rawUrl : `${HELPER_URL}${rawUrl}`;
  const separator = absoluteUrl.includes("?") ? "&" : "?";
  return item.stored_name
    ? `${absoluteUrl}${separator}v=${encodeURIComponent(String(item.stored_name))}`
    : absoluteUrl;
}

function buildOverrideMediaUrl(replacement) {
  return String(replacement.streamUrl || "");
}

function invalidateTrackCaches(trackId) {
  const key = String(trackId || "");
  if (!key) {
    replacementMediaCache.clear();
    originalMediaOverrides.clear();
    replacementCache.fetchedAt = 0;
    return;
  }

  for (const cacheKey of Array.from(replacementMediaCache.keys())) {
    if (cacheKey.startsWith(`${key}:`)) {
      replacementMediaCache.delete(cacheKey);
    }
  }

  for (const [url, replacement] of Array.from(originalMediaOverrides.entries())) {
    if (replacement && String(replacement.trackId || "") === key) {
      originalMediaOverrides.delete(url);
    }
  }

  replacementCache.fetchedAt = 0;
}

async function fetchReplacementMediaPayload(replacement) {
  if (!replacement || !replacement.trackId || !replacement.streamUrl) {
    return null;
  }

  const cacheKey = `${replacement.trackId}:${replacement.storedName || replacement.streamUrl}`;
  const cached = replacementMediaCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const mediaPath = replacement.streamUrl.replace(HELPER_URL, "");
  const response = await fetch(`${HELPER_URL}${mediaPath}`, { method: "GET" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const payload = {
    contentType: String(replacement.contentType || response.headers.get("content-type") || "audio/mpeg"),
    bytes,
  };
  replacementMediaCache.set(cacheKey, payload);
  return payload;
}

function guessCodec(contentType, fallbackCodec) {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("flac")) {
    return "flac";
  }
  if (normalized.includes("wav")) {
    return "wav";
  }
  if (normalized.includes("ogg")) {
    return "ogg";
  }
  if (normalized.includes("mp4") || normalized.includes("aac")) {
    return "aac-mp4";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return "mp3";
  }
  return fallbackCodec || "mp3";
}

function parseOverrideMediaUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!parsed.href.startsWith(OVERRIDE_MEDIA_PREFIX)) {
      return null;
    }
    const trackId = decodeURIComponent(parsed.pathname.slice("/media/".length));
    const storedName = parsed.searchParams.get("stored") || "";
    const contentType = parsed.searchParams.get("contentType") || "audio/mpeg";
    return { trackId, storedName, contentType };
  } catch (error) {
    return null;
  }
}

function normalizeUrlForMatch(url) {
  try {
    return new URL(String(url || "")).href;
  } catch (error) {
    return String(url || "");
  }
}

function buildMediaOverrideKeys(url) {
  try {
    const parsed = new URL(String(url || ""));
    const full = parsed.href;
    parsed.search = "";
    parsed.hash = "";
    const base = parsed.href;
    return Array.from(new Set([full, base].filter(Boolean)));
  } catch (error) {
    const value = String(url || "");
    const base = value.split("?")[0].split("#")[0];
    return Array.from(new Set([value, base].filter(Boolean)));
  }
}

function findOriginalMediaOverride(url) {
  const keys = buildMediaOverrideKeys(url);
  for (const key of keys) {
    const match = originalMediaOverrides.get(key);
    if (match) {
      return match;
    }
  }
  return null;
}

function getHeaderValue(headers, name) {
  if (!headers || typeof headers !== "object") {
    return "";
  }
  const targetName = String(name || "").toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (String(headerName || "").toLowerCase() === targetName) {
      return String(value || "");
    }
  }
  return "";
}

function buildRangeResponse(bytes, rangeHeader) {
  const totalLength = bytes.length;
  if (!rangeHeader || !/^bytes=\d*-\d*$/.test(rangeHeader)) {
    return {
      responseCode: 200,
      bytes,
      headers: [
        { name: "Accept-Ranges", value: "bytes" },
        { name: "Content-Length", value: String(totalLength) },
      ],
    };
  }

  const [, startRaw, endRaw] = rangeHeader.match(/^bytes=(\d*)-(\d*)$/) || [];
  let start = startRaw ? Number(startRaw) : 0;
  let end = endRaw ? Number(endRaw) : totalLength - 1;

  if (!Number.isFinite(start) || start < 0) {
    start = 0;
  }
  if (!Number.isFinite(end) || end >= totalLength) {
    end = totalLength - 1;
  }
  if (start > end || start >= totalLength) {
    return {
      responseCode: 416,
      bytes: new Uint8Array(),
      headers: [
        { name: "Accept-Ranges", value: "bytes" },
        { name: "Content-Range", value: `bytes */${totalLength}` },
        { name: "Content-Length", value: "0" },
      ],
    };
  }

  const slice = bytes.slice(start, end + 1);
  return {
    responseCode: 206,
    bytes: slice,
    headers: [
      { name: "Accept-Ranges", value: "bytes" },
      { name: "Content-Range", value: `bytes ${start}-${end}/${totalLength}` },
      { name: "Content-Length", value: String(slice.length) },
    ],
  };
}

async function fulfillOverrideMediaRequest(source, params) {
  const requestId = params && params.requestId;
  const requestUrl = params && params.request && params.request.url;
  const requestMethod = String(params && params.request && params.request.method || "GET").toUpperCase();
  const mediaInfo = parseOverrideMediaUrl(requestUrl);
  if (!requestId || !mediaInfo) {
    return false;
  }

  const replacements = await loadReplacementMap();
  const replacement = replacements.get(mediaInfo.trackId);
  if (!replacement) {
    await sendDebuggerCommand(source, "Fetch.fulfillRequest", {
      requestId,
      responseCode: 404,
      responseHeaders: [
        { name: "Content-Type", value: "text/plain; charset=utf-8" },
        { name: "Content-Length", value: "0" },
        { name: "Access-Control-Allow-Origin", value: "*" },
      ],
      body: "",
    });
    return true;
  }

  const payload = await fetchReplacementMediaPayload(replacement);
  if (!payload || !payload.bytes) {
    await sendDebuggerCommand(source, "Fetch.fulfillRequest", {
      requestId,
      responseCode: 404,
      responseHeaders: [
        { name: "Content-Type", value: "text/plain; charset=utf-8" },
        { name: "Content-Length", value: "0" },
        { name: "Access-Control-Allow-Origin", value: "*" },
      ],
      body: "",
    });
    return true;
  }

  const rangeHeader = getHeaderValue(params.request.headers, "Range");
  const rangeResponse = buildRangeResponse(payload.bytes, rangeHeader);
  const responseHeaders = [
    { name: "Content-Type", value: payload.contentType || mediaInfo.contentType || "audio/mpeg" },
    { name: "Cache-Control", value: "no-store" },
    { name: "Access-Control-Allow-Origin", value: "*" },
    ...rangeResponse.headers,
  ];

  await sendDebuggerCommand(source, "Fetch.fulfillRequest", {
    requestId,
    responseCode: rangeResponse.responseCode,
    responseHeaders,
    body: requestMethod === "HEAD" ? "" : encodeBase64(rangeResponse.bytes),
  });
  pushDebugEvent("fulfilledRequests", {
    tabId: source.tabId,
    requestId,
    url: requestUrl,
    trackIds: [mediaInfo.trackId],
    syntheticMedia: true,
    responseCode: rangeResponse.responseCode,
  });
  return true;
}

async function fulfillReplacementMediaRequest(source, params, replacement, requestUrl) {
  const requestId = params && params.requestId;
  const requestMethod = String(params && params.request && params.request.method || "GET").toUpperCase();
  if (!requestId || !replacement) {
    return false;
  }

  const payload = await fetchReplacementMediaPayload(replacement);
  if (!payload || !payload.bytes) {
    return false;
  }

  const rangeHeader = getHeaderValue(params.request.headers, "Range");
  const rangeResponse = FORCE_FULL_MEDIA_RESPONSE
    ? {
        responseCode: 200,
        bytes: payload.bytes,
        headers: [
          { name: "Accept-Ranges", value: "bytes" },
          { name: "Content-Length", value: String(payload.bytes.length) },
        ],
      }
    : buildRangeResponse(payload.bytes, rangeHeader);
  const responseHeaders = [
    { name: "Content-Type", value: payload.contentType || replacement.contentType || "audio/mpeg" },
    { name: "Cache-Control", value: "no-store" },
    { name: "Access-Control-Allow-Origin", value: "*" },
    ...rangeResponse.headers,
  ];
  if (FORCE_FULL_MEDIA_RESPONSE && rangeHeader) {
    responseHeaders.push({ name: "Content-Range", value: `bytes 0-${payload.bytes.length - 1}/${payload.bytes.length}` });
  }

  await sendDebuggerCommand(source, "Fetch.fulfillRequest", {
    requestId,
    responseCode: rangeResponse.responseCode,
    responseHeaders,
    body: requestMethod === "HEAD" ? "" : encodeBase64(rangeResponse.bytes),
  });
  pushDebugEvent("fulfilledRequests", {
    tabId: source.tabId,
    requestId,
    url: requestUrl,
    trackIds: [replacement.trackId],
    originalMedia: true,
    responseCode: rangeResponse.responseCode,
  });
  return true;
}

function registerOriginalMediaUrls(payload, replacements, requestUrl) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  const requestedTrackIds = parseTrackIdsFromUrl(requestUrl);
  const registerItem = (item) => {
    const trackId = item && item.trackId != null ? String(item.trackId) : (requestedTrackIds[0] || "");
    const replacement = replacements.get(trackId);
    if (!replacement) {
      return;
    }

    const urls = [];
    if (item && item.url) {
      urls.push(item.url);
    }
    if (Array.isArray(item && item.urls)) {
      urls.push(...item.urls);
    }

    for (const url of urls) {
      const keys = buildMediaOverrideKeys(url);
      if (!keys.length || keys[0].startsWith(OVERRIDE_MEDIA_PREFIX)) {
        continue;
      }
      for (const key of keys) {
        originalMediaOverrides.set(key, replacement);
        pushDebugEvent("registeredOverrides", {
          trackId,
          url: key,
          requestUrl,
          storedName: replacement.storedName || "",
        });
      }
    }
  };

  if (Array.isArray(payload.downloadInfos)) {
    for (const item of payload.downloadInfos) {
      registerItem(item);
    }
  }

  if (payload.downloadInfo && typeof payload.downloadInfo === "object") {
    registerItem(payload.downloadInfo);
  }
}

async function loadReplacementMap(force = false) {
  if (!force && Date.now() - replacementCache.fetchedAt < 3000) {
    return replacementCache.items;
  }

  const response = await fetch(`${HELPER_URL}/api/replacements`, {
    method: "GET",
  });
  const payload = await response.json();
  const items = new Map();

  for (const item of payload.items || []) {
    const streamUrl = normalizeStreamUrl(item);
    let fileSize = Number(item.file_size || 0);
    if (!fileSize && streamUrl) {
      try {
        const sizeProbe = await fetch(streamUrl, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
        });
        const contentRange = String(sizeProbe.headers.get("content-range") || "");
        const rangeMatch = contentRange.match(/\/(\d+)$/);
        fileSize = Number(
          (rangeMatch && rangeMatch[1])
          || sizeProbe.headers.get("content-length")
          || 0,
        );
      } catch (error) {
        fileSize = 0;
      }
    }
    items.set(String(item.track_id), {
      trackId: String(item.track_id),
      streamUrl,
      storedName: String(item.stored_name || ""),
      contentType: String(item.content_type || "audio/mpeg"),
      fileSize,
    });
  }

  replacementCache = {
    fetchedAt: Date.now(),
    items,
  };
  return items;
}

async function overrideGetFileInfoPayload(payload, replacements, requestUrl) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const requestedTrackIds = parseTrackIdsFromUrl(requestUrl);
  let changed = false;

  if (Array.isArray(payload.downloadInfos)) {
    const downloadInfos = [];
    for (const item of payload.downloadInfos) {
      const trackId = item && item.trackId != null ? String(item.trackId) : "";
      const candidateId = trackId || requestedTrackIds[0] || "";
      const replacement = replacements.get(candidateId);
      if (!candidateId || !replacement || !replacement.streamUrl) {
        downloadInfos.push(item);
        continue;
      }

      const originalUrls = [
        item && item.url ? String(item.url) : "",
        ...(Array.isArray(item && item.urls) ? item.urls.map((url) => String(url || "")) : []),
      ].filter(Boolean);
      const playableUrl = originalUrls[0] || buildOverrideMediaUrl(replacement);
      changed = true;
      downloadInfos.push({
        ...item,
        trackId: candidateId,
        realId: candidateId,
        codec: guessCodec(replacement.contentType, item && item.codec),
        transport: "raw",
        key: "",
        size: replacement.fileSize || Number(item.size || 0) || 0,
        url: playableUrl,
        urls: originalUrls.length ? originalUrls : [playableUrl],
      });
    }

    return changed ? { ...payload, downloadInfos } : null;
  }

  if (payload.downloadInfo && typeof payload.downloadInfo === "object") {
    const item = payload.downloadInfo;
    const trackId = item.trackId != null ? String(item.trackId) : "";
    const candidateId = trackId || requestedTrackIds[0] || "";
    const replacement = replacements.get(candidateId);
    if (!candidateId || !replacement || !replacement.streamUrl) {
      return null;
    }

    const originalUrls = [
      item && item.url ? String(item.url) : "",
      ...(Array.isArray(item && item.urls) ? item.urls.map((url) => String(url || "")) : []),
    ].filter(Boolean);
    const playableUrl = originalUrls[0] || buildOverrideMediaUrl(replacement);

    return {
      ...payload,
      downloadInfo: {
        ...item,
        trackId: candidateId,
        realId: candidateId,
        codec: guessCodec(replacement.contentType, item && item.codec),
        transport: "raw",
        key: "",
        size: replacement.fileSize || Number(item.size || 0) || 0,
        url: playableUrl,
        urls: originalUrls.length ? originalUrls : [playableUrl],
      },
    };
  }

  return null;
}

async function sendDebuggerCommand(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function ensureDebuggerAttached(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  const target = { tabId };
  if (!attachedTabs.has(tabId)) {
    pushDebugEvent("attachAttempts", { tabId, step: "attach-start" });
    try {
      await chrome.debugger.attach(target, DEBUGGER_VERSION);
      attachedTabs.add(tabId);
      pushDebugEvent("attachAttempts", { tabId, step: "attach-ok" });
    } catch (error) {
      const message = String(error && error.message || error);
      if (!message.includes("Another debugger is already attached")) {
        pushDebugEvent("errors", { tabId, step: "attach-failed", message });
        throw error;
      }
      attachedTabs.add(tabId);
      pushDebugEvent("attachAttempts", { tabId, step: "attach-already" });
    }
  }

  await sendDebuggerCommand(target, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  pushDebugEvent("attachAttempts", { tabId, step: "auto-attach-enabled" });
  await sendDebuggerCommand(target, "Network.enable");
  await sendDebuggerCommand(target, "Fetch.enable", { patterns: FETCH_PATTERNS });
  pushDebugEvent("attachAttempts", { tabId, step: "fetch-enabled" });
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) {
    return;
  }

  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
  }
}

async function attachToExistingMusicTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://music.yandex.ru/*"] });
  for (const tab of tabs) {
    if (tab.id != null) {
      ensureDebuggerAttached(tab.id).catch(() => {});
    }
  }
}

async function continuePausedRequest(source, requestId) {
  try {
    pushDebugEvent("continueRequests", { tabId: source.tabId, requestId });
    await sendDebuggerCommand(source, "Fetch.continueRequest", { requestId });
  } catch (error) {
    pushDebugEvent("errors", {
      tabId: source.tabId,
      step: "continue-failed",
      requestId,
      message: String(error && error.message || error),
    });
  }
}

async function enableChildTargetInterception(source, params) {
  const tabId = source && source.tabId;
  const sessionId = params && params.sessionId;
  const targetInfo = params && params.targetInfo;
  if (!Number.isInteger(tabId) || !sessionId) {
    return;
  }

  const childTarget = { tabId, sessionId };
  attachedChildSessions.set(`${tabId}:${sessionId}`, {
    targetId: targetInfo && targetInfo.targetId ? String(targetInfo.targetId) : "",
    type: targetInfo && targetInfo.type ? String(targetInfo.type) : "",
    url: targetInfo && targetInfo.url ? String(targetInfo.url) : "",
  });

  try {
    await sendDebuggerCommand(childTarget, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (error) {
  }

  await sendDebuggerCommand(childTarget, "Runtime.enable");
  await sendDebuggerCommand(childTarget, "Network.enable");
  try {
    await sendDebuggerCommand(childTarget, "Fetch.enable", { patterns: FETCH_PATTERNS });
  } catch (error) {
    pushDebugEvent("attachAttempts", {
      tabId,
      sessionId,
      step: "child-fetch-unsupported",
      targetType: targetInfo && targetInfo.type ? String(targetInfo.type) : "",
      message: String(error && error.message || error),
    });
  }
  pushDebugEvent("attachAttempts", {
    tabId,
    sessionId,
    step: "child-fetch-enabled",
    targetType: targetInfo && targetInfo.type ? String(targetInfo.type) : "",
    targetUrl: targetInfo && targetInfo.url ? String(targetInfo.url) : "",
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || !Number.isInteger(source.tabId) || !attachedTabs.has(source.tabId)) {
    return;
  }

  if (method === "Target.attachedToTarget") {
    enableChildTargetInterception(source, params).catch((error) => {
      pushDebugEvent("errors", {
        tabId: source.tabId,
        sessionId: params && params.sessionId ? String(params.sessionId) : "",
        step: "child-attach-failed",
        targetType: params && params.targetInfo && params.targetInfo.type ? String(params.targetInfo.type) : "",
        message: String(error && error.message || error),
      });
    });
    return;
  }

  if (method === "Target.detachedFromTarget") {
    const sessionId = params && params.sessionId ? String(params.sessionId) : "";
    if (sessionId) {
      attachedChildSessions.delete(`${source.tabId}:${sessionId}`);
    }
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const requestUrl = params && params.request && params.request.url ? String(params.request.url) : "";
    if (
      requestUrl.includes("127.0.0.1:9876")
      || requestUrl.startsWith(OVERRIDE_MEDIA_ORIGIN)
      || requestUrl.includes("strm.yandex.net")
      || requestUrl.includes("get-file-info")
    ) {
      pushDebugEvent("seenMediaLikeRequests", {
        tabId: source.tabId,
        sessionId: source.sessionId ? String(source.sessionId) : "",
        url: requestUrl,
        method: params && params.request && params.request.method ? String(params.request.method) : "",
        type: params && params.type ? String(params.type) : "",
        initiatorType: params && params.initiator && params.initiator.type ? String(params.initiator.type) : "",
      });
    }
    return;
  }

  if (method === "Network.loadingFailed") {
    const blockedUrl = params && params.requestId ? String(params.requestId) : "";
    pushDebugEvent("errors", {
      tabId: source.tabId,
      sessionId: source.sessionId ? String(source.sessionId) : "",
      step: "network-loading-failed",
      requestId: blockedUrl,
      errorText: params && params.errorText ? String(params.errorText) : "",
      canceled: Boolean(params && params.canceled),
    });
    return;
  }

  if (method !== "Fetch.requestPaused") {
    return;
  }

  const requestId = params && params.requestId;
  const requestUrl = params && params.request && params.request.url;
  if (!requestId || typeof requestUrl !== "string") {
    continuePausedRequest(source, requestId);
    return;
  }

  if (requestUrl.startsWith(OVERRIDE_MEDIA_PREFIX)) {
    (async () => {
      try {
        const fulfilled = await fulfillOverrideMediaRequest(source, params);
        if (!fulfilled) {
          await continuePausedRequest(source, requestId);
        }
      } catch (error) {
        pushDebugEvent("errors", {
          tabId: source.tabId,
          step: "fulfill-media-failed",
          requestId,
          url: requestUrl,
          message: String(error && error.message || error),
        });
        await continuePausedRequest(source, requestId);
      }
    })();
    return;
  }

  const originalOverride = findOriginalMediaOverride(requestUrl);
  if (originalOverride) {
    (async () => {
      try {
        const fulfilled = await fulfillReplacementMediaRequest(source, params, originalOverride, requestUrl);
        if (!fulfilled) {
          await continuePausedRequest(source, requestId);
        }
      } catch (error) {
        pushDebugEvent("errors", {
          tabId: source.tabId,
          step: "fulfill-original-media-failed",
          requestId,
          url: requestUrl,
          message: String(error && error.message || error),
        });
        await continuePausedRequest(source, requestId);
      }
    })();
    return;
  }

  if (originalMediaOverrides.size) {
    let requestHost = "";
    try {
      requestHost = new URL(requestUrl).host;
    } catch (error) {
    }
    if (requestHost) {
      const knownHosts = new Set();
      for (const url of originalMediaOverrides.keys()) {
        try {
          knownHosts.add(new URL(url).host);
        } catch (error) {
        }
      }
      if (knownHosts.has(requestHost)) {
        pushDebugEvent("seenMediaLikeRequests", {
          tabId: source.tabId,
          requestId,
          url: requestUrl,
          method: params && params.request && params.request.method,
          responseStage: "responseStatusCode" in params,
        });
      }
    }
  }

  if (requestUrl.includes("api.music.yandex.ru/get-file-info")) {
    pushDebugEvent("pausedRequests", {
      tabId: source.tabId,
      requestId,
      url: requestUrl,
      responseStage: "responseStatusCode" in params,
    });
  }

  continuePausedRequest(source, requestId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source && Number.isInteger(source.tabId)) {
    attachedTabs.delete(source.tabId);
    for (const key of Array.from(attachedChildSessions.keys())) {
      if (key.startsWith(`${source.tabId}:`)) {
        attachedChildSessions.delete(key);
      }
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const nextUrl = changeInfo.url || tab.url || "";
  if (isMusicTabUrl(nextUrl)) {
    ensureDebuggerAttached(tabId).catch(() => {});
    return;
  }

  if (changeInfo.status === "loading" && attachedTabs.has(tabId) && nextUrl && !isMusicTabUrl(nextUrl)) {
    detachDebugger(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detachDebugger(tabId).catch(() => {});
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isMusicTabUrl(tab.url)) {
      ensureDebuggerAttached(tabId).catch(() => {});
    }
  } catch (error) {
  }
});

chrome.runtime.onInstalled.addListener(() => {
  attachToExistingMusicTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  attachToExistingMusicTabs().catch(() => {});
});

attachToExistingMusicTabs().catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  (async () => {
    if (message.type === "debug-state") {
      sendResponse({
        ok: true,
        status: 200,
        text: "",
        json: self.__ymLocalOverrideBackgroundDebug && self.__ymLocalOverrideBackgroundDebug.getState
          ? self.__ymLocalOverrideBackgroundDebug.getState()
          : null,
      });
      return;
    }

    if (message.type === "invalidate-track-cache") {
      invalidateTrackCaches(message.trackId || "");
      sendResponse({
        ok: true,
        status: 200,
        text: "",
        json: { trackId: String(message.trackId || "") },
      });
      return;
    }

    if (!message.type.startsWith("helper-")) {
      sendResponse({ ok: false, status: 0, text: "Unknown message", json: null });
      return;
    }

    if (message.type === "helper-request") {
      const response = await fetch(`${HELPER_URL}${message.path}`, {
        method: message.method || "GET",
      });
      sendResponse(await parseResponse(response));
      return;
    }

    if (message.type === "helper-upload") {
      const formData = new FormData();
      const byteArray = normalizeUploadBytes(message);
      const blob = new Blob(
        [byteArray],
        { type: message.fileType || "application/octet-stream" },
      );
      formData.append("track_id", message.trackId || "");
      formData.append("title", message.title || "");
      formData.append("artist", message.artist || "");
      formData.append("file", blob, message.fileName || "track.mp3");

      const response = await fetch(`${HELPER_URL}/api/replacements`, {
        method: "POST",
        body: formData,
      });
      invalidateTrackCaches(message.trackId || "");
      sendResponse(await parseResponse(response));
      return;
    }

    if (message.type === "helper-upload-start") {
      const uploadId = randomUploadId();
      pendingUploads.set(uploadId, {
        trackId: message.trackId || "",
        title: message.title || "",
        artist: message.artist || "",
        fileName: message.fileName || "track.mp3",
        fileType: message.fileType || "application/octet-stream",
        chunks: [],
      });
      sendResponse({ ok: true, uploadId });
      return;
    }

    if (message.type === "helper-upload-chunk") {
      const upload = pendingUploads.get(message.uploadId);
      if (!upload) {
        sendResponse({ ok: false, status: 404, text: "Upload session not found", json: null });
        return;
      }
      upload.chunks.push(decodeBase64(message.chunkBase64 || ""));
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "helper-upload-complete") {
      const upload = pendingUploads.get(message.uploadId);
      if (!upload) {
        sendResponse({ ok: false, status: 404, text: "Upload session not found", json: null });
        return;
      }

      pendingUploads.delete(message.uploadId);
      const formData = new FormData();
      const blob = new Blob(upload.chunks, { type: upload.fileType });
      formData.append("track_id", upload.trackId);
      formData.append("title", upload.title);
      formData.append("artist", upload.artist);
      formData.append("file", blob, upload.fileName);

      const response = await fetch(`${HELPER_URL}/api/replacements`, {
        method: "POST",
        body: formData,
      });
      invalidateTrackCaches(upload.trackId || "");
      sendResponse(await parseResponse(response));
      return;
    }

    if (message.type === "helper-upload-abort") {
      pendingUploads.delete(message.uploadId);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "helper-media") {
      const response = await fetch(`${HELPER_URL}${message.path}`, {
        method: "GET",
      });
      sendResponse(await parseBinaryResponse(response));
      return;
    }

    sendResponse({ ok: false, status: 0, text: "Unknown helper message", json: null });
  })().catch((error) => {
    sendResponse({
      ok: false,
      status: 0,
      text: String(error),
      json: null,
    });
  });

  return true;
});
