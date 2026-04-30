import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

type TradingMode = 'demo' | 'live';
type PositionRow = {
  id: number;
  symbol: string;
  positionType: string;
  managementMode: string;
  origin: string | null;
  timeframe: string | null;
  status: string;
  createdAt: Date;
  closedAt: Date | null;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  profitLossPercent: number | null;
  maxProfitPercent: number | null;
  quantity: number;
  tradingMode: string;
};

type OrderHistoryRow = {
  symbol?: string;
  size?: string;
  orderId?: string;
  baseVolume?: string;
  status?: string;
  side?: string;
  orderSource?: string;
  reduceOnly?: string;
  priceAvg?: string;
  cTime?: string;
};

type PlanHistoryRow = {
  symbol?: string;
  size?: string;
  orderId?: string;
  executeOrderId?: string;
  planStatus?: string;
  triggerPrice?: string;
  cTime?: string;
};

type Summary = {
  total: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnl: number;
  medianPnl: number;
  totalPnl: number;
  avgMfe: number;
  avgDurationMin: number;
};

const prisma = new PrismaClient();
const BASE_URL = 'https://api.bitget.com';
const MONITORED_FILES = ['app/api/entry/route.ts', 'app/api/monitor/route.ts'];

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (!arg.startsWith('--')) {
      continue;
    }

    const cleanArg = arg.slice(2);
    const equalIndex = cleanArg.indexOf('=');
    if (equalIndex === -1) {
      parsed[cleanArg] = true;
      continue;
    }

    const key = cleanArg.slice(0, equalIndex);
    const value = cleanArg.slice(equalIndex + 1);
    parsed[key] = value;
  }

  return parsed;
}

function readGitIsoDateForFiles(files: string[]) {
  const output = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...files], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();

  if (!output) {
    throw new Error(`No se encontro commit para ${files.join(', ')}`);
  }

  return output;
}

function toUtcDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Fecha invalida: ${value}`);
  }
  return date;
}

function formatDate(value: Date | null) {
  return value ? value.toISOString() : '-';
}

function sum(values: number[]) {
  return values.reduce((acc, value) => acc + value, 0);
}

function average(values: number[]) {
  return values.length ? sum(values) / values.length : 0;
}

function median(values: number[]) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number, decimals = 3) {
  return Number(value.toFixed(decimals));
}

function buildSummary(rows: PositionRow[]): Summary {
  const closed = rows.filter((row) => row.status === 'closed');
  const open = rows.filter((row) => row.status !== 'closed');
  const pnl = closed.map((row) => Number(row.profitLossPercent || 0));
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value <= 0);
  const durations = closed
    .filter((row) => row.closedAt)
    .map((row) => (row.closedAt!.getTime() - row.createdAt.getTime()) / 60000);
  const mfe = closed.map((row) => Number(row.maxProfitPercent || 0));

  return {
    total: rows.length,
    closed: closed.length,
    open: open.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? round((wins.length * 100) / closed.length, 1) : 0,
    avgPnl: round(average(pnl)),
    medianPnl: round(median(pnl)),
    totalPnl: round(sum(pnl)),
    avgMfe: round(average(mfe)),
    avgDurationMin: round(average(durations), 1),
  };
}

function printSummary(label: string, summary: Summary) {
  console.log(label);
  console.log(
    JSON.stringify(summary, null, 2)
  );
}

function getProductType(symbol: string) {
  if (symbol.endsWith('USDC')) return 'usdc-futures';
  if (symbol.endsWith('USD')) return 'coin-futures';
  return 'usdt-futures';
}

function getBitgetDemoCredentials() {
  const apiKey = process.env.BITGET_DEMO_API_KEY || '';
  const secret = process.env.BITGET_DEMO_SECRET_KEY || '';
  const passphrase = process.env.BITGET_DEMO_PASSPHRASE || '';

  if (!apiKey || !secret || !passphrase) {
    return null;
  }

  return { apiKey, secret, passphrase };
}

async function bitgetSignedGet(endpoint: string, params: Record<string, string>) {
  const credentials = getBitgetDemoCredentials();
  if (!credentials) {
    throw new Error('Credenciales demo de Bitget no disponibles');
  }

  const query = new URLSearchParams(params).toString();
  const requestPath = `${endpoint}?${query}`;
  const timestamp = Date.now().toString();
  const prehash = `${timestamp}GET${requestPath}`;
  const signature = crypto
    .createHmac('sha256', credentials.secret)
    .update(prehash)
    .digest('base64');

  const response = await axios.get(`${BASE_URL}${requestPath}`, {
    timeout: 20000,
    headers: {
      'ACCESS-KEY': credentials.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': credentials.passphrase,
      'Content-Type': 'application/json',
      paptrading: '1',
    },
  });

  return response.data;
}

async function fetchOrderHistory(symbol: string, startTime: Date, endTime: Date) {
  const response = await bitgetSignedGet('/api/v2/mix/order/orders-history', {
    symbol,
    productType: getProductType(symbol),
    startTime: String(startTime.getTime()),
    endTime: String(endTime.getTime()),
    limit: '100',
  });

  return Array.isArray(response?.data?.entrustedList)
    ? (response.data.entrustedList as OrderHistoryRow[])
    : [];
}

async function fetchPlanHistory(symbol: string, startTime: Date, endTime: Date) {
  const response = await bitgetSignedGet('/api/v2/mix/order/orders-plan-history', {
    symbol,
    productType: getProductType(symbol),
    planType: 'normal_plan',
    startTime: String(startTime.getTime()),
    endTime: String(endTime.getTime()),
    limit: '100',
  });

  return Array.isArray(response?.data?.entrustedList)
    ? (response.data.entrustedList as PlanHistoryRow[])
    : [];
}

function buildBucket<T>(rows: T[], keyFn: (row: T) => string, valueFn: (row: T) => number) {
  const map = new Map<string, { count: number; wins: number; total: number }>();

  for (const row of rows) {
    const key = keyFn(row);
    const current = map.get(key) || { count: 0, wins: 0, total: 0 };
    const pnl = valueFn(row);
    current.count += 1;
    current.total += pnl;
    if (pnl > 0) {
      current.wins += 1;
    }
    map.set(key, current);
  }

  return Array.from(map.entries()).map(([key, value]) => ({
    key,
    n: value.count,
    wins: value.wins,
    winRate: round((value.wins * 100) / value.count, 1),
    avgPnl: round(value.total / value.count),
    totalPnl: round(value.total),
  }));
}

async function main() {
  loadDotEnv();
  const args = parseArgs();

  const pivot = args.pivot
    ? toUtcDate(String(args.pivot))
    : toUtcDate(readGitIsoDateForFiles(MONITORED_FILES));
  const rangeStart = args.from ? toUtcDate(String(args.from)) : null;
  const rangeEnd = args.to ? toUtcDate(String(args.to)) : null;
  const tradingMode = (String(args.mode || 'demo') === 'live' ? 'live' : 'demo') as TradingMode;

  const where: Record<string, unknown> = {
    tradingMode,
  };

  if (rangeStart || rangeEnd) {
    where.createdAt = {} as Record<string, Date>;
    if (rangeStart) {
      (where.createdAt as Record<string, Date>).gte = rangeStart;
    }
    if (rangeEnd) {
      (where.createdAt as Record<string, Date>).lte = rangeEnd;
    }
  }

  const positions = (await prisma.position.findMany({
    where: where as any,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      symbol: true,
      positionType: true,
      managementMode: true,
      amount: true,
      quantity: true,
      entryPrice: true,
      requestedEntryPrice: true,
      stopLoss: true,
      takeProfit: true,
      status: true,
      tradingMode: true,
      profitLossPercent: true,
      profitLossFiat: true,
      createdAt: true,
      closedAt: true,
      origin: true,
      timeframe: true,
      commission: true,
      pricePrecision: true,
      maxProfitPercent: true,
      maxProfitAt: true,
    },
  })) as unknown as PositionRow[];

  const before = positions.filter((row) => row.createdAt < pivot);
  const after = positions.filter((row) => row.createdAt >= pivot);
  const afterClosed = after.filter((row) => row.status === 'closed');
  const afterAutoClosed = afterClosed.filter((row) => row.managementMode === 'auto');

  console.log('Analisis de rendimiento');
  console.log(`Pivot UTC: ${pivot.toISOString()}`);
  console.log(`Modo: ${tradingMode}`);
  console.log(`Rango analizado: ${rangeStart ? rangeStart.toISOString() : 'inicio'} -> ${rangeEnd ? rangeEnd.toISOString() : 'fin'}`);
  console.log('');

  printSummary('Antes del cambio', buildSummary(before));
  console.log('');
  printSummary('Despues del cambio', buildSummary(after));
  console.log('');
  printSummary('Antes del cambio | auto', buildSummary(before.filter((row) => row.managementMode === 'auto')));
  console.log('');
  printSummary('Despues del cambio | auto', buildSummary(after.filter((row) => row.managementMode === 'auto')));
  console.log('');
  printSummary('Antes del cambio | self', buildSummary(before.filter((row) => row.managementMode === 'self')));
  console.log('');
  printSummary('Despues del cambio | self', buildSummary(after.filter((row) => row.managementMode === 'self')));

  console.log('');
  console.log('Desglose posterior por dia / modo / origen');
  const groupedAfter = buildBucket(
    afterClosed,
    (row) => `${row.createdAt.toISOString().slice(0, 10)} | ${row.managementMode} | ${row.origin || 'null'}`,
    (row) => Number(row.profitLossPercent || 0)
  );
  console.log(JSON.stringify(groupedAfter, null, 2));

  const tpUpgrades = await prisma.auditLog.findMany({
    where: {
      createdAt: { gte: pivot },
      action: 'position.tp_upgraded_from_signal',
    },
    orderBy: { createdAt: 'asc' },
    select: {
      targetId: true,
      createdAt: true,
      metadata: true,
    },
  });

  console.log('');
  console.log(`Eventos de mejora de TP tras el cambio: ${tpUpgrades.length}`);
  if (tpUpgrades.length > 0) {
    console.log(
      JSON.stringify(
        tpUpgrades.map((row) => ({
          targetId: row.targetId,
          createdAt: row.createdAt.toISOString(),
          symbol: (row.metadata as any)?.symbol || null,
          previousTakeProfit: (row.metadata as any)?.previousTakeProfit ?? null,
          appliedTakeProfit: (row.metadata as any)?.appliedTakeProfit ?? null,
          requestedTakeProfitPercent: (row.metadata as any)?.requestedTakeProfitPercent ?? null,
        })),
        null,
        2
      )
    );
  }

  if (tradingMode !== 'demo') {
    console.log('');
    console.log('El cruce con historial de ordenes de Bitget solo esta implementado para demo en este script.');
    return;
  }

  const credentials = getBitgetDemoCredentials();
  if (!credentials) {
    console.log('');
    console.log('Sin credenciales demo de Bitget: se omite el analisis de protecciones y cierres en exchange.');
    return;
  }

  const startForBitget = new Date(Math.max(pivot.getTime() - 10 * 60 * 1000, positions[0]?.createdAt?.getTime?.() || pivot.getTime()));
  const endForBitget = rangeEnd || new Date();
  const symbols = Array.from(new Set(afterAutoClosed.map((row) => row.symbol)));
  const ordersBySymbol = new Map<string, OrderHistoryRow[]>();
  const plansBySymbol = new Map<string, PlanHistoryRow[]>();

  for (const symbol of symbols) {
    const [orders, plans] = await Promise.all([
      fetchOrderHistory(symbol, startForBitget, endForBitget),
      fetchPlanHistory(symbol, startForBitget, endForBitget),
    ]);
    ordersBySymbol.set(symbol, orders);
    plansBySymbol.set(symbol, plans);
  }

  const protectionRows = afterAutoClosed.map((position) => {
    const expectedCloseSide = position.positionType === 'buy' ? 'sell' : 'buy';
    const orders = ordersBySymbol.get(position.symbol) || [];
    const plans = plansBySymbol.get(position.symbol) || [];

    const closeOrder = orders
      .filter((order) => {
        const baseVolume = Number.parseFloat(String(order.baseVolume || '0'));
        const closeTime = Number.parseInt(String(order.cTime || '0'), 10);
        return (
          String(order.side || '').toLowerCase() === expectedCloseSide &&
          String(order.reduceOnly || '') === 'YES' &&
          Math.abs(baseVolume - position.quantity) < Math.max(0.01, position.quantity * 0.02) &&
          Math.abs(closeTime - (position.closedAt?.getTime() || 0)) <= 20 * 60 * 1000
        );
      })
      .sort((left, right) => {
        const leftDiff = Math.abs(Number.parseInt(String(left.cTime || '0'), 10) - (position.closedAt?.getTime() || 0));
        const rightDiff = Math.abs(Number.parseInt(String(right.cTime || '0'), 10) - (position.closedAt?.getTime() || 0));
        return leftDiff - rightDiff;
      })[0] || null;

    const matchedPlan = plans.find((plan) => {
      const size = Number.parseFloat(String(plan.size || '0'));
      const createdTime = Number.parseInt(String(plan.cTime || '0'), 10);
      return (
        Math.abs(size - position.quantity) < Math.max(0.01, position.quantity * 0.02) &&
        Math.abs(createdTime - position.createdAt.getTime()) <= 20 * 60 * 1000
      );
    }) || null;

    return {
      id: position.id,
      symbol: position.symbol,
      pnl: round(Number(position.profitLossPercent || 0)),
      closeSource: closeOrder?.orderSource || 'none',
      planStatus: matchedPlan?.planStatus || 'none',
      planTrigger: matchedPlan?.triggerPrice || null,
      closePriceAvg: closeOrder?.priceAvg || null,
      createdAt: position.createdAt.toISOString(),
      closedAt: formatDate(position.closedAt),
    };
  });

  console.log('');
  console.log('Analisis posterior de cierres auto y protecciones');
  console.log(JSON.stringify(protectionRows, null, 2));

  const protectionSummary = buildBucket(
    protectionRows,
    (row) => `${row.closeSource} | ${row.planStatus}`,
    (row) => row.pnl
  );
  console.log('');
  console.log('Resumen por tipo de cierre / estado del plan');
  console.log(JSON.stringify(protectionSummary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
