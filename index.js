const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000;
let currentCache = { data: null, timestamp: 0 };
const dateCache = {};

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
    const res2 = await fetch('https://ve.dolarapi.com/v1/dolares/oficial');
    const data = await res2.json();
    const rates = {
      dolar: data.promedio || null,
      idi: null,
      idi_date: null,
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

  try {
    const isoDate = yyyy + '-' + mm + '-' + dd;
    const response = await fetch('https://ve.dolarapi.com/v1/dolares/oficial/historico?fecha=' + isoDate);
    const data = await response.json();
    console.log('DolarAPI response:', JSON.stringify(data));

    if (data && data.promedio) {
      const row = { fecha: from, dolar: data.promedio, idi: null };
      dateCache[from] = row;
      return res.json({ rows: [row], from });
    }

    return res.status(404).json({
      error: 'Sin tasa disponible',
      motivo: 'No se encontro tasa para este dia (posible feriado)',
      from
    });
  } catch (err) {
    res.status(503).json({ error: 'Error buscando tasa', detail: err.message });
  }
});

app.get('/api/cache/status', (req, res) => {
  const keys = Object.keys(dateCache).sort();
  res.json({ fechas_en_cache: keys.length, primera: keys[0], ultima: keys[keys.length - 1] });
});

app.listen(PORT, () => {
  console.log('Servidor en puerto ' + PORT);
});
