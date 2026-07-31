# Estudio de `Trend Length` — Target Trend MTF

## Conclusión operativa

Para una configuración conjunta de BTCUSDT y XRPUSDT, la recomendación inicial es:

| Temporalidad | Valor recomendado |
|---|---:|
| 5m | **5** |
| 15m | **5** |
| 1H | **43** |

El valor actual `10` no fue el mejor en ninguna temporalidad dentro de la muestra analizada. La diferencia más clara aparece en 1H. En 5m y 15m existe una zona estable alrededor de 4–7, por lo que el valor 5 es preferible a perseguir un máximo puntual.

## Datos y metodología

- Fuente: Binance USDⓈ-M Futures, endpoint público `/fapi/v1/klines`.
- Símbolos: BTCUSDT y XRPUSDT.
- Periodo: 2024-01-01 a 2026-07-27 UTC.
- Datos descargados: 270.432 velas de 5m por símbolo; las velas de 15m y 1H se agregaron desde las de 5m.
- Valores probados: `Trend Length` de 3 a 50.
- La lógica replica el indicador: ATR(200) suavizado con SMA(200) y multiplicado por 0,8; entrada al cierre de la vela de cambio de tendencia; TP1 a 5 ATR; SL en `smaLow` para LONG y `smaHigh` para SHORT.
- La vela de entrada no se usa para cerrar la operación. Si una vela posterior toca TP y SL a la vez, se cuenta SL de forma conservadora.
- Una señal contraria cierra la operación como `reversal`; esas operaciones se informan aparte y no se mezclan con el porcentaje TP/SL.
- No se incluyen comisiones, funding ni slippage. Por tanto, es un estudio de aciertos TP frente a SL, no una simulación exacta de PnL.

## Resultado conjunto de los dos símbolos

`Winrate TP/SL` = TP / (TP + SL). Las cifras OOS corresponden a 2026-01-01–2026-07-27. Se usaron como comprobación fuera de muestra, evitando escoger únicamente el máximo aislado de ese tramo.

| TF | Valor | Periodo completo TP | SL | Winrate | OOS TP | SL | Winrate |
|---|---:|---:|---:|---:|---:|---:|---:|
| 5m | 10 actual | 4.807 | 8.050 | 37,39% | 1.119 | 1.825 | 38,01% |
| 5m | **5** | **4.962** | **7.620** | **39,44%** | **1.127** | **1.737** | **39,35%** |
| 15m | 10 actual | 1.541 | 2.805 | 35,46% | 354 | 632 | 35,90% |
| 15m | **5** | **1.593** | **2.586** | **38,12%** | **374** | **595** | **38,60%** |
| 1H | 10 actual | 372 | 723 | 33,97% | 78 | 162 | 32,50% |
| 1H | **43** | **280** | **458** | **37,94%** | **60** | **98** | **37,97%** |

## ¿Mismo valor o diferente?

Los resultados favorecen usar valores diferentes por temporalidad:

- 5m y 15m tienen su mejor zona alrededor de `5`.
- 1H mejora claramente al usar un valor largo, aproximadamente `40–46`; `43` es un punto central razonable del conjunto.
- Usar `5/5/43` produjo en conjunto un 39,11% OOS frente a 38,85% usando `5/5/5` y 37,19% usando `10/10/10`.

La mejora de 1H es la más relevante, pero sus resultados tienen menos operaciones que 5m y 15m. Por eso no recomiendo fijar 43 como una verdad universal: recomiendo probarlo en demo y volver a medir con datos nuevos.

## Resultados por símbolo

La configuración conjunta no coincide siempre con el máximo individual:

- 5m: BTCUSDT favorece 5; XRPUSDT favorece 6. Ambos están en la misma zona.
- 15m: BTCUSDT favorece 7; XRPUSDT favorece 5. La zona baja sigue siendo consistente.
- 1H: BTCUSDT favorece 44; XRPUSDT favorece 27. Esta diferencia muestra que el máximo individual de 1H es menos estable; por eso se eligió 43 para ambos.

## Archivos generados

- `targettrend_length_grid.csv`: todos los valores probados y sus métricas.
- `targettrend_length_summary.json`: resumen completo, incluidos resultados por símbolo.
- `scripts/backtest_targettrend.py`: script reproducible del estudio.
