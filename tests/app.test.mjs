import { loadApp, fakeFile } from "./harness.mjs";

let pass = 0;
let fail = 0;
const lines = [];
const failures = [];

function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    lines.push("  ok    " + name);
  } else {
    fail++;
    lines.push("  FAIL  " + name + (extra ? "\n          -> " + extra : ""));
    failures.push(name);
  }
}
const section = (t) => lines.push("\n" + t);

const seed = [
  { id: "m1", type: "text", author: "田中", body: "明日の練習は17時からです", created_at: "2026-10-01T09:00:00Z" },
  { id: "m2", type: "text", author: "佐藤", body: "パート練習の場所が変わりました", created_at: "2026-10-03T09:00:00Z" },
  {
    id: "s1",
    type: "voice",
    author: "管理者",
    title: "旅立ちの時",
    body: "",
    object_path: "voices/s1.mp3",
    mime_type: "audio/mpeg",
    size_bytes: 3 * 1024 * 1024,
    duration_ms: 245000,
    created_at: "2026-10-02T09:00:00Z",
  },
];

process.on("unhandledRejection", (e) => {
  fail++;
  lines.push("  FAIL  unhandledRejection -> " + (e?.stack ?? e));
});

/* ---------------------------------------------------------------- */
section("未設定のとき");
{
  const app = await loadApp({ config: { SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", AUTH_EMAIL: "" } });
  const { document } = app;
  check("警告バナーが出る", !document.querySelector("#setup-warning").classList.contains("hidden"));
  check("不足している項目名が書いてある", document.querySelector("#setup-warning-text").textContent.includes("SUPABASE_URL"),
    document.querySelector("#setup-warning-text").textContent);
  check("ログインカードが出る", !document.querySelector("#login-view").classList.contains("hidden"));
  check("アプリ画面は出ない", document.querySelector("#app-view").classList.contains("hidden"));

  document.querySelector("#password").value = "pass1234";
  app.submit("#login-form");
  await app.flush(20);
  const err = document.querySelector("#login-error").textContent;
  check("未設定でログインしてもクラッシュせず日本語で案内", err.includes("設定") && !err.includes("undefined"), err);
  check("未設定で TypeError が出ない", app.errors.length === 0, JSON.stringify(app.errors));
}

{
  // 出荷時の config.js（AUTH_EMAIL が example.com のまま）でも「未設定」として止まる
  const fs = await import("node:fs");
  const realConfig = fs.readFileSync(new URL("../public/config.js", import.meta.url).pathname, "utf8");
  const sandbox = {};
  new Function("window", realConfig)(sandbox);
  const app = await loadApp({ config: sandbox.CHOIR_CONFIG });
  check("example.com のままの設定は未設定扱い", !app.document.querySelector("#setup-warning").classList.contains("hidden"));
  check("どの項目を設定すればよいかが分かる", app.document.querySelector("#setup-warning-text").textContent.includes("AUTH_EMAIL"),
    app.document.querySelector("#setup-warning-text").textContent);
}

/* ---------------------------------------------------------------- */
section("起動時の表示");
{
  const app = await loadApp({ loggedIn: true, messages: seed });
  const { document } = app;
  check("ログイン済みなら起動オーバーレイは消える", document.querySelector("#boot-overlay").classList.contains("hidden"));
  check("アプリ画面が出る", !document.querySelector("#app-view").classList.contains("hidden"));
  check("ログインカードは隠れる", document.querySelector("#login-view").classList.contains("hidden"));
  check("表示中のページは1枚だけ",
    document.querySelectorAll(".page-view:not(.hidden)").length === 1,
    [...document.querySelectorAll(".page-view:not(.hidden)")].map((n) => n.id).join(","));
  check("初期ページはコメント", document.querySelector("#comments-page").classList.contains("active-page"));
  check("件数バッジが更新される", document.querySelector("#message-count").textContent === "2");
  check("曲バッジが更新される", document.querySelector("#song-count").textContent === "1");
  check("曲名がヘッダーに出る", document.querySelector("#song-title").textContent === "旅立ちの時");
  check("管理者バッジ", document.querySelector("#role-badge").textContent === "管理者");
  check("設定タブは管理者に見える", !document.querySelector("#settings-tab").classList.contains("hidden"));
  check("リアルタイム購読した", app.fake.state.channelSubs.length === 1);

  const member = await loadApp({ loggedIn: true, admin: false, messages: seed });
  check("メンバーには設定タブを隠す", member.document.querySelector("#settings-tab").classList.contains("hidden"));
  check("メンバーのバッジ", member.document.querySelector("#role-badge").textContent === "メンバー");
}

/* ---------------------------------------------------------------- */
section("HTMLの初期状態（JS実行前）");
{
  const { JSDOM } = await import("jsdom");
  const fs = await import("node:fs");
  const dom = new JSDOM(fs.readFileSync(new URL("../public/index.html", import.meta.url).pathname, "utf8"));
  const visible = [...dom.window.document.querySelectorAll(".page-view")]
    .filter((n) => !n.classList.contains("hidden"))
    .map((n) => n.id);
  check("初期HTMLで可視のページは0枚（ちらつきなし）", visible.length === 0, visible.join(","));
  check("初期HTMLでログインカードは隠れている", dom.window.document.querySelector("#login-view").classList.contains("hidden"));
  check("初期HTMLでアプリ画面は隠れている", dom.window.document.querySelector("#app-view").classList.contains("hidden"));
}

/* ---------------------------------------------------------------- */
section("タブ切り替え");
{
  const app = await loadApp({ loggedIn: true, messages: seed });
  const { document } = app;
  const nav = (p) => [...document.querySelectorAll(".nav-item")].find((b) => b.dataset.page === p);

  app.click("#settings-tab");
  check("設定タブへ移動", document.querySelector("#settings-page").classList.contains("active-page"));
  check("他のページは隠れる", document.querySelector("#comments-page").classList.contains("hidden"));
  check("ハッシュが更新される", app.window.location.hash === "#settings-page", app.window.location.hash);
  check("aria-pressed が更新される", nav("settings-page").getAttribute("aria-pressed") === "true");

  app.click("#settings-tab");
  check("同じタブを2回押しても表示されたまま（ハンドラ重複なし）",
    document.querySelector("#settings-page").classList.contains("active-page"));

  app.click('[data-page="songs-page"]');
  check("曲タブへ移動", document.querySelector("#songs-page").classList.contains("active-page"));
  check("曲カードが1枚", document.querySelectorAll("#song-messages .message").length === 1);
  check("曲の再生時間が出る", document.querySelector("#song-messages .message-meta").textContent.includes("4:05"),
    document.querySelector("#song-messages .message-meta").textContent);
  check("曲のサイズが出る", document.querySelector("#song-messages .message-meta").textContent.includes("3.0MB"));

  const deep = await loadApp({ loggedIn: true, messages: seed, url: "https://example.github.io/1A-test/public/#songs-page" });
  check("URLハッシュから曲タブを開ける", deep.document.querySelector("#songs-page").classList.contains("active-page"));
  const badHash = await loadApp({ loggedIn: true, messages: seed, url: "https://example.github.io/1A-test/public/#settings-page", admin: false });
  check("権限のないタブのハッシュは無視される", badHash.document.querySelector("#comments-page").classList.contains("active-page"));
}

/* ---------------------------------------------------------------- */
section("ログイン / ログアウト");
{
  const app = await loadApp({ loggedIn: false });
  const { document } = app;
  check("ログアウト状態ではログインカード", !document.querySelector("#login-view").classList.contains("hidden"));

  document.querySelector("#password").value = "wrong";
  app.submit("#login-form");
  await app.flush(30);
  check("パスワード違いのメッセージ", document.querySelector("#login-error").textContent === "パスワードが違います。",
    document.querySelector("#login-error").textContent);
  check("ログイン失敗中はボタンが戻る", !document.querySelector("#login-form button[type=submit]").disabled);

  document.querySelector("#password").value = "pass1234";
  app.submit("#login-form");
  await app.flush(30);
  check("ログイン成功でアプリ画面", !document.querySelector("#app-view").classList.contains("hidden"));
  check("ログイン成功でパスワード欄を空に", document.querySelector("#password").value === "");
  check("ログイン後のエラー表示は消える", document.querySelector("#login-error").textContent === "");

  app.click("#logout-button");
  await app.flush(30);
  check("ログアウトでログインカードへ", !document.querySelector("#login-view").classList.contains("hidden"));
  check("ログアウトでアプリ画面が隠れる", document.querySelector("#app-view").classList.contains("hidden"));
  check("ログアウトでリアルタイムを解除", app.fake.state.removedChannels.length === 1);
  check("ログアウトのトースト", app.toasts().some((t) => t.includes("ログアウト")), JSON.stringify(app.toasts()));
}
{
  const app = await loadApp({ loggedIn: false, admin: true });
  const { document } = app;
  app.click("#show-admin-login");
  check("管理者ログイン画面へ", !document.querySelector("#admin-login-view").classList.contains("hidden"));
  document.querySelector("#admin-email").value = "admin@example.com";
  document.querySelector("#admin-password").value = "pass1234";
  app.submit("#admin-login-form");
  await app.flush(30);
  check("管理者ログイン成功", !document.querySelector("#app-view").classList.contains("hidden"));
  check("管理者として認識", document.querySelector("#role-badge").textContent === "管理者");
}
{
  const app = await loadApp({ loggedIn: false, admin: false });
  const { document } = app;
  document.querySelector("#admin-email").value = "nobody@example.com";
  document.querySelector("#admin-password").value = "pass1234";
  app.submit("#admin-login-form");
  await app.flush(30);
  check("管理者でないアカウントは弾く", document.querySelector("#admin-login-error").textContent.includes("管理者として登録されていません"),
    document.querySelector("#admin-login-error").textContent);
  check("管理者ログイン失敗後はアプリ画面を出さない", document.querySelector("#app-view").classList.contains("hidden"));
  check("失敗したらサインアウト済み", app.fake.state.session === null);
}

/* ---------------------------------------------------------------- */
section("コメント投稿");
{
  const app = await loadApp({ loggedIn: true, admin: false, messages: seed, insertDelayMs: 40 });
  const { document } = app;

  app.submit("#message-form");
  await app.flush(20);
  check("空の投稿はトーストで注意", app.toasts().some((t) => t.includes("入力してください")), JSON.stringify(app.toasts()));
  check("空の投稿ではDBに書かない", !app.fake.state.calls.some(([t, op]) => t === "messages" && op === "insert"));

  document.querySelector("#message-body").value = "今日は18時から体育館です";
  app.input("#message-body");
  check("文字数カウンタが動く", document.querySelector("#message-count-chars").textContent === "13 / 2000",
    document.querySelector("#message-count-chars").textContent);

  document.querySelector("#message-author").value = "鈴木";
  document.querySelector("#remember-author").checked = true;
  app.submit("#message-form");
  await app.flush(3);
  check("送信中の仮カードが出る（楽観的更新）",
    document.querySelector("#text-messages .message-pending:not(.hidden)") !== null);
  await app.flush(60);
  check("投稿が保存される", app.fake.state.messages.some((m) => m.body === "今日は18時から体育館です" && m.author === "鈴木"));
  check("投稿後は仮カードが残らない", document.querySelector("#text-messages .message-pending:not(.hidden)") === null);
  check("投稿後は一覧に出る", [...document.querySelectorAll("#text-messages .message-body")].some((n) => n.textContent === "今日は18時から体育館です"));
  check("投稿後は入力欄が空になる", document.querySelector("#message-body").value === "");
  check("成功トースト", app.toasts().some((t) => t.includes("投稿しました")), JSON.stringify(app.toasts()));
  check("名前を端末に覚える", app.window.localStorage.getItem("choir-author-v1") === "鈴木");
  check("件数が増える", document.querySelector("#message-count").textContent === "3");
}
{
  // 「名前を覚えておく」にしていると、次に開いたとき名前が入っている
  const app2 = await loadApp({
    loggedIn: true,
    admin: false,
    messages: seed,
    storage: { "choir-author-v1": "高橋", "choir-author-remember-v1": "1" },
  });
  check("覚えた名前が次回の投稿欄に入る", app2.document.querySelector("#message-author").value === "高橋",
    app2.document.querySelector("#message-author").value);
  check("覚えた名前はチェックボックスも復元", app2.document.querySelector("#remember-author").checked === true);

  const app3 = await loadApp({ loggedIn: true, admin: false, messages: seed });
  check("覚えていない端末では名前を勝手に入れない", app3.document.querySelector("#message-author").value === "");
}
{
  // 投稿に失敗しても下書きが消えない
  const app = await loadApp({ loggedIn: true, admin: false, messages: seed });
  const { document } = app;
  app.fake.state.failNext = "insert";
  document.querySelector("#message-body").value = "消えてほしくない下書き";
  app.submit("#message-form");
  await app.flush(30);
  check("失敗しても下書きが残る", document.querySelector("#message-body").value === "消えてほしくない下書き",
    document.querySelector("#message-body").value);
  check("失敗はトーストで知らせる", app.toasts().some((t) => t.includes("投稿できませんでした") || t.includes("row-level")),
    JSON.stringify(app.toasts()));
  check("失敗時の送信ボタンは復帰", !document.querySelector("#message-form button[type=submit]").disabled);
}
{
  // 投稿後にリアルタイムで自分のINSERTが来ても二重表示にならない
  const app = await loadApp({ loggedIn: true, admin: false, messages: seed });
  const { document } = app;
  document.querySelector("#message-body").value = "リアルタイム重複チェック";
  app.submit("#message-form");
  await app.flush(6);
  const inserted = app.fake.state.messages.find((m) => m.body === "リアルタイム重複チェック");
  app.emit("messages", "INSERT", { new: inserted });
  await app.flush(10);
  const count = [...document.querySelectorAll("#text-messages .message-body")].filter((n) => n.textContent === "リアルタイム重複チェック").length;
  check("リアルタイムINSERTで二重表示にならない", count <= 1, "count=" + count);
}

/* ---------------------------------------------------------------- */
section("曲の再生");
{
  const app = await loadApp({ loggedIn: true, messages: seed });
  const { document } = app;
  app.click('[data-page="songs-page"]');
  const card = document.querySelector("#song-messages .message");
  const bar = card.querySelector(".load-audio");
  const audio = card.querySelector(".message-audio");

  check("再生前は音声を取得しない", app.fake.state.signedUrls.length === 0);
  bar.dispatchEvent(new app.window.Event("click", { bubbles: true }));
  await app.flush(30);
  check("再生ボタンで署名URLを取得", app.fake.state.signedUrls[0] === "voices/s1.mp3", JSON.stringify(app.fake.state.signedUrls));
  check("audio に src が入る", audio.getAttribute("src") === "https://signed.example/voices/s1.mp3", audio.getAttribute("src"));
  check("audio が表示される", !audio.classList.contains("hidden"));
  check("読み込みボタンは隠れる", bar.classList.contains("hidden"));
  check("エラー表示は出ていない", card.querySelector(".audio-error").textContent === "");
  check("音量操作できるcontrolsが付いている", audio.hasAttribute("controls"));
}
{
  const app = await loadApp({ loggedIn: true, messages: seed });
  const { document } = app;
  app.fake.client.storage.from = () => ({
    createSignedUrl: async () => ({ data: null, error: new Error("Failed to fetch") }),
    remove: async () => ({ data: null, error: null }),
  });
  app.click('[data-page="songs-page"]');
  const card = document.querySelector("#song-messages .message");
  card.querySelector(".load-audio").dispatchEvent(new app.window.Event("click", { bubbles: true }));
  await app.flush(30);
  check("取得失敗はカード上に日本語で表示", card.querySelector(".audio-error").textContent.includes("通信"),
    card.querySelector(".audio-error").textContent);
  check("取得失敗後もボタンは押せる", !card.querySelector(".load-audio").disabled);
}
{
  // 一覧の再描画（ほかの人の投稿）で再生中のカードが消えても復帰する
  const app = await loadApp({ loggedIn: true, messages: seed });
  const { document } = app;
  app.click('[data-page="songs-page"]');
  const card = document.querySelector("#song-messages .message");
  card.querySelector(".load-audio").dispatchEvent(new app.window.Event("click", { bubbles: true }));
  await app.flush(30);
  const audio = card.querySelector(".message-audio");
  Object.defineProperty(audio, "currentTime", { value: 42, configurable: true });
  Object.defineProperty(audio, "duration", { value: 200, configurable: true });

  const incoming = { id: "m9", type: "text", author: "ほかの人", body: "こんにちは", created_at: new Date().toISOString() };
  app.fake.state.messages.push(incoming);
  app.emit("messages", "INSERT", { new: incoming });
  await app.flush(20);
  const again = document.querySelector("#song-messages .message .message-audio");
  check("再描画後も再生状態を引き継ぐ", !!again && again.getAttribute("src") === "https://signed.example/voices/s1.mp3",
    again ? JSON.stringify(again.getAttribute("src")) : "audio要素なし / songs=" + document.querySelectorAll("#song-messages .message").length);
}

/* ---------------------------------------------------------------- */
section("曲の追加（管理者）");
{
  const app = await loadApp({ loggedIn: true, admin: true, messages: seed });
  const { document } = app;
  app.click('[data-page="songs-page"]');

  const input = document.querySelector("#voice-file");
  Object.defineProperty(input, "files", { value: [fakeFile("song.webm", 3 * 1024 * 1024, "video/webm")], configurable: true });
  input.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await app.flush(30);
  check("WebM（video/webm）を受け付ける", document.querySelector("#recording-status").textContent.includes("song.webm"),
    document.querySelector("#recording-status").textContent);
  check("プレビューが出る", !document.querySelector("#recording-preview").classList.contains("hidden"));
  check("投稿フォームが出る", !document.querySelector("#voice-form").classList.contains("hidden"));
  check("ファイル名から曲名を補完", document.querySelector("#voice-title").value === "song",
    document.querySelector("#voice-title").value);

  document.querySelector("#voice-title").value = "合唱コンクール課題曲";
  app.submit("#voice-form");
  await app.flush(40);
  check("tusでアップロードした", app.fake.state.uploads.length === 1);
  check("曲の行が追加される", app.fake.state.messages.some((m) => m.type === "voice" && m.title === "合唱コンクール課題曲"));
  check("追加後はフォームが隠れる", document.querySelector("#voice-form").classList.contains("hidden"));
  check("保存完了のステータス", document.querySelector("#recording-status").textContent.includes("保存しました"),
    document.querySelector("#recording-status").textContent);
  check("一覧に増える", document.querySelectorAll("#song-messages .message").length === 2);
  check("曲バッジが増える", document.querySelector("#song-count").textContent === "2");
}
{
  // アップロード失敗時にDBへ書かない
  const app = await loadApp({ loggedIn: true, admin: true });
  const { document } = app;
  app.click('[data-page="songs-page"]');
  const input = document.querySelector("#voice-file");
  Object.defineProperty(input, "files", { value: [fakeFile("fail.mp3", 2 * 1024 * 1024, "audio/mpeg")], configurable: true });
  input.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  await app.flush(30);
  app.window.tus.Upload.failNext = true;
  app.submit("#voice-form");
  await app.flush(40);
  app.window.tus.Upload.failNext = false;
  check("アップロード失敗を画面に出す", document.querySelector("#recording-status").textContent.includes("曲の保存に失敗しました"),
    document.querySelector("#recording-status").textContent);
  check("アップロード失敗時はDBに書かない", !app.fake.state.messages.length);
  check("失敗後も送信ボタンが戻る", !document.querySelector("#voice-form button[type=submit]").disabled);
  check("失敗後も選択したファイルは残る", !document.querySelector("#voice-form").classList.contains("hidden"));
}
{
  const app = await loadApp({ loggedIn: true, admin: true });
  const { document } = app;
  const input = document.querySelector("#voice-file");
  const setFile = (f) => {
    Object.defineProperty(input, "files", { value: [f], configurable: true });
    input.dispatchEvent(new app.window.Event("change", { bubbles: true }));
  };

  app.window.__audioDuration = 30;
  setFile(fakeFile("short.mp3", 500 * 1024, "audio/mpeg"));
  await app.flush(30);
  check("60秒以下の曲は断る", document.querySelector("#recording-status").textContent.includes("60秒より長く"),
    document.querySelector("#recording-status").textContent);
  check("60秒以下の曲はフォームを出さない", document.querySelector("#voice-form").classList.contains("hidden"));

  app.window.__audioDuration = 120;
  setFile(fakeFile("huge.mp3", 20 * 1024 * 1024, "audio/mpeg"));
  await app.flush(30);
  check("10MB超は断る", document.querySelector("#recording-status").textContent.includes("10MBを超え"),
    document.querySelector("#recording-status").textContent);

  setFile(fakeFile("photo.jpg", 1024, "image/jpeg"));
  await app.flush(30);
  check("音声以外は断る", document.querySelector("#recording-status").textContent.includes("音声ファイル"),
    document.querySelector("#recording-status").textContent);

  setFile(fakeFile("ok.mp3", 2 * 1024 * 1024, "audio/mpeg"));
  await app.flush(30);
  app.click("#track-cancel");
  check("選択を取り消せる", document.querySelector("#voice-form").classList.contains("hidden"));
  check("取り消し後に入力も消える", document.querySelector("#voice-file").value === "");
}
{
  const app = await loadApp({ loggedIn: true, admin: false });
  check("メンバーにはアップロード欄を見せない", app.document.querySelector("#admin-song-upload").classList.contains("hidden"));
}

/* ---------------------------------------------------------------- */
section("設定と削除（管理者）");
{
  const app = await loadApp({ loggedIn: true, admin: true, messages: seed });
  const { document } = app;
  app.click("#settings-tab");

  document.querySelector("#site-input").value = "1年A組 合唱ボード";
  document.querySelector("#song-input").value = "手紙";
  app.submit("#site-form");
  await app.flush(30);
  check("サイト名が保存される", app.fake.state.settings.find((s) => s.key === "siteTitle").value === "1年A組 合唱ボード");
  check("ヘッダーに反映される", document.querySelector("#site-title").textContent === "1年A組 合唱ボード");
  check("現在の曲が反映される", document.querySelector("#song-title").textContent === "手紙");
  check("設定保存のトースト", app.toasts().some((t) => t.includes("設定を保存")), JSON.stringify(app.toasts()));

  check("投稿管理に一覧が出る", document.querySelectorAll("#admin-message-list .admin-row").length === 3,
    "rows=" + document.querySelectorAll("#admin-message-list .admin-row").length);
  const row = [...document.querySelectorAll("#admin-message-list .admin-row")].find((r) => r.textContent.includes("旅立ちの時"));
  row.querySelector(".admin-row-delete").dispatchEvent(new app.window.Event("click", { bubbles: true }));
  await app.flush(40);
  check("曲の行が削除される", !app.fake.state.messages.some((m) => m.id === "s1"));
  check("音声ファイルも削除される", app.fake.state.removedObjects.includes("voices/s1.mp3"), JSON.stringify(app.fake.state.removedObjects));
  check("削除のトースト", app.toasts().some((t) => t.includes("削除しました")), JSON.stringify(app.toasts()));
  check("一覧が減る", document.querySelectorAll("#admin-message-list .admin-row").length === 2,
    "rows=" + document.querySelectorAll("#admin-message-list .admin-row").length);
  check("曲一覧からも消える", document.querySelectorAll("#song-messages .message").length === 0);
  check("コメントの投稿カードには削除ボタンを出さない（README通り）",
    document.querySelector("#text-messages .delete-button") === null);
}
{
  const app = await loadApp({ loggedIn: true, admin: true, messages: seed });
  app.click("#settings-tab");
  app.fake.state.failNext = "delete";
  const row = app.document.querySelector("#admin-message-list .admin-row");
  row.querySelector(".admin-row-delete").dispatchEvent(new app.window.Event("click", { bubbles: true }));
  await app.flush(40);
  check("削除失敗をトーストで知らせる", app.toasts().some((t) => t.includes("削除できませんでした") || t.includes("permission")),
    JSON.stringify(app.toasts()));
  check("削除失敗後もボタンが押せる", !row.querySelector(".admin-row-delete").disabled);
  check("削除失敗で未処理の例外を出さない", app.errors.length === 0, JSON.stringify(app.errors));
}
{
  const app = await loadApp({ loggedIn: true, admin: false, messages: seed });
  app.click("#settings-tab");
  check("メンバーが設定タブを押しても設定ページは出ない",
    app.document.querySelector("#settings-page").classList.contains("hidden"));
}

/* ---------------------------------------------------------------- */
section("更新ボタン / 通信断 / リアルタイム");
{
  const app = await loadApp({ loggedIn: true, messages: seed });
  const { document } = app;
  app.click("#reload-button");
  await app.flush(30);
  check("更新のトースト", app.toasts().some((t) => t.includes("更新しました")), JSON.stringify(app.toasts()));
  check("更新ボタンが復帰", !document.querySelector("#reload-button").disabled && document.querySelector("#reload-button").textContent === "更新");
}
{
  const app = await loadApp({
    loggedIn: false,
    storage: {
      "choir-cache-messages-v3": JSON.stringify({ savedAt: Date.now(), data: seed }),
      "choir-cache-settings-v3": JSON.stringify({ savedAt: Date.now(), data: { siteTitle: "1A 合唱伝言板", songTitle: "旅立ちの時" } }),
    },
  });
  const { document } = app;
  app.fake.state.failNext = "select:messages";

  document.querySelector("#password").value = "pass1234";
  app.submit("#login-form");
  await app.flush(40);
  check("通信断でもログインしてアプリ画面を出せる", !document.querySelector("#app-view").classList.contains("hidden"));
  check("通信断でもキャッシュを表示", document.querySelectorAll("#text-messages .message").length === 2,
    "cards=" + document.querySelectorAll("#text-messages .message").length);
  check("通信断のバナーが出る", !document.querySelector("#messages-error").classList.contains("hidden"),
    document.querySelector("#messages-error").textContent);
  check("ヘッダーに状態を出す", document.querySelector("#connection-status").textContent.includes("最新"),
    JSON.stringify(document.querySelector("#connection-status").textContent));
}
{
  const app = await loadApp({ loggedIn: true, admin: false, messages: seed });
  const { document } = app;
  check("リアルタイム購読している", app.fake.state.channelSubs.length === 1);
  app.emit("messages", "INSERT", {
    new: { id: "live1", type: "text", author: "山田", body: "リアルタイム投稿", created_at: new Date().toISOString() },
  });
  await app.flush(10);
  check("リアルタイムで新着が出る", [...document.querySelectorAll("#text-messages .message-body")].some((n) => n.textContent === "リアルタイム投稿"));
  check("リアルタイムで件数が増える", document.querySelector("#message-count").textContent === "3",
    document.querySelector("#message-count").textContent);

  app.emit("messages", "DELETE", { old: { id: "live1" } });
  await app.flush(10);
  check("リアルタイムで削除が反映される", ![...document.querySelectorAll("#text-messages .message-body")].some((n) => n.textContent === "リアルタイム投稿"));

  app.emit("settings", "UPDATE", { new: { key: "songTitle", value: "新しい曲" } });
  await app.flush(10);
  check("リアルタイムで曲名が変わる", document.querySelector("#song-title").textContent === "新しい曲",
    document.querySelector("#song-title").textContent);
}

/* ---------------------------------------------------------------- */
section("空の状態");
{
  const app = await loadApp({ loggedIn: true, messages: [] });
  const { document } = app;
  check("コメントが0件のときの案内", document.querySelector("#text-messages .empty").textContent.includes("まだコメントはありません"));
  app.click('[data-page="songs-page"]');
  check("曲が0件のときの案内", document.querySelector("#song-messages .empty").textContent.includes("まだ曲はありません"));
  app.click("#settings-tab");
  check("管理一覧が0件のときの案内", document.querySelector("#admin-message-list .empty").textContent.includes("まだありません"));
}

/* ---------------------------------------------------------------- */
console.log(lines.join("\n"));
console.log("\n" + "=".repeat(52));
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) console.log("failed:\n - " + failures.join("\n - "));
process.exit(fail ? 1 : 0);
