(() => {
  const SOURCE = "ym-local-override-bridge";
  const LOCAL_AUDIO_ID = "ym-local-override-audio";
  const trackedMedia = new Set();
  const trackedContexts = new Set();
  const trackedWorkers = new Set();
  const replacementMap = new Map();
  let pageMuted = false;
  let activeReplacementTrackId = "";
  let activeReplacementUrl = "";

  function readTrackIdsFromUrl(url) {
    try {
      const parsed = new URL(String(url || ""), window.location.origin);
      const singleTrackId = parsed.searchParams.get("trackId");
      const batchTrackIds = parsed.searchParams.get("trackIds");
      if (singleTrackId) {
        return [String(singleTrackId)];
      }
      if (!batchTrackIds) {
        return [];
      }
      return batchTrackIds.split(",").map((item) => String(item || "").trim()).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  function guessCodecFromContentType(contentType, fallbackCodec) {
    const normalized = String(contentType || "").toLowerCase();
    if (normalized.includes("flac")) return "flac";
    if (normalized.includes("wav")) return "wav";
    if (normalized.includes("ogg")) return "ogg";
    if (normalized.includes("mp4") || normalized.includes("aac")) return "aac-mp4";
    if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
    return fallbackCodec || "mp3";
  }

  function serializeReplacementItems() {
    return [...replacementMap.values()].map((item) => ({
      trackId: String(item.trackId || ""),
      streamUrl: String(item.streamUrl || ""),
      contentType: String(item.contentType || "audio/mpeg"),
      storedName: String(item.storedName || ""),
    }));
  }

  function getReplacementUrlForTrack(trackId) {
    const item = replacementMap.get(String(trackId || ""));
    return item && item.streamUrl ? String(item.streamUrl) : "";
  }

  function isVisible(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function invokeNativeTrackPlay(trackId) {
    const key = String(trackId || "");
    if (!key) {
      return false;
    }

    const rowAnchor = [...document.querySelectorAll(`a[href*="/track/${key}"]`)]
      .find((anchor) => anchor instanceof HTMLAnchorElement && isVisible(anchor));
    const rowContainer = rowAnchor instanceof HTMLElement
      ? rowAnchor.closest('[class*="CommonTrack_root"], li, article, [role="row"]')
      : null;
    const rowButton = rowContainer instanceof HTMLElement
      ? [...rowContainer.querySelectorAll("button, [role='button']")]
        .find((node) => node instanceof HTMLElement && isVisible(node))
      : null;
    if (rowButton instanceof HTMLElement) {
      rowButton.click();
      return true;
    }

    const taggedButtons = [...document.querySelectorAll("button, [role='button']")]
      .filter((node) => node instanceof HTMLElement)
      .filter(isVisible)
      .filter((node) => node.dataset && node.dataset.ymloTriggerTrackId === key);

    const fallbackButtons = taggedButtons.length
      ? []
      : [...document.querySelectorAll("button, [role='button']")]
        .filter((node) => node instanceof HTMLElement)
        .filter(isVisible);

    for (const button of [...taggedButtons, ...fallbackButtons]) {
      const fiberKey = Object.keys(button).find((item) => item.startsWith("__reactFiber$"));
      if (!fiberKey) {
        continue;
      }

      let cursor = button[fiberKey];
      let fallbackPlay = null;
      let fallbackRestart = null;
      for (let depth = 0; cursor && depth < 20; depth += 1) {
        const props = cursor.memoizedProps || cursor.pendingProps || null;
        if (
          props &&
          props.track &&
          String(props.track.id || "") === key
        ) {
          if (typeof props.togglePlay === "function") {
            props.togglePlay();
            return true;
          }
          if (!fallbackPlay && typeof props.onPlayButtonClick === "function") {
            fallbackPlay = props.onPlayButtonClick;
          }
          if (!fallbackRestart && typeof props.restartPlay === "function") {
            fallbackRestart = props.restartPlay;
          }
        }
        cursor = cursor.return;
      }

      if (typeof fallbackPlay === "function") {
        fallbackPlay();
        return true;
      }
      if (typeof fallbackRestart === "function") {
        fallbackRestart();
        return true;
      }
    }

    return false;
  }

  function buildReplacementInfo(trackId, currentInfo) {
    const replacement = replacementMap.get(String(trackId));
    if (!replacement || !replacement.streamUrl) {
      return currentInfo;
    }
    const replacementUrl = String(replacement.streamUrl || "");
    const replacementCodec = replacementUrl.startsWith("blob:")
      ? "mp3"
      : guessCodecFromContentType(replacement.contentType, currentInfo && currentInfo.codec);

    return {
      ...currentInfo,
      trackId: String(trackId),
      realId: String(trackId),
      transport: "override",
      codec: replacementCodec,
      bitrate: currentInfo && currentInfo.bitrate ? currentInfo.bitrate : 320,
      key: "ym-local-override",
      size: currentInfo && currentInfo.size ? currentInfo.size : 0,
      gain: false,
      url: replacementUrl,
      urls: [replacementUrl],
    };
  }

  function overrideGetFileInfoPayload(payload, requestUrl) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const requestedTrackIds = readTrackIdsFromUrl(requestUrl);
    let changed = false;

    if (Array.isArray(payload.downloadInfos)) {
      const downloadInfos = payload.downloadInfos.map((item) => {
        const trackId = item && item.trackId != null ? String(item.trackId) : "";
        const candidateId = trackId || requestedTrackIds[0] || "";
        if (!candidateId || !replacementMap.has(candidateId)) {
          return item;
        }
        changed = true;
        return buildReplacementInfo(candidateId, item || {});
      });

      return changed ? { ...payload, downloadInfos } : null;
    }

    if (payload.downloadInfo && typeof payload.downloadInfo === "object") {
      const item = payload.downloadInfo;
      const trackId = item.trackId != null ? String(item.trackId) : "";
      const candidateId = trackId || requestedTrackIds[0] || "";
      if (!candidateId || !replacementMap.has(candidateId)) {
        return null;
      }

      return {
        ...payload,
        downloadInfo: buildReplacementInfo(candidateId, item),
      };
    }

    return null;
  }

  function emitTrackHints(payload) {
    if (!payload) {
      return;
    }

    const tracks = [];
    const seen = new Set();

    function artistName(node) {
      if (!Array.isArray(node)) return "";
      return node.map((artist) => artist && artist.name).filter(Boolean).join(", ");
    }

    function albumId(node) {
      if (Array.isArray(node) && node.length && node[0] && node[0].id != null) {
        return node[0].id;
      }
      return null;
    }

    function maybeTrack(node) {
      if (!node || typeof node !== "object") return;
      const durationMs = Number(node.durationMs ?? node.duration_ms ?? 0);
      const isTrackLike =
        node.id != null &&
        typeof node.title === "string" &&
        Number.isFinite(durationMs) &&
        durationMs > 0 &&
        (Array.isArray(node.artists) || Array.isArray(node.albums) || node.durationMs != null || node.duration_ms != null);

      if (!isTrackLike) return;

      const trackId = String(node.id);
      if (seen.has(trackId)) return;
      seen.add(trackId);
      tracks.push({
        trackId,
        albumId: albumId(node.albums),
        title: node.title,
        artist: artistName(node.artists),
        durationMs,
      });
    }

    function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== "object") return;
      maybeTrack(node);
      for (const value of Object.values(node)) {
        walk(value);
      }
    }

    walk(payload);
    if (tracks.length) {
      window.postMessage({ source: SOURCE, type: "tracks", tracks }, "*");
    }
  }

  function inspectText(text) {
    if (!text || typeof text !== "string") return;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
    try {
      emitTrackHints(JSON.parse(trimmed));
    } catch (error) {
    }
  }

  async function maybeOverrideFetchResponse(response, requestUrl) {
    const url = String(requestUrl || "");
    if (!/api\.music\.yandex\.ru\/get-file-info(\/batch)?/i.test(url)) {
      return response;
    }

    try {
      const text = await response.clone().text();
      inspectText(text);
      const overriddenPayload = overrideGetFileInfoPayload(JSON.parse(text), url);
      if (!overriddenPayload) {
        return response;
      }

      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json; charset=utf-8");
      window.postMessage({ source: SOURCE, type: "replacement-source-hit", trackIds: readTrackIdsFromUrl(url) }, "*");
      return new Response(JSON.stringify(overriddenPayload), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      return response;
    }
  }

  function patchXhrResponse(xhr) {
    try {
      const url = xhr.responseURL || xhr.__ymLocalOverrideUrl || "";
      if (!/api\.music\.yandex\.ru\/get-file-info(\/batch)?/i.test(url)) return;
      const contentType = xhr.getResponseHeader("content-type") || "";
      if (!contentType.includes("json")) return;
      const originalText = xhr.responseText;
      const overriddenPayload = overrideGetFileInfoPayload(JSON.parse(originalText), url);
      if (!overriddenPayload) {
        inspectText(originalText);
        return;
      }

      const nextText = JSON.stringify(overriddenPayload);
      Object.defineProperty(xhr, "responseText", { configurable: true, get() { return nextText; } });
      Object.defineProperty(xhr, "response", {
        configurable: true,
        get() { return xhr.responseType === "json" ? overriddenPayload : nextText; },
      });
      window.postMessage({ source: SOURCE, type: "replacement-source-hit", trackIds: readTrackIdsFromUrl(url) }, "*");
      inspectText(nextText);
    } catch (error) {
    }
  }

  function applyMuteStateToMedia(media) {
    if (!(media instanceof HTMLMediaElement) || media.id === LOCAL_AUDIO_ID) return;
    if (pageMuted) {
      media.muted = true;
      return;
    }
  }

  function rememberMedia(media) {
    if (!(media instanceof HTMLMediaElement)) return media;
    trackedMedia.add(media);
    applyMuteStateToMedia(media);
    return media;
  }

  function setTrackedMediaMuted(muted) {
    pageMuted = Boolean(muted);
    document.querySelectorAll("audio, video").forEach((media) => rememberMedia(media));
    trackedMedia.forEach((media) => applyMuteStateToMedia(media));
  }

  function rememberContext(context) {
    if (!context) return context;
    trackedContexts.add(context);
    return context;
  }

  function buildWorkerBootstrapSource(originalUrl, isModule) {
    const itemsJson = JSON.stringify(serializeReplacementItems());
    const importCode = isModule
      ? `import(${JSON.stringify(String(originalUrl || ""))}).catch(() => {});`
      : `try { importScripts(${JSON.stringify(String(originalUrl || ""))}); } catch (error) {}`;

    return `
      const YMLO_SOURCE = ${JSON.stringify(SOURCE)};
      const ymloReplacementMap = new Map();
      const ymloItems = ${itemsJson};
      for (const item of ymloItems) {
        const trackId = String(item.trackId || "");
        const streamUrl = String(item.streamUrl || "");
        if (trackId && streamUrl) ymloReplacementMap.set(trackId, item);
      }
      function ymloReadTrackIdsFromUrl(url) {
        try {
          const parsed = new URL(String(url || ""), "https://music.yandex.ru");
          const singleTrackId = parsed.searchParams.get("trackId");
          const batchTrackIds = parsed.searchParams.get("trackIds");
          if (singleTrackId) return [String(singleTrackId)];
          if (!batchTrackIds) return [];
          return batchTrackIds.split(",").map((item) => String(item || "").trim()).filter(Boolean);
        } catch (error) { return []; }
      }
      function ymloBuildReplacementInfo(trackId, currentInfo) {
        const replacement = ymloReplacementMap.get(String(trackId));
        if (!replacement || !replacement.streamUrl) return currentInfo;
        return { ...currentInfo, trackId: String(trackId), realId: String(trackId), transport: "override", codec: "mp3", url: String(replacement.streamUrl), urls: [String(replacement.streamUrl)] };
      }
      function ymloOverridePayload(payload, requestUrl) {
        if (!payload || typeof payload !== "object") return null;
        const requestedTrackIds = ymloReadTrackIdsFromUrl(requestUrl);
        let changed = false;
        if (Array.isArray(payload.downloadInfos)) {
          const downloadInfos = payload.downloadInfos.map((item) => {
            const trackId = item && item.trackId != null ? String(item.trackId) : "";
            const candidateId = trackId || requestedTrackIds[0] || "";
            if (!candidateId || !ymloReplacementMap.has(candidateId)) return item;
            changed = true;
            return ymloBuildReplacementInfo(candidateId, item || {});
          });
          return changed ? { ...payload, downloadInfos } : null;
        }
        if (payload.downloadInfo && typeof payload.downloadInfo === "object") {
          const item = payload.downloadInfo;
          const trackId = item.trackId != null ? String(item.trackId) : "";
          const candidateId = trackId || requestedTrackIds[0] || "";
          if (!candidateId || !ymloReplacementMap.has(candidateId)) return null;
          return { ...payload, downloadInfo: ymloBuildReplacementInfo(candidateId, item) };
        }
        return null;
      }
      self.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || data.source !== YMLO_SOURCE || data.type !== "replacement-map") return;
        ymloReplacementMap.clear();
        for (const item of data.items || []) {
          const trackId = String(item.trackId || "");
          const streamUrl = String(item.streamUrl || "");
          if (trackId && streamUrl) ymloReplacementMap.set(trackId, item);
        }
      });
      const ymloFetch = self.fetch;
      self.fetch = async (...args) => {
        const requestUrl = typeof args[0] === "string" ? args[0] : ((args[0] && args[0].url) || "");
        const response = await ymloFetch(...args);
        if (!/api\\.music\\.yandex\\.ru\\/get-file-info(\\/batch)?/i.test(String(requestUrl || ""))) return response;
        try {
          const text = await response.clone().text();
          const overridden = ymloOverridePayload(JSON.parse(text), requestUrl);
          if (!overridden) return response;
          return new Response(JSON.stringify(overridden), { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch (error) { return response; }
      };
      ${importCode}
    `;
  }

  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalCreateElement = Document.prototype.createElement;
  const originalPlay = HTMLMediaElement.prototype.play;
  const NativeWorker = window.Worker;
  const NativeAudio = window.Audio;
  const NativeAudioContext = window.AudioContext;
  const NativeWebkitAudioContext = window.webkitAudioContext;

  window.fetch = async (...args) => {
    const requestUrl = typeof args[0] === "string" ? args[0] : ((args[0] && args[0].url) || "");
    let response = await originalFetch(...args);
    response = await maybeOverrideFetchResponse(response, requestUrl);
    try { response.clone().text().then(inspectText).catch(() => {}); } catch (error) {}
    return response;
  };

  XMLHttpRequest.prototype.open = function(...args) {
    this.__ymLocalOverrideUrl = args[1];
    return originalOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", () => {
      try {
        patchXhrResponse(this);
        const contentType = this.getResponseHeader("content-type") || "";
        const url = this.responseURL || this.__ymLocalOverrideUrl || "";
        if (contentType.includes("json") || url.includes("music.yandex")) {
          inspectText(this.responseText);
        }
      } catch (error) {}
    });
    return originalSend.apply(this, args);
  };

  Document.prototype.createElement = function(tagName, ...args) {
    const element = originalCreateElement.call(this, tagName, ...args);
    const normalized = String(tagName || "").toLowerCase();
    if (normalized === "audio" || normalized === "video") rememberMedia(element);
    return element;
  };

  HTMLMediaElement.prototype.play = function(...args) {
    rememberMedia(this);
    const result = originalPlay.apply(this, args);
    applyMuteStateToMedia(this);
    return result;
  };

  window.Audio = function(...args) {
    return rememberMedia(new NativeAudio(...args));
  };
  window.Audio.prototype = NativeAudio.prototype;
  Object.setPrototypeOf(window.Audio, NativeAudio);

  if (typeof NativeAudioContext === "function") {
    window.AudioContext = function(...args) {
      return rememberContext(new NativeAudioContext(...args));
    };
    window.AudioContext.prototype = NativeAudioContext.prototype;
    Object.setPrototypeOf(window.AudioContext, NativeAudioContext);
  }

  if (typeof NativeWebkitAudioContext === "function") {
    window.webkitAudioContext = function(...args) {
      return rememberContext(new NativeWebkitAudioContext(...args));
    };
    window.webkitAudioContext.prototype = NativeWebkitAudioContext.prototype;
    Object.setPrototypeOf(window.webkitAudioContext, NativeWebkitAudioContext);
  }

  if (typeof NativeWorker === "function") {
    window.Worker = function(scriptURL, options) {
      const originalUrl = String(scriptURL || "");
      const shouldWrap = originalUrl.startsWith("blob:") || originalUrl.startsWith(window.location.origin);
      if (!shouldWrap) {
        return new NativeWorker(scriptURL, options);
      }
      const wrapperSource = buildWorkerBootstrapSource(originalUrl, Boolean(options && options.type === "module"));
      const wrapperUrl = URL.createObjectURL(new Blob([wrapperSource], { type: "text/javascript" }));
      const worker = new NativeWorker(wrapperUrl, options);
      trackedWorkers.add(worker);
      const originalTerminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        trackedWorkers.delete(worker);
        URL.revokeObjectURL(wrapperUrl);
        return originalTerminate();
      };
      try {
        worker.postMessage({ source: SOURCE, type: "replacement-map", items: serializeReplacementItems() });
      } catch (error) {}
      return worker;
    };
    window.Worker.prototype = NativeWorker.prototype;
    Object.setPrototypeOf(window.Worker, NativeWorker);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === "page-media-mute") {
      setTrackedMediaMuted(Boolean(data.muted));
      return;
    }
    if (data.type === "replacement-map") {
      replacementMap.clear();
      for (const item of data.items || []) {
        const trackId = String(item.trackId || "");
        const streamUrl = String(item.streamUrl || "");
        if (!trackId || !streamUrl) continue;
        replacementMap.set(trackId, {
          trackId,
          streamUrl,
          contentType: String(item.contentType || "audio/mpeg"),
          storedName: String(item.storedName || ""),
        });
      }
      trackedWorkers.forEach((worker) => {
        try {
          worker.postMessage({ source: SOURCE, type: "replacement-map", items: serializeReplacementItems() });
        } catch (error) {}
      });
      return;
    }
    if (data.type === "active-replacement") {
      activeReplacementTrackId = String(data.trackId || "");
      activeReplacementUrl = String(data.streamUrl || "");
      return;
    }
    if (data.type === "native-track-play") {
      const ok = invokeNativeTrackPlay(data.trackId);
      window.postMessage({
        source: SOURCE,
        type: "native-track-play-response",
        requestId: data.requestId || null,
        trackId: String(data.trackId || ""),
        ok,
      }, "*");
    }
  });

  window.__ymloPageDebug = function() {
    return {
      replacementKeys: [...replacementMap.keys()],
      activeReplacementTrackId,
      activeReplacementUrl,
      trackedWorkerCount: trackedWorkers.size,
      pageMuted,
    };
  };
})();
