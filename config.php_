<?php
// config.php

define('BINANCE_API_KEY', 'BybstQ0Af40qEDVqAVBRkT4kXfI3O9VVvwL9diTgFeoTNfWrVL9f9n6Ahgm3eb06');
define('BINANCE_SECRET_KEY', 'Jw58keRYtwFY3yHOWwzasLSKt254IJXALleIwIqpn9rS9AKuB5dXI7XUZsMXFzPi');
define('BINANCE_BASE_URL', 'https://testnet.binancefuture.com'); // Usando futuros testnet (demo)


// Base de datos SQLite
define('DB_FILE', __DIR__ . '/trading.sqlite');

try {
    $db = new PDO('sqlite:' . DB_FILE);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    // Crear tabla de posiciones
    $db->exec("CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        position_type TEXT NOT NULL, -- 'buy' (Long) o 'sell' (Short)
        amount REAL NOT NULL,
        quantity REAL NOT NULL,
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', -- 'open' o 'closed'
        profit_loss_percent REAL DEFAULT 0,
        profit_loss_fiat REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME DEFAULT NULL
    )");

    // Crear tabla de settings si no existe
    $db->exec("CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )");

    // Inicializar setting por defecto si no existe
    $stmt = $db->prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('bot_enabled', '1')");
    $stmt->execute();
} catch (PDOException $e) {
    die("Error en la conexión a la base de datos: " . $e->getMessage());
}
?>