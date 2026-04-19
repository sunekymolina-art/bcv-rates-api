'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const agent = new https.Agent({ rejectUnauthorized: false });

const DB_URL = process.env.DATABASE_PUBLIC_URL || 'postgresql://postgres:UThjYRVuLBTszXfgbvpJnjsSOiApHcsL@centerbeam.proxy.rlwy.net:10781/railway';
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const getHeaders = () => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html',
  'Connection': 'keep-alive'
});

function fetchWithTimeout(url, options, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function scrapeEuroFromBCV() {
  const BASE = 'https://www.bcv.org.ve';
  const BASE_URL = BASE + '/estadisticas/tipo-cambio-de-referencia-smc';

  const xlsLinks = [];
  const seen = new Set();
  let page = 0;
  let pagesWithLinks = 0;

  while (true) {
    const url = `${BASE_URL}?page=${page}`;
    let html;
    try {
      const pageRes = await fetchWithTimeout(url, { headers: getHeaders(), agent }, 20000);
      html = await pageRes.text();
    } catch (e) {
      console.error(`[Euro] Error cargando página ${page}:`, e.message);
      break;
    }

    const $ = cheerio.load(html);
    const found = [];
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && /\.(xls|xlsx)$/i.test(href)) {
        const full = href.startsWith('http') ? href : BASE + href;
        if (!seen.has(full)) { seen.add(full); found.push(full); }
      }
    });

    if (found.length === 0) break;
    xlsLinks.push(...found);
    pagesWithLinks++;
    page++;
  }

  console.log(`[Euro] ${pagesWithLinks} páginas procesadas | ${xlsLinks.length} archivos XLS encontrados`);

  let saved = 0;
  for (const link of xlsLinks) {
    try {
      const fileRes = await fetchWithTimeout(link, { headers: { ...getHeaders(), 'Accept': 'application/octet-stream,application/vnd.ms-excel,*/*' }, agent }, 30000);
      const arrayBuffer = await fileRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      let fileSaved = 0;
      let loggedFailSheet = false;
      console.log(`[Euro] ${link} | ${workbook.SheetNames.length} pestañas`);

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

        let fecha = null;
        for (const row of rows) {
          if (!row) continue;
          for (const cell of row) {
            if (typeof cell === 'string' && cell.includes('Fecha Valor:')) {
              const m = cell.match(/(\d{2})\/(\d{2})\/(\d{4})/);
              if (m) { fecha = `${m[1]}-${m[2]}-${m[3]}`; break; }
            }
          }
          if (fecha) break;
        }
        if (!fecha) {
          const m = sheetName.match(/^(\d{2})(\d{2})(\d{4})$/);
          if (m) fecha = `${m[1]}-${m[2]}-${m[3]}`;
        }
        if (!fecha) {
          console.log(`[Euro]   pestaña "${sheetName}": no se pudo determinar fecha`);
          continue;
        }

        let euroValue = null;
        for (const row of rows) {
          if (!row || !row.some(c => c === 'EUR')) continue;
          for (let i = row.length - 1; i >= 0; i--) {
            const val = row[i];
            const parsed = typeof val === 'number'
              ? val
              : (typeof val === 'string' ? parseFloat(val.replace(/\./g, '').replace(',', '.')) : NaN);
            if (!isNaN(parsed) && parsed > 0) { euroValue = parsed; break; }
          }
          break;
        }

        if (euroValue !== null) {
          await pool.query(
            'INSERT INTO tasas_euro (fecha, euro) VALUES ($1, $2) ON CONFLICT (fecha) DO NOTHING',
            [fecha, euroValue]
          );
          saved++;
          fileSaved++;
        } else {
          console.log(`[Euro]   pestaña "${sheetName}" (${fecha}): EUR no encontrado o valor inválido`);
          if (link.includes('2_1_2b20_smc') && !loggedFailSheet) {
            loggedFailSheet = true;
            console.log(`[Euro DEBUG] Primeras 15 filas de "${sheetName}":`);
            rows.slice(0, 15).forEach((row, i) => console.log(`  [${i}]:`, JSON.stringify(row)));
          }
        }
      }
      console.log(`[Euro]   → ${fileSaved}/${workbook.SheetNames.length} pestañas guardadas`);
    } catch (e) {
      console.error(`[Euro] Error en ${link}:`, e.message);
    }
  }

  console.log(`[Euro] ${saved} filas guardadas en total`);
  return saved;
}

scrapeEuroFromBCV()
  .then(saved => {
    console.log(`[Euro] Proceso completado. ${saved} filas nuevas insertadas.`);
    process.exit(0);
  })
  .catch(err => {
    console.error('[Euro] Error fatal:', err.message);
    process.exit(1);
  });
