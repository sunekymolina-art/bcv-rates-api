const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000;

let currentCache = { data: null, timestamp: 0 };
const dateCache = {}; // caché por fecha específica

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-VE,es;q=0.9,en;q=0.8',
  'Connection': 'keep-alive'
};

async function scrapeCurrentRates() {
  const [bcvRes, idiRes] = await Promise.all([
    fetch('https://www.bcv.org.ve/', { headers, agent }),
    fetch('https://www.bcv.org.ve/estadisticas/indice-de-inversion', { headers, agent })
  ]);

  const bcvHtml = await bcvRes.text();
  const idiHtml = await idiRes.text();

  const $bcv = cheerio.load(bcvHtml);
  const $idi = cheerio.load(idiHtml);

  let dolar = null;
  const dolarText = $bcv('#dolar strong').first().text().trim();
  if (dolarText) {
    dolar = parseFloat(dolarText.replace(/\./g, '').replace(',', '.'));
  }

  let idi = null;
  let idiDate = null;
  const firstRow = $idi('tbody tr').first();
  if (firstRow.length) {
    const cells = firstRow.find('td');
    idiDate = cells.eq(0).text().trim();
    const idiText = cells.last().text().trim();
    if (idiText && idiText !== 'N/A') {
      idi = parseFloat(idiText.replace(/\./g, '').replace(',', '.'));
    }
  }

  return {
    dolar: isNaN(dolar) ? null : dolar,
    idi: isNaN(idi) ? null : idi,
    idi_date: idiDate || null,
    updated_at: new Date().toISOString()
  };
}

async function scrapePageRows(page) {
  const url = `https://www.bcv.org.ve/estadisticas/indice-de-inversion?page=${page}`;
  const res = await fetch(url, { headers, agent });
  const html = await res.text();
  const $ = cheerio.load(html);

  const rows = [];
  $('tbody tr').each((i, el) => {
    const cells = $(el).find('td');
    const fecha = cells.eq(0).text().trim();
    const dolarCell = cells.eq(1).text().trim();
    const idiCell = cells.last().text().trim();
    if (fecha && fecha.match(/\d{2}-\d{2}-\d{4}/)) {
      rows.push({
        fecha,
        dolar: dolarCell && dolarCell !== 'N/A' ? parseFloat(dolarCell.replace(/\./g, '').replace(',', '.')) : null,
        idi: idiCell && idiCell !== 'N/A' ? parseFloat(idiCell.replace(/\./g, '').replace(',', '.')) : null
      });
    }
  });

  return rows;
}

async function findRateByDate(targetDate) {
  // Si ya está en caché, respuesta instantánea
  if (dateCache[targetDate]) {
    return dateCache[targetDate];
  }

  for (let page = 0; page <= 35; page++) {
    const rows = await scrapePageRows(page);
    if (rows.length === 0) break;

    // Guardar todas las filas de esta página en caché
    rows.forEach(r => { dateCache[r.fecha] = r; });

    const match = rows.find(r => r.fecha === targetDate);
    if (match) return match;

    // Si la fecha buscada es más reciente que la última fila, no está más adelante
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      const [dd, mm, yyyy] = lastRow.fecha.split('-');
      const [tdd, tmm, tyyyy] = targetDate.split('-');
      const lastDate = new Date(`${yyyy}-${mm}-${dd}`);
      const target = new Date(`${tyyyy}-${tmm}-${tdd}`);
      if (target > lastDate && page > 0) break;
    }
  }

  return null;
}

// Precarga en segundo plano al arrancar el servidor
async function preloadCache() {
  console.log('Precargando caché de tasas históricas...');
  try {
    for (let page = 0; page <= 35; page++) {
      const rows = await scrapePageRows(page);
      if (rows.length === 0) break;
      rows.forEach(r => { dateCache[r.fecha] = r; });
      console.log(`Página ${page} cargada — ${Object.keys(dateCache).length} fechas en caché`);
    }
    console.log('Precarga completa:', Object.keys(dateCache).length, 'fechas disponibles');
  } catch (err) {
    console.error('Error en precarga:', err.message);
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/rates', async (req, res) => {
  const now = Date.now();
  if (currentCache.data && (now - currentCache.timestamp) < CACHE_TTL) {
    return res.json({ ...currentCache.data, cached: true });
  }
  try {
    const rates = await scrapeCurrentRates();
    currentCache = { data: rates, timestamp: now };
    res.json({ ...rates, cached: false });
  } catch (err) {
    console.error('Error:', err.message);
    if (currentCache.data) return res.json({ ...currentCache.data, cached: true, stale: true });
    res.status(503).json({ error: 'No se pudieron obtener las tasas', detail: err.message });
  }
});

app.get('/api/rates/history', async (req, res) => {
  const { from } = req.query;
  if (!from) {
    return res.status(400).json({ error: 'Se requiere parámetro from (formato: DD-MM-YYYY)' });
  }
  try {
    const result = await findRateByDate(from);
    if (result) {
      return res.json({ rows: [result], from });
    } else {
      return res.status(404).json({ error: 'No se encontró tasa para esa fecha', from });
    }
  } catch (err) {
    console.error('Error history:', err.message);
    res.status(503).json({ error: 'No se pudieron obtener los datos', detail: err.message });
  }
});

app.get('/api/cache/status', (req, res) => {
  res.json({
    fechas_en_cache: Object.keys(dateCache).length,
    primera: Object.keys(dateCache).sort()[0],
    ultima: Object.keys(dateCache).sort().reverse()[0]
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BCV Rates API funcionando' });
});

app.listen(PORT, () => {
  console.log('Servidor corriendo en puerto ' + PORT);
  preloadCache(); // arranca la precarga en segundo plano
});
```

**"Commit changes"** → **"Commit directly to the main branch"** → **"Commit changes"**. ✅

Lo que hace esto es que cuando el servidor arranca, **descarga todas las páginas del BCV en segundo plano** y guarda todas las fechas en memoria. Así cualquier búsqueda posterior es instantánea. Podés verificar cuántas fechas cargó con:
```
https://bcv-rates-api-production.up.railway.app/api/cache/status
