# Mis Torrents para Kino

Plugin de video para Kino (apiVersion 8, Kino 0.9.54 o superior): pega el magnet o la URL `.torrent`
de tus propios torrents en Ajustes y aparecen en Inicio listos para reproducir. Si un torrent trae
varios archivos de video, se listan como episodios; si trae uno solo, se reproduce directo.

## Cómo saca el stream (y por qué no usa el navegador oculto)

Usa la API REST pública de Webtor (`https://api.webtor.io`), en tres pasos normales de HTTP/JSON:

1. `POST /resource/` con el magnet o la URL del `.torrent` → Webtor lo añade y devuelve metadatos
   (nombre, tamaño, si es de un solo archivo o varios).
2. `GET /resource/{id}/list` → lista los archivos (solo si el torrent tiene varios).
3. `GET /resource/{id}/export/{content_id}?types=stream` → un link de streaming ya listo para el
   reproductor.

Pedí usar el navegador oculto (`kino.browser.capture`) para esto, pero no hacía falta: ese mecanismo
sirve para cuando un sitio arma la URL del video ejecutando su propio JavaScript y no hay otra forma
de verla. Webtor expone esos tres pasos como una API REST normal (`api.webtor.io`), así que
`kino.fetch` directo es más simple y más confiable que simular un navegador — nada que capturar, nada
que se rompa si Webtor cambia su reproductor web. El widget embebible de Webtor (el que usarías en una
página) sí arma su iframe mandando el magnet por `postMessage` después de cargar, lo cual no encaja
con lo que `kino.browser.capture` ofrece (no inyecta mensajes a la página); por eso se usó la API en
vez de esa ruta.

Si en el futuro alguna vez Webtor retira su API pública y solo queda el reproductor web, ahí sí haría
falta el navegador oculto (y probablemente negociar con Webtor cómo inicializan ese `postMessage`).
Por ahora no es necesario.

## Ajustes

- **Torrent 1 a Torrent 10**: pega el magnet o la URL `.torrent` en cada campo que quieras usar; los
  que dejes vacíos se ignoran. El título que ves en Inicio sale del nombre que el propio torrent trae
  (Webtor lo devuelve al añadirlo), así que no hace falta ponerle nombre a mano.
- **API key de Webtor (opcional)**: sin ella usas el límite gratuito compartido; con tu propia key
  (cuenta en webtor.io, o RapidAPI) tienes tu propio límite de uso.
- **Estado**: cuántos de tus torrents están cargando bien ahora mismo.
- **Volver a cargar los torrents**: borra la caché local (`kino.storage`) y fuerza a releer metadatos
  de Webtor en el próximo Inicio — útil si cambiaste un link o un torrent dejó de tener semillas.

### Por qué 10 campos fijos y no una lista

La primera versión usaba un ajuste de tipo `"list"` (una lista editable de "agregar otro torrent").
Kino la rechazó al instalar el plugin ("error en el campo settings") y no pude confirmar con certeza,
contra tu versión de Kino, qué exactamente estaba mal en esa sintaxis — la documentación pública tiene
partes desactualizadas o contradictorias sobre `"list"`. Para no seguir adivinando, se cambió a 10
campos `url` sueltos (`torrent1`...`torrent10`), el mismo tipo de ajuste que ya usa con éxito tu plugin
de YTMusic. Si más adelante quieres más de 10, hay que agregar más campos `torrentN` a mano (y volver a
instalar), no hay forma de que la persona "agregue una fila" dinámicamente con este enfoque.

## Qué hace y qué no

- Reproduce video de torrents que tú mismo agregas por link. No busca ni sugiere nada: no hay
  catálogo, ni índice, ni descubrimiento de contenido ajeno.
- No descarga el torrent al dispositivo: Webtor lo transcodifica/sirve en streaming desde sus
  servidores (tu teléfono nunca entra al swarm de BitTorrent).
- Cachea el "resource id" de Webtor por 6 horas para no tener que re-añadir el mismo torrent en cada
  apertura de Inicio.
- No valida en segundo plano que cada link siga sirviendo semillas; `settingsStatus` sí hace una
  comprobación rápida (recarga desde caché o reintenta) cada vez que abres el formulario de Ajustes.

## Probar y publicar

Igual que los otros plugins de Kino: copia la carpeta `sdk/` de
[kinotvapp/kino-plugin-archive-audio](https://github.com/kinotvapp/kino-plugin-archive-audio) junto a
este plugin y usa:

```
node sdk/validate.mjs .
node sdk/run.mjs . home
node sdk/run.mjs . resolve "<resourceId>|<contentId>"
```

Publica como repositorio público (no fork) con el topic `kino-plugin`, ajusta `author` y `homepage`
en `kino-plugin.json`, e instala desde Ajustes → Plugins con `usuario/repo`.
