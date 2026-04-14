const form = document.getElementById("upload-form");
const list = document.getElementById("replacement-list");
const countLabel = document.getElementById("count-label");
const formStatus = document.getElementById("form-status");
const refreshButton = document.getElementById("refresh-button");
const clearPrefillButton = document.getElementById("clear-prefill");
const prefillHint = document.getElementById("prefill-hint");
const fileInput = document.getElementById("track-file");
const filePickerName = document.getElementById("file-picker-name");
const urlInput = document.getElementById("track-url");
const submitButton = document.getElementById("submit-button");
const sourceButtons = Array.from(document.querySelectorAll("[data-source-mode]"));
const sourcePanels = Array.from(document.querySelectorAll("[data-source-panel]"));

let sourceMode = "file";

function qs(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

function notifyOpener(type, trackId) {
  if (!window.opener || typeof window.opener.postMessage !== "function") {
    return;
  }
  window.opener.postMessage({ source: "ym-local-override-manager", type, trackId: trackId || "" }, "*");
}

function fillPrefill() {
  const trackId = qs("track_id");
  const title = qs("title");
  const artist = qs("artist");

  if (trackId) {
    document.getElementById("track-id").value = trackId;
    prefillHint.textContent = `Текущий трек из клиента: ${trackId}${title ? ` · ${title}` : ""}${artist ? ` — ${artist}` : ""}`;
  } else {
    prefillHint.textContent = "Можно ввести track ID вручную или открыть это окно из кнопки замены в Яндекс Музыке.";
  }

  if (title) {
    document.getElementById("track-title").value = title;
  }

  if (artist) {
    document.getElementById("track-artist").value = artist;
  }
}

function updateFilePickerLabel() {
  if (!filePickerName || !fileInput) {
    return;
  }
  const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
  filePickerName.textContent = file ? file.name : "Файл не выбран";
}

function setSourceMode(nextMode) {
  sourceMode = nextMode === "url" ? "url" : "file";

  for (const button of sourceButtons) {
    button.classList.toggle("is-active", button.dataset.sourceMode === sourceMode);
  }

  for (const panel of sourcePanels) {
    panel.classList.toggle("is-active", panel.dataset.sourcePanel === sourceMode);
  }

  fileInput.required = sourceMode === "file";
  urlInput.required = sourceMode === "url";
  submitButton.textContent = sourceMode === "file" ? "Сохранить замену" : "Загрузить по ссылке";
  formStatus.textContent = "";
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const rawText = await response.text();
  let parsed = null;

  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch (_error) {
      parsed = null;
    }
  }

  if (!response.ok) {
    const detail = parsed && typeof parsed === "object"
      ? (parsed.detail || JSON.stringify(parsed))
      : (rawText || `Request failed: ${response.status}`);
    throw new Error(detail);
  }

  return parsed ?? {};
}

function renderItem(item) {
  return `
    <article class="replacement-item">
      <div>
        <h3 class="replacement-title">${item.title || "Без названия"}${item.artist ? ` — ${item.artist}` : ""}</h3>
        <p class="replacement-meta">
          <strong>Track ID:</strong> ${item.track_id}<br />
          <strong>Файл:</strong> ${item.original_name}
        </p>
        <audio class="replacement-preview" controls preload="none" src="${item.stream_url}"></audio>
      </div>
      <div class="replacement-actions">
        <button class="button" type="button" data-track-id="${item.track_id}" data-action="delete">Удалить</button>
      </div>
    </article>
  `;
}

async function loadList() {
  const payload = await api("/api/replacements");
  const items = payload.items || [];
  countLabel.textContent = `${items.length} ${items.length === 1 ? "запись" : items.length < 5 ? "записи" : "записей"}`;

  if (!items.length) {
    list.innerHTML = `<div class="empty">Пока нет ни одной локальной замены.</div>`;
    return;
  }

  list.innerHTML = items.map(renderItem).join("");
}

async function deleteItem(trackId) {
  await api(`/api/replacements/${encodeURIComponent(trackId)}`, { method: "DELETE" });
  notifyOpener("replacement-deleted", trackId);
  await loadList();
}

async function saveFromFile() {
  const data = new FormData(form);
  await api("/api/replacements", { method: "POST", body: data });
  return String(data.get("track_id") || "");
}

async function saveFromUrl() {
  const payload = {
    track_id: document.getElementById("track-id").value.trim(),
    title: document.getElementById("track-title").value.trim(),
    artist: document.getElementById("track-artist").value.trim(),
    source_url: urlInput.value.trim(),
  };
  await api("/api/replacements/import-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return payload.track_id;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formStatus.textContent = sourceMode === "file"
    ? "Загружаю файл и сохраняю замену..."
    : "Скачиваю аудио по ссылке и сохраняю замену...";

  try {
    const trackId = sourceMode === "file" ? await saveFromFile() : await saveFromUrl();
    notifyOpener("replacement-saved", trackId);
    form.reset();
    fillPrefill();
    updateFilePickerLabel();
    setSourceMode(sourceMode);
    formStatus.textContent = "Замена сохранена.";
    await loadList();
    if (qs("close") === "1") {
      window.setTimeout(() => window.close(), 250);
    }
  } catch (error) {
    formStatus.textContent = `Ошибка: ${error.message}`;
  }
});

list.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.dataset.action === "delete" && target.dataset.trackId) {
    await deleteItem(target.dataset.trackId);
  }
});

refreshButton.addEventListener("click", async () => {
  await loadList();
});

clearPrefillButton.addEventListener("click", () => {
  document.getElementById("track-id").value = "";
  document.getElementById("track-title").value = "";
  document.getElementById("track-artist").value = "";
  urlInput.value = "";
  prefillHint.textContent = "Поля очищены.";
  formStatus.textContent = "";
  updateFilePickerLabel();
});

fileInput.addEventListener("change", updateFilePickerLabel);

for (const button of sourceButtons) {
  button.addEventListener("click", () => {
    setSourceMode(button.dataset.sourceMode || "file");
  });
}

fillPrefill();
updateFilePickerLabel();
setSourceMode("file");
loadList().catch((error) => {
  list.innerHTML = `<div class="empty">Не удалось загрузить список: ${error.message}</div>`;
});
