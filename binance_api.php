<?php
// binance_api.php

/**
 * Función base para hacer peticiones a la API de Binance Futures.
 * Escribe logs detallados en binance_api.log para diagnóstico.
 */
function binance_request($endpoint, $params = [], $method = 'GET', $signed = false) {
    if ($signed) {
        $params['timestamp'] = number_format(microtime(true) * 1000, 0, '.', '');
        $query_string = http_build_query($params);
        $signature = hash_hmac('sha256', $query_string, BINANCE_SECRET_KEY);
        $params['signature'] = $signature;
    }

    $url = BINANCE_BASE_URL . $endpoint;
    if ($method === 'GET' && !empty($params)) {
        $url .= '?' . http_build_query($params);
    }

    $ch = curl_init();

    $headers = ['Content-Type: application/x-www-form-urlencoded'];
    if ($signed) {
        $headers[] = 'X-MBX-APIKEY: ' . BINANCE_API_KEY;
    }

    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        if (!empty($params)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));
        }
    } elseif ($method === 'DELETE') {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'DELETE');
        if (!empty($params)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));
        }
    }

    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    curl_setopt($ch, CURLOPT_TIMEOUT, 15);
    // curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); // Descomentar si hay errores SSL en local

    $output = curl_exec($ch);
    $curl_error = curl_error($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    // Log detallado de TODAS las llamadas a la API (para diagnóstico)
    $log_entry = date('Y-m-d H:i:s') . " | $method $endpoint | HTTP $http_code";
    if ($curl_error) {
        $log_entry .= " | CURL_ERROR: $curl_error";
        file_put_contents(__DIR__ . '/binance_api.log', $log_entry . "\n", FILE_APPEND);
        return ['error' => true, 'message' => $curl_error];
    }

    $decoded = json_decode($output, true);
    $log_entry .= " | RESPONSE: " . substr($output, 0, 300);
    file_put_contents(__DIR__ . '/binance_api.log', $log_entry . "\n", FILE_APPEND);

    if ($decoded === null) {
        return ['error' => true, 'message' => 'JSON inválido de Binance: ' . $output];
    }

    return $decoded;
}

/**
 * Obtiene el precio actual de un símbolo.
 */
function binance_get_price($symbol) {
    $response = binance_request('/fapi/v1/ticker/price', ['symbol' => strtoupper($symbol)]);
    if (isset($response['price'])) {
        return (float) $response['price'];
    }
    return false;
}

/**
 * Coloca una orden de mercado estándar (para ABRIR posiciones).
 * NO usar para cerrar — usar binance_close_position en su lugar.
 */
function binance_place_market_order($symbol, $side, $quantity) {
    $params = [
        'symbol'   => strtoupper($symbol),
        'side'     => $side,
        'type'     => 'MARKET',
        'quantity' => $quantity,
    ];
    return binance_request('/fapi/v1/order', $params, 'POST', true);
}

/**
 * Cierra una posición abierta en Binance Futures.
 *
 * ESTRATEGIA DE CIERRE ROBUSTA:
 * 1. Intenta con reduceOnly=true (la forma correcta en One-Way Mode).
 * 2. Si falla con error -2022 (ReduceOnly rejected), reintenta SIN reduceOnly
 *    (esto puede ocurrir si hay una orden STOP_MARKET con closePosition=true todavía activa).
 * 3. Devuelve el resultado con campo 'binance_closed'=true si se confirmó el cierre.
 *
 * Retorna el response de la orden si tuvo éxito, o array con 'error'=>true si falló.
 */
function binance_close_position($symbol, $side, $quantity) {
    $sym = strtoupper($symbol);

    // Intento 1: con reduceOnly=true
    $params = [
        'symbol'     => $sym,
        'side'       => $side,
        'type'       => 'MARKET',
        'quantity'   => $quantity,
        'reduceOnly' => 'true',
    ];
    $resp = binance_request('/fapi/v1/order', $params, 'POST', true);

    // Si tuvo éxito, devolver
    if (binance_order_success($resp)) {
        return $resp;
    }

    // Intento 2: si el error es -2022 (ReduceOnly rejected), intentar sin reduceOnly
    // Esto puede pasar si el modo es Hedge o si hay otras órdenes en conflicto
    if (isset($resp['code']) && $resp['code'] == -2022) {
        file_put_contents(__DIR__ . '/binance_api.log',
            date('Y-m-d H:i:s') . " | REINTENTO SIN reduceOnly para $sym\n", FILE_APPEND);

        $params2 = [
            'symbol'   => $sym,
            'side'     => $side,
            'type'     => 'MARKET',
            'quantity' => $quantity,
        ];
        $resp = binance_request('/fapi/v1/order', $params2, 'POST', true);
    }

    return $resp;
}

/**
 * Comprueba si una respuesta de orden de Binance indica éxito.
 * Soporta tanto órdenes normales (orderId) como Algo Orders (algoId).
 */
function binance_order_success($resp) {
    if (!is_array($resp)) return false;
    if (isset($resp['error']) && $resp['error']) return false;
    if (isset($resp['code']) && $resp['code'] < 0) return false;
    // Órdenes normales: tienen orderId
    if (isset($resp['orderId'])) return true;
    // Algo Orders (STOP_MARKET desde dic 2025): tienen algoId
    if (isset($resp['algoId'])) return true;
    // Status explícito
    $ok_statuses = ['FILLED', 'NEW', 'PARTIALLY_FILLED', 'EXECUTING'];
    if (isset($resp['status']) && in_array($resp['status'], $ok_statuses)) return true;
    return false;
}

/**
 * Verifica en Binance si una posición sigue abierta (positionAmt != 0).
 * Retorna true si la posición EXISTE y está abierta, false si está cerrada/no existe.
 * Retorna null si no se puede determinar (error de API).
 */
function binance_position_is_open($symbol) {
    $sym = strtoupper($symbol);
    $response = binance_request('/fapi/v2/positionRisk', ['symbol' => $sym], 'GET', true);

    if (isset($response['code'])) {
        // Error de API
        return null;
    }
    if (!is_array($response)) {
        return null;
    }

    foreach ($response as $pos) {
        if (isset($pos['symbol']) && strtoupper($pos['symbol']) === $sym) {
            return floatval($pos['positionAmt']) != 0;
        }
    }
    return false; // No apareció en la respuesta → consideramos cerrada
}

/**
 * Obtiene la precisión de precio (tickSize) de un símbolo desde exchangeInfo.
 * Esto es crucial para formatear stopPrice correctamente y evitar el error -1111.
 */
function get_price_precision($symbol) {
    static $cache = [];
    $sym = strtoupper($symbol);
    if (isset($cache[$sym])) return $cache[$sym];

    $response = binance_request('/fapi/v1/exchangeInfo');
    if (isset($response['symbols'])) {
        foreach ($response['symbols'] as $s) {
            if ($s['symbol'] === $sym) {
                foreach ($s['filters'] as $filter) {
                    if ($filter['filterType'] === 'PRICE_FILTER') {
                        $tickSize = floatval($filter['tickSize']);
                        // Calcular decimales a partir del tickSize
                        $precision = 0;
                        $temp = $tickSize;
                        while ($temp < 1 && $temp > 0) {
                            $temp *= 10;
                            $precision++;
                        }
                        $cache[$sym] = $precision;
                        return $precision;
                    }
                }
            }
        }
    }
    // Fallback: 2 decimales
    $cache[$sym] = 2;
    return 2;
}

/**
 * Coloca una orden Stop-Market como Algo Order (endpoint obligatorio desde dic 2025).
 * Usa POST /fapi/v1/algoOrder con algoType=CONDITIONAL y type=STOP_MARKET.
 *
 * @param string $symbol    Par de futuros (ej. BTCUSDT)
 * @param string $side      BUY o SELL
 * @param float  $stopPrice Precio de triggger del stop
 * @param float  $quantity  Cantidad a cerrar (obligatorio: closePosition ya no acepta el endpoint antiguo)
 */
function binance_place_stop_market($symbol, $side, $stopPrice, $quantity = null) {
    $sym       = strtoupper($symbol);
    $precision = get_price_precision($sym);

    $params = [
        'symbol'       => $sym,
        'side'         => $side,
        'algoType'     => 'CONDITIONAL',   // Tipo requerido por el nuevo endpoint
        'type'         => 'STOP_MARKET',
        'triggerPrice' => number_format($stopPrice, $precision, '.', ''),
        'reduceOnly'   => 'true',
    ];

    // quantity es obligatorio a menos que se use closePosition
    // Usamos closePosition=true para cerrar toda la posición del lado correcto
    if ($quantity !== null) {
        $params['quantity'] = $quantity;
    } else {
        $params['closePosition'] = 'true';
    }

    return binance_request('/fapi/v1/algoOrder', $params, 'POST', true);
}

/**
 * Cancela todas las Algo Orders abiertas de un símbolo.
 * Endpoint: DELETE /fapi/v1/algoOrder/all
 */
function binance_cancel_algo_orders($symbol) {
    $params = ['symbol' => strtoupper($symbol)];
    // El endpoint para cancelar todas las algo orders activas de un símbolo
    return binance_request('/fapi/v1/algoOrder/all', $params, 'DELETE', true);
}

/**
 * Cancela todas las órdenes abiertas de un símbolo en Binance
 * (tanto órdenes normales como algo orders).
 */
function binance_cancel_all_orders($symbol) {
    $sym = strtoupper($symbol);
    // Cancelar órdenes normales
    $r1 = binance_request('/fapi/v1/allOpenOrders', ['symbol' => $sym], 'DELETE', true);
    // Cancelar algo orders (Stop Loss native)
    $r2 = binance_cancel_algo_orders($sym);
    return ['normal' => $r1, 'algo' => $r2];
}

/**
 * Obtiene todas las posiciones de Binance Futures (incluidas las cerradas con positionAmt=0).
 */
function binance_get_positions() {
    $response = binance_request('/fapi/v2/positionRisk', [], 'GET', true);
    if (is_array($response) && !isset($response['code'])) {
        return $response;
    }
    return [];
}

/**
 * Obtiene información de exchange para un símbolo (stepSize etc.).
 */
function binance_get_exchange_info($symbol) {
    $response = binance_request('/fapi/v1/exchangeInfo');
    if (isset($response['symbols'])) {
        foreach ($response['symbols'] as $s) {
            if ($s['symbol'] === strtoupper($symbol)) {
                return $s;
            }
        }
    }
    return null;
}

/**
 * Formatea la cantidad según el stepSize del exchange.
 */
function format_quantity($quantity, $exchange_info) {
    if (!$exchange_info) {
        return round($quantity, 3);
    }
    $stepSize = 0.001;
    foreach ($exchange_info['filters'] as $filter) {
        if ($filter['filterType'] == 'LOT_SIZE') {
            $stepSize = (float)$filter['stepSize'];
            break;
        }
    }
    $precision = 0;
    $temp = $stepSize;
    while ($temp < 1 && $temp > 0) {
        $temp *= 10;
        $precision++;
    }
    $formatted = floor($quantity / $stepSize) * $stepSize;
    return number_format($formatted, $precision, '.', '');
}
?>
