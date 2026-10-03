const $ = (s) => document.querySelector(s);
const CONFIG = window.CHOIR_CONFIG || {};
const SUPABASE_URL = String(CONFIG.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = String(CONFIG.SUPABASE_PUBLISHABLE_KEY || "");
const AUTH_EMAIL = String(CONFIG.AUTH_EMAIL || "");
const AUDIO_BUCKET = "choir-audio";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MIN_AUDIO_DURATION_MS = 60 * 1000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const API_READY = /^https:\/\/[^/]+\.supabase\.co$/.test(SUPABASE_URL) && SUPABASE_KEY && AUTH_EMAIL;

const supabaseClient = API_READY ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const CACHE_KEYS = { settings: "choir-cache-settings-v3", messages: "choir-cache-messages-v3" };
let isAdmin = false;
let realtimeChannel = null;
let selectedVoiceFile = null;
let navObserver = null;

function cacheRead(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v && Number.isFinite(v.savedAt) ? v : null;
  } catch { return null; }
}
function cacheWrite(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data })); } catch {}
}
function fresh(v) { return !!v && Date.now() - v.savedAt < CACHE_TTL_MS; }

function renderSettings(s) {
  $("#site-title").textContent = s.siteTitle || "1A 合唱伝言板";
  $("#song-title").textContent = s.songTitle || "曲名未設定";
  $("#site-input").value = s.siteTitle || "";
  $("#song-input").value = s.songTitle || "";
}

function showApp(loggedIn) {
  $("#login-view").classList.toggle("hidden", loggedIn);
  $("#admin-login-view").classList.add("hidden");
  $("#app-view").classList.toggle("hidden", !loggedIn);
  $("#logout-button").classList.toggle("hidden", !loggedIn);
  $("#role-badge").classList.toggle("hidden", !loggedIn);
  $("#role-badge").textContent = isAdmin ? "管理者" : "メンバー";
  $("#admin-panel").classList.toggle("hidden", !isAdmin);
  $("#admin-song-upload").classList.toggle("hidden", !isAdmin);
}

async function user() {
  if (!supabaseClient) return null;
  const { data } = await supabaseClient.auth.getUser();
  return data.user || null;
}

async function refreshRole() {
  const u = await user();
  isAdmin = false;
  if (!u) return;
  const { data } = await supabaseClient.from("admins").select("user_id").eq("user_id", u.id).maybeSingle();
  isAdmin = !!data;
}

function formatDate(v) {
  return new Date(v).toLocaleString("ja-JP", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
}
function formatDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

async function requireUser() {
  const u = await user();
  if (!u) throw new Error("ログインが必要です。");
  return u;
}
async function requireAdmin() {
  const u = await requireUser();
  if (!isAdmin) throw new Error("管理者権限が必要です。");
  return u;
}

async function loadSettings(force=false) {
  await requireUser();
  const c = cacheRead(CACHE_KEYS.settings);
  if (c?.data) {
    renderSettings(c.data);
    if (!force && fresh(c)) return c.data;
  }

  const { data, error } = await supabaseClient.from("settings").select("key,value");
  if (error) throw error;
  const s = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  renderSettings(s);
  cacheWrite(CACHE_KEYS.settings, s);
  return s;
}

async function signedAudio(audio, path) {
  const cacheKey = "choir-audio-url-v1:" + path;
  const now = Date.now();
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.url && Number.isFinite(cached.expiresAt) && cached.expiresAt > now + 15000) {
      audio.src = cached.url;
      audio.dataset.loaded = "true";
      return;
    }
  } catch {}

  const expiresIn = 3600;
  const { data, error } = await supabaseClient.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(path, expiresIn);
  if (error) throw error;

  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({
      url: data.signedUrl,
      expiresAt: now + expiresIn * 1000
    }));
  } catch {}

  audio.src = data.signedUrl;
  audio.dataset.loaded = "true";
}

async function loadMessages(force=false) {
  await requireUser();
  const c = cacheRead(CACHE_KEYS.messages);
  if (c?.data) {
    renderMessages(c.data);
    if (!force && fresh(c)) return c.data;
  }

  const { data, error } = await supabaseClient.from("messages")
    .select("id,type,author,title,body,object_path,mime_type,size_bytes,duration_ms,created_at")
    .order("created_at", { ascending:false }).limit(100);
  if (error) throw error;
  const messages = data || [];
  renderMessages(messages);
  cacheWrite(CACHE_KEYS.messages, messages);
  return messages;
}

function createMessageCard(item) {
  const node = $("#message-template").content.cloneNode(true);
  const article = node.querySelector(".message");
  const author = node.querySelector(".message-author");
  const time = node.querySelector(".message-time");
  const type = node.querySelector(".message-type");
  const title = node.querySelector(".message-title");
  const body = node.querySelector(".message-body");
  const audio = node.querySelector(".message-audio");
  const play = node.querySelector(".load-audio");
  const del = node.querySelector(".delete-button");

  const isSong = item.type === "voice";
  article.classList.toggle("message-song", isSong);
  type.textContent = isSong ? "曲" : "伝言";
  author.textContent = item.author || "匿名";
  time.textContent = formatDate(item.created_at);
  del.classList.toggle("hidden", !isAdmin);
  del.onclick = async () => {
    if (!isAdmin || !confirm("この" + (item.type === "voice" ? "曲" : "伝言") + "を削除しますか？")) return;
    const { error } = await supabaseClient.from("messages").delete().eq("id", item.id);
    if (error) throw error;
    if (item.object_path) await supabaseClient.storage.from(AUDIO_BUCKET).remove([item.object_path]);
    await loadMessages(true);
  };

  if (item.type === "voice") {
    title.textContent = item.title || "曲";
    body.textContent = "";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = [
      formatDuration(item.duration_ms),
      item.size_bytes ? (item.size_bytes / 1024 / 1024).toFixed(1) + "MB" : ""
    ].filter(Boolean).join(" ・ ");
    title.after(meta);

    play.textContent = "▶ 曲を再生";
    play.onclick = async () => {
      play.disabled = true;
      play.textContent = "読み込み中…";
      try {
        await signedAudio(audio, item.object_path);
        audio.classList.remove("hidden");
        await audio.play();
      } catch (e) {
        alert("曲を再生できませんでした。");
        console.error(e);
      } finally {
        play.disabled = false;
        play.textContent = "▶ 曲を再生";
      }
    };
  } else {
    title.classList.add("hidden");
    play.classList.add("hidden");
    audio.classList.add("hidden");
    body.textContent = item.body || "";
  }

  return article;
}

function renderList(items, selector, emptyText) {
  const root = $(selector);
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

function renderMessages(items) {
  const textMessages = items.filter(item => item.type === "text");
  const songs = items.filter(item => item.type === "voice");

  renderList(textMessages, "#text-messages", "まだ伝言はありません。");
  renderList(songs, "#song-messages", "まだ曲はありません。");

  $("#message-count").textContent = String(textMessages.length);
  $("#song-count").textContent = String(songs.length);
  $("#message-list-label").textContent = textMessages.length + "件";
  $("#song-list-label").textContent = songs.length + "曲";
}

function setupPageNavigation() {
  const links = [...document.querySelectorAll(".nav-item[data-page]")];
  const pages = [...document.querySelectorAll(".page-view[id]")];

  if (!links.length || !pages.length) return;

  const showPage = (pageId, updateHash = true) => {
    const target = document.getElementById(pageId);
    if (!target) return;

    links.forEach(link => {
      link.classList.toggle("active", link.dataset.page === pageId);
    });

    pages.forEach(page => {
      const active = page.id === pageId;
      page.classList.toggle("active-page", active);
      page.classList.toggle("hidden", !active);
    });

    if (updateHash) history.replaceState(null, "", "#" + pageId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  links.forEach(link => {
    link.addEventListener("click", () => showPage(link.dataset.page));
  });

  const hash = location.hash.replace(/^#/, "");
  showPage(document.getElementById(hash) ? hash : "comments-page", false);
}

function resetVoice() {
  selectedVoiceFile = null;
  $("#voice-file").value = "";
  $("#voice-form").reset();
  $("#voice-form").classList.add("hidden");
  $("#recording-preview").classList.add("hidden");
  $("#recording-preview").removeAttribute("src");
}

$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  $("#login-error").textContent = "";
  const button = e.submitter;
  if (button) button.disabled = true;

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: AUTH_EMAIL,
      password: $("#password").value
    });
    if (error) throw error;

    $("#password").value = "";
    await initialize();
  } catch (err) {
    console.error("ログイン処理エラー:", err);
    $("#login-error").textContent =
      err?.message?.toLowerCase?.().includes("invalid login credentials")
        ? "パスワードが違います。"
        : "ログイン後の読み込みに失敗しました。もう一度お試しください。";
  } finally {
    if (button) button.disabled = false;
  }
});

$("#show-admin-login").addEventListener("click", () => {
  $("#login-view").classList.add("hidden");
  $("#admin-login-view").classList.remove("hidden");
});
$("#back-to-login").addEventListener("click", () => {
  $("#admin-login-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
});
$("#admin-login-form").addEventListener("submit", async e => {
  e.preventDefault(); $("#admin-login-error").textContent = "";
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email: $("#admin-email").value.trim(), password: $("#admin-password").value });
    if (error) throw error;
    await initialize();
    if (!isAdmin) { await supabaseClient.auth.signOut(); throw new Error("管理者として登録されていません。"); }
    $("#admin-password").value = "";
  } catch (err) {
    $("#admin-login-error").textContent = err.message === "管理者として登録されていません。" ? err.message : "管理者ログインに失敗しました。";
  }
});

$("#logout-button").addEventListener("click", async () => {
  if (realtimeChannel) { await supabaseClient.removeChannel(realtimeChannel); realtimeChannel = null; }
  await supabaseClient.auth.signOut(); isAdmin = false; showApp(false);
});

$("#reload-button").addEventListener("click", async () => {
  try {
    $("#reload-button").disabled = true;
    $("#reload-button").textContent = "更新中…";
    await Promise.all([loadSettings(true), loadMessages(true)]);
  } catch (e) {
    alert(e.message);
  } finally {
    $("#reload-button").disabled = false;
    $("#reload-button").textContent = "更新";
  }
});

$("#site-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await requireAdmin();
    const siteTitle = $("#site-input").value.trim();
    const songTitle = $("#song-input").value.trim();
    if (!siteTitle) throw new Error("サイト名を入力してください。");
    const { error } = await supabaseClient.from("settings").upsert([
      { key:"siteTitle", value:siteTitle }, { key:"songTitle", value:songTitle }
    ], { onConflict:"key" });
    if (error) throw error;
    await loadSettings(true);
  } catch (err) { alert(err.message); }
});

$("#message-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const u = await requireUser();
    const body = $("#message-body").value.trim();
    if (!body) throw new Error("本文を入力してください。");
    const { error } = await supabaseClient.from("messages").insert({
      type:"text", author:$("#message-author").value.trim() || "匿名", body, user_id:u.id
    });
    if (error) throw error;
    $("#message-author").value = ""; $("#message-body").value = "";
    await loadMessages(true);

  } catch (err) { alert(err.message); }
});

$("#voice-file").addEventListener("change", async e => {
  if (!isAdmin) return resetVoice();
  const file = e.target.files?.[0];
  if (!file) return resetVoice();
  $("#recording-status").textContent = "";
  if (!file.type.startsWith("audio/")) return resetVoice(), $("#recording-status").textContent = "曲ファイルを選択してください。";
  if (file.size > MAX_AUDIO_BYTES) return resetVoice(), $("#recording-status").textContent = "10MBを超えているため保存できません。";
  try {
    const url = URL.createObjectURL(file), a = new Audio(); a.preload = "metadata";
    await new Promise((resolve,reject) => { a.onloadedmetadata=resolve; a.onerror=()=>reject(new Error("音声ファイルを読み込めませんでした。")); a.src=url; });
    const durationMs = Math.round(a.duration*1000); URL.revokeObjectURL(url);
    if (!Number.isFinite(durationMs) || durationMs <= MIN_AUDIO_DURATION_MS) return resetVoice(), $("#recording-status").textContent = "曲は60秒を超えている必要があります。";
    selectedVoiceFile = file;
    $("#recording-preview").src = URL.createObjectURL(file);
    $("#recording-preview").classList.remove("hidden");
    $("#voice-form").classList.remove("hidden");
    $("#voice-form").dataset.durationMs = String(durationMs);
    $("#recording-status").textContent = file.name + "（" + formatDuration(durationMs) + " / " + (file.size/1024/1024).toFixed(1) + "MB）を選択しました。";
  } catch (err) { resetVoice(); $("#recording-status").textContent = err.message; }
});

async function uploadVoice(file, path) {
  await requireAdmin();
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session) throw new Error("ログインが必要です。");
  if (!window.tus?.Upload) throw new Error("大容量アップロード機能の読み込みに失敗しました。");
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  await new Promise((resolve,reject) => {
    const upload = new tus.Upload(file, {
      endpoint: "https://" + ref + ".storage.supabase.co/storage/v1/upload/resumable",
      retryDelays:[0,1000,3000,5000], chunkSize:6*1024*1024,
      uploadDataDuringCreation:true, removeFingerprintOnSuccess:true,
      metadata:{bucketName:AUDIO_BUCKET, objectName:path, contentType:file.type, cacheControl:"3600"},
      headers:{Authorization:"Bearer "+data.session.access_token, apikey:SUPABASE_KEY},
      onError:reject,
      onProgress:(up,total)=>$("#recording-status").textContent="アップロード中… "+Math.floor(up/total*100)+"%",
      onSuccess:resolve
    });
    upload.start();
  });
}

$("#voice-form").addEventListener("submit", async e => {
  e.preventDefault(); if (!selectedVoiceFile || !isAdmin) return;
  try {
    await requireAdmin();
    const durationMs = Number($("#voice-form").dataset.durationMs || 0);
    if (durationMs <= MIN_AUDIO_DURATION_MS) throw new Error("曲は60秒を超えている必要があります。");
    const id = crypto.randomUUID();
    const ext = (selectedVoiceFile.name.split(".").pop() || "audio").replace(/[^a-z0-9]+/gi,"") || "audio";
    const path = "voices/" + id + "." + ext;
    await uploadVoice(selectedVoiceFile, path);
    const { error } = await supabaseClient.from("messages").insert({
      id,type:"voice",author:$("#voice-author").value.trim() || "管理者",
      title:$("#voice-title").value.trim() || "曲",body:"",
      object_path:path,mime_type:selectedVoiceFile.type || "application/octet-stream",
      size_bytes:selectedVoiceFile.size,duration_ms:durationMs,user_id:(await requireAdmin()).id
    });
    if (error) { await supabaseClient.storage.from(AUDIO_BUCKET).remove([path]); throw error; }
    resetVoice(); $("#recording-status").textContent="曲を保存しました。"; await loadMessages(true);
  } catch (err) { $("#recording-status").textContent = err.message || "曲の保存に失敗しました。"; }
});

function cachedMessages() {
  return cacheRead(CACHE_KEYS.messages)?.data || [];
}

function applyMessageChange(payload) {
  const current = cachedMessages();
  let next = current.slice();

  if (payload.eventType === "INSERT") {
    const item = payload.new;
    next = [item, ...next.filter(row => row.id !== item.id)]
      .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 100);
  } else if (payload.eventType === "UPDATE") {
    const item = payload.new;
    next = next.map(row => row.id === item.id ? item : row);
    next.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  } else if (payload.eventType === "DELETE") {
    const id = payload.old?.id;
    if (id) next = next.filter(row => row.id !== id);
  }

  renderMessages(next);
  cacheWrite(CACHE_KEYS.messages, next);
}

function applySettingsChange(payload) {
  const cached = cacheRead(CACHE_KEYS.settings);
  const settings = { ...(cached?.data || {}) };

  if (payload.eventType === "DELETE") {
    delete settings[payload.old?.key];
  } else {
    const row = payload.new;
    if (row?.key) settings[row.key] = row.value;
  }

  renderSettings(settings);
  cacheWrite(CACHE_KEYS.settings, settings);
}

async function subscribeRealtime() {
  if (realtimeChannel) return;
  realtimeChannel = supabaseClient.channel("choir-live")
    .on("postgres_changes",{event:"*",schema:"public",table:"messages"},applyMessageChange)
    .on("postgres_changes",{event:"*",schema:"public",table:"settings"},applySettingsChange)
    .subscribe();
}

async function initialize() {
  if (!API_READY) {
    $("#setup-warning").classList.remove("hidden");
    showApp(false);
    return;
  }

  $("#setup-warning").classList.add("hidden");
  const { data, error } = await supabaseClient.auth.getSession();

  if (error) {
    console.error("セッション確認エラー:", error);
    showApp(false);
    return;
  }

  if (!data.session) {
    showApp(false);
    return;
  }

  // 認証済みなら、まずアプリ画面を表示する。
  // データ取得が一時的に失敗しても「ログイン失敗」とは扱わない。
  showApp(true);
  setupPageNavigation();

  try {
    await refreshRole();
    showApp(true);
  } catch (err) {
    console.error("権限確認エラー:", err);
  }

  try {
    await loadSettings();
  } catch (err) {
    console.error("設定読み込みエラー:", err);
  }

  try {
    await loadMessages();
  } catch (err) {
    console.error("伝言読み込みエラー:", err);
  }

  try {
    await subscribeRealtime();
  } catch (err) {
    console.error("Realtime接続エラー:", err);
  }
}

if (supabaseClient) supabaseClient.auth.onAuthStateChange((_event, session) => {
  if (!session) { isAdmin=false; showApp(false); }
});

initialize();
