const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000;

let cache = { data: null, timestamp: 0 };

async function scrapeRates() {
  const res = await fetch('https://www.bcv.org.ve/', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  const dolar = parseFloat(
    $('#dolar strong').text().trim().replace(',', '.')
  );

  const idi = parseFloat(
    $('#tasaIdi strong, .tasa-idi strong, #idi strong').first().text().trim().replace(',', '.')
  );

  return {
    dolar: isNaN(dolar) ? null : dolar,
    idi: isNaN(idi) ? null : idi,
    updated_at: new Date().toISOString()
  };
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
    const rates = await scrapeRates();
    cache = { data: rates, timestamp: now };
    res.json({ ...rates, cached: false });
  } catch (err) {
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.status(503).json({ error: 'No se pudieron obtener las tasas' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BCV Rates API funcionando' });
});

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
