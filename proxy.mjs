// Proxy HTTPS para IPTV en Vercel (Node.js runtime). /proxy?url=<URL>[&raw=1]
import { Readable } from "node:stream";

const UA = "VLC/3.0.18 LibVLC/3.0.18";
const MEDIA_EXT = /\.(ts|aac|mp4|m4s|m4a|mp3|webm|mkv|flv|key)(\?|$)/i;

function isPrivate(h) {
  h = h.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h.includes(":") && (h === "::1" || /^(fc|fd|fe80|::ffff)/.test(h));
}

function rewrite(text, base) {
  const px = (u) => {
    try { return "/proxy?url=" + encodeURIComponent(new URL(u, base).href); } catch { return u; }
  };
  return text.split(/\r?\n/).map((l) => {
    const t = l.trim();
    if (!t) return l;
    if (t.startsWith("#")) return l.replace(/URI="([^"]*)"/g, (m, u) => (u.startsWith("data:") ? m : `URI="${px(u)}"`));
    return px(t);
  }).join("\n");
}

function rewriteMpd(text, base) {
  const b64 = (u) => Buffer.from(u).toString("base64url");
  const abs = (u) => {
    const x = new URL(u), k = x.pathname.lastIndexOf("/") + 1;
    return "/pp/" + b64(x.origin + x.pathname.slice(0, k)) + "/" + x.pathname.slice(k) + x.search;
  };
  const pi = text.search(/<Period[\s>]/);
  const head = pi < 0 ? text : text.slice(0, pi), tail = pi < 0 ? "" : text.slice(pi);
  const bu = /<BaseURL([^>]*)>([^<]*)<\/BaseURL>/g;
  let found = false;
  let h = head.replace(bu, (m, a, u) => {
    found = true;
    try { return `<BaseURL${a}>${abs(new URL(u.trim(), base).href)}</BaseURL>`; } catch { return m; }
  });
  if (!found) {
    const x = new URL(base), dir = x.origin + x.pathname.slice(0, x.pathname.lastIndexOf("/") + 1);
    h = h.replace(/<MPD[^>]*>/, (m) => m + `<BaseURL>/pp/${b64(dir)}/</BaseURL>`);
  }
  const t = tail.replace(bu, (m, a, u) => (/^https?:\/\//i.test(u.trim()) ? `<BaseURL${a}>${abs(u.trim())}</BaseURL>` : m));
  return h + t;
}

const fail = (res, status, msg) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: msg }));
};

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return fail(res, 403, "Origen no permitido"); }
    catch { return fail(res, 403, "Origen inválido"); }
  }
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  const params = new URL(req.url, "https://x.local").searchParams;
  let target;
  try {
    const pp = params.get("pp");
    if (pp) {
      const i = pp.indexOf("/");
      target = new URL(pp.slice(i + 1), Buffer.from(pp.slice(0, i), "base64url").toString());
      params.forEach((v, k) => { if (k !== "pp") target.searchParams.append(k, v); });
    } else target = new URL(params.get("url") || "");
  } catch { return fail(res, 400, "Falta ?url= válida"); }
  if (!/^https?:$/.test(target.protocol)) return fail(res, 400, "Solo http/https");
  if (isPrivate(target.hostname)) return fail(res, 403, "Host no permitido");

  const headers = { "user-agent": UA, accept: "*/*" };
  if (req.headers.range) headers.range = req.headers.range;

  const ctl = new AbortController();
  req.on("close", () => ctl.abort());
  const timer = setTimeout(() => ctl.abort(), 15000);
  let up;
  try { up = await fetch(target.href, { headers, redirect: "follow", signal: ctl.signal }); }
  catch (e) { return fail(res, 502, "No se pudo conectar: " + (e.name === "AbortError" ? "tiempo agotado" : e.message)); }
  finally { clearTimeout(timer); }

  if (!up.ok && up.status !== 206) return fail(res, up.status, "El servidor respondió " + up.status);

  const ctype = up.headers.get("content-type") || "";
  res.setHeader("cache-control", "no-store");
  for (const k of ["content-type", "content-range", "accept-ranges"]) if (up.headers.get(k)) res.setHeader(k, up.headers.get(k));

  const maybePlaylist = !/^(video|audio)\//i.test(ctype) && !MEDIA_EXT.test(new URL(up.url).pathname);
  if (!up.body) { res.statusCode = up.status; return res.end(); }

  const reader = up.body.getReader();
  const first = await reader.read();
  const head = !first.done && maybePlaylist ? new TextDecoder().decode(first.value.slice(0, 16)).replace(/^\uFEFF/, "") : "";

  if (head.startsWith("#EXTM3U")) {
    const parts = [first.value]; let size = first.value.length;
    while (size < 20e6) { const { done, value } = await reader.read(); if (done) break; parts.push(value); size += value.length; }
    let text = Buffer.concat(parts).toString("utf8");
    if (!params.get("raw") && /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|MAP|VERSION)/.test(text)) text = rewrite(text, up.url);
    res.statusCode = 200;
    res.setHeader("content-type", "application/vnd.apple.mpegurl");
    return res.end(text);
  }

  if (maybePlaylist && !first.done && /<MPD[\s>]/.test(new TextDecoder().decode(first.value.slice(0, 1024)))) {
    const parts = [first.value]; let size = first.value.length;
    while (size < 5e6) { const { done, value } = await reader.read(); if (done) break; parts.push(value); size += value.length; }
    res.statusCode = 200;
    res.setHeader("content-type", "application/dash+xml");
    return res.end(rewriteMpd(Buffer.concat(parts).toString("utf8"), up.url));
  }

  // Stream directo (TS en vivo, segmentos, mp4...)
  res.statusCode = up.status;
  const body = new ReadableStream({
    start(c) { if (first.value) c.enqueue(first.value); if (first.done) c.close(); },
    async pull(c) { const { done, value } = await reader.read(); done ? c.close() : c.enqueue(value); },
    cancel() { reader.cancel().catch(() => {}); },
  });
  const node = Readable.fromWeb(body);
  res.on("close", () => node.destroy());
  node.on("error", () => res.end());
  node.pipe(res);
}
