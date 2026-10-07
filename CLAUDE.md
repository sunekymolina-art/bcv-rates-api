# bcv-rates-api (backend)

Backend de la Calculadora BCV (conversión Bs / USD / EUR / UVC con tasas oficiales del BCV).
Usuario: perfil no técnico, trabaja en español, necesita pasos exactos para git y terminal (PowerShell: no usar `&&`).

## Stack y entornos
- Node.js + Express, cheerio (scraping), pg (PostgreSQL), xlsx, jsonwebtoken + jwks-rsa.
- Railway: producción = rama `main`, development = rama `dev` (cada una con su propio Postgres).
- Flujo obligatorio: cambios en `dev` -> probar en development -> merge a `main`. Nunca tocar `main` directo.
- Antes de mergear `dev` a `main`, revisar `git diff main dev --name-only` para no pisar archivos.
- Push manual desde la terminal PowerShell de VS Code (el shell de Claude Code no encuentra git).

## Variables de entorno (Railway, nunca en el código)
DATABASE_PUBLIC_URL, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET.
Auth0 tenant: dev-z88basn0fhauwxqg.us.auth0.com

## Base de datos
- `tasas` (fecha DD-MM-YYYY, dolar, idi): se llena bajo demanda desde la tabla de historial del BCV.
- `tasas_euro` (fecha DD-MM-YYYY, euro): se llena desde los XLS trimestrales del BCV.

## Reglas de negocio
- El BCV publica la tasa del próximo día hábil a las ~4pm; el euro se guarda con la "Fecha Valor".
- Reconversión: fechas anteriores al 04/10/2021 -> dólar / 1.000.000. El IDI NO se modifica.
- Sin tasa en sábados, domingos ni feriados (404 con mensaje claro).
- /api/rates: dólar e IDI se cachean 1 hora; el euro SIEMPRE se lee fresco de la DB.
- dolar_date: si el dólar del homepage difiere del de la primera fila de la tabla, es el siguiente día hábil.
- Scraper euro: por defecto solo el XLS más reciente (rápido); `?full=true` recorre todos (lento, manual).

## Endpoints
- POST /api/auth/login (valida contra Auth0, flujo password) — público
- GET / — público
- GET /api/rates/euro/scrape — público a propósito (lo llama cron-job.org sin token)
- Protegidos con JWT (middleware requireAuth): /api/rates, /api/rates/history?from=DD-MM-YYYY, /api/rates/euro?date=, /api/rates/euro/status, /api/cache/status

## Cron
cron-job.org llama a /api/rates/euro/scrape todos los días 5pm Venezuela (20:00 UTC), timeout máx 30s.
Se había desactivado sin avisar: activar notificación por email on failure. Puede quedar un job viejo de keep-alive apuntando a Render que ya no hace falta.

## Pendientes de seguridad
- Sacar el fallback de URL de DB hardcodeada que quedó en el código.
- Restringir CORS (hoy `*`) solo a los dominios de Vercel.
- Agregar rate limiting y validación de inputs.
- Rotar secretos expuestos (ver nota en el chat) y limpiar historial de git.