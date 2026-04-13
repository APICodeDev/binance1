# BITGETSync Premium Dashboard (Node.js/Vercel)

Esta es la conversiÃ³n de tu bot de trading PHP a **Node.js 20+** sobre **Next.js 14 (App Router)** y **Vercel**.

## ðŸš€ Requerimientos para Vercel

Dado que Vercel no soporta archivos persistentes (como SQLite), ahora usamos **Prisma + PostgreSQL**.

1.  **Base de Datos**: Te recomiendo usar **Vercel Postgres** o **Supabase** (que ofrece una base de datos Postgres gratuita).
2.  **SincronizaciÃ³n adaptativa**: 
    - El dashboard ejecuta `/api/monitor` cada 3 segundos cuando hay posiciones abiertas y cada 10 segundos cuando estÃ¡ en reposo.
    - La respuesta del monitor ya devuelve el *snapshot* del dashboard para evitar una segunda recarga completa tras cada ciclo.
    - Se ha configurado un **Vercel Cron** (`vercel.json`) que ejecuta una sincronizaciÃ³n cada minuto como respaldo (mÃ­nimo permitido por Vercel).

## ðŸ› ï¸ ConfiguraciÃ³n de Variables de Entorno (.env)

Debes configurar las siguientes variables en Vercel (o en tu archivo `.env.local` localmente):

```env
# Database (PostgreSQL)
DATABASE_URL="postgres://tu_usuario:tu_password@tu_host:5432/tu_db"

# BITGET API
BITGET_API_KEY="BybstQ0Af..."
BITGET_SECRET_KEY="Jw58keRY..."
BITGET_BASE_URL="https://testnet.BITGETfuture.com"
```

## ðŸ“¦ Despliegue

1.  Sube este repositorio a **GitHub**.
2.  ConÃ©ctalo a un nuevo proyecto en **Vercel**.
3.  AÃ±ade las variables de entorno arriba descritas.
4.  Ejecuta localmente o como comando de build: `npx prisma db push` (esto crearÃ¡ las tablas automÃ¡ticamente en tu base de datos Postgres).

## ðŸ’¡ Cambios Clave
- **PHP â†’ TypeScript**: CÃ³digo mÃ¡s robusto y mantenible.
- **SQLite â†’ Prisma/Postgres**: Persistencia real en la nube.
- **AJAX â†’ React/Framer Motion**: Una interfaz premium, fluida y con micro-animaciones.
- **Cron**: ConfiguraciÃ³n nativa `vercel.json` incluida.

---
Puedes borrar los archivos `.php` antiguos una vez confirmes que todo funciona en la nueva plataforma.

