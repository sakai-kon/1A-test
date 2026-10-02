const $ = (selector) => document.querySelector(selector);
const CONFIG = window.CHOIR_CONFIG || {};
const SUPABASE_URL = String(CONFIG.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = String(CONFIG.SUPABASE_PUBLISHABLE_KEY || "");
const AUTH_EMAIL = String(CONFIG.AUTH_EMAIL || "");
const API_READY =
  /^https:\/\/[^/]+\.supabase\.co$/.test(SUPABASE_URL) &&
  SUPABASE_KEY &&
  AUTH_EMAIL &&
  !SUPABASE_URL.includes("YOUR-PROJECT") &&
  !SUPABASE_KEY.includes("YOUR-PUBLISHABLE");

const AUDIO_BUCKET = "choir-audio";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 60_000;

const supabaseClient = API_READY
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const state = {
  recorder: null,
  chunks: [],
  blob: null,
  stream: null,
  startedAt: 0,
  timerId: null
};

function showApp(loggedIn) {
  $("#login-view").classList.toggle("hidden", loggedIn);
  $("#app-view").classList.toggle("hidden", !loggedIn);
  $("#logout-button").classList.toggle("hidden", !loggedIn);
}

function formatDate(value) {
  return new Date(value).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

async function requireUser() {
  if (!supabaseClient) throw new Error("Supabaseが未設定です。");
  const { data, error } = await supabaseClient.auth.getUser();
  if (error || !data.user) {
    showApp(false);
    throw new Error("ログインが必要です。");
  }
  return data.user;
}

async function loadSettings() {
  await requireUser();

  const { data, error } = await supabaseClient
    .from("settings")
    .select("key,value");

  if (error) throw error;

  const settings = Object.fromEntries((data || []).map((row) => [row.key, row.value]));
  $("#site-title").textContent = settings.siteTitle || "1A 合唱練習サイト";
  $("#song-title").textContent = settings.songTitle || "曲名未設定";
  $("#song-input").value = settings.songTitle || "";
}

async function loadProtectedAudio(audio, path) {
  if (audio.dataset.loaded === "true") return;

  const { data, error } = await supabaseClient
    .storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(path, 300);

  if (error) throw error;

  audio.src = data.signedUrl;
  audio.dataset.loaded = "true";
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
          await loadProtectedAudio(audio, item.object_path);
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
        if (item.type === "voice" && item.object_path) {
          const { error: storageError } = await supabaseClient
            .storage
            .from(AUDIO_BUCKET)
            .remove([item.object_path]);
          if (storageError) throw storageError;
        }

        const { error } = await supabaseClient
          .from("messages")
          .delete()
          .eq("id", item.id);

        if (error) throw error;
        await loadMessages();
      } catch (error) {
        alert(error.message);
      }
    });

    container.appendChild(article);
  }
}

async function loadMessages() {
  await requireUser();

  const { data, error } = await supabaseClient
    .from("messages")
    .select("id,type,author,title,body,object_path,mime_type,size_bytes,duration_ms,created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  renderMessages(data || []);
}

async function initialize() {
  if (!API_READY) {
    $("#setup-warning").classList.remove("hidden");
    showApp(false);
    return;
  }

  $("#setup-warning").classList.add("hidden");

  const { data } = await supabaseClient.auth.getSession();
  if (!data.session) {
    showApp(false);
    return;
  }

  try {
    await Promise.all([loadSettings(), loadMessages()]);
    showApp(true);
  } catch (error) {
    console.error(error);
    showApp(false);
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";

  if (!API_READY) return;

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: AUTH_EMAIL,
      password: $("#password").value
    });

    if (error) throw error;

    $("#password").value = "";
    await initialize();
  } catch (error) {
    $("#login-error").textContent = "ログインできませんでした。パスワードを確認してください。";
    console.error(error);
  }
});

$("#logout-button").addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
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
    await requireUser();
    const songTitle = $("#song-input").value.trim();
    if (!songTitle) throw new Error("曲名を入力してください。");

    const { error } = await supabaseClient
      .from("settings")
      .upsert({ key: "songTitle", value: songTitle });

    if (error) throw error;
    await loadSettings();
  } catch (error) {
    alert(error.message);
  }
});

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const user = await requireUser();
    const body = $("#message-body").value.trim();
    if (!body) throw new Error("本文を入力してください。");

    const { error } = await supabaseClient
      .from("messages")
      .insert({
        type: "text",
        author: $("#message-author").value.trim() || "匿名",
        body,
        user_id: user.id
      });

    if (error) throw error;

    $("#message-body").value = "";
    await loadMessages();
  } catch (error) {
    alert(error.message);
  }
});

let selectedVoiceFile = null;

function resetVoiceFile() {
  selectedVoiceFile = null;
  $("#voice-file").value = "";
  $("#voice-form").reset();
  $("#voice-form").classList.add("hidden");
  $("#recording-preview").classList.add("hidden");
  $("#recording-preview").removeAttribute("src");
}

$("#voice-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    resetVoiceFile();
    return;
  }

  $("#recording-status").textContent = "";

  if (!file.type.startsWith("audio/")) {
    resetVoiceFile();
    $("#recording-status").textContent = "音声ファイルを選択してください。";
    return;
  }

  if (file.size > MAX_AUDIO_BYTES) {
    resetVoiceFile();
    $("#recording-status").textContent = "10MBを超えているため保存できません。";
    return;
  }

  try {
    const previewUrl = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";

    await new Promise((resolve, reject) => {
      audio.onloadedmetadata = resolve;
      audio.onerror = () => reject(new Error("音声ファイルを読み込めませんでした。"));
      audio.src = previewUrl;
    });

    const durationMs = Math.round(audio.duration * 1000);
    URL.revokeObjectURL(previewUrl);

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      resetVoiceFile();
      $("#recording-status").textContent = "音声の長さを確認できませんでした。";
      return;
    }

    if (durationMs > MAX_AUDIO_DURATION_MS) {
      resetVoiceFile();
      $("#recording-status").textContent = "60秒を超える音声はアップロードできません。";
      return;
    }

    selectedVoiceFile = file;
    $("#recording-preview").src = URL.createObjectURL(file);
    $("#recording-preview").classList.remove("hidden");
    $("#voice-form").classList.remove("hidden");
    $("#voice-form").dataset.durationMs = String(durationMs);
    $("#recording-status").textContent =
      `${file.name}（${formatDuration(durationMs)} / ${(file.size / 1024 / 1024).toFixed(1)}MB）を選択しました。`;
  } catch (error) {
    resetVoiceFile();
    $("#recording-status").textContent = error.message || "音声ファイルを確認できませんでした。";
  }
});

async function uploadVoice(file, objectPath) {
  const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
  if (sessionError || !sessionData.session) throw new Error("ログインが必要です。");

  if (!window.tus?.Upload) {
    throw new Error("大容量アップロード機能の読み込みに失敗しました。");
  }

  const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
  const endpoint = `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`;
  const token = sessionData.session.access_token;

  await new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint,
      retryDelays: [0, 1000, 3000, 5000],
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: AUDIO_BUCKET,
        objectName: objectPath,
        contentType: file.type,
        cacheControl: "3600"
      },
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_KEY
      },
      onError: reject,
      onProgress: (bytesUploaded, bytesTotal) => {
        const percent = Math.floor((bytesUploaded / bytesTotal) * 100);
        $("#recording-status").textContent = `アップロード中… ${percent}%`;
      },
      onSuccess: resolve
    });

    upload.start();
  });
}

$("#voice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedVoiceFile) return;

  try {
    const user = await requireUser();
    const id = crypto.randomUUID();
    const extension = (selectedVoiceFile.name.split(".").pop() || "audio")
      .replace(/[^a-z0-9]+/gi, "") || "audio";
    const objectPath = `voices/${id}.${extension}`;

    $("#recording-status").textContent = "アップロードを開始しています…";
    await uploadVoice(selectedVoiceFile, objectPath);

    const { error } = await supabaseClient
      .from("messages")
      .insert({
        id,
        type: "voice",
        author: $("#voice-author").value.trim() || "匿名",
        title: $("#voice-title").value.trim() || "音声伝言",
        body: "",
        object_path: objectPath,
        mime_type: selectedVoiceFile.type || "application/octet-stream",
        size_bytes: selectedVoiceFile.size,
        duration_ms: Number($("#voice-form").dataset.durationMs || 0),
        user_id: user.id
      });

    if (error) {
      await supabaseClient.storage.from(AUDIO_BUCKET).remove([objectPath]);
      throw error;
    }

    resetVoiceFile();
    $("#recording-status").textContent = "音声を保存しました。";
    await loadMessages();
  } catch (error) {
    $("#recording-status").textContent = error.message || "音声の保存に失敗しました。";
    console.error(error);
  }
});

if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (!session) showApp(false);
  });
}

initialize();
