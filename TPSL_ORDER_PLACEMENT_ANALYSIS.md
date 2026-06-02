# Análisis: Creación de órdenes TP/SL en modo 'strat' vs 'self'

## 1. Resumen Ejecutivo

Las órdenes de Take Profit (TP) y Stop Loss (SL) se crean de manera **similar** en ambos modos, pero **difieren significativamente** en:

- **Cálculo del precio de stop**
- **Estrategia de validación**
- **Verificación post-colocación** (solo strat)
- **Manejo de upgrades de TP** desde nuevas señales

---

## 2. Flujo General de Colocación de TPSL

### Ubicación: `app/api/entry/route.ts` función `executeEntry()`

**Pasos comunes para ambos modos:**

1. **Cálculo de precios** (líneas 1100-1155)
   - Se determinan precios de stop y TP basados en entrada del usuario
   - Se validan contra el precio de entrada
   
2. **Placement de SL** (líneas 1193-1226)
   - Se llama a `bitgetPlaceStopMarket()` con `planType: 'normal_plan'`
   - Apenas en modo strat se verifica post-colocación
   
3. **Placement de TP** (líneas 1233-1275)
   - Se llama a `bitgetPlaceTpslMarket()` con `planType: 'profit_plan'`
   - Apenas en modo strat se verifica post-colocación

---

## 3. Diferencias Clave por Modo

### 3.1 Cálculo del Precio de Stop Loss

**Líneas 1149-1153:**

```typescript
const stopPrice = stratManaged
  ? (isRequestedStopValid ? normalizedRequestedStop : legacyStopPrice)
  : managementMode === 'self'
    ? normalizedRequestedStop
    : (apiStopMode === 'legacy' ? legacyStopPrice : (isRequestedStopValid ? normalizedRequestedStop : legacyStopPrice));
```

| Modo | Lógica | Fallback |
|------|--------|---------|
| **strat** | Si el SL solicitado es válido → usarlo. Si no → usar SL legacy (1.2%) | Sí, fallback a legacy |
| **self** | Usar exactamente el SL solicitado | **NO hay fallback** |
| **auto** | Depende de `apiStopMode` setting (legacy o signal). Si es legacy, fallback a legacy | Sí |

**Implicación para SELF:**
- Si el usuario no proporciona SL válido, `normalizedRequestedStop` será `null`
- El `stopPrice` será `null` → **NO se colocará SL**
- La posición se abrirá **SIN protección de SL**

**Implicación para STRAT:**
- Siempre tiene un SL colocado (ya sea el solicitado o el legacy)
- Más seguro por defecto

### 3.2 Cálculo del Precio de Take Profit

**Líneas 1154-1156:**

```typescript
const takeProfitPrice = stratManaged
  ? (isRequestedTakeProfitValid ? normalizedRequestedTakeProfit : null)
  : (isRequestedTakeProfitValid ? normalizedRequestedTakeProfit : null);
```

**Lógica idéntica para ambos modos:**
- Si el TP solicitado es válido → usarlo
- Si no es válido → `null` (NO se coloca TP)

---

## 4. Validación de Entrada según Modo

**Líneas 1159-1179:**

```typescript
const shouldRejectInvalidStop = !stratManaged && ((managementMode === 'self' && stopInputProvided) || hasPayloadValue(rawRequestedStopPercent));
const shouldRejectInvalidTakeProfit = !stratManaged && ((managementMode === 'self' && takeProfitInputProvided) || hasPayloadValue(rawRequestedTakeProfitPercent));
```

| Escenario | strat | self | auto |
|-----------|-------|------|------|
| SL inválido + SL proporcionado | Permitir (usa legacy) | **Rechazar y rollback** | Permitir (depende de setting) |
| TP inválido + TP proporcionado | Permitir (sin TP) | **Rechazar y rollback** | Permitir (sin TP) |

**Implicación:**
- **STRAT:** Es más tolerante y busca un fallback
- **SELF:** Es restrictivo - si el usuario proporciona un SL/TP inválido, la posición se rechaza completamente

---

## 5. Funciones de Placement

### 5.1 Stop Loss: `bitgetPlaceStopMarket()` (lib/bitget.ts, línea 433)

```typescript
export const bitgetPlaceStopMarket = async (
  symbol: string,
  side: 'BUY' | 'SELL',
  stopPrice: number,
  quantity?: number,
  tradingMode: 'demo' | 'live' = 'demo',
  tradeSide?: 'open' | 'close'
)
```

**Parámetros clave:**
- `planType: 'normal_plan'` - Orden de stop clásica
- `triggerType: 'mark_price'` - Se activa al precio de marca
- `executePrice: '0'` - Se ejecuta a mercado

**Cómo se coloca en entry:**
```typescript
await placeProtectionOrderWithRetries({
  kind: 'stop',
  symbol,
  tradingMode,
  place: () => bitgetPlaceStopMarket(symbol, slSide, stopPrice!, filledSize, tradingMode, closeTradeSide),
})
```

### 5.2 Take Profit: `bitgetPlaceTpslMarket()` (lib/bitget.ts, línea 470)

```typescript
export const bitgetPlaceTpslMarket = async (
  symbol: string,
  planType: 'profit_plan' | 'loss_plan',
  holdSide: 'long' | 'short' | 'buy' | 'sell',
  triggerPrice: number,
  quantity: number,
  clientOid?: string,
  tradingMode: 'demo' | 'live' = 'demo'
)
```

**Parámetros clave:**
- `planType: 'profit_plan'` - Orden de take profit automática
- `triggerType: 'mark_price'` - Se activa al precio de marca
- `executePrice: '0'` - Se ejecuta a mercado
- `holdSide` - Indica si es long/short

**Cómo se coloca en entry:**
```typescript
await bitgetPlaceTpslMarket(
  symbol,
  'profit_plan',      // Siempre profit_plan para TP inicial
  holdSide,           // long o short según posición
  takeProfitPrice!,
  filledSize,
  createClientOid(symbol),
  tradingMode
)
```

---

## 6. Verificación Post-Colocación (SOLO STRAT)

### 6.1 ¿Cuándo se verifica?

**Líneas 1216-1230 (para SL) y 1264-1278 (para TP):**

```typescript
if (stratManaged && shouldPlaceInitialStop) {
  const verifiedStop = await verifyProtectionOrder({
    kind: 'stop',
    symbol,
    tradingMode,
    expectedTriggerPrice: stopPrice!,
    expectedSize: filledSize,
    pricePrecision,
  });
  
  if (!verifiedStop.ok) {
    // Rollback completo
  }
}
```

**Nota:** Este bloque SOLO se ejecuta si `stratManaged === true`

### 6.2 Función `verifyProtectionOrder()` (líneas 223-266)

```typescript
async function verifyProtectionOrder(params: {
  kind: 'stop' | 'takeProfit';
  symbol: string;
  tradingMode: TradingMode;
  expectedTriggerPrice: number;
  expectedSize: number;
  pricePrecision: number;
})
```

**Lógica de verificación:**

1. **Delayed retries:** `[250, 700, 1300]` ms (después de colocación inicial)
   - Espera a que Bitget procese la orden
   - 3 intentos de verificación máximo

2. **Matcher for stop orders:**
   - Busca orden con `planType === 'normal_plan'`
   - Verifica que `triggerPrice` coincida (con tolerancia de precisión)
   - Verifica que `size` coincida

3. **Matcher for TP orders:**
   - Busca orden con `planType.includes('profit')`
   - Verifica `triggerPrice` y `size`

4. **Si no se verifica:**
   - Cancela todas las órdenes
   - Cierra la posición (rollback)
   - Retorna error

---

## 7. Retry Logic de Placement

### Función `placeProtectionOrderWithRetries()` (líneas 267-294)

Aplica a ambos modos (tanto SL como TP):

```typescript
async function placeProtectionOrderWithRetries(params: {
  kind: 'stop' | 'takeProfit';
  symbol: string;
  tradingMode: TradingMode;
  place: () => Promise<any>;
})
```

**Retries:** Se reintenta si Bitget retorna un error retryable (códigos 43023 o 40891)
- **Delays:** `getProtectionRetryDelays()` (típicamente 500, 1000, 1500 ms)
- **Max intentos:** Hasta 3-4 intentos

**Diferencia importante:**
- Si `exhaustedRetryable === true` y estamos en TP placement → Se continúa (TP pending)
- Si es SL y falla → Se hace rollback inmediato

---

## 8. Manejo de TP Pending (SOLO EN ENTRADA)

**Líneas 1249-1252 (para entry):**

```typescript
let initialTakeProfitPending = false;
let persistedTakeProfitPrice = takeProfitPrice;

if (shouldPlaceInitialTakeProfit) {
  const takeProfitPlacement = await placeProtectionOrderWithRetries(...);
  initialTakeProfitPending = takeProfitPlacement.exhaustedRetryable;
}
```

**Si TP placement agota los retries:**
- No es un error fatal (la posición se abre igualmente)
- Se guarda `initialTakeProfitPending = true`
- Se notifica al usuario: "Position opened with TP pending on Bitget"
- La posición se registra en DB con el TP solicitado (esperando que Bitget lo procese)

---

## 9. Diferencias en Upgrades de TP desde Nuevas Señales

**Función `maybeUpgradeTakeProfitFromSameDirectionSignal()` (líneas 450-570)**

### 9.1 Comportamiento por Modo

**Línea 497:**
```typescript
if (existingManagementMode === 'strat') {
  return NextResponse.json({
    success: true,
    message: `Ignorada (${tradingMode}): Ya existe una posicion STRAT abierta en direccion ${type} y no se le ajusta TP desde nuevas senales.`,
  });
}
```

| Modo | Permite upgrade de TP | Razonamiento |
|------|----------------------|--------------|
| **strat** | ❌ NO | Las posiciones strat no deben ser modificadas por nuevas señales (son estrategias predefinidas) |
| **self** | ✅ SÍ | Las posiciones self son manuales y pueden mejorarse |
| **auto** | ✅ SÍ | Las posiciones auto pueden mejorarse |

### 9.2 Si se permite upgrade

**Línea 534:**
```typescript
const tpResp = currentProfitOrder?.orderId
  ? await bitgetModifyTpslOrder(symbol, String(currentProfitOrder.orderId), candidateTakeProfit, existing.quantity, tradingMode)
  : await bitgetPlaceTpslMarket(
      symbol,
      'profit_plan',
      existingContext.holdSide,
      candidateTakeProfit,
      existing.quantity,
      createClientOid(symbol),
      tradingMode
    );
```

**Lógica:**
1. Si ya existe una orden de TP → modificarla
2. Si no existe → colocar nueva orden de TP

---

## 10. Orden SL Initial: ¿'normal_plan' vs 'loss_plan'?

### Contexto histórico (de session memory)

- **`normal_plan`:** Órdenes de stop clásicas (creadas por `bitgetPlaceStopMarket`)
- **`loss_plan`:** Órdenes TPSL automáticas de Bitget

**En entry actual:**
- Se coloca `normal_plan` (línea 1196-1202)
- Para breakeven/trailing se espera modificar esta `normal_plan`

**Anterior problema resuelto:**
- La verificación de stop buscaba `planType === 'normal_plan'`
- Pero después había conflicto si se intentaba colocar `loss_plan`
- **Solución:** Cancelar ambos tipos antes de crear nueva orden

---

## 11. Tabla Comparativa Resumen

| Aspecto | STRAT | SELF | AUTO |
|--------|-------|------|------|
| **SL Fallback** | Sí (legacy 1.2%) | No | Sí (según setting) |
| **TP Fallback** | No | No | No |
| **Validación estricta** | No (tolerante) | Sí (rechaza inválidos) | No |
| **Verificación post-placement** | Sí | No | No |
| **Permite upgrade de TP** | No | Sí | Sí |
| **TP Pending handling** | Sí | Sí | Sí |
| **Max verification delays** | [250, 700, 1300] ms | [250, 700, 1300] ms | [250, 700, 1300] ms |

---

## 12. Recomendaciones por Modo de Uso

### Para STRAT (estrategias bot):
✅ Proporcionar TP y SL - serán verificados y garantizados  
✅ Tolerante a valores inválidos (usa fallback)  
✅ Más seguro - no se modifica por nuevas señales  

### Para SELF (manual):
✅ Proporcionar TP y SL **exactamente como los quieres**  
⚠️ Si no son válidos, la posición será rechazada  
✅ Puedes mejorar el TP con nuevas señales  
✅ Máxima control y flexibilidad  

### Para AUTO (default):
✅ Flexible - usa setting `api_stop_mode` para SL fallback  
✅ Permite upgrades de TP  
⚠️ Sin verificación post-placement  

---

## Archivos Relevantes

- **Entry logic:** [app/api/entry/route.ts](app/api/entry/route.ts)
  - `executeEntry()` (línea 632)
  - `verifyProtectionOrder()` (línea 223)
  - `placeProtectionOrderWithRetries()` (línea 267)
  - `maybeUpgradeTakeProfitFromSameDirectionSignal()` (línea 450)

- **Bitget API functions:** [lib/bitget.ts](lib/bitget.ts)
  - `bitgetPlaceStopMarket()` (línea 433)
  - `bitgetPlaceTpslMarket()` (línea 470)
  - `bitgetModifyTpslOrder()` para upgrades
  - `bitgetGetPendingStopOrders()` para verificación
  - `bitgetGetPendingTpslOrders()` para verificación
