const $ = (selector) => document.querySelector(selector);
const API_BASE = String(window.CHOIR_CONFIG?.API_BASE || "").replace(/\/$/, "");
const API_READY = /^https:\/\/[^/]+/.test(API_BASE) && !API_BASE.includes("YOUR-WORKER");

const state = {
  token: sessionStorage.getItem("choir_token") || "",
  recorder: null,
  chunks: [],
  blob: null,
  stream: null,
  startedAt: 0,
  timerId: null
};

function apiUrl(path) {
  return API_BASE + (path.startsWith("/") ? path : "/" + path);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (state.token) headers.set("Authorization", "Bearer " + state.token);

  return fetch(apiUrl(path), {
    ...options,
    headers
  });
}

async function api(path, options = {}) {
  const response = await request(path, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    if (response.status === 401) {
      state.token = "";
      sessionStorage.removeItem("choir_token");
      showApp(false);
    }
    const message = typeof data === "object" && data?.error ? data.error : "通信に失敗しました。";
    throw new Error(message);
  }

  return data;
}

function showApp(loggedIn) {
  $("#login-view").classList.toggle("hidden", loggedIn);
  $("#app-view").classList.toggle("hidden", !loggedIn);
  $("#logout-button").classList.toggle("hidden", !loggedIn);
}

function formatDate(ms) {
  return new Date(Number(ms)).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const min = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, "0");
  return min + ":" + sec;
}

async function loadSettings() {
  const settings = await api("/api/settings");
  $("#site-title").textContent = settings.siteTitle || "1A 合唱練習サイト";
  $("#song-title").textContent = settings.songTitle || "曲名未設定";
  $("#song-input").value = settings.songTitle || "";
}

async function loadProtectedAudio(audio, audioUrl) {
  if (audio.dataset.loaded === "true") return;

  audio.disabled = true;
  try {
    const response = await request(audioUrl);
    if (!response.ok) throw new Error("音声を取得できませんでした。");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    audio.src = objectUrl;
    audio.dataset.loaded = "true";
  } catch (error) {
    alert(error.message);
  } finally {
    audio.disabled = false;
  }
}

function renderMessages(items) {
  const container = $("#messages");
  container.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "まだ伝言はありません。";
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const node = $("#message-template").content.cloneNode(true);
    const article = node.querySelector(".message");
    const title = node.querySelector(".message-title");
    const body = node.querySelector(".message-body");
    const audio = node.querySelector(".message-audio");
    const loadAudioButton = node.querySelector(".load-audio");
    const deleteButton = node.querySelector(".delete-button");

    node.querySelector(".message-author").textContent = item.author || "匿名";
    node.querySelector(".message-time").textContent = formatDate(item.created_at);

    title.textContent = item.type === "voice"
      ? (item.title || "音声伝言") + "（" + formatDuration(item.duration_ms) + "）"
      : "文字の伝言";

    body.textContent = item.type === "voice" ? "" : item.body;

    if (item.type === "voice") {
      loadAudioButton.addEventListener("click", async () => {
        loadAudioButton.disabled = true;
        loadAudioButton.textContent = "読み込み中…";
        try {
          await loadProtectedAudio(audio, item.audioUrl);
          loadAudioButton.classList.add("hidden");
          audio.classList.remove("hidden");
          await audio.play();
        } catch (error) {
          alert(error.message);
          loadAudioButton.disabled = false;
          loadAudioButton.textContent = "▶ 音声を再生";
        }
      });
    } else {
      loadAudioButton.remove();
      audio.remove();
    }

    deleteButton.addEventListener("click", async () => {
      if (!confirm("この伝言を削除しますか？")) return;
      try {
        await api("/api/messages/" + encodeURIComponent(item.id), { method: "DELETE" });
        await loadMessages();
      } catch (error) {
        alert(error.message);
      }
    });

    container.appendChild(article);
  }
}

async function loadMessages() {
  const data = await api("/api/messages");
  renderMessages(data.messages || []);
}

async function initialize() {
  if (!API_READY) {
    $("#setup-warning").classList.remove("hidden");
    showApp(false);
    return;
  }

  $("#setup-warning").classList.add("hidden");

  if (!state.token) {
    showApp(false);
    return;
  }

  try {
    await Promise.all([loadSettings(), loadMessages()]);
    showApp(true);
  } catch {
    showApp(false);
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";

  if (!API_READY) return;

  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#password").value })
    });
    state.token = result.token;
    sessionStorage.setItem("choir_token", state.token);
    $("#password").value = "";
    await initialize();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

$("#logout-button").addEventListener("click", async () => {
  if (API_READY) await api("/api/logout", { method: "POST" }).catch(() => {});
  state.token = "";
  sessionStorage.removeItem("choir_token");
  showApp(false);
});

$("#reload-button").addEventListener("click", async () => {
  try {
    await Promise.all([loadSettings(), loadMessages()]);
  } catch (error) {
    alert(error.message);
  }
});

$("#song-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ songTitle: $("#song-input").value })
    });
    await loadSettings();
  } catch (error) {
    alert(error.message);
  }
});

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        author: $("#message-author").value,
        body: $("#message-body").value
      })
    });
    $("#message-body").value = "";
    await loadMessages();
  } catch (error) {
    alert(error.message);
  }
});

function resetRecording() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
  state.startedAt = 0;
  state.chunks = [];
  state.recorder = null;
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  $("#recording-time").textContent = "00:00";
  $("#record-start").disabled = false;
  $("#record-stop").disabled = true;
}

function updateTimer() {
  if (!state.startedAt) return;
  const elapsed = Date.now() - state.startedAt;
  $("#recording-time").textContent = formatDuration(elapsed);
  if (elapsed >= 60_000 && state.recorder?.state === "recording") {
    state.recorder.stop();
  }
}

$("#record-start").addEventListener("click", async () => {
  $("#recording-status").textContent = "";

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $("#recording-status").textContent = "このブラウザでは録音に対応していません。";
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const preferredTypes = [
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus"
    ];
    const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
    state.recorder = mimeType
      ? new MediaRecorder(state.stream, { mimeType })
      : new MediaRecorder(state.stream);

    state.chunks = [];
    state.startedAt = Date.now();

    state.recorder.ondataavailable = (event) => {
      if (event.data.size) state.chunks.push(event.data);
    };

    state.recorder.onstop = () => {
      const duration = Math.min(60_000, Date.now() - state.startedAt);
      state.blob = new Blob(state.chunks, { type: state.recorder.mimeType || "audio/mp4" });
      $("#recording-preview").src = URL.createObjectURL(state.blob);
      $("#recording-preview").classList.remove("hidden");
      $("#voice-form").classList.remove("hidden");
      $("#recording-status").textContent = state.blob.size > 10 * 1024 * 1024
        ? "録音が10MBを超えています。もう一度短めに録音してください。"
        : "録音できました。タイトルを入力して保存できます。";
      $("#voice-form").dataset.durationMs = String(duration);
      resetRecording();
    };

    state.recorder.start(250);
    $("#record-start").disabled = true;
    $("#record-stop").disabled = false;
    state.timerId = setInterval(updateTimer, 250);
    updateTimer();
  } catch {
    resetRecording();
    $("#recording-status").textContent = "マイクを利用できませんでした。ブラウザの権限を確認してください。";
  }
});

$("#record-stop").addEventListener("click", () => {
  if (state.recorder?.state === "recording") state.recorder.stop();
});

$("#voice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.blob) return;

  const form = new FormData();
  form.append("audio", state.blob, "voice");
  form.append("author", $("#voice-author").value);
  form.append("title", $("#voice-title").value);
  form.append("durationMs", $("#voice-form").dataset.durationMs || "0");

  try {
    $("#recording-status").textContent = "アップロード中…";
    await api("/api/voices", { method: "POST", body: form });
    $("#voice-form").reset();
    $("#voice-form").classList.add("hidden");
    $("#recording-preview").classList.add("hidden");
    $("#recording-preview").removeAttribute("src");
    state.blob = null;
    $("#recording-status").textContent = "音声を保存しました。";
    await loadMessages();
  } catch (error) {
    $("#recording-status").textContent = error.message;
  }
});

initialize();
