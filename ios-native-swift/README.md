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

## Qué incluye

- Login por cuenta o token API
- Dashboard principal
- Posiciones abiertas
- Ajustes globales
- Heatmap / pre-signal
- Stats
- Vista admin
- Cliente HTTP para las APIs existentes
- Persistencia de token en Keychain

## Cómo abrirlo

1. Abre `BitgetDeskNative.xcodeproj` en Xcode.
2. Selecciona un simulador o dispositivo iOS.
3. Compila y ejecuta.

## URL del backend

La app permite definir la base URL desde la pantalla de login.

Ejemplos:

- `https://trades.apicode.cloud`
- `http://localhost:3000`

La app nativa guarda esa URL en `AppStorage`. Si alguna vez se probó con `localhost`, ese valor puede quedarse persistido entre ejecuciones hasta que lo cambies desde la pantalla de login o reinstales la app.

## Nota

Esta app es un clon nativo inicial del dashboard actual. Las mejoras futuras del producto principal seguirán haciéndose sobre la app web actual, salvo que explícitamente decidas pedirme cambios también aquí.
