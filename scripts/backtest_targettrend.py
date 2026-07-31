"""Backtest Target Trend Trend Length on Binance USDⓈ-M Futures data.

The script reproduces the relevant Pine logic from TargetTrend_MTF_Apicode.pine:
  ATR = SMA(RMA(True Range, 200), 200) * 0.8
  smaHigh = SMA(high, trend_length) + ATR
  smaLow  = SMA(low, trend_length) - ATR
  entries on confirmed trend flips
  TP1 = entry +/- ATR * 5
  SL  = smaLow for longs / smaHigh for shorts

It uses 5m Binance Futures klines and aggregates them to 15m and 1h, so all
three timeframe calculations use one consistent source and UTC boundaries.
"""

from __future__ import annotations

import csv
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "backtest_data"
RESULTS_DIR = ROOT / "backtest_results"
API_URL = "https://fapi.binance.com/fapi/v1/klines"

SYMBOLS = ("BTCUSDT", "XRPUSDT")
BASE_INTERVAL = "5m"
INTERVAL_MS = 5 * 60 * 1000
START_MS = int(datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
# Complete through 2026-07-27 UTC; this avoids including an incomplete current day.
END_MS = int(datetime(2026, 7, 28, tzinfo=timezone.utc).timestamp() * 1000)
TEST_START_MS = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)

# Values broad enough to cover the original default and practical alternatives.
CANDIDATE_LENGTHS = tuple(range(3, 51))
ATR_LENGTH = 200
ATR_SMOOTH_LENGTH = 200
TARGET_ATR_MULTIPLIER = 5.0


def finite(value: float) -> bool:
    return math.isfinite(value)


def utc_text(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def fetch_json(params: dict[str, str | int]) -> list[list[object]]:
    query = urlencode(params)
    request = Request(
        f"{API_URL}?{query}",
        headers={"User-Agent": "TargetTrend-research/1.0"},
    )
    for attempt in range(6):
        try:
            with urlopen(request, timeout=45) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == 5:
                raise RuntimeError(f"Binance request failed after retries: {exc}") from exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("Unreachable")


def cache_path(symbol: str) -> Path:
    return DATA_DIR / f"{symbol}_{BASE_INTERVAL}_{START_MS}_{END_MS}.csv"


def load_cached_5m(symbol: str) -> list[dict[str, float | int]] | None:
    path = cache_path(symbol)
    if not path.exists():
        return None
    rows: list[dict[str, float | int]] = []
    with path.open("r", newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            rows.append(
                {
                    "time": int(row["time"]),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                }
            )
    if rows and rows[0]["time"] == START_MS and rows[-1]["time"] < END_MS:
        return rows
    return None


def save_5m(symbol: str, rows: list[dict[str, float | int]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with cache_path(symbol).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["time", "open", "high", "low", "close"])
        writer.writeheader()
        writer.writerows(rows)


def download_5m(symbol: str) -> list[dict[str, float | int]]:
    cached = load_cached_5m(symbol)
    if cached is not None:
        print(f"{symbol}: using cached {len(cached):,} 5m candles")
        return cached

    rows: list[dict[str, float | int]] = []
    cursor = START_MS
    request_count = 0
    while cursor < END_MS:
        response = fetch_json(
            {
                "symbol": symbol,
                "interval": BASE_INTERVAL,
                "startTime": cursor,
                "endTime": END_MS - 1,
                "limit": 1500,
            }
        )
        if not response:
            break
        request_count += 1
        previous_cursor = cursor
        for item in response:
            open_time = int(item[0])
            if START_MS <= open_time < END_MS:
                rows.append(
                    {
                        "time": open_time,
                        "open": float(item[1]),
                        "high": float(item[2]),
                        "low": float(item[3]),
                        "close": float(item[4]),
                    }
                )
        cursor = int(response[-1][0]) + INTERVAL_MS
        if cursor <= previous_cursor:
            raise RuntimeError(f"Binance pagination did not advance for {symbol}")
        if request_count % 20 == 0:
            print(f"{symbol}: downloaded {len(rows):,} candles through {utc_text(cursor)}")
        time.sleep(0.08)

    rows.sort(key=lambda row: int(row["time"]))
    deduped: list[dict[str, float | int]] = []
    seen: set[int] = set()
    for row in rows:
        timestamp = int(row["time"])
        if timestamp not in seen:
            deduped.append(row)
            seen.add(timestamp)
    if len(deduped) < 100_000:
        raise RuntimeError(f"Unexpectedly short {symbol} dataset: {len(deduped)} rows")
    save_5m(symbol, deduped)
    print(f"{symbol}: saved {len(deduped):,} 5m candles using {request_count} API requests")
    return deduped


def aggregate(rows: list[dict[str, float | int]], interval_minutes: int) -> list[dict[str, float | int]]:
    interval_ms = interval_minutes * 60 * 1000
    output: list[dict[str, float | int]] = []
    current_bucket: int | None = None
    current: dict[str, float | int] | None = None
    bucket_count = 0
    expected_count = interval_minutes // 5

    for row in rows:
        timestamp = int(row["time"])
        bucket = timestamp - (timestamp % interval_ms)
        if bucket != current_bucket:
            if current is not None and bucket_count == expected_count:
                output.append(current)
            current_bucket = bucket
            current = {
                "time": bucket,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
            }
            bucket_count = 1
        else:
            assert current is not None
            current["high"] = max(float(current["high"]), float(row["high"]))
            current["low"] = min(float(current["low"]), float(row["low"]))
            current["close"] = float(row["close"])
            bucket_count += 1
    if current is not None and bucket_count == expected_count:
        output.append(current)
    return output


def rolling_sma(values: list[float], length: int) -> list[float]:
    output = [math.nan] * len(values)
    running = 0.0
    valid = 0
    for index, value in enumerate(values):
        if finite(value):
            running += value
            valid += 1
        if index >= length:
            old = values[index - length]
            if finite(old):
                running -= old
                valid -= 1
        if valid == length:
            output[index] = running / length
    return output


def rma(values: list[float], length: int) -> list[float]:
    """Wilder RMA, matching Pine ta.rma for fully populated OHLC series."""
    output = [math.nan] * len(values)
    if len(values) < length:
        return output
    seed = sum(values[:length]) / length
    output[length - 1] = seed
    previous = seed
    for index in range(length, len(values)):
        previous = ((previous * (length - 1)) + values[index]) / length
        output[index] = previous
    return output


def calculate_atr(rows: list[dict[str, float | int]]) -> list[float]:
    true_ranges: list[float] = []
    previous_close = math.nan
    for row in rows:
        high = float(row["high"])
        low = float(row["low"])
        close = float(row["close"])
        if finite(previous_close):
            true_ranges.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
        else:
            true_ranges.append(high - low)
        previous_close = close
    atr_rma = rma(true_ranges, ATR_LENGTH)
    return rolling_sma(atr_rma, ATR_SMOOTH_LENGTH)


def make_bars(rows: list[dict[str, float | int]]) -> dict[str, list[dict[str, float | int]]]:
    return {
        "5m": rows,
        "15m": aggregate(rows, 15),
        "1h": aggregate(rows, 60),
    }


def simulate(
    rows: list[dict[str, float | int]],
    trend_length: int,
    atr_values: list[float],
    start_filter: int = START_MS,
    end_filter: int = END_MS,
) -> dict[str, int | float]:
    highs = [float(row["high"]) for row in rows]
    lows = [float(row["low"]) for row in rows]
    closes = [float(row["close"]) for row in rows]
    times = [int(row["time"]) for row in rows]
    sma_high_base = rolling_sma(highs, trend_length)
    sma_low_base = rolling_sma(lows, trend_length)

    trend = False
    previous_trend = False
    open_trade: dict[str, float | int | str] | None = None
    counts = {
        "signals": 0,
        "tp": 0,
        "sl": 0,
        "reversal": 0,
        "open_at_end": 0,
        "both_hit_same_bar": 0,
        "entry_count": 0,
    }

    for index in range(len(rows)):
        timestamp = times[index]
        # Do not let a position opened before the evaluation window contaminate
        # train/test results. Trend state itself is intentionally kept warm.
        if timestamp == start_filter and start_filter > START_MS:
            open_trade = None

        if index > 0:
            previous_close = closes[index - 1]
            current_sma_high = sma_high_base[index]
            previous_sma_high = sma_high_base[index - 1]
            current_sma_low = sma_low_base[index]
            previous_sma_low = sma_low_base[index - 1]
            if all(finite(value) for value in (current_sma_high, previous_sma_high)):
                if closes[index] > current_sma_high and previous_close <= previous_sma_high:
                    trend = True
            if all(finite(value) for value in (current_sma_low, previous_sma_low)):
                if closes[index] < current_sma_low and previous_close >= previous_sma_low:
                    trend = False

        signal_up = trend and not previous_trend
        signal_down = (not trend) and previous_trend
        previous_trend = trend
        signal = signal_up or signal_down
        in_window = start_filter <= timestamp < end_filter

        if open_trade is not None and signal and in_window:
            counts["reversal"] += 1
            open_trade = None

        atr = atr_values[index]
        base = sma_low_base[index] if signal_up else sma_high_base[index]
        if signal and in_window and finite(atr) and finite(base):
            entry = closes[index]
            direction = 1.0 if signal_up else -1.0
            open_trade = {
                "direction": direction,
                "entry": entry,
                "sl": base,
                "tp": entry + direction * atr * TARGET_ATR_MULTIPLIER,
                "entry_time": timestamp,
            }
            counts["signals"] += 1
            counts["entry_count"] += 1
            # Entry is at this candle's close; exits begin on the next candle.
            continue

        if open_trade is None or timestamp <= start_filter:
            continue
        if not (start_filter <= timestamp < end_filter):
            continue

        direction = float(open_trade["direction"])
        stop = float(open_trade["sl"])
        take = float(open_trade["tp"])
        high = highs[index]
        low = lows[index]
        hit_stop = low <= stop if direction > 0 else high >= stop
        hit_take = high >= take if direction > 0 else low <= take

        if hit_stop and hit_take:
            # Intrabar order is unknowable from OHLC. Count the conservative SL outcome.
            counts["both_hit_same_bar"] += 1
            counts["sl"] += 1
            open_trade = None
        elif hit_stop:
            counts["sl"] += 1
            open_trade = None
        elif hit_take:
            counts["tp"] += 1
            open_trade = None

    if open_trade is not None:
        counts["open_at_end"] += 1
    resolved = counts["tp"] + counts["sl"]
    counts["resolved"] = resolved
    counts["winrate"] = (counts["tp"] / resolved * 100.0) if resolved else math.nan
    counts["tp_sl_ratio"] = (counts["tp"] / counts["sl"]) if counts["sl"] else math.inf if counts["tp"] else math.nan
    counts["reversal_rate"] = (counts["reversal"] / counts["signals"] * 100.0) if counts["signals"] else math.nan
    return counts


def combine_counts(results: Iterable[dict[str, int | float]]) -> dict[str, int | float]:
    keys = ("signals", "tp", "sl", "reversal", "open_at_end", "both_hit_same_bar", "entry_count")
    combined: dict[str, int | float] = {key: 0 for key in keys}
    for result in results:
        for key in keys:
            combined[key] = int(combined[key]) + int(result[key])
    resolved = int(combined["tp"]) + int(combined["sl"])
    combined["resolved"] = resolved
    combined["winrate"] = int(combined["tp"]) / resolved * 100.0 if resolved else math.nan
    combined["tp_sl_ratio"] = int(combined["tp"]) / int(combined["sl"]) if int(combined["sl"]) else math.nan
    combined["reversal_rate"] = int(combined["reversal"]) / int(combined["signals"]) * 100.0 if int(combined["signals"]) else math.nan
    return combined


def rank_key(row: dict[str, int | float]) -> tuple[float, int, float]:
    # Winrate is primary, but minimum resolved trades and TP-SL separation break ties.
    winrate = float(row["winrate"]) if finite(float(row["winrate"])) else -1.0
    resolved = int(row["resolved"])
    edge = int(row["tp"]) - int(row["sl"])
    return (winrate, resolved, float(edge))


def main() -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    all_bars: dict[str, dict[str, list[dict[str, float | int]]]] = {}
    for symbol in SYMBOLS:
        rows = download_5m(symbol)
        all_bars[symbol] = make_bars(rows)
        print(
            f"{symbol}: {len(all_bars[symbol]['5m']):,} 5m | "
            f"{len(all_bars[symbol]['15m']):,} 15m | {len(all_bars[symbol]['1h']):,} 1h"
        )

    rows_out: list[dict[str, object]] = []
    summary: dict[str, object] = {
        "source": API_URL,
        "market": "Binance USDⓈ-M Futures",
        "symbols": list(SYMBOLS),
        "start_utc": utc_text(START_MS),
        "end_utc_exclusive": utc_text(END_MS),
        "test_start_utc": utc_text(TEST_START_MS),
        "tp_definition": "TP1 = entry +/- ATR(200) smoothed by SMA(200) * 0.8 * 5",
        "sl_definition": "SL = smaLow for LONG / smaHigh for SHORT",
        "same_candle_rule": "If SL and TP are both inside one OHLC candle, count SL conservatively",
        "fees_slippage_funding": "not included; this is TP-versus-SL gross hit-rate",
        "candidate_lengths": list(CANDIDATE_LENGTHS),
        "timeframes": {},
    }

    for timeframe in ("5m", "15m", "1h"):
        per_length: list[dict[str, object]] = []
        atr_by_symbol = {symbol: calculate_atr(all_bars[symbol][timeframe]) for symbol in SYMBOLS}
        for length in CANDIDATE_LENGTHS:
            full_by_symbol: dict[str, dict[str, int | float]] = {}
            train_by_symbol: dict[str, dict[str, int | float]] = {}
            test_by_symbol: dict[str, dict[str, int | float]] = {}
            for symbol in SYMBOLS:
                bars = all_bars[symbol][timeframe]
                atr = atr_by_symbol[symbol]
                full_by_symbol[symbol] = simulate(bars, length, atr, START_MS, END_MS)
                train_by_symbol[symbol] = simulate(bars, length, atr, START_MS, TEST_START_MS)
                test_by_symbol[symbol] = simulate(bars, length, atr, TEST_START_MS, END_MS)
            per_length.append(
                {
                    "timeframe": timeframe,
                    "trend_length": length,
                    "full": combine_counts(full_by_symbol.values()),
                    "train": combine_counts(train_by_symbol.values()),
                    "test": combine_counts(test_by_symbol.values()),
                    "by_symbol_full": full_by_symbol,
                    "by_symbol_test": test_by_symbol,
                }
            )

        best_full = max(per_length, key=lambda row: rank_key(row["full"]))
        eligible_train = [row for row in per_length if int(row["train"]["resolved"]) >= 30]
        best_train = max(eligible_train or per_length, key=lambda row: rank_key(row["train"]))
        stable_candidates = sorted(
            per_length,
            key=lambda row: (
                -float(row["test"]["winrate"]) if finite(float(row["test"]["winrate"])) else math.inf,
                -int(row["test"]["resolved"]),
            ),
        )
        timeframe_summary = {
            "full_sample_best": {
                "trend_length": best_full["trend_length"],
                "metrics": best_full["full"],
            },
            "train_selected_for_oos": {
                "trend_length": best_train["trend_length"],
                "train_metrics": best_train["train"],
                "test_metrics": best_train["test"],
            },
            "best_test_reference": {
                "trend_length": stable_candidates[0]["trend_length"],
                "metrics": stable_candidates[0]["test"],
            },
            "all_lengths": per_length,
        }
        summary["timeframes"][timeframe] = timeframe_summary

        for row in per_length:
            full = row["full"]
            train = row["train"]
            test = row["test"]
            rows_out.append(
                {
                    "timeframe": timeframe,
                    "trend_length": row["trend_length"],
                    "full_signals": full["signals"],
                    "full_tp": full["tp"],
                    "full_sl": full["sl"],
                    "full_reversals": full["reversal"],
                    "full_resolved": full["resolved"],
                    "full_winrate": round(float(full["winrate"]), 4),
                    "train_resolved": train["resolved"],
                    "train_tp": train["tp"],
                    "train_sl": train["sl"],
                    "train_winrate": round(float(train["winrate"]), 4),
                    "test_resolved": test["resolved"],
                    "test_tp": test["tp"],
                    "test_sl": test["sl"],
                    "test_winrate": round(float(test["winrate"]), 4),
                }
            )

        print(
            f"{timeframe}: full best length={best_full['trend_length']} "
            f"({best_full['full']['winrate']:.2f}% on {best_full['full']['resolved']} TP/SL trades); "
            f"train->OOS length={best_train['trend_length']} "
            f"({best_train['test']['winrate']:.2f}% OOS on {best_train['test']['resolved']})"
        )

    with (RESULTS_DIR / "targettrend_length_grid.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows_out[0].keys()))
        writer.writeheader()
        writer.writerows(rows_out)
    with (RESULTS_DIR / "targettrend_length_summary.json").open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2, allow_nan=True)

    print(f"Saved {RESULTS_DIR / 'targettrend_length_grid.csv'}")
    print(f"Saved {RESULTS_DIR / 'targettrend_length_summary.json'}")


if __name__ == "__main__":
    main()
