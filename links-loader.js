/**
 * links-loader.js — Cargador robusto de links para PETER-SOFT Panel
 *
 * ARQUITECTURA (Opción A híbrida — sin build step en Netlify):
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ 1. Cache localStorage (< 10 min)    → respuesta instantánea    │
 * │ 2. CSV directo de Google Sheets     → siempre fresco, sin build │
 * │ 3. /links.json del repo             → fallback estático         │
 * │ 4. Cache localStorage (expirada)    → último recurso            │
 * │ 5. null → usar localStorage principal de la app                 │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * El sitio funciona SIEMPRE aunque Google Sheets esté caído.
 * Sin dependencias externas. Sin build step. Compatible con todos los
 * navegadores modernos (fetch + AbortController + localStorage).
 *
 * Uso desde index.html:
 *   const { data, source } = await window.LinksLoader.loadLinksData();
 *   // source: "sheet" | "json" | "cache" | "cache-stale" | "local"
 */

(function (global) {
  'use strict';

  // ─── Configuración ────────────────────────────────────────────────────────
  var CONFIG = {
    /**
     * URL del CSV publicado desde Google Sheets.
     * Para obtenerla: Archivo → Compartir → Publicar en la web
     *   → Hoja "Links" → Formato: CSV → Publicar → copiar URL
     */
    SHEET_CSV_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSZjRhxy_7pdXrPO9fx-C8NBFhQe0JUjc4cNcWrhgDonyUPxxOpT0ushqkQf59RdA3C3Xx8q51b3cGo/pub?output=csv",

    /** Clave de localStorage para la cache de links */
    CACHE_KEY: "peter_soft_links_cache_v2",

    /** TTL de la cache: 10 minutos */
    CACHE_TTL_MS: 10 * 60 * 1000,

    /** Timeout por fetch: 8 segundos */
    FETCH_TIMEOUT_MS: 8000,
  };

  // ─── Parser CSV ───────────────────────────────────────────────────────────

  /**
   * Parsea una línea CSV respetando campos entrecomillados y comas internas.
   * Maneja comillas dobles escapadas ("" → ").
   */
  function parseCSVLine(line) {
    var fields = [];
    var field  = '';
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        if (inQuote && line[i + 1] === '"') { field += '"'; i++; }
        else                                 { inQuote = !inQuote; }
      } else if (c === ',' && !inQuote) {
        fields.push(field.trim());
        field = '';
      } else {
        field += c;
      }
    }
    fields.push(field.trim());
    return fields;
  }

  /**
   * Convierte texto CSV a { updatedAt, source, links[] }.
   *
   * Columnas requeridas en la hoja (fila 1 = encabezados):
   *   enabled   → TRUE/FALSE (o YES/1) para mostrar/ocultar
   *   category  → id de categoría (ej: ia, salud, tools)
   *   title     → nombre del zócalo
   *   url       → URL destino
   *
   * Columnas opcionales:
   *   icon      → 2-3 letras para el ícono (ej: FAA)
   *   order     → número para ordenar dentro de la categoría
   *   target    → _blank (default) | _self
   *
   * @param  {string} csvText
   * @returns {{ updatedAt:string, source:string, links:Array }|null}
   */
  function csvToLinksData(csvText) {
    var text  = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var lines = text.split('\n').filter(function (l) { return l.trim().length > 0; });
    if (lines.length < 2) return null;

    var headers = parseCSVLine(lines[0]).map(function (h) {
      return h.toLowerCase().replace(/^"|"$/g, '').trim();
    });

    var idx = {
      enabled:  headers.indexOf('enabled'),
      category: headers.indexOf('category'),
      title:    headers.indexOf('title'),
      url:      headers.indexOf('url'),
      icon:     headers.indexOf('icon'),
      order:    headers.indexOf('order'),
      target:   headers.indexOf('target'),
    };

    if (idx.title < 0 || idx.url < 0) {
      console.warn('[LinksLoader] CSV sin columnas "title"/"url". Headers detectados:', headers.join(', '));
      return null;
    }

    var links = [];
    for (var i = 1; i < lines.length; i++) {
      var row = parseCSVLine(lines[i]);

      // Filtrar por columna "enabled" si existe
      if (idx.enabled >= 0) {
        var en = (row[idx.enabled] || '').toUpperCase().trim();
        if (en !== 'TRUE' && en !== '1' && en !== 'YES') continue;
      }

      var title = (row[idx.title] || '').trim();
      var url   = (row[idx.url]   || '').trim();
      if (!title || !url) continue;

      links.push({
        category: idx.category >= 0
          ? ((row[idx.category] || 'misc').trim() || 'misc')
          : 'misc',
        title:  title,
        url:    url,
        icon:   idx.icon   >= 0 ? (row[idx.icon]   || '').trim()  : '',
        order:  idx.order  >= 0 ? (parseInt(row[idx.order]  || '0', 10) || 0) : 0,
        target: idx.target >= 0 ? ((row[idx.target] || '_blank').trim() || '_blank') : '_blank',
      });
    }

    return {
      updatedAt: new Date().toISOString(),
      source:    'Google Sheets CSV (runtime)',
      links:     links,
    };
  }

  // ─── Utilidades de red ────────────────────────────────────────────────────

  /** fetch() con timeout automático usando AbortController. */
  function fetchWithTimeout(url, timeoutMs) {
    var ctrl = new AbortController();
    var tid  = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    return fetch(url, { cache: 'no-store', signal: ctrl.signal })
      .then(function (res) { clearTimeout(tid); return res; })
      .catch(function (err) { clearTimeout(tid); throw err; });
  }

  // ─── Cache ────────────────────────────────────────────────────────────────

  function cacheGet() {
    try {
      var raw = localStorage.getItem(CONFIG.CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function cacheSet(data) {
    try {
      localStorage.setItem(
        CONFIG.CACHE_KEY,
        JSON.stringify(Object.assign({}, data, { cachedAt: new Date().toISOString() }))
      );
    } catch (e) { /* quota exceeded — ignorar */ }
  }

  function isCacheFresh(cached) {
    if (!cached || !cached.cachedAt || !cached.links) return false;
    return Date.now() - new Date(cached.cachedAt).getTime() < CONFIG.CACHE_TTL_MS;
  }

  // ─── Función principal ────────────────────────────────────────────────────

  /**
   * Carga los links con fallback automático.
   * Devuelve una Promise con { data, source }.
   *
   * @returns {Promise<{ data: Object|null, source: string }>}
   *   source puede ser: "sheet" | "json" | "cache" | "cache-stale" | "local"
   */
  function loadLinksData() {
    // ── 1. Cache reciente (sin red) ──────────────────────────────────────
    var cached = cacheGet();
    if (isCacheFresh(cached)) {
      var age = Math.round((Date.now() - new Date(cached.cachedAt).getTime()) / 1000);
      console.log('[LinksLoader] 💾 Cache fresca (' + age + 's):', cached.links.length, 'links');
      return Promise.resolve({ data: cached, source: 'cache' });
    }

    // ── 2. CSV directo de Google Sheets ─────────────────────────────────
    return fetchWithTimeout(CONFIG.SHEET_CSV_URL, CONFIG.FETCH_TIMEOUT_MS)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
        return res.text();
      })
      .then(function (text) {
        var data = csvToLinksData(text);
        if (!data || !data.links.length) throw new Error('CSV vacío o sin links habilitados');
        console.log('[LinksLoader] ☁️  Google Sheets:', data.links.length, 'links');
        cacheSet(data);
        return { data: data, source: 'sheet' };
      })
      .catch(function (csvErr) {
        console.warn('[LinksLoader] ⚠️  CSV falló:', csvErr.message, '— probando /links.json…');

        // ── 3. /links.json estático del repo ────────────────────────────
        return fetchWithTimeout('/links.json?ts=' + Date.now(), CONFIG.FETCH_TIMEOUT_MS)
          .then(function (res2) {
            if (!res2.ok) throw new Error('/links.json HTTP ' + res2.status);
            return res2.json();
          })
          .then(function (data2) {
            if (!Array.isArray(data2.links)) throw new Error('/links.json sin campo links[]');
            console.log('[LinksLoader] 📄 /links.json:', data2.links.length, 'links');
            return { data: data2, source: 'json' };
          })
          .catch(function (jsonErr) {
            console.warn('[LinksLoader] ⚠️  /links.json falló:', jsonErr.message);

            // ── 4. Cache expirada (mejor que nada) ──────────────────────
            var stale = cacheGet();
            if (stale && stale.links && stale.links.length) {
              console.log('[LinksLoader] 💾 Cache expirada:', stale.links.length, 'links');
              return { data: stale, source: 'cache-stale' };
            }

            // ── 5. Sin datos remotos → app usa localStorage propio ──────
            console.log('[LinksLoader] 📱 Sin datos externos. La app usará localStorage.');
            return { data: null, source: 'local' };
          });
      });
  }

  // ─── API pública ──────────────────────────────────────────────────────────
  global.LinksLoader = {
    loadLinksData: loadLinksData,
    CONFIG:        CONFIG,
  };

}(window));
