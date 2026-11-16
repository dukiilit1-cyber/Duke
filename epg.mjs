// Guía EPG real multi-país. /api/epg?src=US2&name=HBO&tid=HBO.us
// Descarga epg_ripper_<src>.xml.gz de epgshare01, busca el canal y devuelve solo sus programas.
import zlib from "node:zlib";

const HOSTS = (s) => [
  `https://epgshare01.online/epgshare01/epg_ripper_${s}.xml.gz`,
  `https://raw.githubusercontent.com/kevev/share01/master/epg_ripper_${s}.xml.gz`,
];
const cache = new Map(); // src -> { t, xml }

const dec = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function norm(x) {
  return String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(hd|fhd|uhd|sd|4k|1080p|720p|480p|hevc|h265|tv|canal|ar|arg|argentina|en vivo|live)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
export function parseChannels(xml) {
  const ch = {};
  for (const m of xml.matchAll(/<channel id="([^"]*)">([\s\S]*?)<\/channel>/g))
    ch[dec(m[1])] = [...m[2].matchAll(/<display-name[^>]*>([^<]*)<\/display-name>/g)].map((x) => dec(x[1].trim())).filter(Boolean);
  return ch;
}
export function findChannel(ch, name, tid) {
  if (tid && ch[tid]) return tid;
  const idx = new Map();
  for (const id in ch) for (const n of [id.replace(/\.[a-z]{2}$/i, ""), ...ch[id]]) { const k = norm(n); if (k && !idx.has(k)) idx.set(k, id); }
  const k = norm(name);
  if (!k) return null;
  if (idx.has(k)) return idx.get(k);
  if (k.length < 4) return null;
  let best = null, bl = 0;
  for (const [n, id] of idx)
    if (n.length >= 4 && n.length > bl && ((" " + k + " ").includes(" " + n + " ") || (" " + n + " ").includes(" " + k + " "))) { best = id; bl = n.length; }
  return best;
}
function ts(v) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-]\d{4})?/.exec(v || "");
  if (!m) return 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const o = m[7] ? (m[7][0] === "-" ? -1 : 1) * (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) : 0;
  return t - o * 60000;
}
export function programmes(xml, id, now = Date.now()) {
  const from = now - 3 * 3600e3, to = now + 30 * 3600e3, out = [];
  const re = new RegExp('<programme\\s+[^>]*channel="' + esc(id) + '"[^>]*>[\\s\\S]*?<\\/programme>', "g");
  for (const m of xml.matchAll(re)) {
    const a = m[0], s = ts((/start="([^"]*)"/.exec(a) || [])[1]), e = ts((/stop="([^"]*)"/.exec(a) || [])[1]);
    const t = /<title[^>]*>([^<]*)<\/title>/.exec(a);
    if (s && e && t && e > from && s < to) out.push([s, e, dec(t[1].trim())]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

async function getXml(src) {
  const c = cache.get(src);
  if (c && Date.now() - c.t < 20 * 60e3) return c.xml;
  let last = "";
  for (const url of HOSTS(src)) {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0" } });
      if (!r.ok) { clearTimeout(timer); last = "HTTP " + r.status; continue; }
      const buf = Buffer.from(await r.arrayBuffer()); clearTimeout(timer);
      const xml = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString("utf8");
      cache.set(src, { t: Date.now(), xml });
      while (cache.size > 3) cache.delete(cache.keys().next().value);
      return xml;
    } catch (e) { last = e.message; }
  }
  throw new Error(last || "sin respuesta");
}

export default async function handler(req, res) {
  const p = new URL(req.url, "https://x.local").searchParams;
  const src = p.get("src") || "AR1", name = p.get("name") || "", tid = p.get("tid") || "";
  res.setHeader("content-type", "application/json");
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(src)) { res.statusCode = 400; return res.end(JSON.stringify({ error: "src inválido" })); }
  try {
    const xml = await getXml(src);
    const id = findChannel(parseChannels(xml), name, tid);
    const pr = id ? programmes(xml, id) : [];
    res.setHeader("cache-control", "public, s-maxage=1800, stale-while-revalidate=7200");
    res.end(JSON.stringify({ src, id: id || null, pr }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: `Fuente ${src} no disponible: ${e.message}` }));
  }
}
