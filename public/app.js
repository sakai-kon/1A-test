const $ = (s) => document.querySelector(s);
const CONFIG = window.CHOIR_CONFIG || {};
const SUPABASE_URL = String(CONFIG.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = String(CONFIG.SUPABASE_PUBLISHABLE_KEY || "");
const AUTH_EMAIL = String(CONFIG.AUTH_EMAIL || "");
const AUDIO_BUCKET = "choir-audio";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MIN_AUDIO_DURATION_MS = 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const API_READY = /^https:\/\/[^/]+\.supabase\.co$/.test(SUPABASE_URL) && SUPABASE_KEY && AUTH_EMAIL;

const supabaseClient = API_READY ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const CACHE_KEYS = { settings: "choir-cache-settings-v3", messages: "choir-cache-messages-v3" };
let isAdmin = false;
let realtimeChannel = null;
let selectedVoiceFile = null;

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
  $(".audio-post").classList.toggle("hidden", !isAdmin);
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
  if (c?.data) renderSettings(c.data);
  if (!force && fresh(c)) return;
  const { data, error } = await supabaseClient.from("settings").select("key,value");
  if (error) throw error;
  const s = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  renderSettings(s);
  cacheWrite(CACHE_KEYS.settings, s);
}

async function signedAudio(audio, path) {
  const { data, error } = await supabaseClient.storage.from(AUDIO_BUCKET).createSignedUrl(path, 300);
  if (error) throw error;
  audio.src = data.signedUrl;
  audio.dataset.loaded = "true";
}

async function loadMessages(force=false) {
  await requireUser();
  const c = cacheRead(CACHE_KEYS.messages);
  if (c?.data) renderMessages(c.data);
  if (!force && fresh(c)) return;
  const { data, error } = await supabaseClient.from("messages")
    .select("id,type,author,title,body,object_path,mime_type,size_bytes,duration_ms,created_at")
    .order("created_at", { ascending:false }).limit(100);
  if (error) throw error;
  renderMessages(data || []);
  cacheWrite(CACHE_KEYS.messages, data || []);
}

function renderMessages(items) {
  const root = $("#messages");
  root.replaceChildren();
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty"; p.textContent = "まだ伝言はありません。"; root.appendChild(p); return;
  }
  for (const item of items) {
    const node = $("#message-template").content.cloneNode(true);
    const article = node.querySelector(".message");
    const author = node.querySelector(".message-author");
    const time = node.querySelector(".message-time");
    const title = node.querySelector(".message-title");
    const body = node.querySelector(".message-body");
    const audio = node.querySelector(".message-audio");
    const play = node.querySelector(".load-audio");
    const del = node.querySelector(".delete-button");
    author.textContent = item.author || "匿名";
    time.textContent = formatDate(item.created_at);
    del.classList.toggle("hidden", !isAdmin);
    del.onclick = async () => {
      if (!isAdmin || !confirm("この伝言を削除しますか？")) return;
      const { error } = await supabaseClient.from("messages").delete().eq("id", item.id);
      if (error) throw error;
      if (item.object_path) await supabaseClient.storage.from(AUDIO_BUCKET).remove([item.object_path]);
      await loadMessages(true);
    };

    if (item.type === "voice") {
      title.textContent = item.title || "曲";
      body.textContent = [formatDuration(item.duration_ms), item.size_bytes ? (item.size_bytes/1024/1024).toFixed(1)+"MB" : ""].filter(Boolean).join(" ・ ");
      play.onclick = async () => {
        play.disabled = true; play.textContent = "読み込み中…";
        try { await signedAudio(audio, item.object_path); audio.classList.remove("hidden"); await audio.play(); }
        catch (e) { alert("曲を再生できませんでした。"); console.error(e); }
        finally { play.disabled = false; play.textContent = "▶ 音声を再生"; }
      };
    } else {
      title.classList.add("hidden"); play.classList.add("hidden"); audio.classList.add("hidden"); body.textContent = item.body || "";
    }
    root.appendChild(article);
  }
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
  e.preventDefault(); $("#login-error").textContent = "";
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email: AUTH_EMAIL, password: $("#password").value });
    if (error) throw error;
    $("#password").value = ""; await initialize();
  } catch { $("#login-error").textContent = "ログインできませんでした。パスワードを確認してください。"; }
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

$("#reload-button").addEventListener("click", () => Promise.all([loadSettings(true), loadMessages(true)]).catch(e => alert(e.message)));

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

async function subscribeRealtime() {
  if (realtimeChannel) return;
  realtimeChannel = supabaseClient.channel("choir-live")
    .on("postgres_changes",{event:"*",schema:"public",table:"messages"},()=>loadMessages(true).catch(console.error))
    .on("postgres_changes",{event:"*",schema:"public",table:"settings"},()=>loadSettings(true).catch(console.error))
    .subscribe();
}

async function initialize() {
  if (!API_READY) { $("#setup-warning").classList.remove("hidden"); showApp(false); return; }
  $("#setup-warning").classList.add("hidden");
  const { data } = await supabaseClient.auth.getSession();
  if (!data.session) { showApp(false); return; }
  try {
    await refreshRole();
    await Promise.all([loadSettings(), loadMessages()]);
    showApp(true);
    await subscribeRealtime();
  } catch (err) { console.error(err); showApp(false); }
}

if (supabaseClient) supabaseClient.auth.onAuthStateChange((_event, session) => {
  if (!session) { isAdmin=false; showApp(false); }
});

initialize();
