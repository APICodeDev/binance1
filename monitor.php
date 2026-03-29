<?php
// monitor.php
// Sincronización bidireccional Binance ↔ BD local + Trailing Stop Loss
// Ejecutado cada 10s desde el dashboard vía fetch('monitor.php')

require_once 'config.php';
require_once 'binance_api.php';

// -----------------------------------------------------------------------
// PASO 1: Obtener posiciones abiertas en la BD local
// -----------------------------------------------------------------------
$stmt     = $db->query("SELECT * FROM positions WHERE status = 'open'");
$positions = $stmt->fetchAll(PDO::FETCH_ASSOC);

if (empty($positions)) {
    echo "No hay posiciones abiertas para monitorizar.\n";
    exit;
}

// -----------------------------------------------------------------------
// PASO 2: Obtener estado real de posiciones en Binance Futures
// -----------------------------------------------------------------------
$real_positions = binance_get_positions();

// SEGURIDAD: si la API falla (devuelve error o array vacío sin datos),
// NO sincronizamos para evitar cerrar posiciones erróneamente.
$api_ok = !empty($real_positions) && !isset($real_positions['code']);

if ($api_ok) {
    // Construir mapa: solo posiciones con cantidad activa (!= 0)
    $real_map = [];
    foreach ($real_positions as $rp) {
        if (isset($rp['symbol']) && isset($rp['positionAmt']) && floatval($rp['positionAmt']) != 0) {
            $real_map[strtoupper($rp['symbol'])] = $rp;
        }
    }

    // -----------------------------------------------------------------------
    // PASO 3: SINCRONIZACIÓN Binance → BD
    // Si la posición está en BD (open) pero NO en Binance → cerrada externamente
    // (SL nativo disparado, cierre manual en app Binance, liquidación, etc.)
    // -----------------------------------------------------------------------
    foreach ($positions as $pos) {
        $id     = $pos['id'];
        $symbol = strtoupper($pos['symbol']);
        $type   = $pos['position_type'];

        if (!isset($real_map[$symbol])) {
            // Posición cerrada en Binance — sincronizar BD
            $current_price = binance_get_price($symbol) ?: floatval($pos['entry_price']);
            $entry_price   = floatval($pos['entry_price']);
            $quantity      = floatval($pos['quantity']);

            if ($type === 'buy') {
                $profit_percent = (($current_price - $entry_price) / $entry_price) * 100;
                $profit_fiat    = ($current_price - $entry_price) * $quantity;
            } else {
                $profit_percent = (($entry_price - $current_price) / $entry_price) * 100;
                $profit_fiat    = ($entry_price - $current_price) * $quantity;
            }

            // Limpiar cualquier orden pendiente que pudiera haber quedado
            binance_cancel_all_orders($symbol);

            // Cerrar en la BD
            $upd = $db->prepare(
                "UPDATE positions SET status = 'closed', closed_at = CURRENT_TIMESTAMP,
                 profit_loss_percent = ?, profit_loss_fiat = ? WHERE id = ? AND status = 'open'"
            );
            $upd->execute([$profit_percent, $profit_fiat, $id]);
            echo "SINC_CERRADA: Posición #$id ($symbol) cerrada en Binance externamente (SL/manual). BD actualizada. Precio ref: $current_price\n";
        }
    }

    // Refrescar lista de posiciones aún abiertas tras sincronización
    $stmt      = $db->query("SELECT * FROM positions WHERE status = 'open'");
    $positions = $stmt->fetchAll(PDO::FETCH_ASSOC);

    if (empty($positions)) {
        echo "Todas las posiciones sincronizadas. No quedan posiciones abiertas.\n";
        exit;
    }
} else {
    echo "ADVERTENCIA: API Binance no disponible o sin datos. Se omite sincronización exterior. Solo se ejecuta trailing SL local.\n";
}

// -----------------------------------------------------------------------
// PASO 4: Trailing Stop Loss + Cierre por SL local
// Para cada posición que sigue abierta en BD, ajustar el trailing SL.
// Si el precio toca el SL: enviar orden de cierre REAL a Binance.
// -----------------------------------------------------------------------
foreach ($positions as $pos) {
    $id          = $pos['id'];
    $symbol      = strtoupper($pos['symbol']);
    $type        = $pos['position_type'];
    $entry_price = floatval($pos['entry_price']);
    $current_sl  = floatval($pos['stop_loss']);
    $quantity    = floatval($pos['quantity']);

    $current_price = binance_get_price($symbol);
    if (!$current_price) {
        echo "ERROR: No se pudo obtener precio de $symbol. Saltando.\n";
        continue;
    }

    $profit_percent = 0;
    $profit_fiat    = 0;
    $new_sl         = $current_sl;
    $sl_triggered   = false;

    if ($type === 'buy') {
        $profit_percent = (($current_price - $entry_price) / $entry_price) * 100;
        $profit_fiat    = ($current_price - $entry_price) * $quantity;

        if ($current_price <= $current_sl) {
            $sl_triggered = true;
        } elseif ($profit_percent >= 0.5) {
            // Trailing Stop
            $suggested_sl = $current_price * (1 - 0.005);
            $target_sl    = max($entry_price, $suggested_sl); // al menos breakeven
            if ($target_sl > $current_sl) {
                $new_sl = $target_sl;
                binance_cancel_all_orders($symbol);
                binance_place_stop_market($symbol, 'SELL', $new_sl, $quantity);
            }
        }
    } else { // short
        $profit_percent = (($entry_price - $current_price) / $entry_price) * 100;
        $profit_fiat    = ($entry_price - $current_price) * $quantity;

        if ($current_price >= $current_sl) {
            $sl_triggered = true;
        } elseif ($profit_percent >= 0.5) {
            // Trailing Stop
            $suggested_sl = $current_price * (1 + 0.005);
            $target_sl    = min($entry_price, $suggested_sl); // al menos breakeven
            if ($target_sl < $current_sl) {
                $new_sl = $target_sl;
                binance_cancel_all_orders($symbol);
                binance_place_stop_market($symbol, 'BUY', $new_sl, $quantity);
            }
        }
    }

    if ($sl_triggered) {
        // ----------------------------------------------------------------
        // SL LOCAL ACTIVADO: enviar orden de cierre REAL a Binance
        // No asumir que Binance ya lo cerró — mandarlo explícitamente.
        // ----------------------------------------------------------------
        $close_side = ($type === 'buy') ? 'SELL' : 'BUY';

        // Cancelar órdenes pendientes (el STOP_MARKET nativo) antes de enviar MARKET
        binance_cancel_all_orders($symbol);

        // Enviar orden de cierre de mercado
        $close_resp = binance_close_position($symbol, $close_side, $quantity);

        if (binance_order_success($close_resp)) {
            // Cerrar en BD solo si Binance aceptó la orden
            $upd = $db->prepare(
                "UPDATE positions SET status = 'closed', closed_at = CURRENT_TIMESTAMP,
                 profit_loss_percent = ?, profit_loss_fiat = ? WHERE id = ? AND status = 'open'"
            );
            $upd->execute([$profit_percent, $profit_fiat, $id]);
            echo "SL_CERRADA: Posición #$id ($symbol) cerrada en Binance y BD por Stop Loss local a $current_price. PnL: " . round($profit_percent, 2) . "%\n";
        } else {
            $err = isset($close_resp['code']) ? "code={$close_resp['code']} msg={$close_resp['msg']}" : json_encode($close_resp);
            echo "SL_ERROR: Posición #$id ($symbol) — SL activado pero fallo al cerrar en Binance: $err. BD NO actualizada.\n";
        }
    } else {
        // Actualizar trailing SL y PnL en BD
        $upd = $db->prepare(
            "UPDATE positions SET stop_loss = ?, profit_loss_percent = ?, profit_loss_fiat = ? WHERE id = ?"
        );
        $upd->execute([$new_sl, $profit_percent, $profit_fiat, $id]);
        echo "OK: #$id $symbol | Precio: $current_price | SL: $new_sl | PnL: " . round($profit_percent, 2) . "%\n";
    }
}
?>
