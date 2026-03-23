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
  return {
    dolar: isNaN(dolar) ? null : dolar,
    idi: isNaN(idi) ? null : idi,
    idi_date: idiDate || null,
    updated_at: new Date().toISOString()
  };
}

async function scrapePageRows(page) {
  console.log('Intentando pagina ' + page + '...');
  try {
    const url = 'https://www.bcv.org.ve/estadisticas/indice-de-inversion?page=' + page;
    const res = await fetch(url, { headers, agent, timeout: 20000 });
    console.log('Respuesta pagina ' + page + ': ' + res.status);
    const html = await res.text();
    console.log('HTML recibido, tamaño: ' + html.length);
    const $ = cheerio.load(html, { decodeEntities: false });
    console.log('Cheerio cargado');
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
    console.log('Filas encontradas en pagina ' + page + ': ' + rows.length);
    return rows;
  } catch (err) {
    console.error('Error fetch pagina ' + page + ': ' + err.message);
    return [];
  }
}

async function findRateByDate(targetDate) {
  if (dateCache[targetDate]) return dateCache[targetDate];

  // Si el caché ya tiene muchas fechas y no está ahí, es feriado
  if (Object.keys(dateCache).length > 500) {
    const keys = Object.keys(dateCache).sort();
    const primera = keys[0];
    const ultima = keys[keys.length - 1];
    const [tdd, tmm, tyyyy] = targetDate.split('-');
    const target = new Date(tyyyy + '-' + tmm + '-' + tdd);
    const [pdd, pmm, pyyyy] = primera.split('-');
    const [udd, umm, uyyy] = ultima.split('-');
    const primerDate = new Date(pyyyy + '-' + pmm + '-' + pdd);
    const ultimaDate = new Date(uyyy + '-' + umm + '-' + udd);

    // Si la fecha está dentro del rango del caché y no está, es feriado
    if (target >= primerDate && target <= ultimaDate) {
      return null;
    }
  }

  for (let page = 0; page <= 35; page++) {
    const rows = await scrapePageRows(page);
    if (rows.length === 0) break;
    rows.forEach(r => { dateCache[r.fecha] = r; });
    const match = rows.find(r => r.fecha === targetDate);
    if (match) return match;
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      const [dd, mm, yyyy] = lastRow.fecha.split('-');
      const [tdd, tmm, tyyyy] = targetDate.split('-');
      const lastDate = new Date(yyyy + '-' + mm + '-' + dd);
      const target = new Date(tyyyy + '-' + tmm + '-' + tdd);
      if (target > lastDate && page > 0) break;
    }
  }
  return null;
}

async function preloadCache() {
  console.log('Precargando cache...');
  try {
    for (let page = 0; page <= 35; page++) {
      try {
        const rows = await scrapePageRows(page);
        if (rows.length === 0) {
          console.log('Pagina ' + page + ' vacia, fin de precarga');
          break;
        }
        rows.forEach(r => { dateCache[r.fecha] = r; });
        console.log('Pagina ' + page + ' lista. Total: ' + Object.keys(dateCache).length);
      } catch (pageErr) {
        console.error('Error en pagina ' + page + ': ' + pageErr.message);
        // Esperar 2 segundos y continuar con la siguiente página
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.log('Precarga completa: ' + Object.keys(dateCache).length + ' fechas');
  } catch (err) {
    console.error('Error general precarga:', err.message);
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
    if (currentCache.data) return res.json({ ...currentCache.data, cached: true, stale: true });
    res.status(503).json({ error: 'No se pudieron obtener las tasas', detail: err.message });
  }
});

app.get('/api/rates/history', async (req, res) => {
  const { from } = req.query;
  if (!from) return res.status(400).json({ error: 'Se requiere parametro from (DD-MM-YYYY)' });

  const [dd, mm, yyyy] = from.split('-');
  const fecha = new Date(`${yyyy}-${mm}-${dd}`);
  const diaSemana = fecha.getDay();

  if (diaSemana === 0 || diaSemana === 6) {
    return res.status(400).json({
      error: 'Sin tasa disponible',
      motivo: 'El BCV no publica tasas los sábados ni domingos',
      from
    });
  }

  try {
    const result = await findRateByDate(from);
    if (result) return res.json({ rows: [result], from });
    return res.status(404).json({
      error: 'Sin tasa disponible',
      motivo: 'El BCV no publicó tasa para este día (posible feriado)',
      from
    });
  } catch (err) {
    res.status(503).json({ error: 'No se pudieron obtener los datos', detail: err.message });
  }
});

app.get('/api/cache/status', (req, res) => {
  const keys = Object.keys(dateCache).sort();
  res.json({ fechas_en_cache: keys.length, primera: keys[0], ultima: keys[keys.length - 1] });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'BCV Rates API funcionando' });
});

app.listen(PORT, () => {
  console.log('Servidor en puerto ' + PORT);
  preloadCache();
});
