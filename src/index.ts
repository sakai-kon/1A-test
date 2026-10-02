import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  SITE_PASSWORD: string;
  SESSION_SECRET: string;
  WEB_ORIGIN: string;
  SESSION_TTL_SECONDS?: string;
}

const SESSION_COOKIE = "choir_session";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 60_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = origin && (
    origin === env.WEB_ORIGIN ||
    origin === "http://localhost:8787" ||
    origin === "http://127.0.0.1:8787"
  );

  return {
    "Access-Control-Allow-Origin": allowed ? origin : env.WEB_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

const json = (data: unknown, status = 200, extraHeaders: HeadersInit = {}, request?: Request, env?: Env) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(request && env ? corsHeaders(request, env) : {}),
      ...extraHeaders
    }
  });

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)));
}

async function signSession(env: Env): Promise<string> {
  const ttl = Math.max(300, Number(env.SESSION_TTL_SECONDS ?? "43200") || 43200);
  const payload = JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + ttl,
    nonce: crypto.randomUUID()
  });
  const payload64 = base64UrlEncode(textEncoder.encode(payload));
  const signature = await hmac(env.SESSION_SECRET, payload64);
  return payload64 + "." + base64UrlEncode(signature);
}

async function verifySession(env: Env, token: string | null): Promise<boolean> {
  if (!token || !env.SESSION_SECRET) return false;

  const [payload64, signature64] = token.split(".");
  if (!payload64 || !signature64) return false;

  try {
    const expected = await hmac(env.SESSION_SECRET, payload64);
    const actual = base64UrlDecode(signature64);
    if (actual.length !== expected.length) return false;

    let different = 0;
    for (let i = 0; i < expected.length; i++) different |= expected[i] ^ actual[i];
    if (different !== 0) return false;

    const payload = JSON.parse(textDecoder.decode(base64UrlDecode(payload64))) as { exp?: number };
    return Number.isFinite(payload.exp) && Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function sessionCookie(token: string, maxAge: number): string {
  return [
    SESSION_COOKIE + "=" + token,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=" + maxAge
  ].join("; ");
}

async function isAuthed(request: Request, env: Env): Promise<boolean> {
  const bearer = getBearerToken(request);
  if (await verifySession(env, bearer)) return true;
  return verifySession(env, getCookie(request, SESSION_COOKIE));
}

async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  if (await isAuthed(request, env)) return null;
  return json({ error: "ログインが必要です。" }, 401, {}, request, env);
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

async function readSettings(env: Env): Promise<Record<string, string>> {
  const result = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const row of result.results) settings[row.key] = row.value;
  return settings;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env)
    });
  }

  const pathname = url.pathname;

  if (request.method === "POST" && pathname === "/api/login") {
    const body = await request.json().catch(() => null) as { password?: unknown } | null;
    const password = String(body?.password ?? "");

    if (!env.SITE_PASSWORD || !env.SESSION_SECRET) {
      return json({ error: "CloudflareのSecretが未設定です。" }, 500, {}, request, env);
    }

    if (password.length === 0 || password.length > 256) {
      return json({ error: "パスワードを入力してください。" }, 400, {}, request, env);
    }

    const expected = textEncoder.encode(env.SITE_PASSWORD);
    const actual = textEncoder.encode(password);
    if (expected.length !== actual.length) {
      return json({ error: "パスワードが違います。" }, 401, {}, request, env);
    }

    let different = 0;
    for (let i = 0; i < expected.length; i++) different |= expected[i] ^ actual[i];
    if (different !== 0) return json({ error: "パスワードが違います。" }, 401, {}, request, env);

    const ttl = Math.max(300, Number(env.SESSION_TTL_SECONDS ?? "43200") || 43200);
    const token = await signSession(env);

    return json(
      { ok: true, token, expiresIn: ttl },
      200,
      { "Set-Cookie": sessionCookie(token, ttl) },
      request,
      env
    );
  }

  if (request.method === "POST" && pathname === "/api/logout") {
    return json(
      { ok: true },
      200,
      { "Set-Cookie": sessionCookie("", 0) },
      request,
      env
    );
  }

  const authError = await requireAuth(request, env);
  if (authError) return authError;

  if (request.method === "GET" && pathname === "/api/settings") {
    return json(await readSettings(env), 200, {}, request, env);
  }

  if (request.method === "PUT" && pathname === "/api/settings") {
    const body = await request.json().catch(() => null) as { songTitle?: unknown } | null;
    const songTitle = cleanText(body?.songTitle, 200);
    if (!songTitle) return json({ error: "曲名を入力してください。" }, 400, {}, request, env);

    await env.DB.prepare(
      "INSERT INTO settings(key, value) VALUES('songTitle', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(songTitle).run();

    return json({ ok: true, songTitle }, 200, {}, request, env);
  }

  if (request.method === "GET" && pathname === "/api/messages") {
    const result = await env.DB.prepare(
      "SELECT id, type, author, title, body, mime_type, size_bytes, duration_ms, created_at " +
      "FROM messages ORDER BY created_at DESC LIMIT 100"
    ).all();

    const messages = result.results.map((row) => ({
      ...row,
      audioUrl: row.type === "voice" ? "/api/voice/" + row.id : null
    }));

    return json({ messages }, 200, {}, request, env);
  }

  if (request.method === "POST" && pathname === "/api/messages") {
    const body = await request.json().catch(() => null) as { author?: unknown; body?: unknown } | null;
    const author = cleanText(body?.author, 40) || "匿名";
    const message = cleanText(body?.body, 2000);

    if (!message) return json({ error: "本文を入力してください。" }, 400, {}, request, env);

    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO messages(id, type, author, title, body, created_at) VALUES(?, 'text', ?, '', ?, ?)"
    ).bind(id, author, message, Date.now()).run();

    return json({ ok: true, id }, 200, {}, request, env);
  }

  if (request.method === "POST" && pathname === "/api/voices") {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) return json({ error: "音声ファイルがありません。" }, 400, {}, request, env);

    if (audio.size <= 0 || audio.size > MAX_AUDIO_BYTES) {
      return json({ error: "音声は1ファイル10MBまでです。" }, 413, {}, request, env);
    }

    if (!audio.type.startsWith("audio/")) {
      return json({ error: "音声ファイルだけアップロードできます。" }, 415, {}, request, env);
    }

    const durationMs = Math.max(
      0,
      Math.min(MAX_AUDIO_DURATION_MS, Number(form.get("durationMs") ?? 0) || 0)
    );
    const author = cleanText(form.get("author"), 40) || "匿名";
    const title = cleanText(form.get("title"), 100) || "音声伝言";

    const id = crypto.randomUUID();
    const extension = (audio.type.split("/")[1] ?? "audio").split(";")[0].replace(/[^a-z0-9.+-]/gi, "") || "audio";
    const objectKey = "voices/" + id + "." + extension;

    await env.AUDIO.put(objectKey, audio.stream(), {
      httpMetadata: { contentType: audio.type },
      customMetadata: { author, title }
    });

    await env.DB.prepare(
      "INSERT INTO messages(id, type, author, title, body, object_key, mime_type, size_bytes, duration_ms, created_at) " +
      "VALUES(?, 'voice', ?, ?, '', ?, ?, ?, ?, ?)"
    ).bind(id, author, title, objectKey, audio.type, audio.size, durationMs, Date.now()).run();

    return json({ ok: true, id, audioUrl: "/api/voice/" + id }, 200, {}, request, env);
  }

  if (request.method === "GET" && pathname.startsWith("/api/voice/")) {
    const id = pathname.slice("/api/voice/".length);
    if (!id) return new Response("Not found", { status: 404, headers: corsHeaders(request, env) });

    const row = await env.DB.prepare(
      "SELECT object_key, mime_type FROM messages WHERE id = ? AND type = 'voice'"
    ).bind(id).first<{ object_key: string; mime_type: string }>();

    if (!row?.object_key) return new Response("Not found", { status: 404, headers: corsHeaders(request, env) });

    const object = await env.AUDIO.get(row.object_key);
    if (!object) return new Response("Not found", { status: 404, headers: corsHeaders(request, env) });

    const headers = new Headers(corsHeaders(request, env));
    headers.set("Content-Type", row.mime_type || "application/octet-stream");
    headers.set("Cache-Control", "private, no-store");
    headers.set("Accept-Ranges", "bytes");
    return new Response(object.body, { headers });
  }

  const deleteMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (request.method === "DELETE" && deleteMatch) {
    const id = deleteMatch[1];
    const row = await env.DB.prepare(
      "SELECT type, object_key FROM messages WHERE id = ?"
    ).bind(id).first<{ type: string; object_key: string | null }>();

    if (!row) return json({ error: "メッセージが見つかりません。" }, 404, {}, request, env);

    if (row.object_key) await env.AUDIO.delete(row.object_key);
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();

    return json({ ok: true }, 200, {}, request, env);
  }

  return json({ error: "API endpoint not found" }, 404, {}, request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return new Response("1A Choir API", { status: 200 });
    }

    try {
      return await handleApi(request, env, url);
    } catch (error) {
      console.error(error);
      return json({ error: "サーバー側でエラーが発生しました。" }, 500, {}, request, env);
    }
  }
};
