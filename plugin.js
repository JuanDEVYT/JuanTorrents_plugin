/// <reference path="./kino.d.ts" />
// Mis Torrents para Kino · apiVersion 6
//
// Pega el magnet (o solo el hash) de TUS torrents en Ajustes ("Tus torrents") y aparecen en Inicio.
// Al darle play, Kino abre en su navegador oculto la web de Webtor (https://webtor.io) con ese magnet y
// captura la URL del video que el reproductor de Webtor pide. No usa API ni key.
//
// La página de Webtor de un torrent es https://webtor.io/<infohash> (40 hex). Con un hash base32 se usa
// la forma /show?magnet=..., que no está verificada.

const SHOW_URL = "https://webtor.io/show?magnet=";

function infoHash(link) {
  const m = /xt=urn:btih:([0-9a-f]{40})(?![0-9a-z])/i.exec(link);
  return m ? m[1].toLowerCase() : null;
}

function pageUrl(link) {
  const h = infoHash(link);
  return h ? "https://webtor.io/" + h : SHOW_URL + encodeURIComponent(link);
}

// Para el log: dirección sin tokens (solo host, ruta y nombres de los parámetros).
function safeUrl(u) {
  const s = String(u || "");
  const q = s.indexOf("?");
  const base = (q < 0 ? s : s.slice(0, q)).slice(0, 160);
  if (q < 0) return base;
  const keys = s.slice(q + 1).split("&").map((kv) => kv.split("=")[0]).slice(0, 8).join(",");
  return base + " ?" + keys;
}

// ---------------------------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------------------------

// Kino limita el campo a 500 caracteres: se acepta también solo el hash (40 hex o 32 base32).
function normalizeLink(link) {
  const l = String(link || "").trim();
  if (/^[0-9a-f]{40}$/i.test(l) || /^[a-z2-7]{32}$/i.test(l)) return "magnet:?xt=urn:btih:" + l;
  return l;
}

function isMagnet(link) {
  return /^magnet:\?.*xt=urn:btih:[0-9a-z]{32,40}/i.test(link);
}

function magnetName(link) {
  const m = /[?&]dn=([^&]+)/i.exec(link);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " "));
  } catch (e) {
    return null;
  }
}

function torrentEntries() {
  const raw = kino.config.get("torrents");
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({ name: String((e && e.nombre) || "").trim(), link: normalizeLink((e && e.url) || "") }))
    .filter((e) => e.link);
}

function itemId(link) {
  return "t_" + kino.crypto.hash("sha1", link).slice(0, 20);
}

// ---------------------------------------------------------------------------------------------
// Inicio / sección
// ---------------------------------------------------------------------------------------------

function buildRows() {
  const items = [];
  for (const entry of torrentEntries()) {
    if (!isMagnet(entry.link)) continue;
    items.push({
      id: itemId(entry.link),
      ref: entry.link,
      title: entry.name || magnetName(entry.link) || "Torrent",
      kind: "movie",
    });
  }
  if (!items.length) return [];
  return [{ id: "mytorrents", title: "Mis Torrents", items }];
}

export async function home() {
  return buildRows();
}

// El manifiesto declara "section", así que Kino exige esta función.
export async function section(arg) {
  const rows = buildRows();
  if (rows.length) return { rows };
  return {
    rows: [],
    hero: {
      title: "Sin torrents para mostrar",
      text: "Agrega un magnet en Ajustes ▸ Plugins ▸ Mis Torrents ▸ Tus torrents.",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reproducción: se abre la web de Webtor en el navegador oculto y se captura el video
// ---------------------------------------------------------------------------------------------

export async function resolve(ref) {
  const link = normalizeLink(ref);
  if (!isMagnet(link)) {
    throw kino.error("not_found", "link no es un magnet", { userMessage: "Este link no es un magnet válido." });
  }
  let page;
  try {
    page = await kino.browser.capture(pageUrl(link), { timeoutMs: 25000 });
  } catch (e) {
    kino.log("captura fallida:", (e && (e.code || "")) + " " + ((e && e.message) || e));
    throw e;
  }
  if (!page.media || !page.media.length) {
    throw kino.error("unavailable", "webtor no mostró video", {
      userMessage: "Webtor no mostró ningún video para este torrent (¿tiene semillas?).",
    });
  }
  for (const m of page.media) {
    kino.log("media:", safeUrl(m.url), "mime=" + (m.mime || "?"), "headers=" + Object.keys(m.headers || {}).join(","));
  }
  kino.log("pagina final:", safeUrl(page.finalUrl));
  const [first, ...rest] = page.media;
  return {
    url: first.url,
    headers: first.headers,
    alternatives: rest.map((m) => ({ url: m.url, headers: m.headers })),
    subtitles: (page.subtitles || []).map((s) => ({ url: s.url, lang: "es" })),
  };
}

export async function validateSettings(values) {
  const list = Array.isArray(values.torrents) ? values.torrents : [];
  for (const entry of list) {
    const link = normalizeLink((entry && entry.url) || "");
    if (link && !isMagnet(link)) {
      return { torrents: "Uno de los enlaces no es un magnet válido (o un hash de 40 caracteres)." };
    }
  }
  return null;
}
