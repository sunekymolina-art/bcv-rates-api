# bcv-rates-api (backend)

Backend de la Calculadora BCV (conversión Bs / USD / EUR / UVC con tasas oficiales del BCV).
Usuario: perfil no técnico, trabaja en español, necesita pasos exactos para git y terminal.
Entorno: Mac con zsh.

## Stack y entornos
- Node.js + Express, cheerio (scraping), pg (PostgreSQL), xlsx, jsonwebtoken + jwks-rsa.
- Railway: producción = rama `main`, development = rama `dev`.
- Flujo obligatorio: cambios en `dev` -> probar en development -> merge a `main`. Nunca tocar `main` directo.
- Antes de mergear `dev` a `main`, revisar `git diff main dev --name-only` para no pisar archivos.
- Push manual desde la terminal.

## Variables de entorno (Railway, nunca en el código)
Cada ambiente de Railway (producción y development) necesita sus propias:
DATABASE_PUBLIC_URL, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET.
Auth0 tenant: dev-z88basn0fhauwxqg.us.auth0.com
- AUTH0_CLIENT_ID es la MISMA app de Auth0 en ambos ambientes: al rotar el secret hay que actualizar los dos.
- DATABASE_PUBLIC_URL del backend: en development es referencia `${{Postgres.DATABASE_PUBLIC_URL}}`;
  en production es texto fijo (la referencia quedaba vacía) y hay que copiarla a mano desde Postgres.
- Sin DATABASE_PUBLIC_URL el servidor no arranca (no hay URL de respaldo en el código).

## Rotación de secretos (procedimiento)
Contraseña de Postgres (por ambiente; hacer development primero):
1. Generar la contraseña en la Terminal de la Mac (`openssl rand -hex 24`), nunca en el chat.
2. Postgres -> Console: `psql -U postgres`, luego `\password postgres`, luego `\q`.
3. Postgres -> Variables: editar SOLO `POSTGRES_PASSWORD` y hacer Deploy. Las variables con `${{...}}` se actualizan solas.
   `DATABASE_PUBLIC_URL` de Postgres debe ser:
   `postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}/${{PGDATABASE}}`
4. Backend: en production, copiar la URL nueva de Postgres a `DATABASE_PUBLIC_URL` y hacer Deploy. Verificar "Base de datos lista" en los logs.
En production hay corte entre los pasos 2 y 4: hacerlos seguidos y fuera de los horarios del cron.
Client secret de Auth0: Applications -> la app -> Settings -> "Rotar secreto" (Girar). Actualizar
AUTH0_CLIENT_SECRET en los dos ambientes y hacer Deploy. Solo se cortan los logins nuevos; los tokens existentes siguen válidos.

## Base de datos por ambiente
- Producción y development tienen cada uno su propio Postgres.
- El cronjob solo actualiza la base de producción.
- En development el euro se actualiza llamando a mano a /api/rates/euro/scrape.

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
cron-job.org llama a /api/rates/euro/scrape (producción) dos veces por día, timeout máx 30s:
- 20:00 UTC (4:00 PM Venezuela).
- 23:00 UTC (7:00 PM Venezuela): respaldo, porque el BCV a veces publica hasta las 6:30 PM.
La base ignora las fechas repetidas, así que correrlo dos veces no duplica datos.

## Pendientes
- Activar alerta por email ante fallas en los cronjobs (el job se había desactivado sin avisar).
- Limpiar el historial de git de los secretos viejos (ya rotados el 12-11-2026: no es urgente, es prolijidad).
- xlsx tiene vulnerabilidades sin arreglo en npm: instalarlo desde SheetJS y probar el scraper del euro.
- Opcional: conectar el backend a Postgres por red privada (DATABASE_URL) para evitar costos de egress.
