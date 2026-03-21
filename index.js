const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000;

let cache = { data: null, timestamp: 0 };

async function scrapeCurrentRates() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-VE,es;q=0.9,en;q=0.8',
    'Connection': 'keep-alive'
  };

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
  const firstRow = $idi('tbody tr.views-row-first, tbody tr').first();
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

async function scrapeIdiByDate(dateFrom, dateTo) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.8',
    'Accept-Language': 'es-VE,es;q=0.9',
    'Connection': 'keep-alive'
  };

  const url = `https://www.bcv.org.ve/estadisticas/indice-de-inversion?date_filter[value][date]=${dateFrom}&date_filter_1[value][date]=${dateTo}`;
  const res = await fetch(url, { headers, agent });
  const html = await res.text();
  const $ = cheerio.load(html);

  const rows = [];
  $('tbody tr').each((i, el) => {
    const cells = $(el).find('td');
    const fecha = cells.eq(0).text().trim();
    const dolarCell = cells.eq(1).text().trim();
    const idiCell = cells.last().text().trim();
    if (fecha) {
      rows.push({
        fecha,
        dolar: dolarCell && dolarCell !== 'N/A' ? parseFloat(dolarCell.replace(/\./g, '').replace(',', '.')) : null,
        idi: idiCell && idiCell !== 'N/A' ? parseFloat(idiCell.replace(/\./g, '').replace(',', '.')) : null
      });
    }
  });

  return rows;
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/rates', async (req, res) => {
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return res.json({ ...cache.data, cached: true });
  }
  try {
    const rates = await scrapeCurrentRates();
    cache = { data: rates, timestamp: now };
    res.json({ ...rates, cached: false });
  } catch (err) {
    console.error('Error:', err.message);
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.status(503).json({ error: 'No se pudieron obtener las tasas', detail: err.message });
  }
});

app.get('/api/rates/history', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'Se requieren parámetros from y to (formato: DD-MM-YYYY)' });
  }
  try {
    const rows = await scrapeIdiByDate(from, to);
    res.json({ rows, from, to });
  } catch (err) {
    console.error('Error history:', err.message);
    res.status(503).json({ error: 'No se pudieron obtener los datos históricos', detail: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BCV Rates API funcionando' });
});

app.listen(PORT, () => console.log('Servidor corriendo en puerto ' + PORT));
