# Mis Torrents para Kino

Plugin de video para Kino (apiVersion 6, Kino 0.9.50 o superior). Pega el magnet (o solo el hash de
40 caracteres) de tus propios torrents en Ajustes ▸ Plugins ▸ Mis Torrents y aparecen en Inicio y en su
sección.

## Cómo reproduce

Al darle play, Kino abre en su navegador oculto la web de Webtor (`https://webtor.io/<hash>`) y
captura la URL del video que pide el reproductor de Webtor (`kino.browser.capture`). No usa API ni key.

La dirección de la página de Webtor (`pageUrl` en `plugin.js`): si no captura nada,
es lo primero que hay que revisar.

## Ajustes

- **Tus torrents**: hasta 20 entradas, con "Nombre" (opcional) y "Magnet o hash" (obligatorio).
  Kino limita el campo a 500 caracteres: usa `magnet:?xt=urn:btih:HASH` sin trackers, o solo el `HASH`.

## Limitaciones

- Solo magnets o hashes (no URLs `.torrent`).
- Cada torrent aparece como una sola película; si trae varios archivos, lo que se reproduce depende de
  lo que elija el reproductor de Webtor.
- Requiere aprobar el permiso de páginas web ocultas al instalar.
