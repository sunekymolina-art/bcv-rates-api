const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');
const { Pool } = require('pg');

const agent = new https.Agent({ rejectUnauthorized: false });
const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000;
let currentCache = { data: null, timestamp: 0 };

console.log('DB URL:', process.env.DATABASE_PUBLIC_URL ? 'definida' : 'NO DEFINIDA');

const pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasas (
      fecha VARCHAR(10) PRIMARY KEY,
      dolar NUMERIC,
      idi NUMERIC
    )
  `);
  console.log('Base de datos lista');
}

async function getRateFromDB(fecha) {
  const result = await pool.query('SELECT * FROM tasas WHERE fecha = $1', [fecha]);
  return result.rows[0] || null;
}

async function saveRateToDB(row) {
  await pool.query(
    'INSERT INTO tasas (fecha, dolar, idi) VALUES ($1, $2, $3) ON CONFLICT (fecha) DO NOTHING',
    [row.fecha, row.dolar, row.idi]
  );
}

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

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', async (req, res) => {
  const result = await pool.query('SELECT COUNT(*) FROM tasas');
  res.json({ status: 'ok', fechas_en_db: parseInt(result.rows[0].count) });
});

app.get('/api/rates', async (req, res) => {
  const now = Date.now();
  if (currentCache.data && (now - currentCache.timestamp) < CACHE_TTL) {
    return res.json({ ...currentCache.data, cached: true });
  }
  try {
    const [bcvRes, idiRes] = await Promise.all([
      fetchWithTimeout('https://www.bcv.org.ve/', { headers: getHeaders(), agent }),
      fetchWithTimeout('https://www.bcv.org.ve/estadisticas/indice-de-inversion', { headers: getHeaders(), agent })
    ]);
    const bcvHtml = await bcvRes.text();
    const idiHtml = await idiRes.text();
    const $bcv = cheerio.load(bcvHtml);
    const $idi = cheerio.load(idiHtml);
    let dolar = null;
    const dolarText = $bcv('#dolar strong').first().text().trim();
    if (dolarText) dolar = parseFloat(dolarText.replace(/\./g, '').replace(',', '.'));
    let idi = null;
    let idiDate = null;
    const firstRow = $idi('tbody tr').first();
    if (firstRow.length) {
      const cells = firstRow.find('td');
      idiDate = cells.eq(0).text().trim();
      const idiText = cells.last().text().trim();
      if (idiText && idiText !== 'N/A') idi = parseFloat(idiText.replace(/\./g, '').replace(',', '.'));
    }
    const rates = {
      dolar: isNaN(dolar) ? null : dolar,
      idi: isNaN(idi) ? null : idi,
      idi_date: idiDate || null,
      updated_at: new Date().toISOString()
    };
    currentCache = { data: rates, timestamp: now };
    res.json({ ...rates, cached: false });
  } catch (err) {
    if (currentCache.data) return res.json({ ...currentCache.data, cached: true, stale: true });
    res.status(503).json({ error: 'No se pudieron obtener las tasas', detail: err.message });
  }
});

app.get('/api/rates/history', async (req, res) => {
  const { from } = req.query;
  if (!from) return res.status(400).json({ error: 'Se requiere from en formato DD-MM-YYYY' });

  const [dd, mm, yyyy] = from.split('-');
  const fecha = new Date(yyyy + '-' + mm + '-' + dd);
  const dia = fecha.getDay();
  if (dia === 0 || dia === 6) {
    return res.status(400).json({
      error: 'Sin tasa disponible',
      motivo: 'El BCV no publica tasas los sabados ni domingos',
      from
    });
  }

  try {
    const cached = await getRateFromDB(from);
    if (cached) {
      console.log('DB hit: ' + from);
      return res.json({ rows: [{ fecha: cached.fecha, dolar: parseFloat(cached.dolar), idi: parseFloat(cached.idi) }], from });
    }

    console.log('Buscando en BCV: ' + from);
    for (let page = 0; page <= 35; page++) {
      const url = 'https://www.bcv.org.ve/estadisticas/indice-de-inversion?page=' + page;
      let html;
      try {
        const r = await fetchWithTimeout(url, { headers: getHeaders(), agent });
        html = await r.text();
      } catch (e) {
        console.error('Timeout pag ' + page + ': ' + e.message);
        continue;
      }

      const $ = cheerio.load(html);
      const rows = [];
      $('tbody tr').each((i, el) => {
        const cells = $(el).find('td');
        const f = cells.eq(0).text().trim();
        const d = cells.eq(1).text().trim();
        const id = cells.last().text().trim();
        if (f && f.match(/\d{2}-\d{2}-\d{4}/)) {
          rows.push({
            fecha: f,
            dolar: d && d !== 'N/A' ? parseFloat(d.replace(/\./g, '').replace(',', '.')) : null,
            idi: id && id !== 'N/A' ? parseFloat(id.replace(/\./g, '').replace(',', '.')) : null
          });
        }
      });

      if (rows.length === 0) break;

      for (const row of rows) {
        await saveRateToDB(row);
      }

      const match = rows.find(r => r.fecha === from);
      if (match) return res.json({ rows: [match], from });

      const last = rows[rows.length - 1];
      if (last) {
        const [ldd, lmm, lyyyy] = last.fecha.split('-');
        const lastDate = new Date(lyyyy + '-' + lmm + '-' + ldd);
        if (fecha > lastDate && page > 0) break;
      }
    }

    return res.status(404).json({
      error: 'Sin tasa disponible',
      motivo: 'El BCV no publico tasa para este dia (posible feriado)',
      from
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(503).json({ error: 'Error buscando tasa', detail: err.message });
  }
});

app.get('/api/cache/status', async (req, res) => {
  const result = await pool.query('SELECT COUNT(*), MIN(fecha), MAX(fecha) FROM tasas');
  const row = result.rows[0];
  res.json({ fechas_en_db: parseInt(row.count), primera: row.min, ultima: row.max });
});

app.listen(PORT, async () => {
  console.log('Servidor en puerto ' + PORT);
  await initDB();
});
