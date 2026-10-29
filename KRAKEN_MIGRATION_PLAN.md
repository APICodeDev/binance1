# Plan de migracion del exchange a Kraken

Estado: implementacion Kraken completada para paper; live preparado con activacion explicita y pendiente solo de credenciales/prueba autorizada del usuario.
Fecha: 2026-09-26
Alcance: app Next.js, motor de trading, market data, scripts, configuracion, Docker y clientes iOS.

## 1. Auditoria realizada

Se revisaron rutas `app/api/**`, `lib/**`, scripts, UI, iOS, Docker, configuracion, variables de entorno, pruebas auxiliares y nombres de archivos.

La integracion anterior estaba acoplada a contratos perpetuos, simbolos tipo `BTCUSDT`, endpoints de exchange, servicios WebSocket, stops/TP, posiciones, balances y presets UI. El destino elegido es Kraken Futures porque conserva el modelo de derivados/perpetuos de la aplicacion.

## 2. Arquitectura Kraken elegida

- REST publico Futures para tickers, instrumentos, profundidad, velas y funding.
- REST privado Futures v3 para ordenes, cancelaciones, posiciones, balances, fills e historial.
- WebSocket publico Futures v1: `wss://futures.kraken.com/ws/v1`.
- Paper app-local persistente en PostgreSQL, con market data publico actual de `https://futures.kraken.com`.
- Live privado en `https://futures.kraken.com` y WebSocket publico `wss://futures.kraken.com/ws/v1`.
- Adaptacion interna de simbolos: `BTCUSDT` <-> `PF_XBTUSD`, `ETHUSDT` <-> `PF_ETHUSD`.
- Posicion interna neta one-way; se mantienen las interfaces que consume la app.

## 3. Mapa funcional

| Necesidad | Kraken Futures | Implementacion |
|---|---|---|
| Precio/ticker | `GET /derivatives/api/v3/tickers` | Adaptador normalizado |
| Instrumentos y precision | `GET /derivatives/api/v3/instruments` | Tick size, contract size y minimos |
| Velas | `/api/charts/v1/trade/:symbol/:resolution` | OHLC normalizado |
| Profundidad | `GET /derivatives/api/v3/orderbook` | REST ordenado por mejor precio |
| Market/limit/IOC/post-only | `POST /derivatives/api/v3/sendorder` | `mkt`/`lmt`, reduce-only y `cliOrdId` |
| Stop/TP/trailing | `sendorder` | `stp`, `take_profit`, `trailing_stop` |
| Posiciones | `GET /derivatives/api/v3/openpositions` | Modelo interno de posiciones |
| Ordenes abiertas | `GET /derivatives/api/v3/openorders` | Filtros por contrato/proteccion |
| Cancelar/cerrar | `cancelorder`, `cancelallorders`, market reduce-only | Cierre seguro |
| Leverage | Configuracion Futures/cuenta | No se simula un endpoint inexistente |
| Comisiones | Variables configurables/fallback | Sin inventar una API de fees |
| Proteccion de conectividad | `cancelallordersafter` | Dead man's switch documentado |

La firma Futures v3 implementada es `base64(HMAC-SHA512(base64decode(secret), SHA256(postData + nonce + endpointPath)))`, con el prefijo `/derivatives` eliminado del path de firma.

## 4. Opciones gratuitas estudiadas

- REST y WebSocket publicos de market data.
- Kraken retiro el entorno `demo-futures.kraken.com` el 14/07/2026. La app usa paper persistente local/DB sin claves privadas; adicionalmente, el `kraken-cli` oficial ofrece `kraken futures paper` sin dinero real y puede usarse como herramienta local/MCP.
- Parametro `validate` cuando el tipo de orden lo admite.
- `cliOrdId` para correlacion e idempotencia.
- Dead man's switch para cancelar ordenes tras perdida de conectividad.
- Analytics publicos de funding, open interest, CVD, liquidez, spread y slippage.
- `kraken-cli` oficial con MCP local por stdio. Se recomienda limitarlo a `market,paper` durante pruebas o `market,account,trade` con claves de minimo privilegio. No se expone como servicio publico de Vercel.
- Grabacion/replay de market data y sesiones paper para backtests reproducibles.

Referencias oficiales: [Kraken Futures Send Order](https://docs.kraken.com/api-reference/order-management/send-order), [instrumentos](https://docs.kraken.com/api-reference/instrument-details/get-instruments), [posiciones](https://docs.kraken.com/api-reference/account-information/get-open-positions), [fills](https://docs.kraken.com/api-reference/historical-data/get-your-fills), [autenticacion Futures](https://support.kraken.com/articles/360022635572-calls-and-returns-rest-api-derivatives), [estado del entorno de pruebas](https://support.kraken.com/articles/360024809011-api-testing-environment-derivatives), [kraken-cli/MCP](https://github.com/krakenfx/kraken-cli/blob/main/skills/kraken-mcp-integration/SKILL.md).

## 5. Cambios ejecutados

1. Renombrado de adaptador, servicios, variables, scripts, textos, Docker, bundle iOS y marca visible.
2. Creacion de `lib/kraken.ts` con autenticacion, simbolos, precios, instrumentos, profundidad, velas, ordenes, protecciones, posiciones, balances, fills, historial y cancelaciones.
3. Sustitucion del servicio WebSocket por un bridge Kraken Futures con `/health`, `/subscribe`, `/snapshot` y `/events`.
4. Adaptacion de Bookmap, motor de trading, rutas API, UI, analisis de rendimiento y clientes iOS.
5. Separacion de credenciales live/paper y eliminacion de credenciales antiguas del runtime.
6. Paper app-local persistente: ordenes, fills, ordenes de proteccion, cancelaciones, posiciones y balance paper se guardan en PostgreSQL mediante `Setting`; la app nunca firma ni llama endpoints privados en paper.
7. Live endurecido: solo acepta claves Futures dedicadas, requiere `KRAKEN_LIVE_TRADING_ENABLED=1`, elimina la antigua restriccion USDC, usa contratos Kraken USD (`PF_XBTUSD`, etc.), conserva `cliOrdId` y expone el dead-man switch `cancelallordersafter`.
8. Se eliminaron pruebas antiguas con credenciales hardcodeadas y referencias al host demo retirado.
9. Test offline `scripts/test-kraken-adapter.ts` y script `npm run test:kraken`.
10. Docker actualizado: Node 22 Alpine, variables paper/live explícitas, market data Kraken dentro de la red Compose, healthchecks para los tres servicios auxiliares y arranque de la app condicionado a servicios saludables.

## 6. Variables finales

```text
KRAKEN_FUTURES_API_URL_LIVE=https://futures.kraken.com
KRAKEN_LIVE_API_KEY=
KRAKEN_LIVE_API_SECRET=
KRAKEN_FUTURES_API_KEY=
KRAKEN_FUTURES_API_SECRET=
KRAKEN_LIVE_TRADING_ENABLED=0
KRAKEN_PAPER_INITIAL_BALANCE_USD=10000
KRAKEN_WS_SERVICE_URL=http://127.0.0.1:8787
KRAKEN_WS_SERVICE_PORT=8787
KRAKEN_WS_SERVICE_HOST=127.0.0.1
KRAKEN_LIVE_MAKER_FEE=
KRAKEN_LIVE_TAKER_FEE=
KRAKEN_PAPER_MARKET_WS_URL=wss://futures.kraken.com/ws/v1
```

Las claves reales no se documentan ni se versionan. Deben configurarse como variables de entorno de Vercel o del entorno local.

## 7. Verificacion y criterio de cierre

- [x] Auditoria y sustitucion de referencias activas.
- [x] Adaptador Kraken Futures y firma v3.
- [x] REST publico: ticker, instrumentos, profundidad y velas.
- [x] WebSocket: subscribe/snapshot con bid y ask numericos.
- [x] Bookmap, UI, scripts, Docker e iOS.
- [x] `npx tsc --noEmit` correcto.
- [x] `npm run test:kraken` correcto.
- [x] `npm run build` correcto.
- [x] Paper sin credenciales privadas: market data publico, persistencia DB y protecciones simuladas.
- [x] Paper documentado con `kraken-cli futures paper` como alternativa oficial local/MCP.
- [x] Live protegido por opt-in, credenciales separadas y sin retiros.
- [ ] Smoke live autenticado: requiere que el usuario configure credenciales Futures de minimo privilegio y autorice la prueba.

No se ejecutaron ordenes reales durante la migracion. El bloqueo del smoke autenticado es intencionado y seguro.

## 8. Grid Pine: mode=special

Implementado para perpetuos lineales Kraken `PF_*USD`. Acumula hasta cinco compras en una posicion larga, con cantidad ejecutada y precio medio ponderado. `amount` es el nominal USD de **cada** compra; no se multiplica por el apalancamiento ni se sustituye por `custom_amount`. Se consulta el contrato para redondear hacia abajo y rechazar importes inferiores al lote minimo o superiores al maximo de posicion. Kraken sigue aplicando sus requisitos de margen y disponibilidad del contrato/cuenta.

No exige precio de entrada, SL o TP. Los campos de proteccion recibidos se ignoran en este modo. No activa stops, breakeven, trailing ni cierre por agotamiento. Admite `type=buy` y `type=sell`; si llega el sentido contrario para el mismo activo, origen y timeframe, cierra primero toda la posicion mediante `reduceOnly` y solo despues abre la nueva. `type=close` cierra toda la cantidad acumulada, incluso con el bot desactivado. No mezcla posiciones de otros modos, origenes o timeframes. El monitor solo puede modificar una posicion special por su timeout individual; cambios manuales en Kraken o liquidaciones requieren conciliacion antes de nuevas entradas.

Cada posicion puede configurar un timeout de 3, 6, 12 o 24 horas. Al vencer, si el PnL neto sigue positivo la posicion permanece abierta; se cierra en cuanto el PnL neto llegue a cero o pase a negativo. El timeout puede dejarse desactivado.

En `API-(IK) Grid Strategy.pine`, seleccionar **Bot: cierre total**, activar alertas externas y elegir **special**. Crear/recrear la alerta de ejecuciones de orden con `{{strategy.order.alert_message}}`. Este modo ya existente en el Pine cierra toda la posicion cuando se cumple la primera salida de un tramo: su backtest difiere de **Rejilla original**, que tiene cierres parciales. El importe de la alerta no modifica el tamano del backtest de TradingView.

Ejemplos de cuerpo para `/api/entry`:

```json
{"type":"buy","symbol":"BTCUSD","origin":"API-IK-Grid","timeframe":"5","amount":1000,"mode":"special","signal_id":"grid-unique-entry-1"}
```

```json
{"type":"close","symbol":"BTCUSD","origin":"API-IK-Grid","timeframe":"5","mode":"special","signal_id":"grid-unique-close-1"}
```

El Pine genera `signal_id` por barra, tramo y ciclo. Los reenvios con el mismo ID se deduplican de forma persistente. Los mensajes antiguos sin ID siguen aceptandose, pero no se pueden distinguir sus reenvios de nuevas compras. No reutilizar IDs al iniciar nuevas operaciones. Se conserva la autenticacion y el procesamiento asincrono del webhook existente; el acuse HTTP de recepcion no confirma una ejecucion, que debe revisarse en la auditoria.

Las entradas se serializan mediante un bloqueo en PostgreSQL compartido entre instancias. Una intencion `special_pending:<modo>:<contrato>` se guarda antes del envio. Si faltan fills verificables, falla la persistencia o la respuesta es ambigua, se bloquean nuevas operaciones de ese contrato. Revisar su `clientOid`, los fills y la posicion en Kraken, reconciliar cantidad/precio/estado y solo entonces retirar esa intencion; no borrarla para reintentar a ciegas. Un cierre parcial conserva la cantidad restante y exige otro `close`; no permite nuevas compras mientras esta cerrando. Los recibos `special_receipt:*` conservan la deduplicacion incluso despues del cierre y no deben borrarse durante el uso de las alertas.

Verificacion sin dinero real:

- `npm run test:kraken`: pruebas del adaptador.
- `npm run test:special`: ruta HTTP, cinco entradas, concurrencia, promedio, duplicados, minimos, aislamiento, monitor, cierre total/manual y bloqueo tras fallo de persistencia. Incluye respuestas privadas ficticias para rechazos y ejecuciones parciales; nunca se envian a la red.
- `npm run test:special -- --public-market`: las mismas pruebas con instrumentos y cotizaciones publicas reales. Base de datos aislada en memoria, ordenes simuladas, cero llamadas privadas a Kraken.

Estas pruebas no certifican ejecuciones reales, margen, liquidez ni compilacion/backtest del Pine en TradingView. No se ha activado ni desplegado operativa real.

Fuentes: [ordenes Kraken y reduceOnly](https://docs.kraken.com/api-reference/order-management/send-order), [lotes minimos y especificaciones lineales](https://support.mtf.kraken.com/hc/en-us/articles/25499987607837-Linear-Contract-Specifications), [retirada de la demo](https://support.kraken.com/es/articles/360024809011-api-testing-environment-derivatives).
