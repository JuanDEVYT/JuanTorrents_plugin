/// <reference path="./kino.d.ts" />
// Mis Torrents para Kino · apiVersion 6
//
// Pega el magnet o la URL .torrent de TUS propios torrents en Ajustes ("Tus torrents", lista) y aparecen
// en Inicio listos para reproducir. La resolución del stream usa la API REST pública de Webtor.io
// (https://webtor.p.rapidapi.com, vía RapidAPI): añade el torrent como "recurso", lista sus archivos y pide un link de stream
// ya transcodificado. No usa el navegador oculto de Kino: la API de Webtor expone estos tres pasos como
// JSON normal, así que no hace falta simular nada dentro de una página.
//
// El ajuste "torrents" (tipo "list") copia la forma exacta de JuanEmbeds_plugin (campos nombre/url,
// url con required:true): una versión anterior con sus propias claves ("name"/"link", sin required) dio
// "error en el campo settings" al instalar.

const API = "https://webtor.p.rapidapi.com";
const RAPID_HOST = "webtor.p.rapidapi.com";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas: lo justo para no re-añadir el torrent en cada Inicio
const VERSION = "0.4.0";

// ---------------------------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------------------------

function torrentEntries() {
  const raw = kino.config.get("torrents");
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({ name: String((e && e.nombre) || "").trim(), link: normalizeLink((e && e.url) || "") }))
    .filter((e) => e.link);
}

// Kino limita este campo a 500 caracteres: se acepta también solo el hash (40 hex o 32 base32) y se arma el magnet.
function normalizeLink(link) {
  const l = String(link || "").trim();
  if (/^[0-9a-f]{40}$/i.test(l) || /^[a-z2-7]{32}$/i.test(l)) return "magnet:?xt=urn:btih:" + l;
  return l;
}

function apiKey() {
  const k = kino.config.get("apiKey");
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

function looksLikeTorrentLink(link) {
  link = normalizeLink(link);
  return /^magnet:\?/i.test(link) || /^https?:\/\/\S+\.torrent(\?.*)?$/i.test(link) || /^https?:\/\/\S+$/i.test(link);
}

// ---------------------------------------------------------------------------------------------
// Llamadas a la API de Webtor
// ---------------------------------------------------------------------------------------------

function webtorHeaders(extra) {
  const h = Object.assign({}, extra || {});
  h["X-RapidAPI-Host"] = RAPID_HOST;
  const key = apiKey();
  if (key) h["X-RapidAPI-Key"] = key;
  return h;
}

async function addResource(link) {
  if (!apiKey()) {
    throw kino.error("unavailable", "falta la API key", {
      userMessage: "Falta la API key de RapidAPI: pégala en Ajustes ▸ Plugins ▸ Mis Torrents.",
    });
  }
  // La ruta exacta del POST no está verificada: se prueba con y sin "/" final y se informa lo que responda Webtor.
  const paths = ["/resource/", "/resource"];
  let r = null;
  for (const path of paths) {
    r = await kino.fetch(API + path, {
      method: "POST",
      headers: webtorHeaders({ "Content-Type": "text/plain" }),
      body: link,
      timeoutMs: 25000,
    });
    if (r.status !== 404 && r.status !== 405) break;
  }
  if (r.status === 408) {
    throw kino.error("timeout", "webtor resource timeout (torrent sin semillas?)", {
      userMessage: "Webtor no pudo descargar los metadatos del torrent (¿sigue teniendo semillas?).",
    });
  }
  if (r.status === 401 || r.status === 403) {
    throw kino.error("unavailable", "webtor resource " + r.status, {
      userMessage: "RapidAPI rechazó la key: revisa que sea correcta y que estés suscrito a la API de Webtor.",
    });
  }
  if (r.status === 429) throw kino.error("rate_limited", "webtor resource 429");
  if (!r.ok) {
    let body = "";
    try { body = String(r.text() || "").replace(/\s+/g, " ").slice(0, 80); } catch (e) {}
    throw kino.error("unavailable", ("webtor resource " + r.status + (body ? ": " + body : "")).slice(0, 190));
  }
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

async function buildRows(problems) {
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
      // Un torrent roto no debe tumbar el resto de la fila, pero se anota para mostrarlo.
      const why = (e && (e.userMessage || e.message)) || String(e);
      kino.log("torrent fallido:", why);
      if (problems) problems.push(why);
    }
  }
  if (!items.length) return [];
  return [{ id: "mytorrents", title: "Mis Torrents", items }];
}

export async function home() {
  return buildRows();
}

// El manifiesto declara "section": { "label": "Mis Torrents" }, así que Kino exige esta función
// (si falta, el plugin no carga: "le falta section").
export async function section(arg) {
  const problems = [];
  const rows = await buildRows(problems);
  if (rows.length) return { rows };
  let text;
  if (!torrentEntries().length) {
    text = "Aún no tienes torrents: agrégalos en Ajustes ▸ Plugins ▸ Mis Torrents.";
  } else if (problems.length) {
    text = "Falló: " + problems[0];
  } else {
    text = "Los torrents se añadieron pero no traen archivos de video reproducibles.";
  }
  return { rows: [], hero: { title: "Sin torrents para mostrar", text: text.slice(0, 300) } };
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
