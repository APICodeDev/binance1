<?php
// dashboard.php
require_once 'config.php';
require_once 'binance_api.php';

/**
 * Cierra una posición: cancela órdenes, envía orden de cierre a Binance,
 * verifica que Binance lo confirme, y solo entonces actualiza la BD.
 * Devuelve ['ok'=>true] o ['ok'=>false, 'error'=>'mensaje'].
 */
function close_position_sync($db, $pos) {
    $symbol     = strtoupper($pos['symbol']);
    $type       = $pos['position_type'];
    $quantity   = floatval($pos['quantity']);
    $entry_price = floatval($pos['entry_price']);
    $id         = $pos['id'];

    // 1. Obtener precio actual
    $current_price = binance_get_price($symbol);
    if (!$current_price) {
        return ['ok' => false, 'error' => "No se pudo obtener el precio de $symbol en Binance."];
    }

    // 2. Calcular PnL estimado
    if ($type === 'buy') {
        $profit_percent = (($current_price - $entry_price) / $entry_price) * 100;
        $profit_fiat    = ($current_price - $entry_price) * $quantity;
        $close_side     = 'SELL';
    } else {
        $profit_percent = (($entry_price - $current_price) / $entry_price) * 100;
        $profit_fiat    = ($entry_price - $current_price) * $quantity;
        $close_side     = 'BUY';
    }

    // 3. Cancelar todas las órdenes abiertas del símbolo (SL nativo, etc.)
    binance_cancel_all_orders($symbol);

    // 4. Enviar orden de cierre a Binance (con retry automático en binance_close_position)
    $order_resp = binance_close_position($symbol, $close_side, $quantity);

    // 5. Revisar si la orden fue aceptada por Binance
    if (!binance_order_success($order_resp)) {
        $error_detail = '';
        if (isset($order_resp['code'])) {
            $error_detail = "Código Binance: {$order_resp['code']} — " . ($order_resp['msg'] ?? '');
        } elseif (isset($order_resp['message'])) {
            $error_detail = $order_resp['message'];
        } else {
            $error_detail = json_encode($order_resp);
        }
        return ['ok' => false, 'error' => "Binance rechazó la orden de cierre. $error_detail"];
    }

    // 6. Verificar en Binance que la posición quedó realmente en 0
    // (pequeña pausa para dar tiempo a Binance de procesar)
    usleep(500000); // 0.5 segundos
    $still_open = binance_position_is_open($symbol);

    if ($still_open === true) {
        // La posición sigue abierta en Binance a pesar de la orden
        return ['ok' => false, 'error' => "Orden enviada a Binance (orderId={$order_resp['orderId']}) pero la posición sigue apareciendo como abierta. Verifica manualmente en Binance."];
    }

    // 7. Binance confirmó el cierre (o null = no se pudo verificar, pero la orden fue aceptada)
    // Actualizar BD local
    $upd = $db->prepare(
        "UPDATE positions SET status = 'closed', closed_at = CURRENT_TIMESTAMP, 
         profit_loss_percent = ?, profit_loss_fiat = ? WHERE id = ? AND status = 'open'"
    );
    $upd->execute([$profit_percent, $profit_fiat, $id]);

    return ['ok' => true, 'price' => $current_price, 'pnl' => $profit_fiat];
}

// ---- Handlers POST ----

// Cierre forzado de una posición individual
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'force_close') {
    $id_to_close = intval($_POST['position_id']);
    $stmt = $db->prepare("SELECT * FROM positions WHERE id = ? AND status = 'open'");
    $stmt->execute([$id_to_close]);
    $pos = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($pos) {
        $result = close_position_sync($db, $pos);
        if ($result['ok']) {
            $msg_success = "✅ Posición #{$id_to_close} cerrada correctamente en Binance y BD a precio {$result['price']}. PnL: " . number_format($result['pnl'], 2) . " USDT";
        } else {
            $msg_error = "❌ " . $result['error'];
        }
    } else {
        $msg_error = "Posición no encontrada o ya cerrada.";
    }

// Cierre de emergencia de todas las posiciones
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'force_close_all') {
    $stmt = $db->query("SELECT * FROM positions WHERE status = 'open'");
    $open_pos = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $closed_count = 0;
    $errors = [];

    foreach ($open_pos as $pos) {
        $result = close_position_sync($db, $pos);
        if ($result['ok']) {
            $closed_count++;
        } else {
            $errors[] = "#{$pos['id']} ({$pos['symbol']}): " . $result['error'];
        }
    }

    if ($closed_count > 0) {
        $msg_success = "✅ Cierre de emergencia: $closed_count posición(es) cerrada(s) correctamente.";
    }
    if (!empty($errors)) {
        $msg_error = "❌ Errores en cierre masivo:\n" . implode("\n", $errors);
    }

// Borrar historial
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'clear_history') {
    $stmt = $db->prepare("DELETE FROM positions WHERE status = 'closed'");
    $stmt->execute();
    $msg_success = "El historial de posiciones ha sido borrado de la base de datos local.";

// Toggle Bot Status
} elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'toggle_bot') {
    $new_status = $_POST['status'] === '1' ? '1' : '0';
    $upd = $db->prepare("UPDATE settings SET value = ? WHERE key = 'bot_enabled'");
    $upd->execute([$new_status]);
    $msg_success = "Bot trading " . ($new_status === '1' ? 'ACTIVADO' : 'DESACTIVADO') . " correctamente.";
}

// Obtener estado del Bot
$stmtSetting = $db->query("SELECT value FROM settings WHERE key = 'bot_enabled' LIMIT 1");
$bot_enabled = $stmtSetting->fetchColumn() === '1';
$stmt = $db->query("SELECT * FROM positions WHERE status = 'open' ORDER BY created_at DESC");
$open_positions = $stmt->fetchAll(PDO::FETCH_ASSOC);

// Obtener historial
$stmt = $db->query("SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC");
$closed_positions = $stmt->fetchAll(PDO::FETCH_ASSOC);

// Total beneficio/perdida global
$stmt = $db->query("SELECT SUM(profit_loss_fiat) as total_fiat FROM positions WHERE status = 'closed'");
$total_fiat = $stmt->fetchColumn() ?: 0;
?>
<!DOCTYPE html>
<html lang="es">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Trading Bot</title>
    <link rel="icon" type="image/png" href="favicon.png">
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --accent: #3b82f6;
            --accent-hover: #2563eb;
            --success: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --border: #334155;
        }

        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            margin: 0;
            padding: 20px;
        }

        h1,
        h2 {
            font-weight: 600;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--border);
        }

        .total-pnl {
            font-size: 1.5rem;
            font-weight: 700;
            padding: 10px 20px;
            background: var(--card-bg);
            border-radius: 8px;
            border: 1px solid var(--border);
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }

        .card {
            background-color: var(--card-bg);
            border-radius: 12px;
            padding: 20px;
            border: 1px solid var(--border);
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }

        .symbol {
            font-size: 1.2rem;
            font-weight: 700;
        }

        .badge {
            padding: 4px 8px;
            border-radius: 4px;
            font-weight: 600;
            font-size: 0.8rem;
            text-transform: uppercase;
        }

        .badge.buy {
            background-color: rgba(16, 185, 129, 0.2);
            color: var(--success);
        }

        .badge.sell {
            background-color: rgba(239, 68, 68, 0.2);
            color: var(--danger);
        }

        .badge.safe {
            background-color: rgba(59, 130, 246, 0.2);
            color: var(--accent);
        }

        .stat-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            font-size: 0.95rem;
        }

        .stat-label {
            color: var(--text-muted);
        }

        .stat-value {
            font-weight: 600;
        }

        .text-success {
            color: var(--success);
        }

        .text-danger {
            color: var(--danger);
        }

        .btn {
            background-color: var(--danger);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            width: 100%;
            margin-top: 15px;
            transition: background-color 0.2s;
        }

        .btn:hover {
            background-color: #dc2626;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            background: var(--card-bg);
            border-radius: 12px;
            overflow: hidden;
        }

        th,
        td {
            text-align: left;
            padding: 12px 16px;
        }

        th {
            background-color: rgba(0, 0, 0, 0.2);
            font-weight: 600;
            color: var(--text-muted);
            border-bottom: 1px solid var(--border);
        }

        tr {
            border-bottom: 1px solid var(--border);
        }

        tr:last-child {
            border-bottom: none;
        }

        .alert {
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
        }

        .alert-success {
            background: rgba(16, 185, 129, 0.1);
            color: var(--success);
            border: 1px solid rgba(16, 185, 129, 0.2);
        }

        .alert-error {
            background: rgba(239, 68, 68, 0.1);
            color: var(--danger);
            border: 1px solid rgba(239, 68, 68, 0.2);
        }

        /* Modal styles */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }

        .modal {
            background: var(--card-bg);
            padding: 25px;
            border-radius: 12px;
            width: 100%;
            max-width: 400px;
            border: 1px solid var(--border);
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
        }

        .modal h3 {
            margin-top: 0;
            font-size: 1.3rem;
            margin-bottom: 20px;
        }

        .form-group {
            margin-bottom: 15px;
        }

        .form-group label {
            display: block;
            margin-bottom: 5px;
            color: var(--text-muted);
            font-size: 0.9rem;
        }

        .form-group input,
        .form-group select {
            width: 100%;
            padding: 10px;
            border-radius: 6px;
            border: 1px solid var(--border);
            background: var(--bg-color);
            color: var(--text-main);
            box-sizing: border-box;
            font-family: inherit;
            font-size: 1rem;
        }

        .form-group input:focus,
        .form-group select:focus {
            outline: 2px solid var(--accent);
            border-color: transparent;
        }

        .modal-actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }

        .btn-secondary {
            background: #475569;
        }

        .btn-secondary:hover {
            background: #334155;
        }

        .btn-primary {
            background: var(--accent);
        }

        .btn-primary:hover {
            background: var(--accent-hover);
        }

        /* Toggle Button */
        .toggle-container {
            display: flex;
            align-items: center;
            gap: 10px;
            background: var(--card-bg);
            padding: 8px 15px;
            border-radius: 8px;
            border: 1px solid var(--border);
        }

        .switch {
            position: relative;
            display: inline-block;
            width: 50px;
            height: 24px;
        }

        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #475569;
            transition: .4s;
            border-radius: 24px;
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: .4s;
            border-radius: 50%;
        }

        input:checked + .slider {
            background-color: var(--success);
        }

        input:checked + .slider:before {
            transform: translateX(26px);
        }

        .status-text {
            font-weight: 600;
            font-size: 0.9rem;
            min-width: 80px;
        }
    </style>
</head>

<body>
    <div class="container">
        <div class="header" style="flex-wrap: wrap; gap: 20px;">
            <!-- Logo izquierda -->
            <div style="display: flex; align-items: center; gap: 12px;">
                <svg viewBox="0 0 24 24" fill="none" stroke="#fcd535" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    style="width:36px;height:36px;flex-shrink:0;">
                    <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                    <polyline points="2 17 12 22 22 17"></polyline>
                    <polyline points="2 12 12 17 22 12"></polyline>
                </svg>
                <h1 style="margin:0;">TRADE<span style="color:#fcd535;">BOT</span> <span style="font-weight:400;font-size:1rem;color:var(--text-muted);">Dashboard</span></h1>
            </div>
            <div style="display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                <!-- Bot Toggle Switch -->
                <div class="toggle-container">
                    <span class="status-text <?= $bot_enabled ? 'text-success' : 'text-danger' ?>">
                        BOT: <?= $bot_enabled ? 'ON' : 'OFF' ?>
                    </span>
                    <label class="switch">
                        <input type="checkbox" id="botToggle" <?= $bot_enabled ? 'checked' : '' ?> onclick="toggleBot(this)">
                        <span class="slider"></span>
                    </label>
                </div>

                <button class="btn btn-primary" style="margin: 0; width: auto;" onclick="openModal()">+ Nueva
                    Posición</button>
                <button type="button" class="btn" style="margin: 0; width: auto; background-color: #991b1b;" onclick="emergencyCloseAll()">⚠️ Cierre de Emergencia</button>
                <div class="total-pnl" style="margin-left: auto;">
                    Balance Total:
                    <span class="<?= $total_fiat >= 0 ? 'text-success' : 'text-danger' ?>">
                        <?= number_format($total_fiat, 2) ?> USDT
                    </span>
                </div>
            </div>
        </div>

        <?php if (!empty($msg_success)): ?>
            <div class="alert alert-success"><?= $msg_success ?></div>
        <?php endif; ?>
        <?php if (!empty($msg_error)): ?>
            <div class="alert alert-error"><?= $msg_error ?></div>
        <?php endif; ?>

        <h2>Posiciones Activas (<?= count($open_positions) ?>)</h2>
        <div class="grid">
        <?php foreach ($open_positions as $pos):
                $symbol_data = binance_get_price($pos['symbol']);
                $current_price = $symbol_data ? $symbol_data : $pos['entry_price'];

                // Calcular si el SL garantiza algún beneficio mínimo
                $sl_profit_fiat = 0;
                $is_safe        = false;
                $is_breakeven   = false;

                if ($pos['position_type'] === 'buy') {
                    $profit_percent = (($current_price - $pos['entry_price']) / $pos['entry_price']) * 100;
                    // PnL si la posición se cerrase al precio del SL actual
                    $sl_profit_fiat = ($pos['stop_loss'] - $pos['entry_price']) * floatval($pos['quantity']);
                    if ($pos['stop_loss'] >= $pos['entry_price']) {
                        $is_safe = true;
                        $is_breakeven = (abs($sl_profit_fiat) < 0.01); // prácticamente cero → breakeven
                    }
                } else {
                    $profit_percent = (($pos['entry_price'] - $current_price) / $pos['entry_price']) * 100;
                    $sl_profit_fiat = ($pos['entry_price'] - $pos['stop_loss']) * floatval($pos['quantity']);
                    if ($pos['stop_loss'] <= $pos['entry_price']) {
                        $is_safe = true;
                        $is_breakeven = (abs($sl_profit_fiat) < 0.01);
                    }
                }
                $profit_fiat = ($profit_percent / 100) * $pos['amount'];
                $pnl_class   = $profit_percent >= 0 ? 'text-success' : 'text-danger';
                ?>
                <div class="card">
                    <div class="card-header">
                        <div class="symbol"><?= htmlspecialchars($pos['symbol']) ?></div>
                        <div class="badge <?= htmlspecialchars($pos['position_type']) ?>">
                            <?= strtoupper($pos['position_type']) ?>
                        </div>
                    </div>

                    <div class="stat-row">
                        <span class="stat-label">Fecha/Hora</span>
                        <span class="stat-value"
                            style="font-size: 0.85rem;"><?= htmlspecialchars($pos['created_at']) ?></span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Precio Entrada</span>
                        <span class="stat-value"><?= number_format($pos['entry_price'], 5) ?></span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Precio Actual</span>
                        <span class="stat-value"><?= number_format($current_price, 5) ?></span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">Stop Loss</span>
                        <span class="stat-value"><?= number_format($pos['stop_loss'], 5) ?></span>
                    </div>
                    <div class="stat-row">
                        <span class="stat-label">PnL</span>
                        <span class="stat-value <?= $pnl_class ?>">
                            <?= number_format($profit_percent, 2) ?>% (<?= number_format($profit_fiat, 2) ?> USDT)
                        </span>
                    </div>

                    <?php if ($is_safe): ?>
                        <div class="stat-row" style="margin-top: 10px; justify-content: center;">
                            <?php if ($is_breakeven): ?>
                                <span class="badge safe">⚖️ Breakeven Asegurado</span>
                            <?php else: ?>
                                <span class="badge safe">✓ Beneficio <?= number_format($sl_profit_fiat, 2) ?> USDT Asegurado</span>
                            <?php endif; ?>
                        </div>
                    <?php endif; ?>

                    <button type="button" class="btn" onclick="forceClose(<?= $pos['id'] ?>, '<?= htmlspecialchars($pos['symbol']) ?>')">Forzar Cierre</button>
                </div>
            <?php endforeach; ?>

            <?php if (empty($open_positions)): ?>
                <p style="color: var(--text-muted); margin-bottom: 0; grid-column: 1/-1;">No hay posiciones abiertas en este momento.</p>
            <?php endif; ?>
        </div><!-- /.grid -->

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <h2 style="margin: 0;">Histórico de Posiciones Cerradas</h2>
            <?php if (!empty($closed_positions)): ?>
                <button type="button" class="btn"
                        style="background-color: #475569; margin-top: 0; width: auto; font-size: 0.8em; padding: 6px 12px; border-radius: 4px;"
                        onclick="confirmClearHistory()">🗑️ Borrar Historial</button>
            <?php endif; ?>
        </div>

        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Símbolo</th>
                        <th>Tipo</th>
                        <th>Entrada</th>
                        <th>Monto (USDT)</th>
                        <th>PnL %</th>
                        <th>PnL (USDT)</th>
                        <th>Fecha Cierre</th>
                        <th>Duración</th>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ($closed_positions as $cpos):
                        $pnl_class = $cpos['profit_loss_percent'] >= 0 ? 'text-success' : 'text-danger';
                        ?>
                        <tr>
                            <td>#<?= $cpos['id'] ?></td>
                            <td class="symbol"><?= htmlspecialchars($cpos['symbol']) ?></td>
                            <td><span
                                    class="badge <?= htmlspecialchars($cpos['position_type']) ?>"><?= strtoupper($cpos['position_type']) ?></span>
                            </td>
                            <td><?= number_format($cpos['entry_price'], 5) ?></td>
                            <td><?= number_format($cpos['amount'], 2) ?></td>
                            <td class="<?= $pnl_class ?>"><?= number_format($cpos['profit_loss_percent'], 2) ?>%</td>
                            <td class="<?= $pnl_class ?>"><?= number_format($cpos['profit_loss_fiat'], 2) ?></td>
                            <td style="color: var(--text-muted); font-size: 0.9em;">
                                <?= $cpos['closed_at'] ?>
                            </td>
                            <td style="font-size: 0.85rem; color: var(--text-muted);">
                                <?php
                                $start = strtotime($cpos['created_at']);
                                $end = strtotime($cpos['closed_at']);
                                $diff = $end - $start;
                                if ($diff < 60)
                                    echo $diff . "s";
                                elseif ($diff < 3600)
                                    echo floor($diff / 60) . "m " . ($diff % 60) . "s";
                                else
                                    echo floor($diff / 3600) . "h " . floor(($diff % 3600) / 60) . "m";
                                ?>
                            </td>
                        </tr>
                    <?php endforeach; ?>
                    <?php if (empty($closed_positions)): ?>
                        <tr>
                            <td colspan="8" style="text-align: center; color: var(--text-muted);">Aún no hay posiciones
                                cerradas.</td>
                        </tr>
                    <?php endif; ?>
                </tbody>
            </table>
        </div>

        <!-- Modal -->
        <div class="modal-overlay" id="newPosModal">
            <div class="modal">
                <h3>Abrir Nueva Posición</h3>
                <div class="form-group">
                    <label>Símbolo (ej. BTCUSDT)</label>
                    <input type="text" id="new_symbol" placeholder="BTCUSDT" style="text-transform: uppercase;">
                </div>
                <div class="form-group">
                    <label>Monto a invertir (USDT)</label>
                    <input type="number" id="new_amount" placeholder="100" step="0.01">
                </div>
                <div class="form-group">
                    <label>Tipo de Posición</label>
                    <select id="new_type">
                        <option value="buy">BUY (Long)</option>
                        <option value="sell">SELL (Short)</option>
                    </select>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" style="margin: 0;" onclick="closeModal()">Cancelar</button>
                    <button class="btn btn-primary" style="margin: 0;" onclick="submitNewPosition()"
                        id="btnSubmitPos">Abrir Posición</button>
                </div>
            </div>
        </div>

        <!-- Confirm Modal -->
        <div class="modal-overlay" id="confirmModal">
            <div class="modal">
                <h3 id="confirmTitle">Confirmación</h3>
                <p id="confirmMessage" style="color: var(--text-muted); margin-bottom: 25px;"></p>
                <div class="modal-actions">
                    <button class="btn btn-secondary" style="margin: 0;" onclick="closeConfirm()">No, Cancelar</button>
                    <button class="btn btn-primary" style="margin: 0; background-color: var(--danger);" id="confirmBtnAction">Sí, Proceder</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Bot Toggle function
        function toggleBot(checkbox) {
            const status = checkbox.checked ? '1' : '0';
            const formData = new FormData();
            formData.append('action', 'toggle_bot');
            formData.append('status', status);

            fetch('dashboard.php', {
                method: 'POST',
                body: formData
            })
            .then(response => response.text())
            .then(() => {
                fetchDashboard(); // Refresh all UI components
            })
            .catch(err => {
                console.error('Error toggling bot status:', err);
                alert('No se pudo cambiar el estado del bot.');
                checkbox.checked = !checkbox.checked; // Revert visually
            });
        }

        // Modal functions
        function openModal() {
            document.getElementById('newPosModal').style.display = 'flex';
        }
        function closeModal() {
            document.getElementById('newPosModal').style.display = 'none';
        }
        function submitNewPosition() {
            const symbol = document.getElementById('new_symbol').value.trim();
            const amount = document.getElementById('new_amount').value;
            const type = document.getElementById('new_type').value;

            if (!symbol || !amount) {
                alert('Por favor, rellena todos los campos.');
                return;
            }

            const btn = document.getElementById('btnSubmitPos');
            btn.disabled = true;
            btn.innerText = 'Abriendo...';

            fetch(`entry.php?symbol=${symbol}&amount=${amount}&type=${type}`)
                .then(r => r.json())
                .then(data => {
                    btn.disabled = false;
                    btn.innerText = 'Abrir Posición';
                    if (data.error) {
                        alert('Error: ' + data.message);
                    } else {
                        // Reset forms
                        document.getElementById('new_symbol').value = '';
                        document.getElementById('new_amount').value = '';
                        closeModal();
                        fetchDashboard(); // Refresco inmediato
                    }
                })
                .catch(err => {
                    btn.disabled = false;
                    btn.innerText = 'Abrir Posición';
                    alert('Error en conexión con la API interna.');
                });
        }

        // Función para cierre forzado vía AJAX con modal propio
        let confirmActionCallback = null;

        function showConfirm(title, message, onConfirm) {
            document.getElementById('confirmTitle').innerText = title;
            document.getElementById('confirmMessage').innerText = message;
            confirmActionCallback = onConfirm;
            document.getElementById('confirmModal').style.display = 'flex';
        }

        function closeConfirm() {
            document.getElementById('confirmModal').style.display = 'none';
            confirmActionCallback = null;
        }

        document.getElementById('confirmBtnAction').onclick = function() {
            if (confirmActionCallback) confirmActionCallback();
            closeConfirm();
        };

        function forceClose(id, symbol) {
            showConfirm(
                'Cerrar Posición', 
                `¿Estás seguro de que deseas forzar el cierre de ${symbol}? Esta acción es irreversible.`,
                () => {
                    const formData = new FormData();
                    formData.append('action', 'force_close');
                    formData.append('position_id', id);

                    fetch('dashboard.php', {
                        method: 'POST',
                        body: formData
                    })
                    .then(() => fetchDashboard())
                    .catch(err => alert('Error al intentar cerrar la posición.'));
                }
            );
        }

        // Función para cierre de emergencia AJAX con modal propio
        function emergencyCloseAll() {
            showConfirm(
                'CIERRE DE EMERGENCIA',
                '¡PELIGRO! Esta acción cerrará TODAS tus posiciones abiertas a precio de mercado inmediatamente. ¿Deseas continuar?',
                () => {
                    const formData = new FormData();
                    formData.append('action', 'force_close_all');

                    fetch('dashboard.php', {
                        method: 'POST',
                        body: formData
                    })
                    .then(() => fetchDashboard())
                    .catch(err => alert('Error en cierre masivo.'));
                }
            );
        }

        // Función para borrar historial AJAX con modal propio
        function confirmClearHistory() {
            showConfirm(
                'Borrar Historial',
                '¿Deseas eliminar permanentemente el historial de posiciones cerradas? Esto también reiniciará el balance total acumulado.',
                () => {
                    const formData = new FormData();
                    formData.append('action', 'clear_history');

                    fetch('dashboard.php', {
                        method: 'POST',
                        body: formData
                    })
                    .then(() => fetchDashboard())
                    .catch(err => alert('Error al borrar historial.'));
                }
            );
        }

        // Dashboard reload function
        function fetchDashboard() {
            fetch('dashboard.php')
                .then(response => response.text())
                .then(html => {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');

                    // Update Bot Toggle
                    const currentToggle = document.querySelector('.toggle-container');
                    const newToggle = doc.querySelector('.toggle-container');
                    if (currentToggle && newToggle) currentToggle.innerHTML = newToggle.innerHTML;

                    const currentTotal = document.querySelector('.total-pnl');
                    const newTotal = doc.querySelector('.total-pnl');
                    if (currentTotal && newTotal) currentTotal.innerHTML = newTotal.innerHTML;

                    const currentH2s = document.querySelectorAll('h2');
                    const newH2s = doc.querySelectorAll('h2');
                    if (currentH2s.length > 0 && newH2s.length > 0) currentH2s[0].innerHTML = newH2s[0].innerHTML;

                    const currentGrid = document.querySelector('.grid');
                    const newGrid = doc.querySelector('.grid');
                    if (currentGrid && newGrid) currentGrid.innerHTML = newGrid.innerHTML;

                    const currentTbody = document.querySelector('table tbody');
                    const newTbody = doc.querySelector('table tbody');
                    if (currentTbody && newTbody) currentTbody.innerHTML = newTbody.innerHTML;
                })
                .catch(err => console.error('Error actualizando dashboard:', err));
        }

        // Refresco de información cada 10 segundos
        setInterval(function () {
            // 1. Ejecutar el script monitor.php en segundo plano 
            // (esto actualiza los Stop Loss sin bloquear la UI)
            fetch('monitor.php')
                .then(() => {
                    // 2. Transcurridos los cálculos, refrescar el dashboard visualmente
                    fetchDashboard();
                })
                .catch(err => console.error('Error ejecutando monitor:', err));
        }, 10000);
    </script>
</body>

</html>