import fs from "node:fs";
import { JSDOM } from "jsdom";

const ROOT = new URL("../public", import.meta.url).pathname;

/**
 * Supabase クライアントのフェイク。
 * state を書き換えると、次の select / insert でそれが返る。
 * （配列は必ずコピーして、テスト間で混ざらないようにする）
 */
export function makeFakeSupabase(state = {}) {
  const s = {
    session: state.session ?? null,
    user: state.session ? { id: "user-1", email: "1a-choir-login@choir-class.jp" } : null,
    admins: [...(state.admins ?? [])],
    settings: [
      ...(state.settings ?? [
        { key: "siteTitle", value: "1A 合唱伝言板" },
        { key: "songTitle", value: "旅立ちの時" },
      ]),
    ],
    messages: [...(state.messages ?? [])],
    calls: [],
    failNext: state.failNext ?? null,
    channelSubs: [],
    handlers: [],
    removedChannels: [],
    signedUrls: [],
    removedObjects: [],
    insertDelayMs: state.insertDelayMs ?? 0,
  };

  const table = (name) => {
    const api = {
      select: () => {
        const q = {
          order: () => q,
          limit: () => q,
          eq: () => q,
          maybeSingle: async () => {
            s.calls.push([name, "maybeSingle"]);
            if (name === "admins") {
              const row = s.admins.find((a) => a.user_id === s.user?.id);
              return { data: row ?? null, error: null };
            }
            return { data: null, error: null };
          },
          then: (res, rej) => {
            s.calls.push([name, "select"]);
            if (s.failNext === "select" || s.failNext === "select:" + name) {
              s.failNext = null;
              return Promise.resolve({ data: null, error: new Error("Failed to fetch") }).then(res, rej);
            }
            let rows = name === "settings" ? s.settings : s.messages.slice();
            if (name === "messages") {
              rows = rows
                .slice()
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                .slice(0, 100);
            }
            return Promise.resolve({ data: rows, error: null }).then(res, rej);
          },
        };
        return q;
      },
      insert: (rows) => ({
        then: (res, rej) => {
          s.calls.push([name, "insert"]);
          const list = Array.isArray(rows) ? rows : [rows];
          const run = () => {
            if (s.failNext === "insert") {
              s.failNext = null;
              return { data: null, error: new Error("new row violates row-level security policy") };
            }            for (const r of list) {
              if (name === "settings") {
                const i = s.settings.findIndex((x) => x.key === r.key);
                if (i >= 0) s.settings[i] = { key: r.key, value: r.value };
                else s.settings.push({ key: r.key, value: r.value });
              } else {
                s.messages.push({
                  id: r.id ?? crypto.randomUUID(),
                  created_at: r.created_at ?? new Date().toISOString(),
                  type: r.type,
                  author: r.author,
                  title: r.title ?? "",
                  body: r.body ?? "",
                  object_path: r.object_path ?? null,
                  mime_type: r.mime_type ?? null,
                  size_bytes: r.size_bytes ?? null,
                  duration_ms: r.duration_ms ?? null,
                  user_id: r.user_id,
                });
              }
            }
            return { data: list, error: null };
          };
          const settled = s.insertDelayMs
            ? new Promise((r) => setTimeout(r, s.insertDelayMs)).then(run)
            : Promise.resolve().then(run);
          return settled.then(res, rej);
        },
      }),
      upsert: (rows) => api.insert(rows),
      delete: () => ({
        eq: (_col, val) => ({
          then: (res, rej) => {
            s.calls.push([name, "delete"]);
            if (s.failNext === "delete") {
              s.failNext = null;
              return Promise.resolve({ data: null, error: new Error("permission denied") }).then(res, rej);
            }
            if (name === "messages") s.messages = s.messages.filter((m) => m.id !== val);
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          },
        }),
      }),
    };
    return api;
  };

  const client = {
    auth: {
      getSession: async () => ({ data: { session: s.session }, error: null }),
      getUser: async () => ({ data: { user: s.user }, error: null }),
      signInWithPassword: async ({ email, password }) => {
        s.calls.push(["auth", "signInWithPassword"]);
        if (password !== "pass1234") return { data: null, error: { message: "Invalid login credentials" } };
        s.session = { access_token: "tok" };
        s.user = { id: "user-1", email };
        return { data: { session: s.session, user: s.user }, error: null };
      },
      signOut: async () => {
        s.calls.push(["auth", "signOut"]);
        s.session = null;
        s.user = null;
        return { error: null };
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: table,
    storage: {
      from: () => ({
        createSignedUrl: async (path) => {
          s.signedUrls.push(path);
          return { data: { signedUrl: "https://signed.example/" + path }, error: null };
        },
        remove: async (paths) => {
          s.removedObjects.push(...paths);
          return { data: null, error: null };
        },
      }),
    },
    channel: () => {
      const ch = {
        on: (_type, filter, cb) => {
          s.handlers.push({ table: filter?.table, cb });
          return ch;
        },
        subscribe: (cb) => {
          s.channelSubs.push({ ch, cb });
          cb?.("SUBSCRIBED");
          return ch;
        },
      };
      return ch;
    },
    removeChannel: async (ch) => {
      s.removedChannels.push(ch);
    },
  };

  return { client, state: s };
}

class FakeTusUpload {
  constructor(file, options) {
    this.file = file;
    this.options = options;
    FakeTusUpload.instances.push(this);
  }
  start() {
    const { onProgress, onSuccess, onError } = this.options;
    setTimeout(() => {
      if (FakeTusUpload.failNext) {
        FakeTusUpload.failNext = false;
        onError?.(new Error("tus: unexpected response while creating upload"));
        return;
      }
      onProgress?.(this.file.size / 2, this.file.size);
      onProgress?.(this.file.size, this.file.size);
      onSuccess?.();
    }, 0);
  }
  abort() {}
}
FakeTusUpload.instances = [];
FakeTusUpload.failNext = false;

export function fakeFile(name, size, type) {
  return { name, size, type, slice: () => ({}) };
}

export async function loadApp({
  loggedIn = false,
  admin = true,
  messages = [],
  settings = null,
  config = null,
  storage = null,
  insertDelayMs = 0,
  url = "https://example.github.io/1A-test/public/",
} = {}) {
  const html = fs.readFileSync(ROOT + "/index.html", "utf8");
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;

  const errors = [];
  const consoleErrors = [];

  const fake = makeFakeSupabase({
    session: loggedIn ? { access_token: "tok" } : null,
    admins: admin ? [{ user_id: "user-1" }] : [],
    messages,
    insertDelayMs,
    ...(settings ? { settings } : {}),
  });

  window.CHOIR_CONFIG =
    config ?? {
      SUPABASE_URL: "https://jwizoczvtuxqtyxtbson.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      AUTH_EMAIL: "1a-choir-login@choir-class.jp",
    };
  window.supabase = { createClient: () => fake.client };
  FakeTusUpload.instances.length = 0;
  fake.state.uploads = FakeTusUpload.instances;
  window.tus = { Upload: FakeTusUpload };
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.alert = (m) => errors.push("alert: " + m);
  window.URL.createObjectURL = () => "blob:fake-" + Math.random().toString(36).slice(2);
  window.URL.revokeObjectURL = () => {};
  window.Audio = class {
    set src(_v) {
      setTimeout(() => this.onloadedmetadata?.(), 0);
    }
    get duration() {
      return window.__audioDuration ?? 120;
    }
  };

  window.console.error = (...args) => consoleErrors.push(args.map(String).join(" "));
  window.console.warn = () => {};
  window.addEventListener("error", (e) => errors.push(String(e.message ?? e.error)));

  const media = window.HTMLMediaElement.prototype;
  media.play = async function () {
    Object.defineProperty(this, "paused", { value: false, configurable: true });
    this.dispatchEvent(new window.Event("playing"));
  };
  media.pause = function () {
    Object.defineProperty(this, "paused", { value: true, configurable: true });
  };
  media.load = function () {};

  if (storage) {
    for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  }

  window.eval(fs.readFileSync(ROOT + "/app.js", "utf8"));

  const flush = async (n = 20) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await flush();

  const submit = (selector) =>
    window.document
      .querySelector(selector)
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const click = (selector) =>
    window.document
      .querySelector(selector)
      .dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  const input = (selector) =>
    window.document.querySelector(selector).dispatchEvent(new window.Event("input", { bubbles: true }));
  const toasts = () => [...window.document.querySelectorAll("#toasts .toast")].map((n) => n.textContent);
  const emit = (table, eventType, payload) => {
    for (const h of fake.state.handlers) {
      if (h.table === table) h.cb({ eventType, ...payload });
    }
  };

  return { window, document: window.document, fake, errors, consoleErrors, flush, submit, click, input, toasts, emit };
}
