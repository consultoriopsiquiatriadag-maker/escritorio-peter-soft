/**
 * fetch_links.mjs
 * ---------------
 * Script de build para Netlify.
 * Descarga el CSV de Google Sheets (publicado como CSV público),
 * lo parsea, filtra los links habilitados, los ordena y genera /links.json.
 *
 * Variables de entorno requeridas:
 *   SHEET_CSV_URL — URL del CSV publicado desde Google Sheets
 *
 * Uso: node scripts/fetch_links.mjs
 * Requiere: Node.js 18+ (fetch nativo, sin dependencias externas)
 */

import { writeFileSync } from "fs";

const SHEET_CSV_URL = process.env.SHEET_CSV_URL;

if (!SHEET_CSV_URL) {
  console.warn("⚠️  SHEET_CSV_URL no está definida.");
  console.warn("   Configurá la variable de entorno en Netlify: Site settings → Environment variables.");
  console.warn("   El links.json existente (si hay uno en el repo) se publicará sin cambios.");
  process.exit(0); // Salida suave: no falla el build
}

/**
 * Parser CSV minimal que respeta comillas y comas dentro de campos.
 * Soporta:
 *   - Campos entre comillas dobles: "texto con, coma"
 *   - Comilla literal escapada: ""doble""  → "doble"
 *   - Saltos de línea \r\n y \r normalizados
 */
function parseCSV(text) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const result = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const fields = [];
    let field = "";
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          // Comilla literal ("" dentro de campo entrecomillado)
          field += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === ',' && !inQuote) {
        fields.push(field.trim());
        field = "";
      } else {
        field += ch;
      }
    }
    fields.push(field.trim());
    result.push(fields);
  }

  return result;
}

async function main() {
  console.log("📥 Descargando CSV desde Google Sheets...");
  console.log("   URL:", SHEET_CSV_URL.slice(0, 80) + (SHEET_CSV_URL.length > 80 ? "…" : ""));

  // ── Descarga del CSV ──
  let csvText;
  try {
    const res = await fetch(SHEET_CSV_URL, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    csvText = await res.text();
  } catch (err) {
    console.error("❌ Error al descargar el CSV:", err.message);
    process.exit(1);
  }

  // ── Parse ──
  const rows = parseCSV(csvText);

  if (rows.length < 2) {
    console.error("❌ El CSV está vacío o no tiene filas de datos (solo encabezado o nada).");
    process.exit(1);
  }

  // Primera fila = encabezados (en minúsculas, sin espacios extra)
  const headers = rows[0].map(h => h.toLowerCase().trim());
  console.log("   Encabezados detectados:", headers.join(" | "));

  // ── Verificar columnas requeridas ──
  const required = ["enabled", "category", "title", "url"];
  for (const col of required) {
    if (!headers.includes(col)) {
      console.error(`❌ Columna requerida no encontrada: "${col}"`);
      console.error("   Encabezados encontrados:", headers.join(", "));
      console.error("   Verificá que la hoja 'Links' tenga los encabezados exactos.");
      process.exit(1);
    }
  }

  // Índices de columnas
  const idx = {
    enabled:  headers.indexOf("enabled"),
    category: headers.indexOf("category"),
    title:    headers.indexOf("title"),
    url:      headers.indexOf("url"),
    icon:     headers.indexOf("icon"),
    order:    headers.indexOf("order"),
    target:   headers.indexOf("target"),
  };

  // ── Procesar filas ──
  const links = [];
  let skippedDisabled = 0;
  let skippedEmpty = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    // Fila completamente vacía → ignorar
    if (!row || row.every(f => !f)) {
      continue;
    }

    // Filtrar por enabled = TRUE
    const enabled = (row[idx.enabled] || "").toUpperCase().trim();
    if (enabled !== "TRUE") {
      skippedDisabled++;
      continue;
    }

    const category = (row[idx.category] || "").trim();
    const title    = (row[idx.title]    || "").trim();
    const url      = (row[idx.url]      || "").trim();
    const icon     = idx.icon   >= 0 ? (row[idx.icon]   || "").trim()  : "";
    const orderRaw = idx.order  >= 0 ? (row[idx.order]  || "0").trim() : "0";
    const target   = idx.target >= 0
      ? ((row[idx.target] || "").trim() || "_blank")
      : "_blank";

    if (!url || !title) {
      console.warn(`  ⚠️  Fila ${i + 1}: sin título o URL → ignorada.`);
      skippedEmpty++;
      continue;
    }

    const order = parseInt(orderRaw, 10);

    links.push({
      category,
      title,
      url,
      icon,
      order: isNaN(order) ? 0 : order,
      target,
    });
  }

  // ── Ordenar: category (alfabético es) luego order (numérico) ──
  links.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category, "es", { sensitivity: "base" });
    if (catCmp !== 0) return catCmp;
    return a.order - b.order;
  });

  // ── Escribir links.json en la raíz del sitio ──
  const output = {
    updatedAt: new Date().toISOString(),
    source: "Google Sheets CSV",
    links,
  };

  const json = JSON.stringify(output, null, 2);
  writeFileSync("links.json", json, "utf8");

  // ── Resumen ──
  const cats = [...new Set(links.map(l => l.category))];
  console.log("✅ links.json generado exitosamente.");
  console.log(`   Links habilitados : ${links.length}`);
  console.log(`   Links deshabilitados : ${skippedDisabled}`);
  console.log(`   Links con datos incompletos : ${skippedEmpty}`);
  console.log(`   Categorías : ${cats.join(", ")}`);
  console.log(`   Fecha build : ${output.updatedAt}`);
}

main().catch(err => {
  console.error("❌ Error fatal en fetch_links.mjs:", err.message);
  process.exit(1);
});
