<?php
// entry.php
header('Content-Type: application/json');
require_once 'config.php';
require_once 'binance_api.php';

// 1. EXTRAER PARÁMETROS
$symbol = isset($_REQUEST['symbol']) ? strtoupper($_REQUEST['symbol']) : '';
$amount = isset($_REQUEST['amount']) ? (float)$_REQUEST['amount'] : 0; 
$type   = isset($_REQUEST['type']) ? strtolower($_REQUEST['type']) : '';

if (empty($symbol) || $amount <= 0 || empty($type)) {
    $raw_input = file_get_contents('php://input');
    $json_data = json_decode($raw_input, true);
    if (is_array($json_data)) {
        if (!empty($json_data['symbol'])) $symbol = strtoupper($json_data['symbol']);
        if (isset($json_data['amount'])) $amount = (float)$json_data['amount'];
        if (!empty($json_data['type'])) $type = strtolower($json_data['type']);
    }
}

// 2. VALIDACIÓN RÁPIDA
if (empty($symbol) || $amount <= 0 || !in_array($type, ['buy', 'sell'])) {
    http_response_code(400);
    die(json_encode(['error' => true, 'message' => 'Parámetros inválidos.']));
}

// 3. RESPUESTA INMEDIATA (FAST RESPONSE)
// Preparamos al servidor para seguir trabajando después de responder
ignore_user_abort(true); 
set_time_limit(60); // 60 segundos es suficiente para las APIs de Binance

ob_start();
echo json_encode([
    'success' => true, 
    'message' => "Webhook recibido para $symbol ($type). Procesando en background...",
    'timestamp' => date('Y-m-d H:i:s')
]);
$size = ob_get_length();
header("Content-Length: $size");
header("Connection: close");
header("Content-Type: application/json");
ob_end_flush();
ob_flush();
flush();

// Si el servidor usa FastCGI (FPM), esto cierra la conexión HTTP pero mantiene vivo el proceso PHP
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
}

// =========================================================================
// A PARTIR DE AQUÍ, EL EMISOR YA NO ESPERA Y EL SCRIPT SIGUE TRABAJANDO
// =========================================================================

// 3.5 COMPROBAR SI EL BOT ESTÁ ACTIVADO
$stmtSetting = $db->query("SELECT value FROM settings WHERE key = 'bot_enabled' LIMIT 1");
$bot_enabled = $stmtSetting->fetchColumn();

if ($bot_enabled === '0') {
    // Si el bot está desactivado, no procesamos nada más.
    // El usuario ya recibió un 200 OK arriba (Fast Response), así que simplemente salimos.
    exit;
}

// 4. LÓGICA DE NEGOCIO (ENTRADA / CAMBIO DE DIRECCIÓN)

// Comprobar si ya existe una posición abierta para este símbolo
$stmt = $db->prepare("SELECT * FROM positions WHERE symbol = ? AND status = 'open'");
$stmt->execute([$symbol]);
$existing = $stmt->fetch(PDO::FETCH_ASSOC);

if ($existing) {
    if ($existing['position_type'] === $type) {
        // Mismo tipo, ignoramos (ya respondido por arriba, así que solo salimos)
        exit;
    } else {
        // Cambio de dirección: Cerrar la actual y continuar
        $id_to_close = $existing['id'];
        $existing_type = $existing['position_type'];
        $existing_qty = floatval($existing['quantity']);
        $existing_entry_price = floatval($existing['entry_price']);
        
        $current_price = binance_get_price($symbol);
        if ($current_price) {
            binance_cancel_all_orders($symbol); // Cancelar SL anterior

            $close_side = ($existing_type === 'buy') ? 'SELL' : 'BUY';
            $close_resp = binance_close_position($symbol, $close_side, $existing_qty);

            if (binance_order_success($close_resp)) {
                if ($existing_type === 'buy') {
                    $profit_percent = (($current_price - $existing_entry_price) / $existing_entry_price) * 100;
                    $profit_fiat = ($current_price - $existing_entry_price) * $existing_qty;
                } else {
                    $profit_percent = (($existing_entry_price - $current_price) / $existing_entry_price) * 100;
                    $profit_fiat = ($existing_entry_price - $current_price) * $existing_qty;
                }

                $upd = $db->prepare("UPDATE positions SET status = 'closed', closed_at = CURRENT_TIMESTAMP, profit_loss_percent = ?, profit_loss_fiat = ? WHERE id = ?");
                $upd->execute([$profit_percent, $profit_fiat, $id_to_close]);
            } else {
                // Si falla el cierre, no deberíamos abrir la siguiente para evitar conflictos
                log_debug("ERROR entry.php: No se pudo cerrar la posición previa de $symbol. Abortando nueva entrada.");
                exit;
            }
        }
    }
}

// Abrir nueva posición
$price = binance_get_price($symbol);
if (!$price) exit;

$exchange_info = binance_get_exchange_info($symbol);
$quantity_raw  = $amount / $price;
$quantity      = format_quantity($quantity_raw, $exchange_info);

$side = ($type === 'buy') ? 'BUY' : 'SELL';

// ---- PASO 1: Abrir posición en Binance ----
$orderResponse = binance_place_market_order($symbol, $side, $quantity);

if (!binance_order_success($orderResponse)) {
    log_debug("ERROR entry.php: Fallo al abrir $symbol. " . json_encode($orderResponse));
    exit;
}

$entry_price = isset($orderResponse['avgPrice']) && floatval($orderResponse['avgPrice']) > 0
    ? (float)$orderResponse['avgPrice']
    : $price;

// ---- PASO 2: Colocar Stop Loss (Algo Order) ----
$sl_percent = 1.2 / 100;
if ($type === 'buy') {
    $stop_loss = $entry_price * (1 - $sl_percent);
    $sl_side   = 'SELL';
} else {
    $stop_loss = $entry_price * (1 + $sl_percent);
    $sl_side   = 'BUY';
}

$sl_response = binance_place_stop_market($symbol, $sl_side, $stop_loss, $quantity);

// Si el SL falla, hacemos rollback (cerramos la que acabamos de abrir)
if (!binance_order_success($sl_response)) {
    binance_close_position($symbol, ($sl_side === 'SELL' ? 'SELL' : 'BUY'), $quantity);
    log_debug("ERROR entry.php: SL fallido para $symbol. Rollback ejecutado.");
    exit;
}

// ---- PASO 3: Registro en BD ----
try {
    $stmt = $db->prepare("INSERT INTO positions (symbol, position_type, amount, quantity, entry_price, stop_loss) VALUES (?, ?, ?, ?, ?, ?)");
    $stmt->execute([$symbol, $type, $amount, $quantity, $entry_price, $stop_loss]);
} catch (PDOException $e) {
    log_debug("ERROR BD entry.php: " . $e->getMessage());
}

// Función auxiliar de log para debug en background
function log_debug($msg) {
    file_put_contents('binance_api.log', date('[Y-m-d H:i:s] ') . $msg . "\n", FILE_APPEND);
}
?>


