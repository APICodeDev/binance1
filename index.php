<?php
// index.php
?>
<!DOCTYPE html>
<html lang="es">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Trading Bot - Iniciando</title>
    <link rel="icon" type="image/png" href="favicon.png">
    <style>
        :root {
            --bg-color: #0f172a;
            --accent: #fcd535;
            /* Binance Yellow */
            --text: #f8fafc;
        }

        body {
            margin: 0;
            padding: 0;
            background-color: var(--bg-color);
            color: var(--text);
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            overflow: hidden;
        }

        .splash-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            animation: fadeIn 2s ease-out forwards;
        }

        .logo-icon {
            width: 100px;
            height: 100px;
            margin-bottom: 20px;
            animation: bounce 1s cubic-bezier(0.28, 0.84, 0.42, 1) infinite alternate;
        }

        .title {
            font-size: 2.5rem;
            font-weight: 800;
            letter-spacing: 2px;
            margin: 0;
        }

        .title span {
            color: var(--accent);
        }

        .subtitle {
            margin-top: 10px;
            font-size: 1rem;
            color: #94a3b8;
            letter-spacing: 4px;
            text-transform: uppercase;
        }

        @keyframes bounce {
            0% { transform: translateY(0) scale(1.0); }
            100% { transform: translateY(-15px) scale(1.05); }
        }

        @keyframes fadeIn {
            0% {
                opacity: 0;
                transform: scale(0.9);
                filter: blur(10px);
            }
            100% {
                opacity: 1;
                transform: scale(1);
                filter: blur(0);
            }
        }
    </style>
</head>

<body>
    <div class="splash-container">
        <!-- Icono abstracto que representa a Binance / Trading -->
        <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="#fcd535" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
        </svg>
        <h1 class="title">TRADE<span>BOT</span></h1>
        <div class="subtitle">System Initializing</div>
    </div>

    <script>
        // Transición suave al dashboard: espera a la animación (2s) y añade otros 2s extra
        setTimeout(() => {
            window.location.href = 'dashboard.php';
        }, 4100);
    </script>
</body>

</html>