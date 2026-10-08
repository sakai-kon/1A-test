/**
 * 1A 合唱伝言板 - フロントエンド
 *
 * 画面は3枚（コメント / 曲 / 設定）のタブ切り替え。
 * データは Supabase（Auth + Postgres + Storage）。通信が失敗しても
 * 前回のキャッシュを表示し、エラーは画面上のバナーとトーストで伝えます。
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const CONFIG = window.CHOIR_CONFIG || {};
const SUPABASE_URL = String(CONFIG.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_KEY = String(CONFIG.SUPABASE_PUBLISHABLE_KEY || "").trim();
const AUTH_EMAIL = String(CONFIG.AUTH_EMAIL || "").trim();
// example.com のまま（＝まだ設定していない）なら未設定として扱う
const IS_PLACEHOLDER_EMAIL = /@(example\.(com|org|net)|localhost)$/i.test(AUTH_EMAIL);

const AUDIO_BUCKET = "choir-audio";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MIN_AUDIO_DURATION_MS = 60 * 1000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // オフライン表示用の保持期間
const REFRESH_INTERVAL_MS = 60 * 1000;          // 画面が開いている間の自動更新
const REQUEST_TIMEOUT_MS = 20 * 1000;
const AUTOPLAY_DELAY_MS = 4000;                 // 読み込み後に自動再生をあきらめる時間

// Supabase のプロジェクトURL（*.supabase.co）以外でも動くように https かどうかだけを見る
const API_READY =
  /^https:\/\/[^/\s]+/.test(SUPABASE_URL) && !!SUPABASE_KEY && !!AUTH_EMAIL && !IS_PLACEHOLDER_EMAIL;
const MISSING_CONFIG = [
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_PUBLISHABLE_KEY", SUPABASE_KEY],
  ["AUTH_EMAIL", IS_PLACEHOLDER_EMAIL ? "" : AUTH_EMAIL],
].filter(([, value]) => !value).map(([key]) => key);

const supabaseClient = API_READY && window.supabase?.createClient
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const CACHE_KEYS = { settings: "choir-cache-settings-v3", messages: "choir-cache-messages-v3" };
const PREF_KEYS = { author: "choir-author-v1", rememberAuthor: "choir-author-remember-v1" };

let isAdmin = false;
let bootstrapped = false;
let navReady = false;
let realtimeChannel = null;
let realtimeRetryTimer = null;
let refreshTimer = null;
let selectedTrack = null;
let dataStale = false;
let previewObjectUrl = null;
let lastPlayedId = null;

/* ------------------------------------------------------------------ *
 * 小さなユーティリティ
 * ------------------------------------------------------------------ */

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (!Number.isFinite(s)) return "0:00";
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function errorMessage(err, fallback) {
  const message = err?.message ? String(err.message) : "";
  if (!message || /^(failed to fetch|networkerror|load failed)$/i.test(message)) {
    return "通信できませんでした。インターネット接続を確認してもう一度お試しください。";
  }
  return fallback ? message + "（" + fallback + "）" : message;
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + "がタイムアウトしました。")), REQUEST_TIMEOUT_MS)
    ),
  ]);
}

function toast(message, kind = "info") {
  const host = $("#toasts");
  if (!host || !message) return;
  const node = document.createElement("div");
  node.className = "toast toast-" + kind;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add("toast-out");
    setTimeout(() => node.remove(), 260);
  }, kind === "error" ? 6000 : 3200);
}

/** ボタンを作業中に押しっぱなし（二重送信）できないようにする */
function setBusy(form, busy, busyLabel) {
  if (!form) return;
  $$("button", form).forEach((btn) => {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
    if (btn.classList.contains("text-button")) {
      btn.disabled = busy;
      return;
    }
    btn.disabled = busy;
    btn.classList.toggle("is-busy", busy);
    btn.textContent = busy ? (busyLabel || "処理中…") : btn.dataset.label;
  });
}

function setBanner(selector, message) {
  const node = $(selector);
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("hidden", !message);
}

function setStatus(selector, message, isError = false) {
  const node = $(selector);
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("is-error", !!isError && !!message);
}

/* ------------------------------------------------------------------ *
 * キャッシュ（通信できないときの表示用）
 * ------------------------------------------------------------------ */

function cacheRead(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v && Number.isFinite(v.savedAt) ? v : null;
  } catch {
    return null;
  }
}

function cacheWrite(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    /* 保存できなくても表示は続けられる */
  }
}

function cacheDrop(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function fresh(entry) {
  return !!entry && Date.now() - entry.savedAt < CACHE_TTL_MS;
}

/* ------------------------------------------------------------------ *
 * 表示
 * ------------------------------------------------------------------ */

function renderSettings(s) {
  const settings = s || {};
  $("#site-title").textContent = settings.siteTitle || "1A 合唱伝言板";
  $("#song-title").textContent = settings.songTitle || "曲名未設定";
  const siteInput = $("#site-input");
  const songInput = $("#song-input");
  if (siteInput && document.activeElement !== siteInput) siteInput.value = settings.siteTitle || "";
  if (songInput && document.activeElement !== songInput) songInput.value = settings.songTitle || "";
  document.title = (settings.siteTitle || "1A 合唱伝言板") + " | 合唱伝言板";
}

function showApp(loggedIn) {
  $("#login-view").classList.toggle("hidden", loggedIn);
  $("#admin-login-view").classList.add("hidden");
  $("#app-view").classList.toggle("hidden", !loggedIn);
  $("#logout-button").classList.toggle("hidden", !loggedIn);
  $("#role-badge").classList.toggle("hidden", !loggedIn);
  $("#role-badge").textContent = isAdmin ? "管理者" : "メンバー";
  const settingsTab = $("#settings-tab");
  if (settingsTab) settingsTab.classList.toggle("hidden", !isAdmin);
  // 設定タブを開いたままログアウトしたら、コメント画面に戻す
  if (!isAdmin && $("#settings-page")?.classList.contains("active-page")) showPage("comments-page");
}

function setBooting(on, text) {
  const overlay = $("#boot-overlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !on);
  if (on) $("#boot-text").textContent = text || "読み込み中…";
}

function setConnection(text) {
  const node = $("#connection-status");
  if (!node) return;
  node.textContent = text || "";
  node.classList.toggle("hidden", !text);
}

/* ------------------------------------------------------------------ *
 * 認証・権限
 * ------------------------------------------------------------------ */

async function currentUser() {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.getUser();
  if (error) throw error;
  return data?.user || null;
}

async function requireUser() {
  const u = await currentUser();
  if (!u) throw new Error("ログインが必要です。");
  return u;
}

async function refreshRole() {
  const u = await currentUser();
  isAdmin = false;
  if (!u) return false;
  const { data, error } = await supabaseClient
    .from("admins")
    .select("user_id")
    .eq("user_id", u.id)
    .maybeSingle();
  if (error) throw error;
  isAdmin = !!data;
  return isAdmin;
}

async function requireAdmin() {
  const u = await requireUser();
  if (!isAdmin) throw new Error("この操作は管理者だけが行えます。");
  return u;
}

/* ------------------------------------------------------------------ *
 * データ取得
 * ------------------------------------------------------------------ */

async function loadSettings(force = false) {
  await requireUser();
  const cached = cacheRead(CACHE_KEYS.settings);
  if (cached?.data) {
    renderSettings(cached.data);
    if (!force && fresh(cached)) return cached.data;
  }

  const { data, error } = await withTimeout(
    supabaseClient.from("settings").select("key,value"),
    "設定の読み込み"
  );
  if (error) throw error;
  const settings = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  renderSettings(settings);
  cacheWrite(CACHE_KEYS.settings, settings);
  return settings;
}

async function loadMessages(force = false) {
  await requireUser();
  const cached = cacheRead(CACHE_KEYS.messages);
  if (cached?.data) {
    renderMessages(cached.data);
    if (!force && fresh(cached)) return cached.data;
  }

  const { data, error } = await withTimeout(
    supabaseClient
      .from("messages")
      .select("id,type,author,title,body,object_path,mime_type,size_bytes,duration_ms,created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    "コメントの読み込み"
  );
  if (error) throw error;
  const messages = data || [];
  renderMessages(messages);
  cacheWrite(CACHE_KEYS.messages, messages);
  return messages;
}

/** 自分が投稿した直後はキャッシュを捨てて、必ずサーバーから取り直す */
async function reloadMessages() {
  cacheDrop(CACHE_KEYS.messages);
  return loadMessages(true);
}

async function reloadSettings() {
  cacheDrop(CACHE_KEYS.settings);
  return loadSettings(true);
}

async function signedAudioUrl(path) {
  const cacheKey = "choir-audio-url-v1:" + path;
  const now = Date.now();
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.url && Number.isFinite(cached.expiresAt) && cached.expiresAt > now + 15000) {
      return cached.url;
    }
  } catch {
    /* 署名URLは取り直せばよい */
  }

  const expiresIn = 3600;
  const { data, error } = await supabaseClient.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(path, expiresIn);
  if (error) throw error;

  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ url: data.signedUrl, expiresAt: now + expiresIn * 1000 }));
  } catch {
    /* ignore */
  }
  return data.signedUrl;
}

/* ------------------------------------------------------------------ *
 * カード描画
 * ------------------------------------------------------------------ */

let restorePlayback = null;

function renderMessages(items) {
  const list = Array.isArray(items) ? items : [];
  const playing = document.querySelector(".message-audio[src]");
  if (playing && !playing.paused && playing.getAttribute("src")) {
    restorePlayback = {
      id: playing.closest(".message")?.dataset.id || null,
      src: playing.getAttribute("src"),
      time: playing.currentTime || 0,
    };
  }

  renderList(list.filter((i) => i.type === "text"), "#text-messages", "まだコメントはありません。最初の1件を投稿してみましょう。");
  renderList(list.filter((i) => i.type === "voice"), "#song-messages", "まだ曲はありません。");
  renderAdminList(list);

  const textCount = list.filter((i) => i.type === "text").length;
  const songCount = list.filter((i) => i.type === "voice").length;
  $("#message-count").textContent = String(textCount);
  $("#song-count").textContent = String(songCount);
  $("#message-list-label").textContent = textCount + "件";
  $("#song-list-label").textContent = songCount + "曲";
}

function renderList(items, selector, emptyText) {
  const root = $(selector);
  if (!root) return;
  root.replaceChildren();

  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = emptyText;
    root.appendChild(p);
    return;
  }
  for (const item of items) root.appendChild(createMessageCard(item));
}

function createMessageCard(item) {
  const node = $("#message-template").content.cloneNode(true);
  const article = node.querySelector(".message");
  const isSong = item.type === "voice";

  article.dataset.id = item.id;
  article.classList.toggle("message-song", isSong);
  article.querySelector(".message-type").textContent = isSong ? "曲" : "コメント";
  article.querySelector(".message-author").textContent = item.author || "匿名";
  article.querySelector(".message-time").textContent = formatDate(item.created_at);
  article.querySelector(".message-time").setAttribute("datetime", item.created_at || "");
  article.querySelector(".message-pending").classList.toggle("hidden", !item._pending);

  if (isSong) {
    article.querySelector(".message-title").textContent = item.title || "曲";
    article.querySelector(".message-body").classList.add("hidden");
    article.querySelector(".message-meta").textContent = [
      formatDuration(item.duration_ms),
      formatBytes(item.size_bytes),
    ]
      .filter(Boolean)
      .join(" ・ ");
    setupAudioPlayer(article, item);
  } else {
    article.querySelector(".message-title").classList.add("hidden");
    article.querySelector(".message-meta").classList.add("hidden");
    article.querySelector(".audio-wrap").classList.add("hidden");
    article.querySelector(".message-body").textContent = item.body || "";
  }

  return article;
}

/**
 * 曲カードの再生まわり。
 * 音声ファイルは非公開バケットにあるので、再生ボタンを押したときに
 * 短時間だけ有効な署名URLを取りに行きます。
 */
function setupAudioPlayer(article, item) {
  const audio = article.querySelector(".message-audio");
  const bar = article.querySelector(".load-audio");
  const progress = article.querySelector(".audio-progress");
  const progressBar = article.querySelector(".audio-progress-bar");
  const errorNode = article.querySelector(".audio-error");
  let autoPlay = false;
  let autoPlayTimer = null;

  const idle = () => {
    bar.disabled = false;
    bar.textContent = audio.dataset.loaded ? "▶ 再生する" : "▶ 曲を読み込む";
  };

  // 一覧の再描画（ほかの人の投稿など）で消えた再生状態を引き継ぐ
  const restore = restorePlayback && restorePlayback.id === item.id ? restorePlayback : null;
  if (restore?.src) {
    restorePlayback = null;
    audio.src = restore.src;
    audio.dataset.loaded = "true";
    bar.classList.add("hidden");
    audio.removeAttribute("hidden");
    audio.classList.remove("hidden");
    progress.classList.remove("hidden");
    const resume = () => {
      try {
        audio.currentTime = restore.time || 0;
      } catch {
        /* シークできない形式なら先頭から */
      }
      audio.removeEventListener("loadedmetadata", resume);
      audio.play().catch(() => {});
    };
    audio.addEventListener("loadedmetadata", resume);
    audio.play().catch(() => {});
  }

  const fail = (err) => {
    if (autoPlayTimer) clearTimeout(autoPlayTimer);
    errorNode.textContent = errorMessage(err, "曲の読み込みに失敗しました");
    audio.dataset.loaded = "";
    audio.removeAttribute("src");
    audio.setAttribute("hidden", "");
    audio.classList.add("hidden");
    progress.classList.add("hidden");
    idle();
    console.error("曲の読み込みエラー:", err);
  };

  bar.addEventListener("click", async () => {
    if (audio.dataset.loaded) {
      bar.classList.add("hidden");
      audio.removeAttribute("hidden");
      audio.classList.remove("hidden");
      try {
        await audio.play();
      } catch (err) {
        // 自動再生がブロックされただけなので、controlsから操作してもらう
        console.warn("自動再生できませんでした:", err);
      }
      return;
    }

    bar.disabled = true;
    bar.textContent = "読み込み中…";
    errorNode.textContent = "";
    autoPlay = true;
    autoPlayTimer = setTimeout(() => {
      autoPlay = false;
    }, AUTOPLAY_DELAY_MS);

    try {
      audio.src = await signedAudioUrl(item.object_path);
      audio.dataset.loaded = "true";
      audio.removeAttribute("hidden");
      audio.classList.remove("hidden");
      bar.classList.add("hidden");
      if (autoPlay) {
        await audio.play();
      } else {
        idle();
      }
    } catch (err) {
      fail(err);
    }
  });

  audio.addEventListener("error", () => {
    if (!audio.dataset.loaded) return;
    // 署名URLの有効期限切れなど → キャッシュを捨てて次にもう一度取り直す
    try {
      sessionStorage.removeItem("choir-audio-url-v1:" + item.object_path);
    } catch {
      /* ignore */
    }
    fail(new Error("再生できませんでした。もう一度お試しください。"));
  });

  audio.addEventListener("playing", () => {
    lastPlayedId = item.id;
    bar.classList.add("hidden");
    progress.classList.remove("hidden");
  });

  audio.addEventListener("timeupdate", () => {
    const total = audio.duration;
    const pct = Number.isFinite(total) && total > 0 ? (audio.currentTime / total) * 100 : 0;
    progressBar.style.width = pct.toFixed(2) + "%";
  });

  audio.addEventListener("ended", () => {
    progressBar.style.width = "0%";
  });
}

/** 設定タブの「投稿の管理」一覧（削除はここから） */
function renderAdminList(items) {
  const root = $("#admin-message-list");
  if (!root) return;
  root.replaceChildren();

  const label = $("#admin-list-label");
  if (label) label.textContent = items.length + "件";
  if (!isAdmin) return;

  const tpl = $("#admin-row-template");
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "投稿はまだありません。";
    root.appendChild(p);
    return;
  }

  for (const item of items) {
    const row = tpl.content.cloneNode(true);
    const isSong = item.type === "voice";
    row.querySelector(".admin-row-type").textContent = isSong ? "曲" : "コメント";
    row.querySelector(".admin-row-text").textContent =
      (isSong ? item.title || "曲" : item.body || "").slice(0, 60) || "（本文なし）";
    row.querySelector(".admin-row-meta").textContent =
      [item.author || "匿名", formatDate(item.created_at)].filter(Boolean).join(" ・ ");
    const btn = row.querySelector(".admin-row-delete");
    btn.dataset.id = item.id;
    btn.addEventListener("click", () => deleteMessage(item, btn));
    root.appendChild(row);
  }
}

async function deleteMessage(item, button) {
  const kind = item.type === "voice" ? "曲" : "コメント";
  const preview = (item.type === "voice" ? item.title : item.body) || "";
  const ok = window.confirm(
    "この" + kind + "を削除しますか？\n\n" + (preview ? preview.slice(0, 60) + "\n\n" : "") + "削除すると元に戻せません。"
  );
  if (!ok) return;

  if (button) button.disabled = true;
  try {
    await requireAdmin();
    const { error } = await supabaseClient.from("messages").delete().eq("id", item.id);
    if (error) throw error;
    if (item.object_path) {
      const { error: storageError } = await supabaseClient.storage.from(AUDIO_BUCKET).remove([item.object_path]);
      if (storageError) console.warn("音声ファイルの削除に失敗しました:", storageError);
    }
    toast(kind + "を削除しました。", "success");
    await reloadMessages();
  } catch (err) {
    if (button) button.disabled = false;
    toast(errorMessage(err, "削除できませんでした"), "error");
    console.error("削除エラー:", err);
  }
}

/* ------------------------------------------------------------------ *
 * タブ切り替え
 * ------------------------------------------------------------------ */

let showPage = () => {};

function setupPageNavigation() {
  if (navReady) return;
  navReady = true;

  const tabs = $$(".nav-item[data-page]");
  const pages = $$(".page-view[data-page]");
  if (!tabs.length || !pages.length) return;

  showPage = (pageId, updateHash = true) => {
    const target = document.getElementById(pageId);
    if (!target) return;
    // 権限などで隠しているタブは開けない（URLハッシュからの直接指定も含む）
    const tab = tabs.find((t) => t.dataset.page === pageId);
    if (tab?.classList.contains("hidden")) {
      if (pageId !== "comments-page") showPage("comments-page", updateHash);
      return;
    }

    tabs.forEach((t) => {
      const active = t.dataset.page === pageId;
      t.classList.toggle("active", active);
      t.setAttribute("aria-pressed", String(active));
    });
    pages.forEach((page) => {
      const active = page.id === pageId;
      page.classList.toggle("active-page", active);
      page.classList.toggle("hidden", !active);
    });

    if (updateHash) history.replaceState(null, "", "#" + pageId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => showPage(tab.dataset.page));
    tab.addEventListener("keydown", (e) => {
      const visible = tabs.filter((t) => !t.classList.contains("hidden"));
      const pos = visible.indexOf(tab);
      let next = null;
      if (e.key === "ArrowRight") next = visible[(pos + 1) % visible.length];
      if (e.key === "ArrowLeft") next = visible[(pos - 1 + visible.length) % visible.length];
      if (!next) return;
      e.preventDefault();
      next.focus();
      showPage(next.dataset.page);
    });
    tab.setAttribute("tabindex", index === 0 ? "0" : "-1");
  });

  const hash = location.hash.replace(/^#/, "");
  const allowed = tabs.some((t) => t.dataset.page === hash && !t.classList.contains("hidden"));
  showPage(allowed ? hash : "comments-page", false);
}

/* ------------------------------------------------------------------ *
 * ログイン / ログアウト
 * ------------------------------------------------------------------ */

function showLoginView(view) {
  $("#login-view").classList.toggle("hidden", view !== "login");
  $("#admin-login-view").classList.toggle("hidden", view !== "admin");
  const input = view === "admin" ? $("#admin-email") : $("#password");
  setTimeout(() => input?.focus(), 30);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";

  if (!API_READY || !supabaseClient) {
    $("#login-error").textContent = "サイトの設定が完了していないためログインできません。管理者に伝えてください。";
    return;
  }

  const form = e.currentTarget;
  setBusy(form, true, "確認中…");
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: AUTH_EMAIL,
      password: $("#password").value,
    });
    if (error) throw error;
    $("#password").value = "";
    await initialize();
  } catch (err) {
    console.error("ログイン処理エラー:", err);
    $("#login-error").textContent = /invalid login credentials/i.test(err?.message || "")
      ? "パスワードが違います。"
      : errorMessage(err, "ログインできませんでした");
  } finally {
    setBusy(form, false);
  }
});

$("#show-admin-login").addEventListener("click", () => showLoginView("admin"));
$("#back-to-login").addEventListener("click", () => showLoginView("login"));

$("#admin-login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#admin-login-error").textContent = "";

  if (!API_READY || !supabaseClient) {
    $("#admin-login-error").textContent = "サイトの設定が完了していないためログインできません。";
    return;
  }

  const form = e.currentTarget;
  setBusy(form, true, "確認中…");
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: $("#admin-email").value.trim(),
      password: $("#admin-password").value,
    });
    if (error) throw error;

    await refreshRole().catch(() => false);
    if (!isAdmin) {
      await supabaseClient.auth.signOut().catch(() => {});
      throw new Error("このアカウントは管理者として登録されていません。");
    }
    $("#admin-password").value = "";
    await initialize();
  } catch (err) {
    console.error("管理者ログインエラー:", err);
    $("#admin-login-error").textContent = /invalid login credentials/i.test(err?.message || "")
      ? "メールアドレスまたはパスワードが違います。"
      : err?.message || "管理者ログインに失敗しました。";
  } finally {
    setBusy(form, false);
  }
});

$("#logout-button").addEventListener("click", async () => {
  const button = $("#logout-button");
  button.disabled = true;
  try {
    await stopRealtime();
    if (supabaseClient) await supabaseClient.auth.signOut();
  } catch (err) {
    console.error("ログアウトエラー:", err);
  } finally {
    isAdmin = false;
    setConnection("");
    showApp(false);
    button.disabled = false;
    toast("ログアウトしました。", "info");
  }
});

/* ------------------------------------------------------------------ *
 * 更新ボタン
 * ------------------------------------------------------------------ */

$("#reload-button").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  button.textContent = "更新中…";
  try {
    await Promise.all([reloadSettings(), reloadMessages()]);
    dataStale = false;
    setBanner("#messages-error", "");
    setBanner("#songs-error", "");
    toast("最新の状態に更新しました。", "success");
  } catch (err) {
    const text = errorMessage(err, "更新できませんでした");
    setBanner("#messages-error", text);
    toast(text, "error");
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.label || "更新";
  }
});

/* ------------------------------------------------------------------ *
 * コメント投稿
 * ------------------------------------------------------------------ */

const messageBody = $("#message-body");
const charCounter = $("#message-count-chars");

function updateCharCounter() {
  if (!charCounter) return;
  charCounter.textContent = messageBody.value.length + " / " + messageBody.maxLength;
}
messageBody.addEventListener("input", updateCharCounter);
updateCharCounter();

function readStoredAuthor() {
  try {
    return localStorage.getItem(PREF_KEYS.author) || "";
  } catch {
    return "";
  }
}

// 「名前を覚えておく」にチェックが入っていれば、開いたときに名前を入れておく
(function restoreAuthorName() {
  try {
    if (localStorage.getItem(PREF_KEYS.rememberAuthor) !== "1") return;
    const stored = readStoredAuthor();
    if (!stored) return;
    const checkbox = $("#remember-author");
    if (checkbox) checkbox.checked = true;
    const input = $("#message-author");
    if (input && !input.value) input.value = stored;
  } catch {
    /* ignore */
  }
})();

function rememberAuthor() {
  const remember = $("#remember-author").checked;
  try {
    localStorage.setItem(PREF_KEYS.rememberAuthor, remember ? "1" : "");
    if (remember) localStorage.setItem(PREF_KEYS.author, $("#message-author").value.trim());
  } catch {
    /* ignore */
  }
}

$("#message-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const body = messageBody.value.trim();

  if (!body) {
    messageBody.focus();
    toast("コメントの内容を入力してください。", "error");
    return;
  }

  const authorInput = $("#message-author");
  const author = authorInput.value.trim() || "匿名";
  rememberAuthor();
  setBusy(form, true, "送信中…");

  // まず手元に表示して、送信結果をあとから反映する
  const tempId = "pending-" + Date.now();
  const optimistic = {
    id: tempId,
    _pending: true,
    type: "text",
    author,
    title: "",
    body,
    object_path: null,
    mime_type: null,
    size_bytes: null,
    duration_ms: null,
    created_at: new Date().toISOString(),
  };
  const cached = cachedMessages();
  renderMessages([optimistic, ...cached.filter((m) => !m.id?.startsWith("pending-"))]);

  try {
    const u = await requireUser();
    const { error } = await supabaseClient
      .from("messages")
      .insert({ type: "text", author, body, user_id: u.id });
    if (error) throw error;

    messageBody.value = "";
    updateCharCounter();
    setBanner("#messages-error", "");
    toast("コメントを投稿しました。", "success");
    await reloadMessages();
  } catch (err) {
    // 失敗したら下書きを戻す（消えてしまわないように）
    renderMessages(cachedMessages().filter((m) => !m.id?.startsWith("pending-")));
    messageBody.value = body;
    updateCharCounter();
    messageBody.focus();
    toast(errorMessage(err, "投稿できませんでした"), "error");
    console.error("コメント投稿エラー:", err);
  } finally {
    setBusy(form, false);
  }
});

/* ------------------------------------------------------------------ *
 * 曲の追加（管理者）
 * ------------------------------------------------------------------ */

function releasePreview() {
  const preview = $("#recording-preview");
  if (previewObjectUrl) {
    try {
      URL.revokeObjectURL(previewObjectUrl);
    } catch {
      /* ignore */
    }
    previewObjectUrl = null;
  }
  preview.pause?.();
  preview.removeAttribute("src");
  preview.load?.();
  preview.classList.add("hidden");
}

function resetTrack(keepStatus = false) {
  selectedTrack = null;
  const input = $("#voice-file");
  if (input) input.value = "";
  const form = $("#voice-form");
  form.reset();
  form.classList.add("hidden");
  delete form.dataset.durationMs;
  releasePreview();
  $("#upload-progress").classList.add("hidden");
  $("#upload-progress-bar").style.width = "0%";
  setBusy(form, false);
  if (!keepStatus) setStatus("#recording-status", "");
}

function probeAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    probe.preload = "metadata";
    const cleanup = () => {
      probe.onloadedmetadata = null;
      probe.onerror = null;
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    };
    probe.onloadedmetadata = () => {
      cleanup();
      resolve(Math.round(probe.duration * 1000));
    };
    probe.onerror = () => {
      cleanup();
      reject(new Error("このファイルは読み込めませんでした。別のファイルでお試しください。"));
    };
    probe.src = url;
  });
}

async function acceptTrackFile(file) {
  if (!file) return resetTrack();
  if (!isAdmin) {
    resetTrack();
    setStatus("#recording-status", "曲の追加は管理者だけが行えます。", true);
    return;
  }

  const looksLikeAudio =
    file.type.startsWith("audio/") || file.type === "video/webm" || /\.(mp3|wav|m4a|aac|ogg|oga|opus|webm)$/i.test(file.name);
  if (!looksLikeAudio) {
    resetTrack(true);
    setStatus("#recording-status", "音声ファイル（MP3 / WAV / M4A / AAC / OGG / WebM）を選んでください。", true);
    return;
  }
  if (file.size > MAX_AUDIO_BYTES) {
    resetTrack(true);
    setStatus("#recording-status", "ファイルが10MBを超えています。短い曲にするか音質を落としてください。（" + formatBytes(file.size) + "）", true);
    return;
  }

  setStatus("#recording-status", file.name + " を確認中…");
  let durationMs = 0;
  try {
    durationMs = await probeAudioDuration(file);
  } catch (err) {
    resetTrack(true);
    setStatus("#recording-status", err.message, true);
    return;
  }

  if (!Number.isFinite(durationMs) || durationMs <= MIN_AUDIO_DURATION_MS) {
    resetTrack(true);
    setStatus("#recording-status", "曲は60秒より長くしてください。（このファイルは " + formatDuration(durationMs) + "）", true);
    return;
  }

  selectedTrack = file;
  releasePreview();
  const preview = $("#recording-preview");
  previewObjectUrl = URL.createObjectURL(file);
  preview.src = previewObjectUrl;
  preview.classList.remove("hidden");

  const form = $("#voice-form");
  form.dataset.durationMs = String(durationMs);
  form.classList.remove("hidden");
  if (!$("#voice-title").value) {
    $("#voice-title").value = file.name.replace(/\.[^.]+$/, "").slice(0, 100);
  }
  if (!$("#voice-author").value) $("#voice-author").value = readStoredAuthor();
  $("#voice-title").focus();
  setStatus(
    "#recording-status",
    file.name + "（" + formatDuration(durationMs) + " / " + formatBytes(file.size) + "）を選択しました。上のプレビューで確認できます。"
  );
}

const trackInput = $("#voice-file");
const dropzone = $("#track-dropzone");

$("#track-pick").addEventListener("click", () => trackInput.click());
trackInput.addEventListener("change", (e) => acceptTrackFile(e.target.files?.[0]));
$("#track-cancel").addEventListener("click", () => {
  resetTrack();
  setStatus("#recording-status", "選択を取り消しました。");
});

["dragenter", "dragover"].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add("is-dragover");
  })
);
["dragleave", "dragend", "drop"].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-dragover");
  })
);
dropzone.addEventListener("drop", (e) => acceptTrackFile(e.dataTransfer?.files?.[0]));

function uploadTrack(file, path, onProgress) {
  const endpointHost = new URL(SUPABASE_URL).hostname.split(".")[0];
  return requireAdmin()
    .then(() => supabaseClient.auth.getSession())
    .then(({ data, error }) => {
      if (error || !data?.session) throw new Error("ログインが必要です。");
      if (!window.tus?.Upload) throw new Error("アップロード機能の読み込みに失敗しました。ページを再読み込みしてください。");

      return new Promise((resolve, reject) => {
        const upload = new tus.Upload(file, {
          endpoint: "https://" + endpointHost + ".storage.supabase.co/storage/v1/upload/resumable",
          retryDelays: [0, 1000, 3000, 5000],
          chunkSize: 6 * 1024 * 1024,
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          metadata: {
            bucketName: AUDIO_BUCKET,
            objectName: path,
            contentType: file.type || "application/octet-stream",
            cacheControl: "3600",
          },
          headers: { Authorization: "Bearer " + data.session.access_token, apikey: SUPABASE_KEY },
          onError: reject,
          onProgress: (uploaded, total) => onProgress?.(uploaded, total),
          onSuccess: resolve,
        });
        upload.start();
      });
    });
}

$("#voice-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (!selectedTrack) {
    setStatus("#recording-status", "先に曲ファイルを選んでください。", true);
    return;
  }

  const durationMs = Number(form.dataset.durationMs || 0);
  if (durationMs <= MIN_AUDIO_DURATION_MS) {
    setStatus("#recording-status", "曲は60秒より長くしてください。", true);
    return;
  }

  const title = $("#voice-title").value.trim();
  if (!title) {
    $("#voice-title").focus();
    setStatus("#recording-status", "曲名を入力してください。", true);
    return;
  }

  setBusy(form, true, "アップロード中…");
  $("#upload-progress").classList.remove("hidden");
  setStatus("#recording-status", "アップロード中… 0%");

  const id = crypto.randomUUID();
  const ext = (selectedTrack.name.split(".").pop() || "audio").replace(/[^a-z0-9]+/gi, "") || "audio";
  const path = "voices/" + id + "." + ext;

  try {
    const u = await requireAdmin();
    await uploadTrack(selectedTrack, path, (uploaded, total) => {
      const pct = total ? Math.min(100, Math.floor((uploaded / total) * 100)) : 0;
      $("#upload-progress-bar").style.width = pct + "%";
      $("#upload-progress").setAttribute("aria-valuenow", String(pct));
      setStatus("#recording-status", "アップロード中… " + pct + "%");
    });

    const { error } = await supabaseClient.from("messages").insert({
      id,
      type: "voice",
      author: $("#voice-author").value.trim() || "管理者",
      title,
      body: "",
      object_path: path,
      mime_type: selectedTrack.type || "application/octet-stream",
      size_bytes: selectedTrack.size,
      duration_ms: durationMs,
      user_id: u.id,
    });
    if (error) {
      await supabaseClient.storage.from(AUDIO_BUCKET).remove([path]).catch(() => {});
      throw error;
    }

    rememberAuthor();
    resetTrack();
    setStatus("#recording-status", "「" + title + "」を保存しました。");
    toast("曲を追加しました。", "success");
    await reloadMessages();
  } catch (err) {
    setBusy(form, false);
    setStatus("#recording-status", errorMessage(err, "曲の保存に失敗しました"), true);
    console.error("曲の保存エラー:", err);
  }
});

/* ------------------------------------------------------------------ *
 * サイト設定（管理者）
 * ------------------------------------------------------------------ */

$("#site-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  setBusy(form, true, "保存中…");
  try {
    await requireAdmin();
    const siteTitle = $("#site-input").value.trim();
    const songTitle = $("#song-input").value.trim();
    if (!siteTitle) throw new Error("サイト名を入力してください。");

    const { error } = await supabaseClient.from("settings").upsert(
      [
        { key: "siteTitle", value: siteTitle },
        { key: "songTitle", value: songTitle },
      ],
      { onConflict: "key" }
    );
    if (error) throw error;

    await reloadSettings();
    toast("設定を保存しました。", "success");
  } catch (err) {
    toast(errorMessage(err, "設定を保存できませんでした"), "error");
    console.error("設定保存エラー:", err);
  } finally {
    setBusy(form, false);
  }
});

/* ------------------------------------------------------------------ *
 * リアルタイム更新
 * ------------------------------------------------------------------ */

function cachedMessages() {
  return cacheRead(CACHE_KEYS.messages)?.data || [];
}

function sortMessages(rows) {
  return rows
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 100);
}

function applyMessageChange(payload) {
  const current = cachedMessages();
  let next = current.slice();

  if (payload.eventType === "INSERT") {
    const item = payload.new;
    if (!item?.id) return;
    // 自分の投稿なら「送信中…」の仮カードを取り除く
    next = next.filter((row) => !String(row.id).startsWith("pending-"));
    next = sortMessages([item, ...next.filter((row) => row.id !== item.id)]);
  } else if (payload.eventType === "UPDATE") {
    const item = payload.new;
    if (!item?.id) return;
    next = sortMessages(next.map((row) => (row.id === item.id ? item : row)));
  } else if (payload.eventType === "DELETE") {
    const id = payload.old?.id;
    if (id) next = next.filter((row) => row.id !== id);
  }

  renderMessages(next);
  cacheWrite(CACHE_KEYS.messages, next);
}

function applySettingsChange(payload) {
  const cached = cacheRead(CACHE_KEYS.settings);
  const settings = { ...(cached?.data || {}) };

  if (payload.eventType === "DELETE") {
    delete settings[payload.old?.key];
  } else if (payload.new?.key) {
    settings[payload.new.key] = payload.new.value;
  }

  renderSettings(settings);
  cacheWrite(CACHE_KEYS.settings, settings);
}

async function stopRealtime() {
  if (realtimeRetryTimer) {
    clearTimeout(realtimeRetryTimer);
    realtimeRetryTimer = null;
  }
  if (realtimeChannel && supabaseClient) {
    try {
      await supabaseClient.removeChannel(realtimeChannel);
    } catch (err) {
      console.warn("Realtime切断エラー:", err);
    }
  }
  realtimeChannel = null;
}

async function subscribeRealtime() {
  if (realtimeChannel || !supabaseClient) return;
  realtimeChannel = supabaseClient
    .channel("choir-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, applyMessageChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, applySettingsChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "admins" }, () => {
      refreshRole().then(() => showApp(true)).catch(() => {});
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        // リアルタイムが繋がっても、直近のデータ取得が失敗していたら表示を残す
        if (!dataStale) setConnection("");
        if (realtimeRetryTimer) {
          clearTimeout(realtimeRetryTimer);
          realtimeRetryTimer = null;
        }
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setConnection("リアルタイム更新が切れました");
        scheduleRealtimeRetry();
      }
    });
}

function scheduleRealtimeRetry() {
  if (realtimeRetryTimer) return;
  realtimeRetryTimer = setTimeout(async () => {
    realtimeRetryTimer = null;
    await stopRealtime();
    await subscribeRealtime();
  }, 5000);
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (document.hidden || !supabaseClient) return;
    loadMessages(true).catch(() => {});
    loadSettings(true).catch(() => {});
  }, REFRESH_INTERVAL_MS);
}

async function initialize() {
  if (!API_READY || !supabaseClient) {
    $("#setup-warning").classList.remove("hidden");
    $("#setup-warning-details").classList.remove("hidden");
    $("#setup-warning-text").textContent = MISSING_CONFIG.length
      ? "サイトの設定が完了していません（未設定: " + MISSING_CONFIG.join(", ") + "）。"
      : "サイトの設定を確認してください。";
    setBooting(false);
    showApp(false);
    return;
  }

  $("#setup-warning").classList.add("hidden");
  $("#setup-warning-details").classList.add("hidden");

  if (!bootstrapped) {
    setBooting(true, "ログイン状態を確認中…");
    // キャッシュがあれば、通信を待たずに前回の内容を先に出す
    const cachedSettings = cacheRead(CACHE_KEYS.settings)?.data;
    if (cachedSettings) renderSettings(cachedSettings);
    const cached = cachedMessages();
    if (cached.length) renderMessages(cached);
  }

  let session = null;
  try {
    const result = await withTimeout(supabaseClient.auth.getSession(), "ログイン状態の確認");
    if (result.error) throw result.error;
    session = result.data?.session || null;
  } catch (err) {
    console.error("セッション確認エラー:", err);
    setBooting(false);
    showApp(false);
    $("#login-error").textContent = errorMessage(err, "ログイン状態を確認できませんでした");
    bootstrapped = true;
    return;
  }

  bootstrapped = true;

  if (!session) {
    setBooting(false);
    showApp(false);
    showLoginView("login");
    return;
  }

  // 認証済みなら先にアプリ画面を出す（読み込み失敗をログイン失敗とは扱わない）
  showApp(true);
  setupPageNavigation();
  setBooting(true, "読み込み中…");
  startAutoRefresh();

  try {
    await refreshRole();
  } catch (err) {
    console.error("権限確認エラー:", err);
  }
  showApp(true);

  const [settingsResult, messagesResult] = await Promise.allSettled([loadSettings(true), loadMessages(true)]);
  const failed = [settingsResult, messagesResult].filter((r) => r.status === "rejected");
  dataStale = failed.length > 0;

  // 通信に失敗しても、手元に残っている内容は表示し続ける
  if (settingsResult.status === "rejected") {
    renderSettings(cacheRead(CACHE_KEYS.settings)?.data || {});
  }
  if (messagesResult.status === "rejected") {
    renderMessages(cachedMessages());
  }

  setBooting(false);

  if (failed.length) {
    const text = errorMessage(failed[0].reason, "読み込めませんでした");
    setBanner("#messages-error", text + " 表示中の内容は前回保存されたものです。");
    setConnection("最新の情報ではありません");
    console.error("データ読み込みエラー:", failed.map((r) => r.reason));
  } else {
    setBanner("#messages-error", "");
    setBanner("#songs-error", "");
  }

  await subscribeRealtime();
}

if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (!session) {
      isAdmin = false;
      setConnection("");
      stopRealtime().finally(() => {
        if (bootstrapped) showApp(false);
      });
    }
  });
}

window.addEventListener("online", () => {
  if (!supabaseClient || !bootstrapped) return;
  dataStale = false;
  setConnection("");
  loadMessages(true).catch(() => {});
  loadSettings(true).catch(() => {});
  subscribeRealtime().catch(() => {});
});

window.addEventListener("offline", () => setConnection("オフライン"));
window.addEventListener("pagehide", () => {
  stopRealtime();
  if (refreshTimer) clearInterval(refreshTimer);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && supabaseClient && bootstrapped) {
    loadMessages(true).catch(() => {});
  }
});

initialize();
