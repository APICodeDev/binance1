# BinanceSync Premium Dashboard (Node.js/Vercel)

Esta es la conversión de tu bot de trading PHP a **Node.js 20+** sobre **Next.js 14 (App Router)** y **Vercel**.

## 🚀 Requerimientos para Vercel

Dado que Vercel no soporta archivos persistentes (como SQLite), ahora usamos **Prisma + PostgreSQL**.

1.  **Base de Datos**: Te recomiendo usar **Vercel Postgres** o **Supabase** (que ofrece una base de datos Postgres gratuita).
2.  **Sincronización de 10 segundos**: 
    - El dashboard realiza un *poll* cada 10 segundos a la ruta `/api/monitor` mientras esté abierto.
    - Se ha configurado un **Vercel Cron** (`vercel.json`) que ejecuta una sincronización cada minuto como respaldo (mínimo permitido por Vercel).

## 🛠️ Configuración de Variables de Entorno (.env)

Debes configurar las siguientes variables en Vercel (o en tu archivo `.env.local` localmente):

```env
# Database (PostgreSQL)
DATABASE_URL="postgres://tu_usuario:tu_password@tu_host:5432/tu_db"

# Binance API
BINANCE_API_KEY="BybstQ0Af..."
BINANCE_SECRET_KEY="Jw58keRY..."
BINANCE_BASE_URL="https://testnet.binancefuture.com"
```

## 📦 Despliegue

1.  Sube este repositorio a **GitHub**.
2.  Conéctalo a un nuevo proyecto en **Vercel**.
3.  Añade las variables de entorno arriba descritas.
4.  Ejecuta localmente o como comando de build: `npx prisma db push` (esto creará las tablas automáticamente en tu base de datos Postgres).

## 💡 Cambios Clave
- **PHP → TypeScript**: Código más robusto y mantenible.
- **SQLite → Prisma/Postgres**: Persistencia real en la nube.
- **AJAX → React/Framer Motion**: Una interfaz premium, fluida y con micro-animaciones.
- **Cron**: Configuración nativa `vercel.json` incluida.

---
Puedes borrar los archivos `.php` antiguos una vez confirmes que todo funciona en la nueva plataforma.
