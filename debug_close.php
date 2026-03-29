<?php
// debug_close.php — Diagnóstico y test de sincronización con Binance
// Accede via: http://localhost/binance1/debug_close.php
// Para ejecutar un test de cierre real: añade ?test_close=ID a la URL
header('Content-Type: text/plain; charset=utf-8');

require_once 'config.php';
require_once 'binance_api.php';

echo "=== DIAGNÓSTICO DE SINCRONIZACIÓN BINANCE ===\n";
echo "Timestamp: " . date('Y-m-d H:i:s') . "\n\n";

// ---- 1. Posiciones en BD local ----
echo "--- POSICIONES EN BD LOCAL (open) ---\n";
$stmt  = $db->query("SELECT * FROM positions WHERE status = 'open'");
$locals = $stmt->fetchAll(PDO::FETCH_ASSOC);
if (empty($locals)) {
    echo "  (ninguna posición abierta en BD)\n";
} else {
    foreach ($locals as $p) {
        echo "  ID#{$p['id']} | {$p['symbol']} | tipo={$p['position_type']} | qty={$p['quantity']} | entry={$p['entry_price']} | sl={$p['stop_loss']}\n";
    }
}

// ---- 2. Posiciones en Binance ----
echo "\n--- POSICIONES EN BINANCE (/fapi/v2/positionRisk) ---\n";
$real = binance_get_positions();
if (isset($real['code'])) {
    echo "  ERROR API: code={$real['code']} msg={$real['msg']}\n";
} elseif (empty($real)) {
    echo "  Respuesta vacía — posible error de conexión o credenciales.\n";
} else {
    $found = 0;
    foreach ($real as $rp) {
        if (floatval($rp['positionAmt']) != 0) {
            echo "  ACTIVA: {$rp['symbol']} | positionAmt={$rp['positionAmt']} | entryPrice={$rp['entryPrice']} | PnL={$rp['unRealizedProfit']}\n";
            $found++;
        }
    }
    if ($found === 0) {
        echo "  (ninguna posición activa en Binance — todas con positionAmt=0)\n";
    }
}

// ---- 3. Órdenes abiertas en Binance ----
echo "\n--- ÓRDENES ABIERTAS EN BINANCE ---\n";
foreach ($locals as $p) {
    $sym    = strtoupper($p['symbol']);
    $params = ['symbol' => $sym];
    $resp   = binance_request('/fapi/v1/openOrders', $params, 'GET', true);

    if (isset($resp['code'])) {
        echo "  $sym — ERROR: code={$resp['code']} msg={$resp['msg']}\n";
    } elseif (is_array($resp)) {
        echo "  $sym — " . count($resp) . " orden(es) abierta(s)\n";
        foreach ($resp as $o) {
            echo "    orderId={$o['orderId']} | type={$o['type']} | side={$o['side']} | stopPrice=" . ($o['stopPrice'] ?? 'N/A') . " | status={$o['status']}\n";
        }
    }
}
if (empty($locals)) echo "  (sin posiciones locales para comprobar)\n";

// ---- 3b. Precisión de precio por símbolo ----
echo "\n--- PRECISIÓN DE PRECIO (tickSize) POR SÍMBOLO ---\n";
$symbols_checked = array_unique(array_column($locals, 'symbol'));
if (empty($symbols_checked)) {
    echo "  (sin posiciones locales)\n";
} else {
    foreach ($symbols_checked as $sym) {
        $precision = get_price_precision($sym);
        $current   = binance_get_price($sym);
        $sl_ejemplo = $current ? number_format($current * 0.988, $precision, '.', '') : 'N/A';
        echo "  $sym — tickSize precisión: $precision decimales | Precio actual: $current | SL ejemplo (-1.2%): $sl_ejemplo\n";
    }
}

// ---- 4. Test de cierre real (si se solicita) ----
if (isset($_GET['test_close'])) {
    $test_id = intval($_GET['test_close']);
    echo "\n--- TEST DE CIERRE REAL para ID#$test_id ---\n";

    $stmt = $db->prepare("SELECT * FROM positions WHERE id = ? AND status = 'open'");
    $stmt->execute([$test_id]);
    $pos = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$pos) {
        echo "  ERROR: Posición #$test_id no encontrada o ya cerrada en BD.\n";
    } else {
        $symbol   = strtoupper($pos['symbol']);
        $type     = $pos['position_type'];
        $quantity = floatval($pos['quantity']);
        $side     = ($type === 'buy') ? 'SELL' : 'BUY';

        echo "  Símbolo: $symbol | Tipo: $type | Qty: $quantity | Cerrando con lado: $side\n";
        echo "\n  [1] Cancelando órdenes abiertas...\n";
        $cancel = binance_cancel_all_orders($symbol);
        echo "  Respuesta cancel: " . json_encode($cancel) . "\n";

        echo "\n  [2] Enviando orden de cierre (reduceOnly)...\n";
        $close = binance_close_position($symbol, $side, $quantity);
        echo "  Respuesta close: " . json_encode($close) . "\n";

        $success = binance_order_success($close);
        echo "\n  [3] ¿binance_order_success? " . ($success ? "SÍ ✅" : "NO ❌") . "\n";

        if ($success) {
            echo "\n  [4] Verificando posición tras cierre...\n";
            usleep(500000);
            $still_open = binance_position_is_open($symbol);
            echo "  ¿Posición sigue abierta en Binance? " . ($still_open === true ? "SÍ (problema)" : ($still_open === false ? "NO ✅ (cerrada)" : "NULL (no se pudo verificar)")) . "\n";

            if ($still_open !== true) {
                // Actualizar BD
                $current_price = binance_get_price($symbol);
                $entry_price   = floatval($pos['entry_price']);
                if ($type === 'buy') {
                    $pct  = (($current_price - $entry_price) / $entry_price) * 100;
                    $fiat = ($current_price - $entry_price) * $quantity;
                } else {
                    $pct  = (($entry_price - $current_price) / $entry_price) * 100;
                    $fiat = ($entry_price - $current_price) * $quantity;
                }
                $upd = $db->prepare("UPDATE positions SET status='closed', closed_at=CURRENT_TIMESTAMP, profit_loss_percent=?, profit_loss_fiat=? WHERE id=?");
                $upd->execute([$pct, $fiat, $test_id]);
                echo "  [5] BD LOCAL ACTUALIZADA ✅ — PnL: " . round($pct, 2) . "% / " . round($fiat, 4) . " USDT\n";
            }
        }
    }
}

// ---- 5. Últimas líneas del log de API ----
echo "\n--- ÚLTIMAS 20 LÍNEAS DEL LOG (binance_api.log) ---\n";
$log_file = __DIR__ . '/binance_api.log';
if (file_exists($log_file)) {
    $lines = file($log_file);
    $last  = array_slice($lines, -20);
    echo implode('', $last);
} else {
    echo "  (log aún no existe — se creará en la primera llamada a la API)\n";
}

echo "\n=== FIN DEL DIAGNÓSTICO ===\n";
echo "Para test de cierre real: ?test_close=ID_DE_POSICION\n";
?>
