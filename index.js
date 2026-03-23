const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');

const agent = new https.Agent({ rejectUnauthorized: false });
const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000;
let currentCache = { data: null, timestamp: 0 };
const dateCache = {};

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-VE,es;q=0.9',
  'Connection': 'keep-alive'
};

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', fechas_en_cache: Object.keys(dateCache).length });
});

app.get('/api/rates', async (req, res) => {
  const now = Date.now();
  if (currentCache.data && (now - currentCache.timestamp) < CACHE_TTL) {
    return res.json({ ...currentCache.data, cached: true });
  }
  try {
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

  if (dateCache[from]) {
    return res.json({ rows: [dateCache[from]], from });
  }

  const keys = Object.keys(dateCache).sort();
  if (keys.length > 500) {
    const primera = keys[0];
    const ultima = keys[keys.length - 1];
    const [pdd, pmm, pyyyy] = primera.split('-');
    const [udd, umm, uyyy] = ultima.split('-');
    const primerDate = new Date(pyyyy + '-' + pmm + '-' + pdd);
    const ultimaDate = new Date(uyyy + '-' + umm + '-' + udd);
    if (fecha >= primerDate && fecha <= ultimaDate) {
      return res.status(404).json({
        error: 'Sin tasa disponible',
        motivo: 'El BCV no publico tasa para este dia (posible feriado)',
        from
      });
    }
  }

  return res.status(404).json({
    error: 'Sin tasa disponible',
    motivo: 'Fecha fuera del rango disponible',
    from
  });
});

app.get('/api/cache/status', (req, res) => {
  const keys = Object.keys(dateCache).sort();
  res.json({ fechas_en_cache: keys.length, primera: keys[0], ultima: keys[keys.length - 1] });
});

async function scrapePageRows(page) {
  const url = 'https://www.bcv.org.ve/estadisticas/indice-de-inversion?page=' + page;
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

async function preloadCache() {
  console.log('Iniciando precarga...');
  for (let page = 0; page <= 35; page++) {
    try {
      const rows = await scrapePageRows(page);
      if (rows.length === 0) { console.log('Fin en pagina ' + page); break; }
      rows.forEach(r => { dateCache[r.fecha] = r; });
      console.log('Pag ' + page + ': ' + Object.keys(dateCache).length + ' fechas total');
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error('Error pag ' + page + ': ' + err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log('Precarga lista: ' + Object.keys(dateCache).length + ' fechas');
}

app.listen(PORT, () => {
  console.log('Servidor en puerto ' + PORT);
  setTimeout(preloadCache, 3000);
});
