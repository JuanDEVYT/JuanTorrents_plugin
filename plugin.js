/// <reference path="./kino.d.ts" />
// Mis Torrents para Kino · apiVersion 8
//
// Pega el magnet o la URL .torrent de TUS propios torrents en Ajustes ("Tus torrents", lista) y aparecen
// en Inicio listos para reproducir. La resolución del stream usa la API REST pública de Webtor.io
// (https://api.webtor.io): añade el torrent como "recurso", lista sus archivos y pide un link de stream
// ya transcodificado. No usa el navegador oculto de Kino: la API de Webtor expone estos tres pasos como
// JSON normal, así que no hace falta simular nada dentro de una página.
//
// El ajuste "torrents" (tipo "list") copia la forma exacta de JuanEmbeds_plugin (campos nombre/url,
// url con required:true): una versión anterior con sus propias claves ("name"/"link", sin required) dio
// "error en el campo settings" al instalar.

const API = "https://api.webtor.io";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas: lo justo para no re-añadir el torrent en cada Inicio
const VERSION = "0.3.0";

// ---------------------------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------------------------

function torrentEntries() {
  const raw = kino.config.get("torrents");
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({ name: String((e && e.nombre) || "").trim(), link: String((e && e.url) || "").trim() }))
    .filter((e) => e.link);
}

function apiKey() {
  const k = kino.config.get("apiKey");
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

function looksLikeTorrentLink(link) {
  return /^magnet:\?/i.test(link) || /^https?:\/\/\S+\.torrent(\?.*)?$/i.test(link) || /^https?:\/\/\S+$/i.test(link);
}

// ---------------------------------------------------------------------------------------------
// Llamadas a la API de Webtor
// ---------------------------------------------------------------------------------------------

function webtorHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const key = apiKey();
  if (key) h["X-Api-Key"] = key;
  return h;
}

async function addResource(link) {
  const r = await kino.fetch(API + "/resource/", {
    method: "POST",
    headers: webtorHeaders({ "Content-Type": "text/plain" }),
    body: link,
    timeoutMs: 25000,
  });
  if (r.status === 408) {
    throw kino.error("timeout", "webtor resource timeout (torrent sin semillas?)", {
      userMessage: "Webtor no pudo descargar los metadatos del torrent (¿sigue teniendo semillas?).",
    });
  }
  if (r.status === 429) throw kino.error("rate_limited", "webtor resource 429");
  if (!r.ok) throw kino.error("unavailable", "webtor resource " + r.status);
  return r.json(); // { id, name, magnet_uri, size, files_count, multi_file, file? }
}

async function listFiles(resourceId) {
  const r = await kino.fetch(
    API + "/resource/" + encodeURIComponent(resourceId) + "/list?output=list&sort=name&limit=500",
    { headers: webtorHeaders(), timeoutMs: 20000 },
  );
  if (r.status === 429) throw kino.error("rate_limited", "webtor list 429");
  if (!r.ok) throw kino.error("unavailable", "webtor list " + r.status);
  const data = r.json();
  return Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
}

function isVideoFile(f) {
  if (f.type && f.type !== "file") return false;
  if (f.mime_type && /^video\//i.test(f.mime_type)) return true;
  return /\.(mp4|mkv|avi|mov|webm|m4v|ts)$/i.test(f.name || f.path || "");
}

async function exportStream(resourceId, contentId) {
  const params = new URLSearchParams({ types: "stream" });
  const key = apiKey();
  if (key) params.set("api-key", key);
  const r = await kino.fetch(
    API + "/resource/" + encodeURIComponent(resourceId) + "/export/" + encodeURIComponent(contentId) + "?" + params.toString(),
    { headers: webtorHeaders(), timeoutMs: 20000 },
  );
  if (r.status === 404) throw kino.error("not_found", "webtor export 404");
  if (r.status === 429) throw kino.error("rate_limited", "webtor export 429");
  if (!r.ok) throw kino.error("unavailable", "webtor export " + r.status);
  const data = r.json();
  const stream = data && data.exports && data.exports.stream;
  if (!stream || !stream.url) {
    throw kino.error("unavailable", "webtor no devolvio stream", {
      userMessage: "Webtor no pudo generar el stream para este archivo todavía. Intenta de nuevo en un momento.",
    });
  }
  return stream;
}

// ---------------------------------------------------------------------------------------------
// Caché local: evita re-añadir el mismo torrent (y volver a esperar sus metadatos) en cada Inicio
// ---------------------------------------------------------------------------------------------

function cacheKey(link) {
  return "res:" + kino.crypto.hash("sha1", link);
}

async function resolveResource(link) {
  const key = cacheKey(link);
  const cached = kino.storage.get(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // caché corrupta: se vuelve a calcular
    }
  }
  const meta = await addResource(link);
  const info = {
    id: meta.id,
    name: meta.name || null,
    multiFile: !!meta.multi_file,
    // Para un torrent de un solo archivo, Webtor ya entrega el content id en la propia respuesta.
    singleFile: meta.file ? { id: meta.file.id ?? meta.file.index ?? "0", name: meta.file.name } : null,
  };
  kino.storage.set(key, JSON.stringify(info), { ttlMs: CACHE_TTL_MS });
  return info;
}

// ---------------------------------------------------------------------------------------------
// id / ref de los items: "t_<hash12>" como id; "<resourceId>|<contentId>" como ref
// ---------------------------------------------------------------------------------------------

function itemId(link) {
  return "t_" + kino.crypto.hash("sha1", link).slice(0, 20);
}

function makeRef(resourceId, contentId) {
  return resourceId + "|" + String(contentId);
}

function parseRef(ref) {
  const i = String(ref || "").indexOf("|");
  if (i < 0) return { resourceId: ref, contentId: "0" };
  return { resourceId: ref.slice(0, i), contentId: ref.slice(i + 1) };
}

// Guarda el link original por torrent (lo necesita episodes(), a quien solo le llega el ref/resourceId)
// para poder encontrar de nuevo la entrada de ajustes si hiciera falta releer metadatos.
function rememberLink(resourceId, link) {
  kino.storage.set("link:" + resourceId, link, { ttlMs: CACHE_TTL_MS });
}

function recallLink(resourceId) {
  return kino.storage.get("link:" + resourceId);
}

// ---------------------------------------------------------------------------------------------
// Capacidades expuestas a Kino
// ---------------------------------------------------------------------------------------------

export async function home() {
  const entries = torrentEntries();
  const items = [];
  for (const entry of entries) {
    try {
      const info = await resolveResource(entry.link);
      rememberLink(info.id, entry.link);
      const title = entry.name || info.name || "Torrent";
      if (info.multiFile) {
        items.push({
          id: itemId(entry.link),
          ref: info.id,
          title,
          kind: "series",
        });
      } else if (info.singleFile) {
        items.push({
          id: itemId(entry.link),
          ref: makeRef(info.id, info.singleFile.id),
          title,
          kind: "movie",
        });
      }
    } catch (e) {
      // Un torrent roto no debe tumbar el resto de la fila.
    }
  }
  if (!items.length) return [];
  return [{ id: "mytorrents", title: "Mis Torrents", items }];
}

export async function episodes(ref) {
  const resourceId = ref; // para "series" el ref ES el resourceId (ver home())
  const files = await listFiles(resourceId);
  const videos = files.filter(isVideoFile);
  const episodesOut = videos.map((f, i) => ({
    number: i + 1,
    ref: makeRef(resourceId, f.id ?? f.index ?? i),
    title: f.name || f.path || "Archivo " + (i + 1),
  }));
  return { episodes: episodesOut };
}

export async function resolve(ref) {
  const { resourceId, contentId } = parseRef(ref);
  const stream = await exportStream(resourceId, contentId);
  const out = { url: stream.url };
  if (stream.meta && stream.meta.multibitrate === false && stream.meta.transcode === false) {
    // Copia directa del archivo original: sin transcodificar, puede pesar más pero no pierde calidad.
  }
  return out;
}

export async function settingsStatus() {
  const entries = torrentEntries();
  if (!entries.length) return { linked: "Sin torrents todavía: pega uno en \"Tus torrents\"." };
  let ok = 0;
  for (const entry of entries) {
    try {
      await resolveResource(entry.link);
      ok++;
    } catch (e) {
      // se cuenta como fallido, no se detiene el resto
    }
  }
  return { linked: ok + " de " + entries.length + " torrents cargan bien." };
}

export async function action(key) {
  if (key !== "refresh") return null;
  for (const k of kino.storage.keys()) {
    if (k.startsWith("res:") || k.startsWith("link:")) kino.storage.remove(k);
  }
  return { message: "Torrents recargados", refresh: true };
}

export async function validateSettings(values) {
  const list = Array.isArray(values.torrents) ? values.torrents : [];
  for (const entry of list) {
    const link = String((entry && entry.url) || "").trim();
    if (link && !looksLikeTorrentLink(link)) {
      return { torrents: "Uno de los enlaces no parece un magnet ni una URL .torrent válida." };
    }
  }
  return null;
}
