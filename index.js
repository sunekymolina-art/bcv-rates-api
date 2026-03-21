const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000;

let cache = { data: null, timestamp: 0 };

async function scrapeRates() {
  const res = await fetch('https://www.bcv.org.ve/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-VE,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache'
    },
    timeout: 15000
  });

  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  // Tasa dólar — div#dolar strong
  let dolar = null;
  const dolarText = $('#dolar strong').first().text().trim();
  if (dolarText) {
    dolar = parseFloat(dolarText.replace(/\./g, '').replace(',', '.'));
  }

  // Tasa IDI — buscar por texto en la página
  let idi = null;
  $('div, span, td, strong, p').each((i, el) => {
    const text = $(el).text().trim();
    if (/IDI|Índice de Inversión/i.test(text)) {
      const next = $(el).next().text().trim() || $(el).parent().next().text().trim();
      const match = next.match(/([\d,.]+)/);
      if (match && !idi) {
        idi = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
      }
    }
  });

  // Fallback: buscar cualquier número cerca de "IDI" en el HTML crudo
  if (!idi) {
    const idiMatch = html.match(/IDI[\s\S]{0,200}?([\d]{1,4}[.,][\d]{2,8})/i);
    if (idiMatch) idi = parseFloat(idiMatch[1].replace(',', '.'));
  }

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
    console.error('Error scraping:', err.message);
    if (cache
