# Bitget Desk Native Clone

Proyecto SwiftUI totalmente separado del dashboard actual.

Objetivo:
- Replicar el estado funcional actual de la app web como cliente nativo iOS.
- Consumir las APIs ya existentes en `binance1`.
- No interferir con el desarrollo del dashboard web actual.

## Carpeta aislada

Todo lo de esta app vive solo en:

- `C:\PROYECTOS\binance1\ios-native-swift`

No depende de editar:

- `app/`
- `lib/`
- `prisma/`
- `scripts/`
- `ios/`

## Que incluye

- Login por cuenta o token API
- Dashboard principal
- Posiciones abiertas
- Ajustes globales
- Heatmap / pre-signal
- Stats
- Vista admin
- Cliente HTTP para las APIs existentes
- Persistencia de token en Keychain
- Registro de dispositivo para push notifications
- Background sync con `BGAppRefreshTask` + `Background Fetch`

## Como abrirlo

1. Abre `BitgetDeskNative.xcodeproj` en Xcode.
2. Selecciona un simulador o dispositivo iOS.
3. Compila y ejecuta.

## URL del backend

La app permite definir la base URL desde la pantalla de login.

Ejemplos:

- `https://trades.apicode.cloud`
- `http://localhost:3000`

La app nativa guarda esa URL en `AppStorage`. Si alguna vez se probo con `localhost`, ese valor puede quedarse persistido entre ejecuciones hasta que lo cambies desde la pantalla de login o reinstales la app.

## Push notifications

La app ya registra el token APNs del iPhone y lo envia al backend cuando el usuario ha iniciado sesion.

Configuracion pendiente para que funcione extremo a extremo:

1. Anadir la capability `Push Notifications` al target `BitgetDeskNative` en Xcode.
2. Crear o reutilizar una key APNs (`.p8`) en Apple Developer.
3. Configurar estas variables en el backend:

```env
APPLE_TEAM_ID="TU_TEAM_ID"
APPLE_KEY_ID="TU_KEY_ID"
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
APPLE_BUNDLE_ID="com.bitgetdesk.nativeclone"
CRON_SECRET="un-secreto-largo-y-aleatorio"
```

4. Ejecutar `npx prisma db push` y `npx prisma generate` para crear la tabla `push_devices`.
5. Desplegar en Vercel con el cron `/api/monitor-cron` activo para que el monitor siga funcionando aunque la app este cerrada.

## Segundo plano

La app nativa ya queda preparada para trabajar en segundo plano dentro de los limites reales de iOS:

- `BGAppRefreshTask` para despertares periodicos del sistema
- `Background Fetch`
- `remote-notification` para poder reaccionar a pushes silenciosas si en el futuro las envias

Que hace cuando iOS la despierta:

1. Lee la sesion actual y la `baseURL`.
2. Lanza `/api/monitor` con el modo actual.
3. Refresca posiciones para calentar cache local.
4. Guarda fecha del ultimo wake-up correcto o el ultimo error.

Importante:

- iOS no permite polling continuo ni garantiza una cadencia fija en background.
- Esto es un modo "best effort" compatible con App Store, no un daemon permanente.
- Para cobertura real cuando la app este cerrada o iOS no la despierte a tiempo, el backend debe seguir teniendo su cron `/api/monitor-cron`.

## Nota

Esta app es un clon nativo inicial del dashboard actual. Las mejoras futuras del producto principal seguiran haciendose sobre la app web actual, salvo que explicitamente decidas pedirme cambios tambien aqui.
