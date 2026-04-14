(() => {
  const HELPER_URL = "http://127.0.0.1:9876";
  const LOCAL_AUDIO_ID = "ym-local-override-audio";
  const ROOT_ID = "ym-local-override-root";
  const STYLE_ID = "ym-local-override-style";
  const BRIDGE_SOURCE = "ym-local-override-bridge";
  const HELPER_POLL_MS = 1500;
  const REPLACEMENTS_POLL_MS = 2000;
  const USE_SOURCE_INTERCEPT = true;

  const state = {
    currentTrackId: null,
    currentTrackInfo: null,
    currentReplacementUrl: null,
    helperOnline: false,
    officialMedia: null,
    localAudio: null,
    enabled: false,
    mutedByOverride: false,
    lastError: "",
    trackCache: new Map(),
    replacements: new Map(),
    replacementBlobUrls: new Map(),
    modalTrackInfo: null,
    helperLastCheckedAt: 0,
    replacementsLastCheckedAt: 0,
    replacementsReady: false,
    bindScheduled: false,
    completedReplacementTrackId: null,
    advancingAfterReplacement: false,
    lockedTrackInfo: null,
    lastPlayerControlAt: 0,
    holdingOfficialPlayback: false,
    lastOfficialSuppressionAt: 0,
    preferredVolume: 1,
    playRequestedUntil: 0,
    suppressTransportToggleUntil: 0,
    suppressPlaybackTriggerUntil: 0,
    lastUiTrigger: null,
    pendingTrackInfo: null,
    pendingTrackUntil: 0,
    lastPublishedActiveReplacementKey: "",
  };

  function debug(message, payload) {
    console.debug("[YM Local Override]", message, payload || "");
  }


  function helperRequest(path, method = "GET") {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "helper-request", path, method }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || { ok: false, status: 0, text: "No response", json: null });
      });
    });
  }

  function helperMedia(path) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "helper-media", path }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || { ok: false, status: 0, contentType: "application/octet-stream", bytes: [] });
      });
    });
  }

  function invalidateBackgroundTrackCache(trackId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "invalidate-track-cache", trackId: String(trackId || "") }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(Boolean(response && response.ok));
      });
    });
  }

  function getBackgroundDebugState() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "debug-state" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response && response.json ? response.json : null);
      });
    });
  }

  function setPageMediaMuted(muted) {
    window.postMessage(
      { source: BRIDGE_SOURCE, type: "page-media-mute", muted: Boolean(muted) },
      "*",
    );
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseTrackFromHref(href) {
    const match = String(href || "").match(/\/track\/(\d+)/);
    return match ? match[1] : null;
  }

  function parseAlbumFromHref(href) {
    const match = String(href || "").match(/\/album\/(\d+)/);
    return match ? match[1] : null;
  }

  function parseTrackFromLocation() {
    return parseTrackFromHref(window.location.pathname || "");
  }

  function parseAlbumFromLocation() {
    return parseAlbumFromHref(window.location.pathname || "");
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        left: 18px;
        bottom: 94px;
        z-index: 2147483647;
        font-family: "Segoe UI", system-ui, sans-serif;
        color: #1a1a1a;
      }

      .ymlo-pill {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
        padding: 12px;
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 18px;
        background: rgba(25, 25, 25, 0.86);
        color: white;
        box-shadow: 0 14px 32px rgba(0, 0, 0, 0.22);
        min-width: 0;
        width: min(420px, calc(100vw - 36px));
      }

      .ymlo-pill-top {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .ymlo-pill strong {
        display: block;
        font-size: 13px;
        letter-spacing: 0.02em;
      }

      .ymlo-pill small {
        display: block;
        font-size: 11px;
        opacity: 0.92;
      }

      .ymlo-pill-actions {
        margin-left: auto;
        display: flex;
        gap: 8px;
      }

      .ymlo-transport {
        display: none !important;
        gap: 8px;
        padding: 10px 12px 12px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.06);
        color: white;
      }

      .ymlo-transport-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 8px;
      }

      .ymlo-transport-row.ymlo-volume-row {
        grid-template-columns: auto 1fr;
      }

      .ymlo-transport-time,
      .ymlo-transport-label {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.86);
        white-space: nowrap;
      }

      .ymlo-transport-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .ymlo-transport-mode {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 22px;
        padding: 0 9px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        font-size: 11px;
        color: rgba(255, 255, 255, 0.88);
      }

      .ymlo-slider {
        width: 100%;
        margin: 0;
        accent-color: #f6d08b;
      }

      .ymlo-btn {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 7px 11px;
        background: rgba(255, 255, 255, 0.16);
        color: inherit;
        cursor: pointer;
        font-size: 11px;
        font-weight: 700;
      }

      .ymlo-btn:hover {
        background: rgba(255, 255, 255, 0.24);
      }

      .ymlo-btn-dark {
        background: rgba(15, 15, 15, 0.82);
        color: white;
      }

      .ymlo-btn-dark:hover {
        background: rgba(15, 15, 15, 0.92);
      }

      .ymlo-overlay {
        display: none !important;
      }

      .ymlo-overlay[data-open="1"] {
        display: flex;
      }

      .ymlo-modal {
        display: none !important;
      }

      .ymlo-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        margin-bottom: 20px;
      }

      .ymlo-head h2,
      .ymlo-section h3,
      .ymlo-track-name {
        margin: 0;
      }

      .ymlo-track-box,
      .ymlo-section {
        background: rgba(255, 255, 255, 0.74);
        border: 1px solid rgba(31, 26, 20, 0.08);
        border-radius: 22px;
        padding: 18px;
      }

      .ymlo-track-box {
        margin-bottom: 16px;
      }

      .ymlo-track-meta,
      .ymlo-note,
      .ymlo-empty,
      .ymlo-status {
        color: #62574c;
        font-size: 14px;
        line-height: 1.5;
      }

      .ymlo-form {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .ymlo-field {
        display: flex;
        flex-direction: column;
        gap: 7px;
      }

      .ymlo-field span {
        font-size: 13px;
        font-weight: 700;
        color: #5e5247;
      }

      .ymlo-field input {
        border: 1px solid rgba(31, 26, 20, 0.12);
        border-radius: 16px;
        padding: 13px 15px;
        font-size: 14px;
        background: rgba(255, 255, 255, 0.92);
      }

      .ymlo-field-full,
      .ymlo-form-actions,
      .ymlo-status {
        grid-column: 1 / -1;
      }

      .ymlo-form-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .ymlo-pill-actions [data-action="open-library"] {
        display: none !important;
      }

      .ymlo-section + .ymlo-section {
        margin-top: 14px;
      }

      .ymlo-list {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }

      .ymlo-list-item {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        align-items: center;
        background: rgba(255, 255, 255, 0.9);
        border-radius: 18px;
        padding: 14px;
        border: 1px solid rgba(31, 26, 20, 0.08);
      }

      .ymlo-track-action {
        margin-left: 6px;
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 999px;
        padding: 0;
        display: inline-grid;
        place-items: center;
        position: relative;
        font-size: 0;
        line-height: 1;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.045);
        color: rgba(255, 255, 255, 0.72);
        vertical-align: middle;
        opacity: 0.78;
        transition: background 120ms ease, color 120ms ease, opacity 120ms ease, transform 120ms ease;
      }

      .ymlo-track-action::before {
        content: "\\21BB";
        font-size: 12px;
        line-height: 1;
      }

      .ymlo-track-action:hover {
        background: rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.92);
        opacity: 1;
        transform: scale(1.04);
      }

      .ymlo-track-action[data-active="1"] {
        background: rgba(143, 227, 176, 0.14);
        color: #8fe3b0;
        opacity: 1;
      }

      @media (max-width: 760px) {
        #${ROOT_ID} {
          left: 12px;
          right: 12px;
          bottom: 88px;
        }

        .ymlo-pill {
          min-width: 0;
          width: 100%;
        }

        .ymlo-form {
          grid-template-columns: 1fr;
        }

        .ymlo-list-item {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureLocalAudio() {
    if (state.localAudio) {
      return state.localAudio;
    }

    const audio = document.createElement("audio");
    audio.id = LOCAL_AUDIO_ID;
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    audio.style.display = "none";
    const syncNativeUi = () => {
      try {
        updateTransportUi();
      } catch (error) {
      }
    };
    ["timeupdate", "loadedmetadata", "durationchange", "seeking", "seeked", "play", "pause", "volumechange"].forEach((eventName) => {
      audio.addEventListener(eventName, syncNativeUi);
    });
    audio.addEventListener("ended", () => {
      if (state.currentTrackId) {
        state.completedReplacementTrackId = state.currentTrackId;
      }
      finishReplacementTrack().catch((error) => {
        state.lastError = String(error);
      });
    });
    document.documentElement.appendChild(audio);
    state.localAudio = audio;
    return audio;
  }

  function getRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) {
      return root;
    }

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="ymlo-pill">
        <div class="ymlo-pill-top">
          <div>
          <strong>YM Custom Client</strong>
          <small id="ymlo-status-line">Запуск локального сервиса...</small>
        </div>
        <div class="ymlo-pill-actions">
          <button class="ymlo-btn" type="button" data-action="open-current">Заменить</button>
          <button class="ymlo-btn" type="button" data-action="open-library">Мои замены</button>
        </div>
      </div>
      </div>
      <div class="ymlo-overlay" id="ymlo-overlay" data-open="0">
        <div class="ymlo-modal" role="dialog" aria-modal="true">
          <div class="ymlo-head">
            <div>
              <h2>Локальная подмена треков</h2>
              <p class="ymlo-note">Это кастомный клиент поверх официальной Яндекс Музыки. История, лайки и рекомендации остаются у оригинального трека.</p>
            </div>
            <button class="ymlo-btn-dark" type="button" data-action="close-modal">Закрыть</button>
          </div>
          <div id="ymlo-modal-content"></div>
        </div>
      </div>
    `;

    const primaryButton = root.querySelector('[data-action="open-current"]');
    if (primaryButton instanceof HTMLButtonElement) {
      primaryButton.dataset.action = "open-manager";
      primaryButton.textContent = "Замены";
    }

    root.addEventListener("click", (event) => {
      const rawTarget = event.target;
      if (!rawTarget || typeof rawTarget.closest !== "function") {
        return;
      }

      const target = rawTarget.closest("[data-action]");
      if (!target) {
        return;
      }

      const action = target.dataset.action;
      if (!action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (action === "open-current") {
        openManagerWindow(getManagerTrackInfo() || null);
      } else if (action === "open-library") {
        openManagerWindow(null);
      } else if (action === "close-modal") {
        closeModal();
      } else if (action === "open-manager") {
        openManagerWindow(state.modalTrackInfo || getManagerTrackInfo() || null);
      } else if (action === "open-full-manager") {
        openManagerWindow(null);
      }
    });

    root.addEventListener("submit", async (event) => {
      const target = event.target;
      if (!target || target.id !== "ymlo-form") {
        return;
      }

      event.preventDefault();
      const trackInfo = {
        trackId: target.querySelector('input[name=track_id]')?.value || "",
        title: target.querySelector('input[name=title]')?.value || "",
        artist: target.querySelector('input[name=artist]')?.value || "",
      };
      openManagerWindow(trackInfo);
    });

    root.addEventListener("click", async (event) => {
      const rawTarget = event.target;
      if (!rawTarget || typeof rawTarget.closest !== "function") {
        return;
      }

      const target = rawTarget.closest("[data-action]");
      if (!target) {
        return;
      }

      if (target.dataset.action === "delete-replacement" && target.dataset.trackId) {
        event.preventDefault();
        await deleteReplacement(target.dataset.trackId);
      }
    });

    document.documentElement.appendChild(root);
    return root;
  }

  function updateHeaderStatus() {
    const root = getRoot();
    updateTransportUi(root);
    const statusNode = root.querySelector("#ymlo-status-line");
    if (!statusNode) {
      return;
    }

    if (!state.helperOnline) {
      statusNode.textContent = "Локальный сервис не найден. Запустите лаунчер.";
      return;
    }

    if (state.enabled && state.currentTrackInfo && state.currentTrackInfo.trackId && getPlaybackState() === "playing") {
      statusNode.textContent = `Сейчас играет локальная версия трека ${state.currentTrackInfo.trackId}.`;
      return;
    }

    if (state.currentTrackInfo && state.currentTrackInfo.trackId) {
      statusNode.textContent = `Кастомный клиент активен. Текущий трек: ${state.currentTrackInfo.trackId}.`;
      return;
    }

    statusNode.textContent = "Кастомный клиент активен. Выберите трек, который хотите заменить.";
  }

  function replacementForTrack(trackId) {
    return trackId ? state.replacements.get(String(trackId)) || null : null;
  }

  async function publishReplacementMapToBridge() {
    const items = await Promise.all(
      [...state.replacements.values()].map(async (item) => {
        const trackId = String(item.track_id || "");
        let playableUrl = "";
        if (trackId && item.stream_url) {
          try {
            playableUrl = await getPlayableReplacementUrl(trackId, String(item.stream_url || ""));
          } catch (error) {
            debug("Failed to prepare playable replacement url", { trackId, error: String(error) });
          }
        }

        return {
          trackId,
          streamUrl: playableUrl,
          contentType: String(item.content_type || "audio/mpeg"),
          storedName: String(item.stored_name || ""),
        };
      }),
    );

    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "replacement-map",
        items,
      },
      "*",
    );
  }

  function publishActiveReplacementToBridge() {
    const trackId = state.enabled && state.currentTrackId ? String(state.currentTrackId) : "";
    const streamUrl = state.enabled && state.currentReplacementUrl ? String(state.currentReplacementUrl) : "";
    const nextKey = `${trackId}::${streamUrl}`;
    if (nextKey === state.lastPublishedActiveReplacementKey) {
      return;
    }
    state.lastPublishedActiveReplacementKey = nextKey;
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "active-replacement",
        trackId,
        streamUrl,
      },
      "*",
    );
  }

  function revokeReplacementBlobUrl(trackId) {
    const current = state.replacementBlobUrls.get(String(trackId));
    if (!current) {
      return;
    }
    URL.revokeObjectURL(current);
    state.replacementBlobUrls.delete(String(trackId));
  }

  async function getPlayableReplacementUrl(trackId, streamUrl) {
    const key = String(trackId || "");
    if (!key || !streamUrl) {
      return null;
    }

    const cached = state.replacementBlobUrls.get(key);
    if (cached) {
      return cached;
    }

    const path = streamUrl.startsWith(HELPER_URL)
      ? streamUrl.slice(HELPER_URL.length)
      : streamUrl;
    const response = await helperMedia(path);
    if (!response.ok) {
      throw new Error(`Media fetch failed: ${response.status}`);
    }

    const blob = new Blob(
      [Uint8Array.from(response.bytes || [])],
      { type: response.contentType || "audio/mpeg" },
    );
    const objectUrl = URL.createObjectURL(blob);
    state.replacementBlobUrls.set(key, objectUrl);
    return objectUrl;
  }

  function renderReplacementList() {
    const items = [...state.replacements.values()].sort((left, right) => {
      const leftKey = `${left.artist || ""} ${left.title || ""} ${left.track_id}`;
      const rightKey = `${right.artist || ""} ${right.title || ""} ${right.track_id}`;
      return leftKey.localeCompare(rightKey, "ru");
    });

    if (!items.length) {
      return `<div class="ymlo-empty">Пока нет ни одной локальной замены.</div>`;
    }

    return `
      <div class="ymlo-list">
        ${items.map((item) => `
          <div class="ymlo-list-item">
            <div>
              <div class="ymlo-track-name">${escapeHtml(item.title || "Без названия")}${item.artist ? ` - ${escapeHtml(item.artist)}` : ""}</div>
              <div class="ymlo-track-meta">Track ID: ${escapeHtml(item.track_id)} · Файл: ${escapeHtml(item.original_name || "")}</div>
            </div>
            <div class="ymlo-form-actions">
              <button class="ymlo-btn-dark" type="button" data-action="delete-replacement" data-track-id="${escapeHtml(item.track_id)}">Удалить</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderModal() {
    const root = getRoot();
    const content = root.querySelector("#ymlo-modal-content");
    if (!content) {
      return;
    }

    const info = state.modalTrackInfo;
    const replacement = info && info.trackId ? replacementForTrack(info.trackId) : null;
    const manageLabel = replacement ? "Обновить локальную версию" : "Выбрать локальный файл";
    const helperMessage = state.helperOnline
      ? "Локальный сервис работает."
      : "Локальный сервис не найден. Сначала запустите Launch YM Local Override.cmd.";

    content.innerHTML = `
      <div class="ymlo-track-box">
        <div class="ymlo-track-name">${info && info.title ? escapeHtml(info.title) : "Выберите трек на странице или нажмите кнопку Заменить рядом с ним."}</div>
        <div class="ymlo-track-meta">
          ${info && info.artist ? `Артист: ${escapeHtml(info.artist)}<br />` : ""}
          ${info && info.trackId ? `Track ID: ${escapeHtml(info.trackId)}` : "Track ID можно вписать вручную ниже."}
        </div>
      </div>

      <div class="ymlo-section">
        <h3>Добавить или обновить замену</h3>
        <p class="ymlo-note">${helperMessage}</p>
        <div id="ymlo-form" class="ymlo-form">
          <label class="ymlo-field">
            <span>Track ID</span>
            <input name="track_id" type="text" value="${info && info.trackId ? escapeHtml(info.trackId) : ""}" required />
          </label>
          <label class="ymlo-field">
            <span>Артист</span>
            <input name="artist" type="text" value="${info && info.artist ? escapeHtml(info.artist) : ""}" />
          </label>
          <label class="ymlo-field ymlo-field-full">
            <span>Название трека</span>
            <input name="title" type="text" value="${info && info.title ? escapeHtml(info.title) : ""}" />
          </label>
          <label class="ymlo-field ymlo-field-full">
            <span>Локальный аудиофайл</span>
            <input name="file" type="file" accept="audio/*" required />
          </label>
          <div class="ymlo-form-actions">
            <button class="ymlo-btn-dark" type="submit">Сохранить замену</button>
            ${replacement ? `<button class="ymlo-btn" type="button" data-action="delete-replacement" data-track-id="${escapeHtml(replacement.track_id)}">Удалить текущую замену</button>` : ""}
          </div>
          <div class="ymlo-status" id="ymlo-form-status">${replacement ? "Для этого трека уже есть локальная версия." : "Для этого трека пока нет локальной версии."}</div>
        </div>
      </div>

      <div class="ymlo-section">
        <h3>Все заменённые треки</h3>
        ${renderReplacementList()}
      </div>
    `;
  }

  function decorateModalActions() {
    const root = getRoot();
    const form = root.querySelector("#ymlo-form");
    if (!(form instanceof HTMLElement)) {
      return;
    }

    const fileField = form.querySelector('input[type="file"]')?.closest("label");
    if (fileField instanceof HTMLElement) {
      fileField.remove();
    }

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.type = "button";
      submitButton.dataset.action = "open-manager";
      submitButton.textContent = "Открыть загрузчик";
    }

    const actions = form.querySelector(".ymlo-form-actions");
    if (actions instanceof HTMLElement && !actions.querySelector('[data-action="open-full-manager"]')) {
      const openAllButton = document.createElement("button");
      openAllButton.type = "button";
      openAllButton.className = "ymlo-btn";
      openAllButton.dataset.action = "open-full-manager";
      openAllButton.textContent = "Все замены";
      actions.insertBefore(openAllButton, actions.firstChild ? actions.firstChild.nextSibling : null);
    }
  }

  function openModal(trackInfo) {
    openManagerWindow(trackInfo || getManagerTrackInfo() || null);
  }

  function closeModal() {
    const overlay = getRoot().querySelector("#ymlo-overlay");
    if (overlay instanceof HTMLElement) {
      overlay.dataset.open = "0";
    }
  }

  function buildManagerUrl(trackInfo) {
    const url = new URL(`${HELPER_URL}/`);
    url.searchParams.set("popup", "1");
    url.searchParams.set("close", "1");
    if (trackInfo && trackInfo.trackId) {
      url.searchParams.set("track_id", trackInfo.trackId);
      if (trackInfo.title) {
        url.searchParams.set("title", trackInfo.title);
      }
      if (trackInfo.artist) {
        url.searchParams.set("artist", trackInfo.artist);
      }
    }
    return url.toString();
  }

  function openManagerWindow(trackInfo) {
    window.open(buildManagerUrl(trackInfo), "ymlo-manager", "popup=yes,width=820,height=900,resizable=yes,scrollbars=yes");
  }

  function getManagerTrackInfo() {
    const officialMedia = detectOfficialMedia();
    const liveTrack = detectCurrentTrackInfo(officialMedia);
    const playerBarTrack = readPlayerBarTrackFallback();
    const locationTrack = readLocationTrackFallback();

    if (playerBarTrack && playerBarTrack.trackId) {
      if (liveTrack && liveTrack.trackId === playerBarTrack.trackId) {
        return {
          trackId: playerBarTrack.trackId,
          albumId: playerBarTrack.albumId || liveTrack.albumId || null,
          title: playerBarTrack.title || liveTrack.title || "",
          artist: playerBarTrack.artist || liveTrack.artist || "",
        };
      }

      return {
        trackId: playerBarTrack.trackId,
        albumId: playerBarTrack.albumId || null,
        title: playerBarTrack.title || "",
        artist: playerBarTrack.artist || "",
      };
    }

    if (liveTrack && liveTrack.trackId) {
      return liveTrack;
    }

    if (state.currentTrackInfo && state.currentTrackInfo.trackId) {
      return state.currentTrackInfo;
    }

    return locationTrack || null;
  }

  async function pingHelper(force = false) {
    if (!force && Date.now() - state.helperLastCheckedAt < HELPER_POLL_MS) {
      return state.helperOnline;
    }

    state.helperLastCheckedAt = Date.now();
    try {
      const response = await helperRequest(`/api/status`);
      state.helperOnline = Boolean(response && response.ok);
      if (!response.ok) {
        state.lastError = `Helper returned ${response.status}`;
      }
    } catch (error) {
      state.helperOnline = false;
      state.lastError = String(error);
    }
    updateHeaderStatus();
    return state.helperOnline;
  }

  function normalizeReplacement(item) {
    const rawStreamUrl = String(item.stream_url || "");
    let streamUrl = rawStreamUrl;
    if (rawStreamUrl && item.stored_name) {
      const separator = rawStreamUrl.includes("?") ? "&" : "?";
      streamUrl = `${rawStreamUrl}${separator}v=${encodeURIComponent(String(item.stored_name))}`;
    }
    return {
      ...item,
      stream_url: streamUrl.startsWith("http") ? streamUrl : `${HELPER_URL}${streamUrl}`,
    };
  }

  async function refreshReplacements(force = false) {
    if (!force && Date.now() - state.replacementsLastCheckedAt < REPLACEMENTS_POLL_MS) {
      return;
    }

    state.replacementsLastCheckedAt = Date.now();
    if (!(await pingHelper(force))) {
      state.replacements.clear();
      state.replacementsReady = true;
      await publishReplacementMapToBridge();
      updateTrackLinkState();
      return;
    }

    try {
      const response = await helperRequest(`/api/replacements`);
      if (!response.ok) {
        throw new Error(`Failed to fetch replacements: ${response.status}`);
      }
      const payload = response.json || {};
      const previousMap = state.replacements;
      const nextMap = new Map();
      for (const item of payload.items || []) {
        nextMap.set(String(item.track_id), normalizeReplacement(item));
      }
      for (const trackId of state.replacements.keys()) {
        if (!nextMap.has(trackId)) {
          revokeReplacementBlobUrl(trackId);
        }
      }
      for (const [trackId, nextItem] of nextMap.entries()) {
        const previousItem = previousMap.get(trackId);
        if (!previousItem) {
          continue;
        }

        if (
          previousItem.stored_name !== nextItem.stored_name ||
          previousItem.stream_url !== nextItem.stream_url ||
          previousItem.content_type !== nextItem.content_type
        ) {
          revokeReplacementBlobUrl(trackId);
          if (state.currentTrackId === trackId) {
            state.currentReplacementUrl = null;
          }
        }
      }
      state.replacements = nextMap;
      state.replacementsReady = true;
      await publishReplacementMapToBridge();
      updateTrackLinkState();
      if (document.querySelector("#ymlo-overlay[data-open='1']")) {
        renderModal();
        decorateModalActions();
      }
    } catch (error) {
      state.lastError = String(error);
      debug("Failed to refresh replacements", error);
    }
  }

  async function refreshTrackAfterReplacementChange(trackId) {
    const key = String(trackId || "");
    if (!key) {
      await refreshReplacements(true);
      await sync();
      return;
    }

    revokeReplacementBlobUrl(key);
    await invalidateBackgroundTrackCache(key);
    state.replacementsLastCheckedAt = 0;
    await refreshReplacements(true);

    const locationTrack = readLocationTrackFallback();
    const currentInfo = state.currentTrackInfo && String(state.currentTrackInfo.trackId || "") === key
      ? state.currentTrackInfo
      : null;
    const hintedInfo = currentInfo
      || (locationTrack && String(locationTrack.trackId || "") === key ? locationTrack : null)
      || state.trackCache.get(key)
      || {
        trackId: key,
        albumId: null,
        title: "",
        artist: "",
      };

    const isCurrentTrack = String(state.currentTrackId || "") === key;
    const isCurrentPageTrack = Boolean(locationTrack && String(locationTrack.trackId || "") === key);
    const playbackState = getPlaybackState();

    if (isCurrentTrack || isCurrentPageTrack) {
      state.currentTrackId = key;
      state.currentTrackInfo = hintedInfo;
      setPendingTrackInfo(hintedInfo);
      clearReplacementLock();
      await resolveReplacement(hintedInfo);

      if (playbackState === "playing") {
        state.suppressPlaybackTriggerUntil = Date.now() + 1200;
        await requestNativeTrackPlay(key);
      }
    }

    await sync();
  }

  async function saveReplacement(form) {
    const statusNode = form.querySelector("#ymlo-form-status");
    if (statusNode) {
      statusNode.textContent = "???????? ????????? ??????...";
    }

    try {
      const fileInput = form.querySelector('input[type=file]');
      const file = fileInput && fileInput.files ? fileInput.files[0] : null;
      if (!file) {
        throw new Error("???????? ?????????.");
      }
      const startResponse = await helperUploadStart({
        trackId: form.querySelector('input[name=track_id]').value,
        artist: form.querySelector('input[name=artist]').value,
        title: form.querySelector('input[name=title]').value,
        fileType: file.type,
        fileName: file.name,
      });
      if (!startResponse.ok || !startResponse.uploadId) {
        const text = startResponse.text || "";
        throw new Error(text || `Upload start failed: ${startResponse.status}`);
      }

      const uploadId = startResponse.uploadId;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const chunkSize = 256 * 1024;
        const totalChunks = Math.max(1, Math.ceil(bytes.length / chunkSize));

        for (let index = 0; index < totalChunks; index += 1) {
          const begin = index * chunkSize;
          const chunk = bytes.subarray(begin, Math.min(bytes.length, begin + chunkSize));
          if (statusNode) {
            statusNode.textContent = `Загрузка файла ${index + 1}/${totalChunks}...`;
          }
          const chunkResponse = await helperUploadChunk({
            uploadId,
            chunkBase64: uint8ToBase64(chunk),
          });
          if (!chunkResponse.ok) {
            const text = chunkResponse.text || "";
            throw new Error(text || `Upload chunk failed: ${chunkResponse.status}`);
          }
        }

        const response = await helperUploadComplete({ uploadId });
        if (!response.ok) {
          const text = response.text || "";
          throw new Error(text || `Upload failed: ${response.status}`);
        }
      } catch (error) {
        await helperUploadAbort({ uploadId }).catch(() => {});
        throw error;
      }

      state.helperOnline = true;
      await refreshReplacements(true);
      if (statusNode) {
        statusNode.textContent = "????????? ?????? ?????????.";
      }
      renderModal();
    } catch (error) {
      if (statusNode) {
        statusNode.textContent = `??????: ${error.message}`;
      }
      state.lastError = String(error);
    }
  }

  async function deleteReplacement(trackId) {
    try {
      const response = await helperRequest(`/api/replacements/${encodeURIComponent(trackId)}`, "DELETE");
      if (!response.ok) {
        const text = response.text || "";
        throw new Error(text || `Delete failed: ${response.status}`);
      }

      if (state.modalTrackInfo && state.modalTrackInfo.trackId === String(trackId)) {
        state.modalTrackInfo = { ...state.modalTrackInfo };
      }
      await refreshReplacements(true);
      if (state.currentTrackId === String(trackId)) {
        state.currentReplacementUrl = null;
      }
      renderModal();
      decorateModalActions();
    } catch (error) {
      state.lastError = String(error);
      renderModal();
      decorateModalActions();
    }
  }

  function trimTrackCache() {
    const items = [...state.trackCache.values()].sort((a, b) => b.seenAt - a.seenAt);
    state.trackCache.clear();
    for (const item of items.slice(0, 500)) {
      state.trackCache.set(item.trackId, item);
    }
  }

  function rememberTracks(tracks) {
    const seenAt = Date.now();
    for (const track of tracks) {
      const durationMs = Number(track && (track.durationMs ?? track.duration_ms) || 0);
      if (!track || !track.trackId || !track.title || !Number.isFinite(durationMs) || durationMs <= 0) {
        continue;
      }

      state.trackCache.set(String(track.trackId), {
        trackId: String(track.trackId),
        albumId: track.albumId ? String(track.albumId) : null,
        title: String(track.title || ""),
        artist: String(track.artist || ""),
        durationMs,
        seenAt,
      });
    }
    trimTrackCache();
  }

  function injectBridge() {
    if (document.documentElement.dataset.ymLocalOverrideBridge === "1") {
      return;
    }
    document.documentElement.dataset.ymLocalOverrideBridge = "1";

    const externalScript = document.createElement("script");
    externalScript.src = chrome.runtime.getURL("page-bridge.js");
    externalScript.async = false;
    externalScript.dataset.ymLocalOverrideBridge = "1";
    externalScript.onload = () => externalScript.remove();
    (document.documentElement || document.head).appendChild(externalScript);
    return;

    const script = document.createElement("script");
    script.textContent = `
      (() => {
        try {
        const SOURCE = "${BRIDGE_SOURCE}";
        const LOCAL_AUDIO_ID = "${LOCAL_AUDIO_ID}";
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
            return batchTrackIds
              .split(",")
              .map((item) => String(item || "").trim())
              .filter(Boolean);
          } catch (error) {
            return [];
          }
        }

        function guessCodecFromContentType(contentType, fallbackCodec) {
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

        function serializeReplacementItems() {
          return JSON.stringify(
            [...replacementMap.values()].map((item) => ({
              trackId: String(item.trackId || ""),
              streamUrl: String(item.streamUrl || ""),
              contentType: String(item.contentType || "audio/mpeg"),
              storedName: String(item.storedName || ""),
            })),
          );
        }

        function buildWorkerBootstrapSource(originalUrl, isModule) {
          const escapedSource = JSON.stringify(SOURCE);
          const escapedUrl = JSON.stringify(String(originalUrl || ""));
          const importLine = isModule
            ? \`import(\${escapedUrl}).catch(() => {});\`
            : \`try { importScripts(\${escapedUrl}); } catch (error) {}\`;

          return \`
            const YMLO_SOURCE = \${escapedSource};
            const ymloReplacementMap = new Map();

            function ymloGuessCodec(contentType, fallbackCodec) {
              const normalized = String(contentType || "").toLowerCase();
              if (normalized.includes("flac")) return "flac";
              if (normalized.includes("wav")) return "wav";
              if (normalized.includes("ogg")) return "ogg";
              if (normalized.includes("mp4") || normalized.includes("aac")) return "aac-mp4";
              if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
              return fallbackCodec || "mp3";
            }

            function ymloReadTrackIdsFromUrl(url) {
              try {
                const parsed = new URL(String(url || ""), self.location && self.location.origin ? self.location.origin : "https://music.yandex.ru");
                const singleTrackId = parsed.searchParams.get("trackId");
                const batchTrackIds = parsed.searchParams.get("trackIds");
                if (singleTrackId) return [String(singleTrackId)];
                if (!batchTrackIds) return [];
                return batchTrackIds.split(",").map((item) => String(item || "").trim()).filter(Boolean);
              } catch (error) {
                return [];
              }
            }

            function ymloBuildReplacementInfo(trackId, currentInfo) {
              const replacement = ymloReplacementMap.get(String(trackId));
              if (!replacement || !replacement.streamUrl) {
                return currentInfo;
              }
              const replacementUrl = String(replacement.streamUrl || "");
              const replacementCodec = replacementUrl.startsWith("blob:")
                ? "mp3"
                : ymloGuessCodec(replacement.contentType, currentInfo && currentInfo.codec);
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
                if (!trackId || !streamUrl) continue;
                ymloReplacementMap.set(trackId, {
                  trackId,
                  streamUrl,
                  contentType: String(item.contentType || "audio/mpeg"),
                  storedName: String(item.storedName || ""),
                });
              }
            });

            for (const item of \${serializeReplacementItems()}) {
              const trackId = String(item.trackId || "");
              const streamUrl = String(item.streamUrl || "");
              if (!trackId || !streamUrl) continue;
              ymloReplacementMap.set(trackId, item);
            }

            const ymloOriginalFetch = self.fetch;
            self.fetch = async (...args) => {
              const requestUrl = typeof args[0] === "string" ? args[0] : ((args[0] && args[0].url) || "");
              const response = await ymloOriginalFetch(...args);
              if (!/api\\\\.music\\\\.yandex\\\\.ru\\\\/get-file-info(\\\\/batch)?/i.test(String(requestUrl || ""))) {
                return response;
              }
              try {
                const text = await response.clone().text();
                const overridden = ymloOverridePayload(JSON.parse(text), requestUrl);
                if (!overridden) return response;
                const headers = new Headers(response.headers);
                headers.set("content-type", "application/json; charset=utf-8");
                return new Response(JSON.stringify(overridden), {
                  status: response.status,
                  statusText: response.statusText,
                  headers,
                });
              } catch (error) {
                return response;
              }
            };

            const ymloOriginalOpen = XMLHttpRequest.prototype.open;
            const ymloOriginalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(...args) {
              this.__ymloUrl = args[1];
              return ymloOriginalOpen.apply(this, args);
            };
            XMLHttpRequest.prototype.send = function(...args) {
              this.addEventListener("load", () => {
                try {
                  const url = this.responseURL || this.__ymloUrl || "";
                  const contentType = this.getResponseHeader("content-type") || "";
                  if (!/api\\\\.music\\\\.yandex\\\\.ru\\\\/get-file-info(\\\\/batch)?/i.test(String(url || "")) || !contentType.includes("json")) {
                    return;
                  }
                  const overridden = ymloOverridePayload(JSON.parse(this.responseText), url);
                  if (!overridden) return;
                  const nextText = JSON.stringify(overridden);
                  Object.defineProperty(this, "responseText", { configurable: true, get() { return nextText; } });
                  Object.defineProperty(this, "response", {
                    configurable: true,
                    get() { return this.responseType === "json" ? overridden : nextText; },
                  });
                } catch (error) {}
              });
              return ymloOriginalSend.apply(this, args);
            };

            \${importLine}
          \`;
        }

        function getReplacementUrlForTrack(trackId) {
          const item = replacementMap.get(String(trackId || ""));
          return item && item.streamUrl ? String(item.streamUrl) : "";
        }

        function getActiveReplacementUrl() {
          const mapped = getReplacementUrlForTrack(activeReplacementTrackId);
          return mapped || activeReplacementUrl || "";
        }

        function shouldOverrideMediaSource(media, value) {
          if (!(media instanceof HTMLMediaElement) || media.id === LOCAL_AUDIO_ID) {
            return false;
          }

          const replacementUrl = getActiveReplacementUrl();
          if (!replacementUrl) {
            return false;
          }

          const nextValue = String(value || "");
          if (!nextValue || nextValue === replacementUrl) {
            return false;
          }

          return true;
        }

        function getOverriddenMediaSource(media, value) {
          const replacementUrl = getActiveReplacementUrl();
          return replacementUrl || String(value || "");
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

            if (!changed) {
              return null;
            }

            return {
              ...payload,
              downloadInfos,
            };
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

        async function maybeOverrideFetchResponse(response, requestUrl) {
          const url = String(requestUrl || "");
          if (!/api\\.music\\.yandex\\.ru\\/get-file-info(\\/batch)?/i.test(url)) {
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
            window.postMessage(
              {
                source: SOURCE,
                type: "replacement-source-hit",
                trackIds: readTrackIdsFromUrl(url),
              },
              "*",
            );
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
            if (!/api\\.music\\.yandex\\.ru\\/get-file-info(\\/batch)?/i.test(url)) {
              return;
            }

            const contentType = xhr.getResponseHeader("content-type") || "";
            if (!contentType.includes("json")) {
              return;
            }

            const originalText = xhr.responseText;
            const overriddenPayload = overrideGetFileInfoPayload(JSON.parse(originalText), url);
            if (!overriddenPayload) {
              inspectText(originalText);
              return;
            }

            const nextText = JSON.stringify(overriddenPayload);
            Object.defineProperty(xhr, "responseText", {
              configurable: true,
              get() {
                return nextText;
              },
            });
            Object.defineProperty(xhr, "response", {
              configurable: true,
              get() {
                return xhr.responseType === "json" ? overriddenPayload : nextText;
              },
            });

            window.postMessage(
              {
                source: SOURCE,
                type: "replacement-source-hit",
                trackIds: readTrackIdsFromUrl(url),
              },
              "*",
            );
            inspectText(nextText);
          } catch (error) {
          }
        }

        function applyMuteStateToMedia(media) {
          if (!(media instanceof HTMLMediaElement) || media.id === LOCAL_AUDIO_ID) {
            return;
          }

          if (pageMuted) {
            if (!media.__ymloSavedState) {
              media.__ymloSavedState = {
                muted: media.muted,
                volume: media.volume,
                paused: media.paused,
              };
            }
            if (!media.paused) {
              try {
                media.pause();
              } catch (error) {
              }
            }
            media.muted = true;
            try {
              media.volume = 0;
            } catch (error) {
            }
            return;
          }

          if (!media.__ymloSavedState) {
            return;
          }

          media.muted = Boolean(media.__ymloSavedState.muted);
          try {
            media.volume = Number(media.__ymloSavedState.volume);
          } catch (error) {
          }
          const shouldResume = media.__ymloSavedState.paused === false;
          media.__ymloSavedState = null;
          if (shouldResume) {
            media.play().catch(() => {});
          }
        }

        function applySuspendStateToContext(context) {
          if (!context || typeof context.state !== "string") {
            return;
          }

          if (pageMuted) {
            if (!context.__ymloWasRunning) {
              context.__ymloWasRunning = context.state === "running";
            }
            if (context.state === "running") {
              context.suspend().catch(() => {});
            }
            return;
          }

          if (!context.__ymloWasRunning) {
            context.__ymloWasRunning = false;
            return;
          }

          context.__ymloWasRunning = false;
          if (context.state === "suspended") {
            context.resume().catch(() => {});
          }
        }

        function rememberMedia(media) {
          if (!(media instanceof HTMLMediaElement)) {
            return media;
          }
          trackedMedia.add(media);
          applyMuteStateToMedia(media);
          return media;
        }

        function setTrackedMediaMuted(muted) {
          pageMuted = Boolean(muted);
          document.querySelectorAll("audio, video").forEach((media) => rememberMedia(media));
          trackedMedia.forEach((media) => {
            applyMuteStateToMedia(media);
          });
        }

        function rememberContext(context) {
          if (!context) {
            return context;
          }
          trackedContexts.add(context);
          applySuspendStateToContext(context);
          return context;
        }

        function setTrackedContextsSuspended(suspended) {
          pageMuted = Boolean(suspended);
          trackedContexts.forEach((context) => {
            applySuspendStateToContext(context);
          });
        }

        function emitTracks(payload) {
          if (!payload) {
            return;
          }

          const tracks = [];
          const seen = new Set();

          function artistName(node) {
            if (!Array.isArray(node)) {
              return "";
            }
            return node.map((artist) => artist && artist.name).filter(Boolean).join(", ");
          }

          function albumId(node) {
            if (Array.isArray(node) && node.length && node[0] && node[0].id != null) {
              return node[0].id;
            }
            return null;
          }

          function maybeTrack(node) {
            if (!node || typeof node !== "object") {
              return;
            }

            const isTrackLike =
              node.id != null &&
              typeof node.title === "string" &&
              (Array.isArray(node.artists) || Array.isArray(node.albums) || node.durationMs != null || node.duration_ms != null);

            if (!isTrackLike) {
              return;
            }

            const trackId = String(node.id);
            if (seen.has(trackId)) {
              return;
            }
            seen.add(trackId);
            tracks.push({
              trackId,
              albumId: albumId(node.albums),
              title: node.title,
              artist: artistName(node.artists),
              durationMs: node.durationMs ?? node.duration_ms ?? null,
            });
          }

          function walk(node) {
            if (!node) {
              return;
            }
            if (Array.isArray(node)) {
              node.forEach(walk);
              return;
            }
            if (typeof node !== "object") {
              return;
            }

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
          if (!text || typeof text !== "string") {
            return;
          }
          const trimmed = text.trim();
          if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
            return;
          }
          try {
            emitTracks(JSON.parse(trimmed));
          } catch (error) {
          }
        }

        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const requestUrl = typeof args[0] === "string"
            ? args[0]
            : (args[0] && args[0].url) || "";
          let response = await originalFetch(...args);
          response = await maybeOverrideFetchResponse(response, requestUrl);
          try {
            response.clone().text().then(inspectText).catch(() => {});
          } catch (error) {
          }
          return response;
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalCreateElement = Document.prototype.createElement;
        const originalPlay = HTMLMediaElement.prototype.play;
        const originalSetAttribute = HTMLMediaElement.prototype.setAttribute;
        const NativeWorker = window.Worker;
        const NativeAudio = window.Audio;
        const NativeAudioContext = window.AudioContext;
        const NativeWebkitAudioContext = window.webkitAudioContext;
        const mediaSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");

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

        Document.prototype.createElement = function(tagName, ...args) {
          const element = originalCreateElement.call(this, tagName, ...args);
          const normalized = String(tagName || "").toLowerCase();
          if (normalized === "audio" || normalized === "video") {
            rememberMedia(element);
          }
          return element;
        };

        HTMLMediaElement.prototype.play = function(...args) {
          rememberMedia(this);
          const result = originalPlay.apply(this, args);
          if (pageMuted && this.id !== LOCAL_AUDIO_ID) {
            Promise.resolve(result).then(() => {
              applyMuteStateToMedia(this);
            }).catch(() => {});
          } else {
            applyMuteStateToMedia(this);
          }
          return result;
        };

        if (mediaSrcDescriptor && typeof mediaSrcDescriptor.set === "function") {
          Object.defineProperty(HTMLMediaElement.prototype, "src", {
            configurable: true,
            enumerable: mediaSrcDescriptor.enumerable,
            get() {
              return mediaSrcDescriptor.get
                ? mediaSrcDescriptor.get.call(this)
                : "";
            },
            set(value) {
              const nextValue = shouldOverrideMediaSource(this, value)
                ? getOverriddenMediaSource(this, value)
                : value;
              return mediaSrcDescriptor.set.call(this, nextValue);
            },
          });
        }

        HTMLMediaElement.prototype.setAttribute = function(name, value) {
          if (String(name || "").toLowerCase() === "src" && shouldOverrideMediaSource(this, value)) {
            return originalSetAttribute.call(this, name, getOverriddenMediaSource(this, value));
          }
          return originalSetAttribute.call(this, name, value);
        };

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
              worker.postMessage({
                source: SOURCE,
                type: "replacement-map",
                items: JSON.parse(serializeReplacementItems()),
              });
            } catch (error) {
            }
            return worker;
          };
          window.Worker.prototype = NativeWorker.prototype;
          Object.setPrototypeOf(window.Worker, NativeWorker);
        }

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
            } catch (error) {
            }
          });
          return originalSend.apply(this, args);
        };

        window.addEventListener("message", (event) => {
          if (event.source !== window) {
            return;
          }
          const data = event.data;
          if (!data || data.source !== SOURCE) {
            return;
          }
          if (data.type === "page-media-mute") {
            setTrackedMediaMuted(Boolean(data.muted));
            setTrackedContextsSuspended(Boolean(data.muted));
            return;
          }
          if (data.type === "replacement-map") {
            const items = data.items || [];
            replacementMap.clear();
            for (const item of items) {
              const trackId = String(item.trackId || "");
              const streamUrl = String(item.streamUrl || "");
              if (!trackId || !streamUrl) {
                continue;
              }
              replacementMap.set(trackId, {
                trackId,
                streamUrl,
                contentType: String(item.contentType || "audio/mpeg"),
                storedName: String(item.storedName || ""),
              });
            }
            if (activeReplacementTrackId) {
              activeReplacementUrl = getReplacementUrlForTrack(activeReplacementTrackId) || activeReplacementUrl;
            }
            trackedWorkers.forEach((worker) => {
              try {
                worker.postMessage({
                  source: SOURCE,
                  type: "replacement-map",
                  items,
                });
              } catch (error) {
              }
            });
            return;
          }
          if (data.type === "active-replacement") {
            activeReplacementTrackId = String(data.trackId || "");
            activeReplacementUrl = String(data.streamUrl || "");
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
        } catch (error) {
          window.__ymloPageDebug = function() {
            return {
              bridgeError: String(error),
              stack: String((error && error.stack) || ""),
            };
          };
        }
      })();
    `;

    (document.documentElement || document.head).appendChild(script);
    script.remove();
  }

  function readDomFallback() {
    const anchors = [...document.querySelectorAll('a[href*="/track/"]')]
      .filter((anchor) => anchor instanceof HTMLAnchorElement)
      .filter(isVisible)
      .map((anchor) => {
        const rect = anchor.getBoundingClientRect();
        const container = anchor.closest('[class*="PlayerBar"], [class*="playerBar"], [class*="BarDesktopPlayer"], [class*="NowPlaying"], footer');
        const containerRect = container instanceof HTMLElement
          ? container.getBoundingClientRect()
          : null;
        let score = 0;

        if (container) {
          score += 120;
        }
        if (rect.bottom >= window.innerHeight - 180) {
          score += 90;
        }
        if (containerRect && containerRect.bottom >= window.innerHeight - 80) {
          score += 50;
        }
        if ((anchor.textContent || "").trim()) {
          score += 5;
        }

        return {
          trackId: parseTrackFromHref(anchor.href),
          albumId: parseAlbumFromHref(anchor.href),
          title: (anchor.textContent || "").trim(),
          artist: "",
          score,
          bottom: rect.bottom,
        };
      })
      .filter((item) => item.trackId && item.score > 0);

    anchors.sort((a, b) => (b.score - a.score) || (b.bottom - a.bottom));
    return anchors[0] || null;
  }

  function readLocationTrackFallback() {
    const trackId = parseTrackFromLocation();
    if (!trackId) {
      return null;
    }

    const anchor = document.querySelector(`a[href*="/track/${trackId}"]`);
    const titleFromAnchor = anchor instanceof HTMLAnchorElement ? (anchor.textContent || "").trim() : "";
    const titleFromDocument = (document.title || "").split(" слушать онлайн")[0].trim();

    return {
      trackId,
      albumId: parseAlbumFromLocation(),
      title: titleFromAnchor || titleFromDocument || "",
      artist: "",
    };
  }

  function readPlayerBarTrackFallback() {
    const anchors = [...document.querySelectorAll('footer a[href*="/track/"], [class*="PlayerBar"] a[href*="/track/"], [class*="playerBar"] a[href*="/track/"], [class*="BarDesktopPlayer"] a[href*="/track/"]')]
      .filter((anchor) => anchor instanceof HTMLAnchorElement)
      .filter(isVisible)
      .map((anchor) => {
        const rect = anchor.getBoundingClientRect();
        return {
          anchor,
          rect,
          text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .filter((item) => item.text && item.rect.bottom >= window.innerHeight - 160)
      .sort((left, right) => left.rect.y - right.rect.y);

    const primary = anchors[0];
    if (!primary) {
      return null;
    }

    return {
      trackId: parseTrackFromHref(primary.anchor.href),
      albumId: parseAlbumFromHref(primary.anchor.href),
      title: primary.text,
      artist: "",
    };
  }

  function detectOfficialMedia() {
    const candidates = [...document.querySelectorAll("audio, video")]
      .filter((element) => element.id !== LOCAL_AUDIO_ID);

    if (!candidates.length) {
      return null;
    }

    candidates.sort((left, right) => {
      const leftScore = Number(!left.paused) + Number(left.currentTime > 0) + Number(Number.isFinite(left.duration));
      const rightScore = Number(!right.paused) + Number(right.currentTime > 0) + Number(Number.isFinite(right.duration));
      return rightScore - leftScore;
    });

    return candidates[0];
  }

  function detectPlayerUi() {
    const timeSlider = document.querySelector('input[type="range"][aria-label="Управление таймкодом"]');
    const volumeSlider = document.querySelector('input[type="range"][aria-label="Управление громкостью"]');
    const muteButton = [...document.querySelectorAll("button")]
      .find((button) => /звук/i.test(button.getAttribute("aria-label") || ""));

    return {
      timeSlider: timeSlider instanceof HTMLInputElement ? timeSlider : null,
      volumeSlider: volumeSlider instanceof HTMLInputElement ? volumeSlider : null,
      muteButton: muteButton instanceof HTMLButtonElement ? muteButton : null,
    };
  }

  function getPlaybackState() {
    if (navigator.mediaSession && typeof navigator.mediaSession.playbackState === "string") {
      return navigator.mediaSession.playbackState;
    }
    return "none";
  }

  function readPlayerCurrentTime(playerUi) {
    if (!playerUi || !playerUi.timeSlider) {
      return 0;
    }
    const value = Number(playerUi.timeSlider.value);
    return Number.isFinite(value) ? value : 0;
  }

  function readPlayerVolume(playerUi) {
    if (!playerUi || !playerUi.volumeSlider) {
      return 1;
    }
    const value = Number(playerUi.volumeSlider.value);
    return Number.isFinite(value) ? value : 1;
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function setSliderValue(input, value) {
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const nextValue = String(value);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(input, nextValue);
    } else {
      input.value = nextValue;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setInputValueSilently(input, value) {
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const nextValue = String(value);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(input, nextValue);
    } else {
      input.value = nextValue;
    }
  }

  function setTimecodeLabel(labelNode, seconds, positionPx = null) {
    if (!(labelNode instanceof HTMLElement)) {
      return;
    }

    const text = formatTime(seconds);
    labelNode.setAttribute("aria-label", text);
    const visibleNode = labelNode.querySelector('[aria-hidden="true"]');
    if (visibleNode instanceof HTMLElement) {
      visibleNode.textContent = text;
    } else {
      labelNode.textContent = text;
    }

    if (positionPx != null) {
      labelNode.style.setProperty("--timecode-position", `${Math.max(0, positionPx)}px`);
    }
  }

  function ensureOfficialMuted(officialMedia, playerUi) {
    setPageMediaMuted(true);

    if (officialMedia) {
      officialMedia.muted = true;
      try {
        officialMedia.volume = 0;
      } catch (error) {
      }
    }

    if (officialMedia) {
      return;
    }

    const label = playerUi && playerUi.muteButton
      ? (playerUi.muteButton.getAttribute("aria-label") || "")
      : "";

    if (playerUi && playerUi.muteButton && /выключить звук/i.test(label)) {
      playerUi.muteButton.click();
      state.mutedByOverride = true;
    }
  }

  function capturePreferredVolume(playerUi, officialMedia = state.officialMedia) {
    const sliderVolume = playerUi && playerUi.volumeSlider
      ? readPlayerVolume(playerUi)
      : null;

    if (Number.isFinite(sliderVolume)) {
      state.preferredVolume = sliderVolume;
      return sliderVolume;
    }

    const mediaVolume = officialMedia ? Number(officialMedia.volume) : NaN;
    if (Number.isFinite(mediaVolume)) {
      state.preferredVolume = mediaVolume;
      return mediaVolume;
    }

    return state.preferredVolume;
  }

  function restoreOfficialAudio(playerUi) {
    setPageMediaMuted(false);

    if (state.officialMedia) {
      state.officialMedia.muted = false;
      try {
        state.officialMedia.volume = Number.isFinite(state.preferredVolume) ? state.preferredVolume : 1;
      } catch (error) {
      }
    }

    if (!state.mutedByOverride || !playerUi || !playerUi.muteButton) {
      state.mutedByOverride = false;
      return;
    }

    const label = playerUi.muteButton.getAttribute("aria-label") || "";
    if (/включить звук/i.test(label)) {
      playerUi.muteButton.click();
    }
    state.mutedByOverride = false;
  }

  function clearReplacementLock() {
    state.lockedTrackInfo = null;
    state.completedReplacementTrackId = null;
    state.advancingAfterReplacement = false;
  }

  function setPendingTrackInfo(trackInfo, ttlMs = 6000) {
    if (!trackInfo || !trackInfo.trackId) {
      state.pendingTrackInfo = null;
      state.pendingTrackUntil = 0;
      return;
    }

    state.pendingTrackInfo = trackInfo;
    state.pendingTrackUntil = Date.now() + ttlMs;
  }

  function pauseOfficialPlayback() {
    if (state.holdingOfficialPlayback) {
      return;
    }

    const playPauseButton = findControlButton([/пауза/i, /pause/i, /play/i, /воспроизвед/i]);
    if (playPauseButton instanceof HTMLButtonElement && getPlaybackState() === "playing") {
      playPauseButton.click();
      state.holdingOfficialPlayback = true;
      return;
    }

    if (state.officialMedia && !state.officialMedia.paused) {
      state.officialMedia.pause();
      state.holdingOfficialPlayback = true;
    }
  }

  function enforceOfficialOverrideState(officialMedia = state.officialMedia, playerUi = detectPlayerUi()) {
    setPageMediaMuted(true);

    if (officialMedia) {
      officialMedia.muted = true;
      try {
        officialMedia.volume = 0;
      } catch (error) {
      }
      if (!officialMedia.paused) {
        try {
          officialMedia.pause();
        } catch (error) {
        }
        state.holdingOfficialPlayback = true;
      }
    }

    const now = Date.now();
    const pauseButton = findControlButton([/пауза/i, /pause/i]);
    if (pauseButton instanceof HTMLButtonElement && now - state.lastOfficialSuppressionAt > 700) {
      state.lastOfficialSuppressionAt = now;
      pauseButton.click();
      state.holdingOfficialPlayback = true;
    }

    const muteLabel = playerUi && playerUi.muteButton
      ? (playerUi.muteButton.getAttribute("aria-label") || "")
      : "";
    if (playerUi && playerUi.muteButton && /выключить звук/i.test(muteLabel)) {
      playerUi.muteButton.click();
      state.mutedByOverride = true;
    }
  }

  function resumeOfficialPlaybackIfHeld() {
    if (!state.holdingOfficialPlayback) {
      return;
    }

    const playPauseButton = findControlButton([/пауза/i, /pause/i, /play/i, /воспроизвед/i]);
    if (playPauseButton instanceof HTMLButtonElement && getPlaybackState() !== "playing") {
      playPauseButton.click();
    } else if (state.officialMedia && state.officialMedia.paused) {
      state.officialMedia.play().catch(() => {});
    }
    state.holdingOfficialPlayback = false;
  }

  function findControlButton(patterns) {
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) => button instanceof HTMLButtonElement)
      .filter(isVisible);

    const matches = (button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${(button.textContent || "").trim()}`.toLowerCase();
      return patterns.some((pattern) => pattern.test(label));
    };

    const playerBarButtons = buttons.filter((button) => {
      const container = button.closest('[class*="PlayerBar"], [class*="playerBar"], [class*="BarDesktopPlayer"], [class*="Sonata"], footer');
      if (!container) {
        return false;
      }
      const rect = button.getBoundingClientRect();
      return rect.bottom >= window.innerHeight - 120;
    });

    return playerBarButtons.find(matches) || buttons.find(matches) || null;
  }

  async function finishReplacementTrack() {
    if (!state.enabled || !state.currentTrackId || state.advancingAfterReplacement) {
      return;
    }

    state.advancingAfterReplacement = true;
    state.enabled = false;
    state.currentReplacementUrl = null;
    const playerUi = detectPlayerUi();
    const detectedTrackInfo = detectCurrentTrackInfo(detectOfficialMedia());

    if (detectedTrackInfo && detectedTrackInfo.trackId && detectedTrackInfo.trackId !== state.currentTrackId) {
      clearReplacementLock();
      restoreOfficialAudio(playerUi);
      resumeOfficialPlaybackIfHeld();
      updateHeaderStatus();
      return;
    }

    if (playerUi && playerUi.timeSlider) {
      const maxValue = Number(playerUi.timeSlider.max);
      if (Number.isFinite(maxValue) && maxValue > 0) {
        setSliderValue(playerUi.timeSlider, maxValue);
        window.setTimeout(() => {
          clearReplacementLock();
          sync().catch((error) => {
            state.lastError = String(error);
          });
        }, 220);
        return;
      }
    }

    const nextButton = findControlButton([/след/, /next/]);
    if (nextButton instanceof HTMLButtonElement) {
      nextButton.click();
      window.setTimeout(() => {
        clearReplacementLock();
        sync().catch((error) => {
          state.lastError = String(error);
        });
      }, 180);
      return;
    }

    const playPauseButton = findControlButton([/пауза/, /pause/, /воспроизвед/, /play/]);
    if (playPauseButton instanceof HTMLButtonElement) {
      playPauseButton.click();
    }

    clearReplacementLock();
    restoreOfficialAudio(playerUi);
    resumeOfficialPlaybackIfHeld();
    updateHeaderStatus();
  }

  function findTrackByMetadata(metadata, officialMedia) {
    const title = normalizeText(metadata.title);
    const artist = normalizeText(metadata.artist);
    const durationMs = officialMedia && Number.isFinite(officialMedia.duration)
      ? Math.round(officialMedia.duration * 1000)
      : null;

    let best = null;
    for (const candidate of state.trackCache.values()) {
      let score = 0;

      if (normalizeText(candidate.title) === title) {
        score += 10;
      } else if (title && normalizeText(candidate.title).includes(title)) {
        score += 4;
      }

      if (artist && normalizeText(candidate.artist) === artist) {
        score += 8;
      } else if (artist && normalizeText(candidate.artist).includes(artist)) {
        score += 3;
      }

      if (durationMs && candidate.durationMs) {
        const diff = Math.abs(candidate.durationMs - durationMs);
        if (diff < 1200) {
          score += 6;
        } else if (diff < 4000) {
          score += 2;
        }
      }

      score += Math.max(0, 3 - Math.floor((Date.now() - candidate.seenAt) / 15000));

      if (!best || score > best.score) {
        best = { ...candidate, score };
      }
    }

    return best && best.score >= 9 ? best : null;
  }

  function detectCurrentTrackInfo(officialMedia) {
    const playbackState = getPlaybackState();
    const metadata = navigator.mediaSession && navigator.mediaSession.metadata
      ? {
          title: navigator.mediaSession.metadata.title || "",
          artist: navigator.mediaSession.metadata.artist || "",
        }
      : { title: "", artist: "" };

    const cachedTrack = findTrackByMetadata(metadata, officialMedia);
    const playerBarTrack = readPlayerBarTrackFallback();
    const locationTrack = readLocationTrackFallback();
    const domTrack = readDomFallback();
    const pendingTrack = state.pendingTrackUntil > Date.now() ? state.pendingTrackInfo : null;
    const hasMetadata = Boolean(metadata.title || metadata.artist);
    const officialPlaybackActive = Boolean(
      officialMedia && (!officialMedia.paused || officialMedia.currentTime > 0)
    );
    const hasReliablePlaybackSignal = Boolean(
      officialPlaybackActive ||
      playbackState === "playing" ||
      (playerBarTrack && playerBarTrack.trackId)
    );
    const recentManualTrigger = Date.now() - state.lastPlayerControlAt < 2500;

    if (pendingTrack && pendingTrack.trackId) {
      return pendingTrack;
    }

    if (
      cachedTrack &&
      hasReliablePlaybackSignal
    ) {
      return {
        trackId: cachedTrack.trackId,
        albumId: cachedTrack.albumId,
        title: metadata.title || cachedTrack.title,
        artist: metadata.artist || cachedTrack.artist,
      };
    }

    if (
      playerBarTrack &&
      playerBarTrack.trackId &&
      (
        hasReliablePlaybackSignal ||
        (state.currentTrackInfo && state.currentTrackInfo.trackId === playerBarTrack.trackId)
      )
    ) {
      return {
        trackId: playerBarTrack.trackId,
        albumId: playerBarTrack.albumId,
        title: metadata.title || playerBarTrack.title,
        artist: metadata.artist || playerBarTrack.artist,
      };
    }

    if (
      recentManualTrigger &&
      state.currentTrackInfo &&
      state.currentTrackInfo.trackId
    ) {
      return state.currentTrackInfo;
    }

    if (
      domTrack &&
      hasReliablePlaybackSignal &&
      (
        !playerBarTrack ||
        playerBarTrack.trackId === domTrack.trackId
      )
    ) {
      return {
        trackId: domTrack.trackId,
        albumId: domTrack.albumId,
        title: metadata.title || domTrack.title,
        artist: metadata.artist || domTrack.artist,
      };
    }

    if (locationTrack && hasReliablePlaybackSignal) {
      return {
        trackId: locationTrack.trackId,
        albumId: locationTrack.albumId,
        title: metadata.title || locationTrack.title,
        artist: metadata.artist || locationTrack.artist,
      };
    }

    return null;
  }

  async function resolveReplacement(trackInfo) {
    if (!trackInfo || !trackInfo.trackId) {
      state.currentReplacementUrl = null;
      state.enabled = false;
      publishActiveReplacementToBridge();
      updateHeaderStatus();
      return;
    }

    if (!(await pingHelper())) {
      state.currentReplacementUrl = null;
      state.enabled = false;
      publishActiveReplacementToBridge();
      updateHeaderStatus();
      return;
    }

    if (USE_SOURCE_INTERCEPT) {
      const localItem = replacementForTrack(trackInfo.trackId);
      if (localItem && localItem.stream_url) {
        try {
          state.currentReplacementUrl = await getPlayableReplacementUrl(trackInfo.trackId, localItem.stream_url);
        } catch (error) {
          state.lastError = String(error);
          state.currentReplacementUrl = null;
        }
      } else {
        state.currentReplacementUrl = null;
      }
      state.enabled = Boolean(localItem && state.currentReplacementUrl);
      publishActiveReplacementToBridge();
      updateHeaderStatus();
      return;
    }

    const localItem = replacementForTrack(trackInfo.trackId);
    if (localItem && localItem.stream_url) {
      try {
        state.currentReplacementUrl = await getPlayableReplacementUrl(trackInfo.trackId, localItem.stream_url);
        updateHeaderStatus();
        return;
      } catch (error) {
        state.lastError = String(error);
      }
    }

    try {
      const response = await helperRequest(`/api/resolve?track_id=${encodeURIComponent(trackInfo.trackId)}`);
      state.helperOnline = response.ok;
      if (!response.ok) {
        state.currentReplacementUrl = null;
        state.enabled = false;
        publishActiveReplacementToBridge();
        updateHeaderStatus();
        return;
      }

      const payload = response.json || {};
      if (payload.active && payload.stream_url) {
        const rawStreamUrl = String(payload.stream_url);
        const separator = rawStreamUrl.includes("?") ? "&" : "?";
        state.currentReplacementUrl = await getPlayableReplacementUrl(
          trackInfo.trackId,
          `${rawStreamUrl}${separator}v=${Date.now()}`,
        );
      } else {
        state.currentReplacementUrl = null;
      }
    } catch (error) {
      state.helperOnline = false;
      state.currentReplacementUrl = null;
      state.enabled = false;
      state.lastError = String(error);
    }

    publishActiveReplacementToBridge();
    updateHeaderStatus();
  }

  function disableOverride(options = {}) {
    const resumeOfficial = options.resumeOfficial !== false;
    const clearTrack = options.clearTrack !== false;
    const local = state.localAudio || document.getElementById(LOCAL_AUDIO_ID);
    const shouldResumeOfficial = !USE_SOURCE_INTERCEPT && resumeOfficial && state.holdingOfficialPlayback;

    if (local instanceof HTMLAudioElement) {
      local.pause();
      local.src = "";
      local.removeAttribute("src");
      try {
        local.load();
      } catch (error) {
      }
      local.currentTime = 0;
      if (local.parentElement) {
        local.parentElement.removeChild(local);
      }
    }

    state.localAudio = null;
    state.enabled = false;
    state.currentReplacementUrl = null;
    state.playRequestedUntil = 0;
    if (clearTrack) {
      clearReplacementLock();
    }

    if (USE_SOURCE_INTERCEPT) {
      restoreOfficialAudio(detectPlayerUi());
      state.holdingOfficialPlayback = false;
      publishActiveReplacementToBridge();
      updateHeaderStatus();
      return;
    }

    restoreOfficialAudio(detectPlayerUi());
    if (shouldResumeOfficial) {
      resumeOfficialPlaybackIfHeld();
    } else {
      state.holdingOfficialPlayback = false;
    }

    updateHeaderStatus();
  }

  function cleanupLegacyOverrideState() {
    const hadLocal = Boolean(state.localAudio || document.getElementById(LOCAL_AUDIO_ID));
    const hadSuppressedOfficial = Boolean(state.holdingOfficialPlayback || state.mutedByOverride);

    if (!hadLocal && !hadSuppressedOfficial) {
      return;
    }

    const local = state.localAudio || document.getElementById(LOCAL_AUDIO_ID);
    if (local instanceof HTMLAudioElement) {
      local.pause();
      local.src = "";
      local.removeAttribute("src");
      try {
        local.load();
      } catch (error) {
      }
      if (local.parentElement) {
        local.parentElement.removeChild(local);
      }
    }

    state.localAudio = null;
    state.holdingOfficialPlayback = false;
    restoreOfficialAudio(detectPlayerUi());
  }

  async function enableOverride(officialMedia, trackInfo, options = {}) {
    if (!state.currentReplacementUrl) {
      disableOverride();
      return;
    }

    const local = ensureLocalAudio();
    const playerUi = detectPlayerUi();
    const preferredVolume = capturePreferredVolume(playerUi, officialMedia);
    const preserveLocalTimeline = Boolean(options.preserveLocalTimeline);
    const playWasRequested = Date.now() < state.playRequestedUntil;
    const replacementAlreadyActive = Boolean(state.enabled && local.src);
    const localPlaybackState = replacementAlreadyActive
      ? (local.paused ? "paused" : "playing")
      : null;
    const shouldRetryRequestedPlay =
      Boolean(
        playWasRequested &&
        replacementAlreadyActive &&
        local.paused &&
        !local.ended &&
        Number(local.currentTime || 0) < 0.75
      );
    const playerCurrentTime = officialMedia ? (officialMedia.currentTime || 0) : readPlayerCurrentTime(playerUi);
    const playerVolume = Number.isFinite(preferredVolume)
      ? preferredVolume
      : (officialMedia ? officialMedia.volume : readPlayerVolume(playerUi));
    const playbackState = preserveLocalTimeline
      ? "playing"
      : shouldRetryRequestedPlay
        ? "playing"
      : localPlaybackState
        ? localPlaybackState
      : playWasRequested
        ? "playing"
        : officialMedia
          ? (officialMedia.paused ? "paused" : "playing")
          : (state.enabled && local.src ? (local.paused ? "paused" : "playing") : getPlaybackState());

    if (local.src !== state.currentReplacementUrl) {
      local.src = state.currentReplacementUrl;
      local.currentTime = preserveLocalTimeline ? 0 : (playerCurrentTime || 0);
      state.completedReplacementTrackId = null;
    }

    ensureOfficialMuted(officialMedia, playerUi);
    if (!state.holdingOfficialPlayback && playbackState === "playing") {
      pauseOfficialPlayback();
    }
    enforceOfficialOverrideState(officialMedia, playerUi);
    local.volume = playerVolume;
    local.playbackRate = officialMedia ? (officialMedia.playbackRate || 1) : 1;

    try {
      if (playbackState !== "playing") {
        local.pause();
      } else if (local.ended) {
        state.enabled = true;
        state.currentTrackInfo = trackInfo;
        updateHeaderStatus();
        return;
      } else {
        await local.play();
      }
      state.enabled = true;
      state.currentTrackInfo = trackInfo;
      state.lockedTrackInfo = trackInfo;
    } catch (error) {
      state.lastError = String(error);
      disableOverride();
      return;
    }

    updateHeaderStatus();
  }

  async function startReplacementPlayback(trackInfo) {
    if (!trackInfo || !trackInfo.trackId || !state.currentReplacementUrl) {
      return;
    }

    const local = ensureLocalAudio();
    const officialMedia = detectOfficialMedia();
    const playerUi = detectPlayerUi();
    const preferredVolume = capturePreferredVolume(playerUi, officialMedia);
    const playerCurrentTime = officialMedia ? (officialMedia.currentTime || 0) : readPlayerCurrentTime(playerUi);

    if (local.src !== state.currentReplacementUrl) {
      local.src = state.currentReplacementUrl;
      local.currentTime = playerCurrentTime || 0;
      state.completedReplacementTrackId = null;
    }

    ensureOfficialMuted(officialMedia, playerUi);
    pauseOfficialPlayback();
    enforceOfficialOverrideState(officialMedia, playerUi);
    local.volume = Number.isFinite(preferredVolume) ? preferredVolume : 1;
    local.playbackRate = officialMedia ? (officialMedia.playbackRate || 1) : 1;
    state.enabled = true;
    state.currentTrackInfo = trackInfo;
    state.currentTrackId = trackInfo.trackId;
    state.lockedTrackInfo = trackInfo;
    await local.play();
    updateHeaderStatus();
  }

  function inferTrackInfoFromAnchor(anchor, trackId) {
    const container = anchor.closest("li, article, [role='row'], div") || anchor.parentElement;
    const title = (anchor.textContent || "").trim();
    let artist = "";

    if (container) {
      const text = (container.textContent || "")
        .replace(title, "")
        .replace(/\s+/g, " ")
        .trim();
      artist = text.slice(0, 120);
    }

    return {
      trackId,
      albumId: parseAlbumFromHref(anchor.href),
      title,
      artist,
    };
  }

  function inferTrackInfoFromNode(node) {
    if (!(node instanceof Element)) {
      return null;
    }

    const pageTrack = readLocationTrackFallback();
    const container = node.closest("li, article, [role='row'], [class*='Track'], [class*='PlayerBar'], [class*='Meta'], div");
    const anchors = container
      ? [...container.querySelectorAll('a[href*="/track/"]')].filter((anchor) => anchor instanceof HTMLAnchorElement)
      : [];

    const primaryAnchor = anchors.find((anchor) => ((anchor.textContent || "").replace(/\s+/g, " ").trim().length > 0)) || anchors[0] || null;
    if (primaryAnchor) {
      const trackId = parseTrackFromHref(primaryAnchor.href);
      if (trackId) {
        return inferTrackInfoFromAnchor(primaryAnchor, trackId);
      }
    }

    return pageTrack;
  }

  function isPlaybackTrigger(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    const button = node.closest("button, [role='button']");
    if (!button) {
      return false;
    }

    const aria = button.getAttribute("aria-label") || "";
    const text = (button.textContent || "").replace(/\s+/g, " ").trim();
    return /воспроизвед/i.test(aria) || /слушать/i.test(text);
  }

  function handlePotentialPlaybackTrigger(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (USE_SOURCE_INTERCEPT) {
      if (target.closest('[class*="PlayerBar"], footer, [class*="playerBar"], [class*="BarDesktopPlayer"]')) {
        state.lastPlayerControlAt = Date.now();
      }

      if (!isPlaybackTrigger(target)) {
        return;
      }

      state.lastPlayerControlAt = Date.now();
      const info = inferTrackInfoFromNode(target) || readLocationTrackFallback();
      if (!info || !info.trackId) {
        return;
      }

      state.currentTrackInfo = info;
      state.currentTrackId = info.trackId;
      setPendingTrackInfo(info);
      clearReplacementLock();
      resolveReplacement(info).catch((error) => {
        state.lastError = String(error);
      });
      return;
    }

    const button = target.closest("button, [role='button']");
    const playerBarButton = button && button.closest('[class*="PlayerBar"], footer, [class*="playerBar"], [class*="BarDesktopPlayer"]')
      ? button
      : null;
    const aria = playerBarButton ? (playerBarButton.getAttribute("aria-label") || "").toLowerCase() : "";
    const local = ensureLocalAudio();
    const now = Date.now();
    state.lastUiTrigger = {
      at: now,
      aria: button ? (button.getAttribute("aria-label") || "") : "",
      isPlayerBar: Boolean(playerBarButton),
      taggedTrackId: button instanceof HTMLElement ? (button.dataset.ymloTriggerTrackId || null) : null,
      locationTrackId: parseTrackFromLocation(),
    };

    if (playerBarButton && state.currentReplacementUrl && state.currentTrackId) {
      if (now < state.suppressTransportToggleUntil) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        return;
      }
      if (/след|next|пред|prev/.test(aria)) {
        state.lastPlayerControlAt = Date.now();
        state.playRequestedUntil = 0;
        state.suppressTransportToggleUntil = 0;
        disableOverride({ resumeOfficial: false });
        state.currentTrackId = null;
        state.currentTrackInfo = null;
        return;
      }

      if (/воспроиз|play|пауза|pause/.test(aria) && state.currentTrackInfo && state.currentTrackInfo.trackId === state.currentTrackId) {
        event.preventDefault();
        event.stopPropagation();
        state.lastPlayerControlAt = Date.now();
        if (local.paused || local.ended) {
          state.playRequestedUntil = Date.now() + 1200;
          startReplacementPlayback(state.currentTrackInfo).catch((error) => {
            state.lastError = String(error);
          });
        } else {
          state.playRequestedUntil = 0;
          local.pause();
          updateHeaderStatus();
        }
        return;
      }
    }

    if (target.closest('[class*="PlayerBar"], footer, [class*="playerBar"], [class*="BarDesktopPlayer"]')) {
      state.lastPlayerControlAt = Date.now();
    }

    if (!isPlaybackTrigger(target)) {
      return;
    }

    state.lastPlayerControlAt = Date.now();
    state.playRequestedUntil = Date.now() + 1200;

    const info = inferTrackInfoFromNode(target);
    const pageTrack = readLocationTrackFallback();
    if (state.enabled && info && info.trackId && info.trackId !== state.currentTrackId) {
      disableOverride({ resumeOfficial: false });
    }
    if (!info || !info.trackId || !replacementForTrack(info.trackId)) {
      return;
    }

    if (!playerBarButton && pageTrack && pageTrack.trackId === info.trackId) {
      const currentPlayingTrackId = state.currentTrackInfo && state.currentTrackInfo.trackId;
      const sameTrackAlreadyPlaying = currentPlayingTrackId === info.trackId;

      state.currentTrackInfo = info;
      state.currentTrackId = info.trackId;
      clearReplacementLock();

      if (sameTrackAlreadyPlaying) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        state.suppressTransportToggleUntil = Date.now() + 1500;

        if (state.currentReplacementUrl) {
          startReplacementPlayback(info)
            .catch((error) => {
              state.lastError = String(error);
            });
          return;
        }

        resolveReplacement(info)
          .then(() => enableOverride(detectOfficialMedia(), info, { preserveLocalTimeline: false }))
          .catch((error) => {
            state.lastError = String(error);
          });
        return;
      }

      resolveReplacement(info)
        .then(() => window.setTimeout(() => {
          sync().catch((error) => {
            state.lastError = String(error);
          });
        }, 220))
        .catch((error) => {
          state.lastError = String(error);
        });
      return;
    }

    state.currentTrackInfo = info;
    state.currentTrackId = info.trackId;
    clearReplacementLock();
    state.currentTrackInfo = info;
    state.currentTrackId = info.trackId;
    resolveReplacement(info)
      .then(() => window.setTimeout(() => {
        sync().catch((error) => {
          state.lastError = String(error);
        });
      }, 80))
      .catch((error) => {
        state.lastError = String(error);
      });
  }

  function handlePlayerRangeSync(event) {
    if (USE_SOURCE_INTERCEPT) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "range" || !state.enabled) {
      return;
    }

    const aria = target.getAttribute("aria-label") || "";
    const local = ensureLocalAudio();

    if (/РЈРїСЂР°РІР»РµРЅРёРµ С‚Р°Р№РјРєРѕРґРѕРј/i.test(aria)) {
      const value = Number(target.value);
      if (Number.isFinite(value)) {
        state.lastPlayerControlAt = Date.now();
        try {
          local.currentTime = value;
        } catch (error) {
          debug("Failed to sync local seek", error);
        }
      }
      return;
    }

    if (/РЈРїСЂР°РІР»РµРЅРёРµ РіСЂРѕРјРєРѕСЃС‚СЊСЋ/i.test(aria)) {
      const value = Number(target.value);
      if (Number.isFinite(value)) {
        local.volume = value;
      }
    }
  }

  function detectPlayerUiRobust() {
    const rangeInputs = [...document.querySelectorAll('input[type="range"]')]
      .filter((node) => node instanceof HTMLInputElement)
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const timeSlider = rangeInputs.find((input) => {
      const aria = (input.getAttribute("aria-label") || "").toLowerCase();
      const max = Number(input.max);
      return aria.includes("тайм") || aria.includes("time") || (Number.isFinite(max) && max > 10);
    }) || null;
    const volumeSlider = rangeInputs.find((input) => {
      if (timeSlider && input === timeSlider) {
        return false;
      }
      const aria = (input.getAttribute("aria-label") || "").toLowerCase();
      const max = Number(input.max);
      return aria.includes("громк") || aria.includes("volume") || (Number.isFinite(max) && max > 0 && max <= 1.5);
    }) || null;

    return { timeSlider, volumeSlider };
  }

  function handlePlayerRangeSyncRobust(event) {
    if (USE_SOURCE_INTERCEPT) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "range" || !state.enabled) {
      return;
    }

    const { timeSlider, volumeSlider } = detectPlayerUiRobust();
    const local = ensureLocalAudio();
    const value = Number(target.value);
    if (!Number.isFinite(value)) {
      return;
    }

    if (timeSlider && target === timeSlider) {
      state.lastPlayerControlAt = Date.now();
      try {
        local.currentTime = value;
      } catch (error) {
        debug("Failed to sync local seek", error);
      }
      return;
    }

    if (volumeSlider && target === volumeSlider) {
      state.preferredVolume = value;
      local.volume = value;
    }
  }

  function handleCustomTransportInput(event) {
    return;
  }

  function updateNativeTransportVisibility(replacementActive) {
    const { timeSlider, volumeSlider } = detectPlayerUiRobust();
    if (timeSlider instanceof HTMLInputElement) {
      timeSlider.style.opacity = "";
      timeSlider.style.pointerEvents = "";
    }
    if (volumeSlider instanceof HTMLInputElement) {
      volumeSlider.style.opacity = "";
      volumeSlider.style.pointerEvents = "";
    }
  }

  function updateTransportUi(root = getRoot()) {
    const local = state.localAudio || document.getElementById(LOCAL_AUDIO_ID);
    const playerUi = detectPlayerUi();
    const { timeSlider, volumeSlider } = detectPlayerUiRobust();
    const replacementActive = Boolean(state.enabled && state.currentReplacementUrl && local instanceof HTMLAudioElement && local.src);

    updateNativeTransportVisibility(replacementActive);

    if (volumeSlider instanceof HTMLInputElement) {
      const liveVolume = Number(volumeSlider.value);
      if (Number.isFinite(liveVolume)) {
        state.preferredVolume = liveVolume;
      }
    } else if (playerUi && playerUi.volumeSlider) {
      const liveVolume = readPlayerVolume(playerUi);
      if (Number.isFinite(liveVolume)) {
        state.preferredVolume = liveVolume;
      }
    }

    if (!(timeSlider instanceof HTMLInputElement)) {
      return;
    }

    if (!replacementActive || !(local instanceof HTMLAudioElement)) {
      return;
    }

    enforceOfficialOverrideState(state.officialMedia, playerUi);

    const duration = Number.isFinite(local.duration) ? Number(local.duration || 0) : 0;
    const currentTime = Math.max(0, Number(local.currentTime || 0));
    const safeDuration = duration > 0 ? duration : 1;
    const safeCurrent = Math.min(currentTime, safeDuration);
    const progress = duration > 0 ? (safeCurrent / duration) * 100 : 0;
    const sliderWidth = timeSlider.getBoundingClientRect().width || 0;
    const thumbPosition = sliderWidth * (progress / 100);

    timeSlider.max = String(safeDuration);
    setInputValueSilently(timeSlider, safeCurrent);
    timeSlider.setAttribute("aria-valuetext", formatTime(safeCurrent));
    timeSlider.style.setProperty("--seek-before-width", `${progress}%`);
    timeSlider.style.setProperty("--buffered-width", "100%");
    timeSlider.style.backgroundSize = `${progress}% 100%`;

    const timeRoot = timeSlider.parentElement;
    if (timeRoot instanceof HTMLElement) {
      timeRoot.style.setProperty("--track-progress", `${progress}%`);
      timeRoot.style.setProperty("--thumb-position", `${thumbPosition}px`);
      const totalLabel = timeRoot.querySelector('[class*="Timecode_root_end"], [class*="TimecodeGroup_timecode_end"]');
      const currentLabel = timeRoot.querySelector('[class*="Timecode_root_start"], [class*="TimecodeGroup_timecode_current"]');
      setTimecodeLabel(totalLabel, duration);
      setTimecodeLabel(currentLabel, safeCurrent, thumbPosition);
    }
  }

  function updateTrackLinkState() {
    const anchors = document.querySelectorAll("a[data-ymlo-track-id]");

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) {
        continue;
      }

      const hrefTrackId = parseTrackFromHref(anchor.href);
      if (hrefTrackId && hrefTrackId !== anchor.dataset.ymloTrackId) {
        anchor.dataset.ymloTrackId = hrefTrackId;
        const staleButton = anchor.nextElementSibling;
        if (staleButton instanceof HTMLButtonElement && staleButton.classList.contains("ymlo-track-action")) {
          staleButton.dataset.ymloTrackId = hrefTrackId;
        }
      }

      const trackId = anchor.dataset.ymloTrackId;
      if (!trackId) {
        continue;
      }

      const hasReplacement = state.replacements.has(trackId);
      anchor.dataset.ymloActive = hasReplacement ? "1" : "0";

      const button = anchor.nextElementSibling;
      if (!(button instanceof HTMLButtonElement) || button.dataset.ymloTrackId !== trackId) {
        continue;
      }

      button.dataset.active = hasReplacement ? "1" : "0";
      button.textContent = "";
      button.title = hasReplacement
        ? "Открыть замену для этого трека"
        : "Добавить локальную замену";
      button.setAttribute("aria-label", button.title);
    }
  }

  function bindTrackLinks() {
    const anchors = document.querySelectorAll('a[href*="/track/"]:not([data-ymlo-track-id])');
    const pageTrackId = parseTrackFromLocation();
    const seenTrackIds = new Set(
      [...document.querySelectorAll(".ymlo-track-action[data-ymlo-track-id]")]
        .map((node) => node.dataset.ymloTrackId)
        .filter(Boolean),
    );

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) {
        continue;
      }

      const trackId = parseTrackFromHref(anchor.href);
      if (!trackId) {
        continue;
      }

      if (pageTrackId && trackId !== pageTrackId) {
        continue;
      }

      if (seenTrackIds.has(trackId)) {
        anchor.dataset.ymloTrackId = trackId;
        anchor.classList.add("ymlo-track-link");
        continue;
      }

      const text = (anchor.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) {
        continue;
      }

      const existingTrackButton = document.querySelector(`.ymlo-track-action[data-ymlo-track-id="${trackId}"]`);
      if (existingTrackButton) {
        anchor.dataset.ymloTrackId = trackId;
        anchor.classList.add("ymlo-track-link");
        continue;
      }

      const container = anchor.closest("li, article, [role='row'], [class*='PlayerBar'], [class*='Track'], [class*='Meta'], div");
      if (container instanceof HTMLElement) {
        const existingButton = container.querySelector(`.ymlo-track-action[data-ymlo-track-id="${trackId}"]`);
        if (existingButton) {
          anchor.dataset.ymloTrackId = trackId;
          anchor.classList.add("ymlo-track-link");
          continue;
        }

        const candidateAnchors = [...container.querySelectorAll(`a[href*="/track/${trackId}"]`)]
          .filter((node) => node instanceof HTMLAnchorElement)
          .filter((node) => ((node.textContent || "").replace(/\s+/g, " ").trim().length > 0));
        if (candidateAnchors.length && candidateAnchors[0] !== anchor) {
          anchor.dataset.ymloTrackId = trackId;
          anchor.classList.add("ymlo-track-link");
          continue;
        }
      }

      anchor.dataset.ymloTrackId = trackId;
      anchor.classList.add("ymlo-track-link");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "ymlo-track-action";
      button.dataset.ymloTrackId = trackId;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const liveTrackId = parseTrackFromHref(anchor.href) || button.dataset.ymloTrackId || trackId;
        const inPlayerBar = Boolean(
          anchor.closest('[class*="PlayerBar"], footer, [class*="playerBar"], [class*="BarDesktopPlayer"]'),
        );
        const trackInfo = inPlayerBar
          ? (getManagerTrackInfo() || inferTrackInfoFromAnchor(anchor, liveTrackId))
          : inferTrackInfoFromAnchor(anchor, liveTrackId);
        openManagerWindow(trackInfo);
      });
      anchor.insertAdjacentElement("afterend", button);
      seenTrackIds.add(trackId);
    }

    updateTrackLinkState();
  }

  function scheduleTrackLinkBinding() {
    if (state.bindScheduled) {
      return;
    }

    state.bindScheduled = true;
    window.setTimeout(() => {
      state.bindScheduled = false;
      bindTrackLinks();
      bindTrackPlayButtons();
    }, 180);
  }

  async function sync() {
    await pingHelper();
    await refreshReplacements();

    const officialMedia = detectOfficialMedia();
    const detectedTrackInfo = detectCurrentTrackInfo(officialMedia);
    const local = USE_SOURCE_INTERCEPT ? state.localAudio : ensureLocalAudio();
    const lockedTrackInfo = state.lockedTrackInfo;
    const localRemaining = local && Number.isFinite(local.duration)
      ? Math.max(0, Number(local.duration || 0) - Number(local.currentTime || 0))
      : 0;
    const recentControlInteraction = Date.now() - state.lastPlayerControlAt < 1200;
    const autoAdvancedWhileLocked =
      Boolean(
        lockedTrackInfo &&
        state.currentReplacementUrl &&
        !state.advancingAfterReplacement &&
        local.src &&
        !local.ended &&
        detectedTrackInfo &&
        detectedTrackInfo.trackId &&
        detectedTrackInfo.trackId !== lockedTrackInfo.trackId &&
        !recentControlInteraction &&
        localRemaining > 1.2
      );
    const shouldKeepLockedTrack =
      Boolean(
        lockedTrackInfo &&
        state.currentReplacementUrl &&
        !state.advancingAfterReplacement &&
        local.src &&
        !local.ended &&
        (
          state.enabled ||
          !detectedTrackInfo ||
          !detectedTrackInfo.trackId ||
          detectedTrackInfo.trackId === lockedTrackInfo.trackId ||
          autoAdvancedWhileLocked
        )
      );
    const trackInfo = shouldKeepLockedTrack ? lockedTrackInfo : detectedTrackInfo;

    if (autoAdvancedWhileLocked) {
      pauseOfficialPlayback();
    }

    state.currentTrackInfo = trackInfo;
    state.officialMedia = officialMedia;

    const nextTrackId = trackInfo ? trackInfo.trackId : null;
    if (nextTrackId !== state.currentTrackId) {
      state.currentTrackId = nextTrackId;
      if (!shouldKeepLockedTrack) {
        clearReplacementLock();
      }
      await resolveReplacement(trackInfo);
    } else if (
      !state.advancingAfterReplacement &&
      trackInfo &&
      trackInfo.trackId &&
      !state.currentReplacementUrl &&
      (replacementForTrack(trackInfo.trackId) || state.helperOnline)
    ) {
      await resolveReplacement(trackInfo);
    }

    if (USE_SOURCE_INTERCEPT) {
      cleanupLegacyOverrideState();
      const hasReplacement = Boolean(
        trackInfo &&
        trackInfo.trackId &&
        state.currentReplacementUrl &&
        replacementForTrack(trackInfo.trackId)
      );
      state.enabled = hasReplacement;
      if (!hasReplacement && state.currentReplacementUrl) {
        state.currentReplacementUrl = null;
        publishActiveReplacementToBridge();
      }
      updateHeaderStatus();
      return;
    }

    if (!trackInfo || !trackInfo.trackId) {
      disableOverride();
      return;
    }

    if (state.advancingAfterReplacement) {
      updateHeaderStatus();
      return;
    }

    if (!state.currentReplacementUrl) {
      disableOverride();
      return;
    }

    await enableOverride(officialMedia, trackInfo, {
      preserveLocalTimeline: autoAdvancedWhileLocked,
    });
  }

  function detectPlayerUi() {
    const { timeSlider, volumeSlider } = detectPlayerUiRobust();
    const muteButton = [...document.querySelectorAll("button")]
      .find((button) => /звук|mute|volume/i.test(button.getAttribute("aria-label") || ""));

    return {
      timeSlider,
      volumeSlider,
      muteButton: muteButton instanceof HTMLButtonElement ? muteButton : null,
    };
  }

  function isPlayPauseLabel(value) {
    return /воспроиз|play|пауза|pause/i.test(String(value || ""));
  }

  function isNextPrevLabel(value) {
    return /след|next|пред|prev/i.test(String(value || ""));
  }

  function pauseOfficialPlayback() {
    if (state.holdingOfficialPlayback) {
      return;
    }

    const playPauseButton = findControlButton([/пауза/i, /pause/i, /play/i, /воспроизвед/i]);
    if (playPauseButton instanceof HTMLButtonElement && getPlaybackState() === "playing") {
      playPauseButton.click();
      state.holdingOfficialPlayback = true;
      return;
    }

    if (state.officialMedia && !state.officialMedia.paused) {
      state.officialMedia.pause();
      state.holdingOfficialPlayback = true;
    }
  }

  function enforceOfficialOverrideState(officialMedia = state.officialMedia, playerUi = detectPlayerUi()) {
    setPageMediaMuted(true);

    if (officialMedia) {
      officialMedia.muted = true;
      try {
        officialMedia.volume = 0;
      } catch (error) {
      }
      if (!officialMedia.paused) {
        try {
          officialMedia.pause();
        } catch (error) {
        }
        state.holdingOfficialPlayback = true;
      }
    }

    const now = Date.now();
    const pauseButton = findControlButton([/пауза/i, /pause/i]);
    if (pauseButton instanceof HTMLButtonElement && now - state.lastOfficialSuppressionAt > 700) {
      state.lastOfficialSuppressionAt = now;
      pauseButton.click();
      state.holdingOfficialPlayback = true;
    }

    const muteLabel = playerUi && playerUi.muteButton
      ? (playerUi.muteButton.getAttribute("aria-label") || "")
      : "";
    if (playerUi && playerUi.muteButton && /выключить звук|mute/i.test(muteLabel)) {
      playerUi.muteButton.click();
      state.mutedByOverride = true;
    }
  }

  function resumeOfficialPlaybackIfHeld() {
    if (!state.holdingOfficialPlayback) {
      return;
    }

    const playPauseButton = findControlButton([/пауза/i, /pause/i, /play/i, /воспроизвед/i]);
    if (playPauseButton instanceof HTMLButtonElement && getPlaybackState() !== "playing") {
      playPauseButton.click();
    } else if (state.officialMedia && state.officialMedia.paused) {
      state.officialMedia.play().catch(() => {});
    }
    state.holdingOfficialPlayback = false;
  }

  async function finishReplacementTrack() {
    if (!state.enabled || !state.currentTrackId || state.advancingAfterReplacement) {
      return;
    }

    state.advancingAfterReplacement = true;
    state.enabled = false;
    state.currentReplacementUrl = null;
    const playerUi = detectPlayerUi();
    const detectedTrackInfo = detectCurrentTrackInfo(detectOfficialMedia());

    if (detectedTrackInfo && detectedTrackInfo.trackId && detectedTrackInfo.trackId !== state.currentTrackId) {
      clearReplacementLock();
      restoreOfficialAudio(playerUi);
      resumeOfficialPlaybackIfHeld();
      updateHeaderStatus();
      return;
    }

    if (playerUi && playerUi.timeSlider) {
      const maxValue = Number(playerUi.timeSlider.max);
      if (Number.isFinite(maxValue) && maxValue > 0) {
        setSliderValue(playerUi.timeSlider, maxValue);
        window.setTimeout(() => {
          clearReplacementLock();
          sync().catch((error) => {
            state.lastError = String(error);
          });
        }, 220);
        return;
      }
    }

    const nextButton = findControlButton([/след/i, /next/i]);
    if (nextButton instanceof HTMLButtonElement) {
      nextButton.click();
      window.setTimeout(() => {
        clearReplacementLock();
        sync().catch((error) => {
          state.lastError = String(error);
        });
      }, 180);
      return;
    }

    const playPauseButton = findControlButton([/пауза/i, /pause/i, /воспроизвед/i, /play/i]);
    if (playPauseButton instanceof HTMLButtonElement) {
      playPauseButton.click();
    }

    clearReplacementLock();
    restoreOfficialAudio(playerUi);
    resumeOfficialPlaybackIfHeld();
    updateHeaderStatus();
  }

  function isPlaybackTrigger(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    const button = node.closest("button, [role='button']");
    if (!button) {
      return false;
    }

    const aria = button.getAttribute("aria-label") || "";
    const text = (button.textContent || "").replace(/\s+/g, " ").trim();
    return /воспроизвед/i.test(aria) || /слушать/i.test(text) || /play/i.test(aria);
  }

  function invokeNativeTrackPlay(trackId, sourceNode = null) {
    const key = String(trackId || "");
    if (!key) {
      return false;
    }

    const buttons = [];

    if (sourceNode instanceof Element) {
      const container = sourceNode.closest('.CommonTrack_root__i6shE, [class*="CommonTrack_root"], [class*="HorizontalCardContainer_root"], li, article, [role="row"]');
      if (container instanceof Element) {
        buttons.push(
          ...[...container.querySelectorAll('button, [role="button"]')]
            .filter((node) => node instanceof HTMLElement)
            .filter(isVisible),
        );
      }
    }

    if (!buttons.length) {
      const trackAnchors = [...document.querySelectorAll(`a[href*="/track/${key}"]`)]
        .filter((anchor) => anchor instanceof HTMLAnchorElement)
        .filter(isVisible);

      for (const anchor of trackAnchors) {
        const container = anchor.closest('.CommonTrack_root__i6shE, [class*="CommonTrack_root"], [class*="HorizontalCardContainer_root"], li, article, [role="row"]');
        if (!(container instanceof Element)) {
          continue;
        }
        buttons.push(
          ...[...container.querySelectorAll('button, [role="button"]')]
            .filter((node) => node instanceof HTMLElement)
            .filter(isVisible),
        );
        if (buttons.length) {
          break;
        }
      }
    }

    if (!buttons.length) {
      buttons.push(
        ...[...document.querySelectorAll('button, [role="button"]')]
          .filter((node) => node instanceof HTMLElement)
          .filter(isVisible),
      );
    }

    for (const button of buttons) {
      const ownKeys = Object.keys(button);
      const fiberKey = ownKeys.find((item) => item.startsWith("__reactFiber$"));
      if (!fiberKey) {
        continue;
      }

      let cursor = button[fiberKey];
      for (let depth = 0; cursor && depth < 14; depth += 1) {
        const props = cursor.memoizedProps || {};
        if (
          props.track &&
          String(props.track.id || "") === key &&
          typeof props.onPlayButtonClick === "function"
        ) {
          props.onPlayButtonClick();
          return true;
        }
        cursor = cursor.return;
      }
    }

    return false;
  }

  function requestNativeTrackPlay(trackId) {
    const key = String(trackId || "");
    if (!key) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const requestId = `native-track-play-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;

      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener("message", handleMessage);
        window.clearTimeout(timeoutId);
        resolve(Boolean(value));
      };

      const handleMessage = (event) => {
        if (event.source !== window) {
          return;
        }
        const data = event.data;
        if (!data || data.source !== BRIDGE_SOURCE || data.type !== "native-track-play-response") {
          return;
        }
        if (String(data.requestId || "") !== requestId) {
          return;
        }
        finish(Boolean(data.ok));
      };

      const timeoutId = window.setTimeout(() => {
        finish(false);
      }, 1200);

      window.addEventListener("message", handleMessage);
      window.postMessage({
        source: BRIDGE_SOURCE,
        type: "native-track-play",
        requestId,
        trackId: key,
      }, "*");
    });
  }

  function bindTrackPlayButtons() {
    for (const node of document.querySelectorAll('[data-ymlo-trigger-track-id]')) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      delete node.dataset.ymloTriggerTrackId;
      delete node.dataset.ymloTriggerAlbumId;
      delete node.dataset.ymloTriggerTitle;
    }

    const anchors = [...document.querySelectorAll('a[data-ymlo-track-id]')]
      .filter((anchor) => anchor instanceof HTMLAnchorElement)
      .filter(isVisible);

    for (const anchor of anchors) {
      const trackId = anchor.dataset.ymloTrackId;
      if (!trackId) {
        continue;
      }

      const anchorRect = anchor.getBoundingClientRect();
      const anchorCenterY = anchorRect.y + (anchorRect.height / 2);
      const playButton = [...document.querySelectorAll('button, [role="button"]')]
        .filter((node) => node instanceof HTMLElement)
        .filter(isVisible)
        .filter((node) => /воспроизвед|play/i.test(node.getAttribute("aria-label") || ""))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            node,
            deltaY: Math.abs((rect.y + (rect.height / 2)) - anchorCenterY),
            deltaX: anchorRect.x - rect.x,
          };
        })
        .filter((item) => item.deltaY < 24 && item.deltaX > 0)
        .sort((left, right) => (left.deltaY - right.deltaY) || (left.deltaX - right.deltaX))[0];

      if (!playButton || !(playButton.node instanceof HTMLElement)) {
        continue;
      }

      playButton.node.dataset.ymloTriggerTrackId = trackId;
      playButton.node.dataset.ymloTriggerAlbumId = parseAlbumFromHref(anchor.href) || "";
      playButton.node.dataset.ymloTriggerTitle = (anchor.textContent || "").trim();

      if (USE_SOURCE_INTERCEPT) {
        continue;
      }

      if (playButton.node.dataset.ymloTriggerBound !== "1") {
        playButton.node.dataset.ymloTriggerBound = "1";
        playButton.node.addEventListener("click", () => {
          const triggerTrackId = playButton.node.dataset.ymloTriggerTrackId || "";
          if (!triggerTrackId || !replacementForTrack(triggerTrackId)) {
            return;
          }

          const info = {
            trackId: triggerTrackId,
            albumId: playButton.node.dataset.ymloTriggerAlbumId || null,
            title: playButton.node.dataset.ymloTriggerTitle || "",
            artist: "",
          };

          state.lastPlayerControlAt = Date.now();
          state.playRequestedUntil = Date.now() + 4000;
          state.currentTrackId = triggerTrackId;
          state.currentTrackInfo = info;
          setPendingTrackInfo(info);
          clearReplacementLock();
          invokeNativeTrackPlay(triggerTrackId, playButton.node);

          resolveReplacement(info)
            .then(() => window.setTimeout(() => {
              sync().catch((error) => {
                state.lastError = String(error);
              });
            }, 120))
            .catch((error) => {
              state.lastError = String(error);
            });
        });
      }
    }
  }

  function inferTrackInfoFromNode(node) {
    if (!(node instanceof Element)) {
      return null;
    }

    const taggedButton = node.closest('[data-ymlo-trigger-track-id]');
    if (taggedButton instanceof HTMLElement && taggedButton.dataset.ymloTriggerTrackId) {
      return {
        trackId: taggedButton.dataset.ymloTriggerTrackId,
        albumId: taggedButton.dataset.ymloTriggerAlbumId || null,
        title: taggedButton.dataset.ymloTriggerTitle || "",
        artist: "",
      };
    }

    const pageTrack = readLocationTrackFallback();
    const container = node.closest("li, article, [role='row'], [class*='Track'], [class*='PlayerBar'], [class*='Meta'], div");
    const anchors = container
      ? [...container.querySelectorAll('a[href*="/track/"]')].filter((anchor) => anchor instanceof HTMLAnchorElement)
      : [];

    const primaryAnchor = anchors.find((anchor) => ((anchor.textContent || "").replace(/\s+/g, " ").trim().length > 0)) || anchors[0] || null;
    if (primaryAnchor) {
      const trackId = parseTrackFromHref(primaryAnchor.href);
      if (trackId) {
        return inferTrackInfoFromAnchor(primaryAnchor, trackId);
      }
    }

    const button = node.closest("button, [role='button']");
    const buttonRect = button instanceof HTMLElement ? button.getBoundingClientRect() : null;
    if (buttonRect) {
      const buttonCenterY = buttonRect.y + (buttonRect.height / 2);
      const rowAnchor = [...document.querySelectorAll('a[href*="/track/"]')]
        .filter((anchor) => anchor instanceof HTMLAnchorElement)
        .filter(isVisible)
        .map((anchor) => {
          const rect = anchor.getBoundingClientRect();
          return {
            anchor,
            deltaY: Math.abs((rect.y + (rect.height / 2)) - buttonCenterY),
            deltaX: rect.x - buttonRect.x,
            textLength: ((anchor.textContent || "").replace(/\s+/g, " ").trim().length),
          };
        })
        .filter((item) => item.deltaY < 24 && item.deltaX > 0 && item.textLength > 0)
        .sort((left, right) => (left.deltaY - right.deltaY) || (left.deltaX - right.deltaX))[0];

      if (rowAnchor && rowAnchor.anchor) {
        const trackId = parseTrackFromHref(rowAnchor.anchor.href);
        if (trackId) {
          return inferTrackInfoFromAnchor(rowAnchor.anchor, trackId);
        }
      }
    }

    return pageTrack;
  }

  function hasVisibleTrackPlaybackControl(trackId) {
    const key = String(trackId || "");
    if (!key) {
      return false;
    }

    const anchors = [...document.querySelectorAll(`a[href*="/track/${key}"]`)]
      .filter((anchor) => anchor instanceof HTMLAnchorElement)
      .filter(isVisible);

    return anchors.some((anchor) => {
      const container = anchor.closest('[class*="CommonTrack_root"], li, article, [role="row"]');
      if (!(container instanceof HTMLElement)) {
        return false;
      }
      return [...container.querySelectorAll('button, [role="button"]')]
        .some((node) => node instanceof HTMLElement && isVisible(node));
    });
  }

  function handlePotentialPlaybackTrigger(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (Date.now() < state.suppressPlaybackTriggerUntil) {
      return;
    }

    const button = target.closest("button, [role='button']");
    const playerBarButton = button && button.closest('[class*="PlayerBar"], footer, [class*="playerBar"], [class*="BarDesktopPlayer"]')
      ? button
      : null;
    const aria = playerBarButton ? (playerBarButton.getAttribute("aria-label") || "").toLowerCase() : "";

    if (USE_SOURCE_INTERCEPT) {
      if (playerBarButton && isNextPrevLabel(aria)) {
        state.lastPlayerControlAt = Date.now();
        state.currentTrackId = null;
        state.currentTrackInfo = null;
        state.currentReplacementUrl = null;
        state.enabled = false;
        clearReplacementLock();
        publishActiveReplacementToBridge();
        updateHeaderStatus();
        return;
      }

      if (target.closest('[class*="PlayerBar"], footer, [class*="playerBar"], [class*="BarDesktopPlayer"]')) {
        state.lastPlayerControlAt = Date.now();
      }

      if (!isPlaybackTrigger(target)) {
        return;
      }

      state.lastPlayerControlAt = Date.now();
      const info = inferTrackInfoFromNode(target) || readLocationTrackFallback();
      if (!info || !info.trackId) {
        return;
      }

      state.currentTrackInfo = info;
      state.currentTrackId = info.trackId;
      setPendingTrackInfo(info);
      clearReplacementLock();
      if (!playerBarButton && state.replacementsReady && hasVisibleTrackPlaybackControl(info.trackId)) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }

        state.suppressPlaybackTriggerUntil = Date.now() + 1200;
        resolveReplacement(info)
          .then(() => requestNativeTrackPlay(info.trackId))
          .then(() => window.setTimeout(() => {
            sync().catch((error) => {
              state.lastError = String(error);
            });
          }, 180))
          .catch((error) => {
            state.lastError = String(error);
          });
        return;
      }

      resolveReplacement(info)
        .then(() => window.setTimeout(() => {
          sync().catch((error) => {
            state.lastError = String(error);
          });
        }, 120))
        .catch((error) => {
          state.lastError = String(error);
        });
      return;
    }

    const local = ensureLocalAudio();
    const now = Date.now();

    if (playerBarButton && state.currentReplacementUrl && state.currentTrackId) {
      if (now < state.suppressTransportToggleUntil) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        return;
      }
      if (isNextPrevLabel(aria)) {
        state.lastPlayerControlAt = Date.now();
        state.playRequestedUntil = 0;
        state.suppressTransportToggleUntil = 0;
        disableOverride({ resumeOfficial: false });
        state.currentTrackId = null;
        state.currentTrackInfo = null;
        return;
      }

      if (isPlayPauseLabel(aria) && state.currentTrackInfo && state.currentTrackInfo.trackId === state.currentTrackId) {
        event.preventDefault();
        event.stopPropagation();
        state.lastPlayerControlAt = Date.now();
        if (local.paused || local.ended) {
          state.playRequestedUntil = Date.now() + 1200;
          startReplacementPlayback(state.currentTrackInfo).catch((error) => {
            state.lastError = String(error);
          });
        } else {
          state.playRequestedUntil = 0;
          local.pause();
          updateHeaderStatus();
        }
        return;
      }
    }

    if (target.closest('[class*="PlayerBar"], footer, [class*="playerBar"], [class*="BarDesktopPlayer"]')) {
      state.lastPlayerControlAt = Date.now();
    }

    if (!isPlaybackTrigger(target)) {
      return;
    }

    state.lastPlayerControlAt = Date.now();
    state.playRequestedUntil = Date.now() + 1200;

    const info = inferTrackInfoFromNode(target);
    const pageTrack = readLocationTrackFallback();
    if (state.enabled && info && info.trackId && info.trackId !== state.currentTrackId) {
      disableOverride({ resumeOfficial: false });
    }
    if (!info || !info.trackId || !replacementForTrack(info.trackId)) {
      return;
    }

    if (!playerBarButton && pageTrack && pageTrack.trackId === info.trackId) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      state.suppressTransportToggleUntil = Date.now() + 1500;
      state.currentTrackInfo = info;
      state.currentTrackId = info.trackId;
      clearReplacementLock();

      if (state.currentReplacementUrl) {
        startReplacementPlayback(info)
          .catch((error) => {
            state.lastError = String(error);
          });
        return;
      }

      resolveReplacement(info)
        .then(() => enableOverride(detectOfficialMedia(), info, { preserveLocalTimeline: false }))
        .catch((error) => {
          state.lastError = String(error);
        });
      return;
    }

    state.currentTrackInfo = info;
    state.currentTrackId = info.trackId;
    clearReplacementLock();
    resolveReplacement(info)
      .then(() => window.setTimeout(() => {
        sync().catch((error) => {
          state.lastError = String(error);
        });
      }, 80))
      .catch((error) => {
        state.lastError = String(error);
      });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE || data.type !== "tracks" || !Array.isArray(data.tracks)) {
      return;
    }
    rememberTracks(data.tracks);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE || data.type !== "replacement-source-hit") {
      return;
    }

    const hitTrackIds = Array.isArray(data.trackIds) ? data.trackIds.map((item) => String(item)) : [];
    if (state.currentTrackId && hitTrackIds.includes(String(state.currentTrackId))) {
      state.enabled = true;
      updateHeaderStatus();
    }
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "ym-local-override-manager") {
      return;
    }

    if (data.type === "replacement-saved" || data.type === "replacement-deleted") {
      refreshTrackAfterReplacementChange(data.trackId || "")
        .catch((error) => {
          state.lastError = String(error);
          updateHeaderStatus();
        });
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== "ym-local-override-test") {
      return;
    }

    if (data.type === "snapshot-request") {
      const local = document.getElementById(LOCAL_AUDIO_ID);
      getBackgroundDebugState().then((backgroundDebug) => {
        window.postMessage({
          source: "ym-local-override-test",
          type: "snapshot-response",
          requestId: data.requestId || null,
          payload: {
            currentTrackId: state.currentTrackId,
            currentTrackInfo: state.currentTrackInfo,
            currentReplacementUrl: state.currentReplacementUrl,
            helperOnline: state.helperOnline,
            enabled: state.enabled,
            lastError: state.lastError,
            holdingOfficialPlayback: state.holdingOfficialPlayback,
            lastUiTrigger: state.lastUiTrigger,
            replacementKeys: [...state.replacements.keys()],
            replacementBlobUrls: [...state.replacementBlobUrls.entries()].map(([trackId, url]) => ({
              trackId: String(trackId || ""),
              url: String(url || ""),
            })),
            backgroundDebug,
            pageDebug: window.__ymloPageDebug ? window.__ymloPageDebug() : null,
            localAudio: local instanceof HTMLAudioElement ? {
              paused: local.paused,
              currentTime: Number(local.currentTime || 0),
              duration: Number.isFinite(local.duration) ? Number(local.duration || 0) : null,
              ended: local.ended,
              src: local.currentSrc || local.src || "",
            } : null,
          },
        }, "*");
      });
      return;
    }

    if (data.type === "start-replacement") {
      const trackId = String(data.trackId || "");
      const cached = state.trackCache.get(trackId) || null;
      const locationTrack = readLocationTrackFallback();
      const info = cached && cached.trackId === trackId
        ? cached
        : (locationTrack && locationTrack.trackId === trackId
            ? locationTrack
            : {
                trackId,
                albumId: null,
                title: "",
                artist: "",
              });

      state.currentTrackId = trackId;
      state.currentTrackInfo = info;
      setPendingTrackInfo(info);
      clearReplacementLock();
      if (USE_SOURCE_INTERCEPT) {
        resolveReplacement(info)
          .then(() => requestNativeTrackPlay(trackId))
          .then((nativeStarted) => sync().then(() => nativeStarted))
          .then((nativeStarted) => {
            window.postMessage({
              source: "ym-local-override-test",
              type: "start-replacement-response",
              requestId: data.requestId || null,
              ok: true,
              nativeStarted,
            }, "*");
          })
          .catch((error) => {
            state.lastError = String(error);
            window.postMessage({
              source: "ym-local-override-test",
              type: "start-replacement-response",
              requestId: data.requestId || null,
              ok: false,
              error: String(error),
            }, "*");
          });
        return;
      }
      resolveReplacement(info)
        .then(() => startReplacementPlayback(info))
        .then(() => {
          window.postMessage({
            source: "ym-local-override-test",
            type: "start-replacement-response",
            requestId: data.requestId || null,
            ok: true,
          }, "*");
        })
        .catch((error) => {
          state.lastError = String(error);
          window.postMessage({
            source: "ym-local-override-test",
            type: "start-replacement-response",
            requestId: data.requestId || null,
            ok: false,
            error: String(error),
          }, "*");
        });
      return;
    }
  });

  window.addEventListener("beforeunload", disableOverride);
  window.addEventListener("beforeunload", () => {
    for (const url of state.replacementBlobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    state.replacementBlobUrls.clear();
  });

  ensureStyles();
  getRoot();
  injectBridge();
  if (!USE_SOURCE_INTERCEPT) {
    ensureLocalAudio();
  }
  window.__ymloDebug = {
    getState() {
      return {
        currentTrackId: state.currentTrackId,
        currentTrackInfo: state.currentTrackInfo,
        currentReplacementUrl: state.currentReplacementUrl,
        helperOnline: state.helperOnline,
        enabled: state.enabled,
        lastError: state.lastError,
        playRequestedUntil: state.playRequestedUntil,
        suppressTransportToggleUntil: state.suppressTransportToggleUntil,
        holdingOfficialPlayback: state.holdingOfficialPlayback,
        replacementKeys: [...state.replacements.keys()],
        replacementItems: [...state.replacements.values()].map((item) => ({
          track_id: String(item.track_id || ""),
          stored_name: String(item.stored_name || ""),
          stream_url: String(item.stream_url || ""),
          content_type: String(item.content_type || ""),
        })),
        replacementBlobUrls: [...state.replacementBlobUrls.entries()].map(([trackId, url]) => ({
          trackId: String(trackId || ""),
          url: String(url || ""),
        })),
      };
    },
  };
  updateHeaderStatus();
  scheduleTrackLinkBinding();
  document.addEventListener("click", handlePotentialPlaybackTrigger, true);
  document.addEventListener("input", handlePlayerRangeSyncRobust, true);
  document.addEventListener("change", handlePlayerRangeSyncRobust, true);

  Promise.resolve().then(async () => {
    try {
      await pingHelper(true);
      await refreshReplacements(true);
      await sync();
    } catch (error) {
      state.lastError = String(error);
      updateHeaderStatus();
    }
  });

  window.setTimeout(() => {
    pingHelper(true)
      .then(() => refreshReplacements(true))
      .then(() => sync())
      .catch((error) => {
        state.lastError = String(error);
        updateHeaderStatus();
      });
  }, 1200);

  setInterval(() => {
    sync().catch((error) => {
      state.lastError = String(error);
      debug("Sync failed", error);
      updateHeaderStatus();
    });
  }, 350);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }

      const hasExternalNode = [...mutation.addedNodes].some(
        (node) => node instanceof HTMLElement && !node.closest(`#${ROOT_ID}`),
      );
      if (hasExternalNode) {
        scheduleTrackLinkBinding();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
