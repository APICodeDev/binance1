'use client';

import Image from 'next/image';
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ShieldCheck, 
  Settings, 
  AlertTriangle, 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  Plus, 
  History, 
  Trash2, 
  RefreshCw,
  Clock,
  ExternalLink,
  BarChart3,
  Bot,
  Zap,
  Globe,
  Hammer,
  Menu,
  CircleHelp,
  ChevronDown,
  ChevronUp,
  Volume2,
  Play
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { apiClient } from '@/lib/apiClient';
import { buildInfo } from '@/lib/buildInfo';
import appLogo from '@/logo1.png';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const AVAILABLE_SYMBOLS = [
  'ADAUSDT',
  'ATOMUSD',
  'AVAXUSDT',
  'DOGEUSDT',
  'ETCUSDT',
  'ETHUSDT',
  'FILUSDT',
  'HBARUSDT',
  'LINKUSDT',
  'LTCUSDT',
  'NEARUSDT',
  'RENDERUSDT',
  'SANDUSDT',
  'SOLUSDT',
  'SUIUSDT',
  'UNIUSDT',
  'XRPUSDT',
];

const BOOKMAP_SYMBOL_STORAGE_KEY = 'bookmap:last-symbol';

// Typing for positions from API
interface Position {
  id: number;
  symbol: string;
  positionType: 'buy' | 'sell';
  amount: number;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  status: 'open' | 'closed';
  tradingMode: 'demo' | 'live';
  profitLossPercent: number;
  profitLossFiat: number;
  createdAt: string;
  closedAt?: string;
  origin?: string | null;
  timeframe?: string | null;
  commission?: number;
  pricePrecision?: number | null;
  maxProfitPercent?: number | null;
  maxProfitAt?: string | null;
}

interface AuthUser {
  id: number;
  email: string;
  username: string | null;
  role: string;
  authType?: 'session' | 'api-token';
}

interface ApiTokenItem {
  id: string;
  name: string;
  lastFour: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
}

interface AuditLogItem {
  id: number;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  user?: {
    email: string;
    username?: string | null;
    role: string;
  } | null;
}

interface AccountOverviewMode {
  summary: Array<{
    accountType: string;
    usdtBalance: number;
    btcBalance: number;
  }>;
  futures: {
    usdt: Array<{
      marginCoin: string;
      available: number;
      locked: number;
      accountEquity: number;
      unrealizedPnl: number;
      crossedMaxAvailable: number;
      maxOpenPosAvailable: number;
    }>;
    usdc: Array<{
      marginCoin: string;
      available: number;
      locked: number;
      accountEquity: number;
      unrealizedPnl: number;
      crossedMaxAvailable: number;
      maxOpenPosAvailable: number;
    }>;
    coin: Array<{
      marginCoin: string;
      available: number;
      locked: number;
      accountEquity: number;
      unrealizedPnl: number;
      crossedMaxAvailable: number;
      maxOpenPosAvailable: number;
    }>;
  };
  spotAssets: Array<{
    coin: string;
    available: number;
    frozen: number;
    total: number;
  }>;
  rawStatus: Record<string, boolean>;
}

interface AccountOverviewPayload {
  demo: AccountOverviewMode;
  live: AccountOverviewMode;
  fetchedAt: string;
}

interface StatsMode {
  closedCount: number;
  successCount: number;
  failedCount: number;
  successPercent: number;
  failedPercent: number;
  profitAmount: number;
  lossAmount: number;
  profitPercent: number;
  lossPercent: number;
  sourceByCount: Array<{
    source: string;
    totalCount: number;
    winCount: number;
    effectivenessPercent: number;
  }>;
  sourceByDuration: Array<{
    source: string;
    totalDurationMs: number;
    winDurationMs: number;
    effectivenessPercent: number;
  }>;
  symbolByWins: Array<{
    symbol: string;
    totalCount: number;
    winCount: number;
    effectivenessPercent: number;
  }>;
  symbolByProfit: Array<{
    symbol: string;
    totalCount: number;
    profitAmount: number;
  }>;
  tradesByWeekday: Array<{
    label: string;
    count: number;
  }>;
  tradesByHour: Array<{
    label: string;
    count: number;
  }>;
}

interface StatsPayload {
  demo: StatsMode;
  live: StatsMode;
  timestamp: string;
}

interface NewPositionForm {
  symbol: string;
  amount: string;
  type: 'buy' | 'sell';
  allowTakerFallback: boolean;
  takerFallbackMode: 'ioc' | 'market';
}

interface BookmapZone {
  price: number;
  totalSize: number;
  totalNotional: number;
  exchangeCount: number;
  exchanges: string[];
  distancePercent: number;
}

interface BookmapSummary {
  symbol: string;
  asOf: number;
  lastPrice: number | null;
  composite: {
    bestBid: number | null;
    bestAsk: number | null;
    mid: number;
    spreadBps: number | null;
  };
  exchanges: Array<{
    exchange: string;
    status: string;
    bestBid: number | null;
    bestAsk: number | null;
    spreadBps: number | null;
    lastUpdateAgeMs: number | null;
    isFresh: boolean;
  }>;
  tape: {
    buyVolume: number;
    sellVolume: number;
    imbalance: number;
    recentTrades: Array<{
      exchange: string;
      price: number;
      size: number;
      side: 'buy' | 'sell';
      timestamp: number;
    }>;
  };
  zones: {
    supports: BookmapZone[];
    resistances: BookmapZone[];
  };
  heatmap: {
    rows: number[];
    columns: number[];
    mids: number[];
    cells: number[][];
    maxIntensity: number;
    step: number;
  };
  heatmapTrades: Array<{
    exchange: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
    columnIndex: number;
    rowIndex: number;
  }>;
  absorptionSignals: Array<{
    side: 'bullish' | 'bearish';
    price: number;
    confidence: number;
    absorbedVolume: number;
    tradeCount: number;
    note: string;
  }>;
  zoneDiagnostics: {
    supports: Array<{
      side: 'support' | 'resistance';
      price: number;
      status: 'stacked' | 'holding' | 'pulling' | 'consumed' | 'fading';
      persistenceScore: number;
      latestIntensity: number;
      averageIntensity: number;
      changePercent: number;
      tradePressure: number;
      ageFrames: number;
      note: string;
    }>;
    resistances: Array<{
      side: 'support' | 'resistance';
      price: number;
      status: 'stacked' | 'holding' | 'pulling' | 'consumed' | 'fading';
      persistenceScore: number;
      latestIntensity: number;
      averageIntensity: number;
      changePercent: number;
      tradePressure: number;
      ageFrames: number;
      note: string;
    }>;
  };
  liquiditySetup: {
    sweep: {
      detected: boolean;
      side: 'long_sweep' | 'short_sweep' | null;
      sweptZonePrice: number | null;
      penetrationPercent: number;
      reclaimPercent: number;
      aggressiveVolume: number;
      liquidityConsumedNotional: number;
      timestamp: number | null;
      notes: string[];
    };
    reversal: {
      confirmed: boolean;
      absorptionStrength: number;
      tapeImbalanceScore: number;
      levelHoldScore: number;
      microStructureShiftScore: number;
      notes: string[];
    };
    target: {
      targetZoneFound: boolean;
      targetZonePrice: number | null;
      targetZoneType: 'sell_liquidity' | 'buy_liquidity' | null;
      targetZoneStrength: number;
      pathClarityScore: number;
      zoneDistanceScore: number;
      pathBlocked: boolean;
      blockingZonePrice: number | null;
      notes: string[];
    };
    economics: {
      entryPrice: number | null;
      stopPrice: number | null;
      targetPrice: number | null;
      targetMovePercent: number;
      riskPercent: number;
      rewardRisk: number | null;
      passesMinTarget: boolean;
      passesMinRR: boolean;
      notes: string[];
    };
    score: {
      sweepScore: number;
      reversalScore: number;
      targetScore: number;
      economicsScore: number;
      finalScore: number;
      probabilityToTarget: number;
    };
    decision: {
      setupType: 'LONG_SWEEP_REVERSAL' | 'SHORT_SWEEP_REVERSAL' | 'NONE';
      state: 'REJECTED' | 'WATCH' | 'CANDIDATE' | 'VALID' | 'EXECUTABLE';
      hardRejectReasons: string[];
      reasons: string[];
    };
  };
  paperCalibration?: {
    sampleSize: number;
    setupWinRate: number | null;
    symbolWinRate: number | null;
    adjustment: number;
    note: string;
  };
  preSignal: {
    actionable: boolean;
    bias: 'long' | 'short' | 'neutral';
    confidence: number;
    entryPrice: number | null;
    stopPrice: number | null;
    targetPrice: number | null;
    rewardRisk: number | null;
    invalidation: string | null;
    mode: 'ready' | 'watch' | 'active' | 'invalidated' | 'replaced';
    reasons: string[];
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    invalidatedAt: number | null;
    invalidationReason: string | null;
  };
  trigger: {
    bias: 'long' | 'short' | 'neutral';
    confidence: number;
    reason: string;
    referencePrice: number | null;
  };
}

interface HeatmapPaperTrade {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  status: 'open' | 'closed';
  tradingMode: 'demo' | 'live';
  confidence: number;
  source: string;
  timeframe: string | null;
  reasons?: string[] | null;
  exitPrice?: number | null;
  exitReason?: string | null;
  profitLossFiat?: number | null;
  profitLossPercent?: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

interface HeatmapPaperPayload {
  mode: 'demo' | 'live';
  open: HeatmapPaperTrade[];
  history: HeatmapPaperTrade[];
  summary: {
    closedCount: number;
    totalPnl: number;
    winCount: number;
    lossCount: number;
  };
  analytics: {
    closedCount: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    targetHits: number;
    stopHits: number;
    averageDurationMs: number;
    symbolPerformance: Array<{
      symbol: string;
      total: number;
      wins: number;
      winRate: number;
      pnl: number;
    }>;
    setupPerformance: Array<{
      setup: string;
      total: number;
      wins: number;
      winRate: number;
      pnl: number;
    }>;
    confidencePerformance: Array<{
      bucket: string;
      total: number;
      wins: number;
      winRate: number;
      pnl: number;
    }>;
  };
}

function formatPrice(value: number, precision?: number | null) {
  return value.toFixed(typeof precision === 'number' ? precision : 4);
}

function formatOpenDuration(createdAt: string) {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatAuditAction(action: string) {
  return action.replace(/\./g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatAuditActor(log: AuditLogItem) {
  if (!log.user) {
    return 'System';
  }

  return log.user.username || log.user.email;
}

function formatAuditMetadata(metadata?: Record<string, unknown> | null) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return 'No extra details';
  }

  return Object.entries(metadata)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' | ');
}

function formatClosedDuration(createdAt: string, closedAt?: string) {
  if (!closedAt) {
    return '-';
  }

  const diffMs = new Date(closedAt).getTime() - new Date(createdAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export default function Dashboard() {
  const [currentView, setCurrentView] = useState<'dashboard' | 'admin' | 'stats'>('dashboard');
  const [showMenu, setShowMenu] = useState(false);
  const [openPositions, setOpenPositions] = useState<Position[]>([]);
  const [closedPositions, setClosedPositions] = useState<Position[]>([]);
  const [botEnabled, setBotEnabled] = useState(true);
  const [tradingMode, setTradingMode] = useState<'demo' | 'live'>('demo');
  const [customAmount, setCustomAmount] = useState('');
  const [leverageEnabled, setLeverageEnabled] = useState(false);
  const [leverageValue, setLeverageValue] = useState('1');
  const [apiStopMode, setApiStopMode] = useState<'signal' | 'legacy'>('signal');
  const [showLeverageHelp, setShowLeverageHelp] = useState(false);
  const [isPhonePortrait, setIsPhonePortrait] = useState(false);
  const [tradeLogsExpanded, setTradeLogsExpanded] = useState(true);
  const [bookmapExpanded, setBookmapExpanded] = useState(true);
  const [profitSoundEnabled, setProfitSoundEnabled] = useState(false);
  const [profitSoundFile, setProfitSoundFile] = useState('');
  const [exhaustionGuardEnabled, setExhaustionGuardEnabled] = useState(false);
  const [availableSounds, setAvailableSounds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [newPos, setNewPos] = useState<NewPositionForm>({
    symbol: '',
    amount: '100',
    type: 'buy',
    allowTakerFallback: true,
    takerFallbackMode: 'market',
  });
  const [showSymbolOptions, setShowSymbolOptions] = useState(false);
  const [totalPnl, setTotalPnl] = useState(0);
  const [showSplash, setShowSplash] = useState(true);
  const [showEjectModal, setShowEjectModal] = useState<Position | null>(null);
  const [lastEntryError, setLastEntryError] = useState<{timestamp: string; symbol: string; type: string; detail: string} | null>(null);
  const [hiddenEntryErrorKey, setHiddenEntryErrorKey] = useState<string | null>(null);
  const [errorPopup, setErrorPopup] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [mobileTokenInput, setMobileTokenInput] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loginMode, setLoginMode] = useState<'account' | 'token'>('account');
  const [apiTokens, setApiTokens] = useState<ApiTokenItem[]>([]);
  const [tokenName, setTokenName] = useState('');
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenSubmitting, setTokenSubmitting] = useState(false);
  const [tokenMessage, setTokenMessage] = useState<string | null>(null);
  const [newTokenValue, setNewTokenValue] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditMessage, setAuditMessage] = useState<string | null>(null);
  const [accountOverview, setAccountOverview] = useState<AccountOverviewPayload | null>(null);
  const [accountOverviewLoading, setAccountOverviewLoading] = useState(false);
  const [accountOverviewMessage, setAccountOverviewMessage] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [syncStatusLabel, setSyncStatusLabel] = useState<'live' | 'paused' | 'offline'>('live');
  const [statsData, setStatsData] = useState<StatsPayload | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsMessage, setStatsMessage] = useState<string | null>(null);
  const [bookmapSymbol, setBookmapSymbol] = useState('ETHUSDT');
  const [bookmapData, setBookmapData] = useState<BookmapSummary | null>(null);
  const [bookmapLoading, setBookmapLoading] = useState(false);
  const [bookmapMessage, setBookmapMessage] = useState<string | null>(null);
  const [executingHeatmapSignal, setExecutingHeatmapSignal] = useState(false);
  const [creatingHeatmapPaper, setCreatingHeatmapPaper] = useState(false);
  const [heatmapPaperData, setHeatmapPaperData] = useState<HeatmapPaperPayload | null>(null);
  const [heatmapPaperMessage, setHeatmapPaperMessage] = useState<string | null>(null);

  const filteredSymbols = AVAILABLE_SYMBOLS.filter((symbol) =>
    symbol.includes(newPos.symbol.toUpperCase())
  );
  const recentClosedPositions = closedPositions.slice(0, 15);
  const lastSeenClosedIdRef = useRef<number | null>(null);
  const lastBookmapSignalKeyRef = useRef<string | null>(null);

  const resetSessionState = useCallback(() => {
    apiClient.setApiToken(null);
    setAuthUser(null);
    setOpenPositions([]);
    setClosedPositions([]);
    setApiTokens([]);
    setNewTokenValue(null);
    setAuditLogs([]);
  }, []);

  const getApiErrorMessage = useCallback((error: unknown, fallback: string) => {
    if (apiClient.isAuthError(error)) {
      resetSessionState();
      return 'Your session is no longer valid. Please sign in again.';
    }

    return apiClient.getErrorMessage(error, fallback);
  }, [resetSessionState]);

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 4100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const updateNetworkState = () => {
      const online = window.navigator.onLine;
      setIsOnline(online);
      setSyncStatusLabel(online ? (document.visibilityState === 'visible' ? 'live' : 'paused') : 'offline');
    };

    const updateVisibilityState = () => {
      const visible = document.visibilityState === 'visible';
      setIsDocumentVisible(visible);
      setSyncStatusLabel(window.navigator.onLine ? (visible ? 'live' : 'paused') : 'offline');
    };

    updateNetworkState();
    updateVisibilityState();

    window.addEventListener('online', updateNetworkState);
    window.addEventListener('offline', updateNetworkState);
    document.addEventListener('visibilitychange', updateVisibilityState);

    return () => {
      window.removeEventListener('online', updateNetworkState);
      window.removeEventListener('offline', updateNetworkState);
      document.removeEventListener('visibilitychange', updateVisibilityState);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const savedBookmapSymbol = window.localStorage.getItem(BOOKMAP_SYMBOL_STORAGE_KEY);
    if (savedBookmapSymbol && AVAILABLE_SYMBOLS.includes(savedBookmapSymbol)) {
      setBookmapSymbol(savedBookmapSymbol);
    }

    const updateTradeLogsLayout = () => {
      const phonePortrait = window.innerWidth < 768 && window.innerHeight > window.innerWidth;
      setIsPhonePortrait(phonePortrait);
      setTradeLogsExpanded(!phonePortrait);
    };

    updateTradeLogsLayout();
    window.addEventListener('resize', updateTradeLogsLayout);
    return () => window.removeEventListener('resize', updateTradeLogsLayout);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !bookmapSymbol) {
      return;
    }

    window.localStorage.setItem(BOOKMAP_SYMBOL_STORAGE_KEY, bookmapSymbol);
  }, [bookmapSymbol]);

  const fetchAuth = useCallback(async () => {
    setAuthLoading(true);
    try {
      const payload = await apiClient.authMe();
      const user = payload.data?.user || null;
      setAuthUser(user ? { ...user, authType: payload.data?.authType } : null);
      return true;
    } catch (error) {
      resetSessionState();
      return false;
    } finally {
      setAuthLoading(false);
    }
  }, [resetSessionState]);

  const fetchApiTokens = useCallback(async () => {
    if (authUser?.role !== 'admin') {
      setApiTokens([]);
      return;
    }

    setTokenLoading(true);
    try {
      const payload = await apiClient.getApiTokens();
      setApiTokens(payload.data?.tokens || []);
    } catch (error) {
      setTokenMessage(getApiErrorMessage(error, 'Unable to load API tokens'));
    } finally {
      setTokenLoading(false);
    }
  }, [authUser, getApiErrorMessage]);

  const fetchAuditLogs = useCallback(async () => {
    if (authUser?.role !== 'admin') {
      setAuditLogs([]);
      return;
    }

    setAuditLoading(true);
    try {
      const payload = await apiClient.getAuditLogs(30);
      setAuditLogs(payload.data?.logs || []);
    } catch (error) {
      setAuditMessage(getApiErrorMessage(error, 'Unable to load audit logs'));
    } finally {
      setAuditLoading(false);
    }
  }, [authUser, getApiErrorMessage]);

  const fetchAccountOverview = useCallback(async () => {
    if (authUser?.role !== 'admin') {
      setAccountOverview(null);
      return;
    }

    setAccountOverviewLoading(true);
    try {
      const payload = await apiClient.getAccountOverview();
      setAccountOverview(payload.data || null);
      setAccountOverviewMessage(null);
    } catch (error) {
      setAccountOverviewMessage(getApiErrorMessage(error, 'Unable to load account overview'));
    } finally {
      setAccountOverviewLoading(false);
    }
  }, [authUser, getApiErrorMessage]);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const payload = await apiClient.getStats();
      setStatsData(payload.data || null);
      setStatsMessage(null);
    } catch (error) {
      setStatsMessage(getApiErrorMessage(error, 'Unable to load statistics'));
    } finally {
      setStatsLoading(false);
    }
  }, [getApiErrorMessage]);

  const fetchBookmap = useCallback(async (symbol: string, isSilent = false) => {
    if (!isSilent) {
      setBookmapLoading(true);
    }

    try {
      const payload = await apiClient.getBookmap(symbol);
      setBookmapData(payload.data || null);
      setBookmapMessage(null);
    } catch (error) {
      setBookmapMessage(getApiErrorMessage(error, 'Unable to load bookmap summary'));
    } finally {
      if (!isSilent) {
        setBookmapLoading(false);
      }
    }
  }, [getApiErrorMessage]);

  const fetchHeatmapPaper = useCallback(async () => {
    try {
      const payload = await apiClient.getHeatmapPaper();
      setHeatmapPaperData(payload.data || null);
      setHeatmapPaperMessage(null);
    } catch (error) {
      setHeatmapPaperMessage(getApiErrorMessage(error, 'Unable to load Heatmap paper tracking'));
    }
  }, [getApiErrorMessage]);

  const fetchSounds = useCallback(async () => {
    try {
      const payload = await apiClient.getSounds();
      setAvailableSounds(payload.data?.files || []);
    } catch {
      setAvailableSounds([]);
    }
  }, []);

  const fetchData = useCallback(async (isSilent = false, overrideMode?: 'demo' | 'live') => {
    if (!isSilent) setLoading(true);
    const modeToUse = overrideMode || tradingMode;
    try {
      // Fetch positions with mode filter
      const data = await apiClient.getPositions(modeToUse);
      setOpenPositions(data.open || []);
      setClosedPositions(data.history || []);
      setTotalPnl(data.totalPnl || 0);

      // Fetch bot status and global mode
      const settings = await apiClient.getSettings();
      setBotEnabled(settings.bot_enabled === '1');
      setCustomAmount(settings.custom_amount || '');
      setTradingMode(settings.trading_mode || 'demo');
      setLeverageEnabled(settings.leverage_enabled === '1');
      setLeverageValue(settings.leverage_value || '1');
      setApiStopMode(settings.api_stop_mode === 'legacy' ? 'legacy' : 'signal');
      setProfitSoundEnabled(settings.profit_sound_enabled === '1');
      setProfitSoundFile(settings.profit_sound_file || '');
      setExhaustionGuardEnabled(settings.exhaustion_guard_enabled === '1');
      
      // Parse last entry error
      if (settings.last_entry_error) {
        try {
          const parsed = JSON.parse(settings.last_entry_error);
          setLastEntryError(parsed);
          const nextKey = `${parsed.timestamp}-${parsed.symbol}-${parsed.type}-${parsed.detail}`;
          setHiddenEntryErrorKey((current) => current === nextKey ? current : null);
        } catch { setLastEntryError(null); }
      } else {
        setLastEntryError(null);
        setHiddenEntryErrorKey(null);
      }
      setLastSyncAt(new Date().toISOString());
    } catch (error) {
      if (apiClient.isAuthError(error)) {
        resetSessionState();
        return;
      }
      console.error('Fetch error:', error);
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [resetSessionState, tradingMode]);

  const runMonitor = useCallback(async () => {
    if (!isOnline || !isDocumentVisible) {
      setSyncStatusLabel(isOnline ? 'paused' : 'offline');
      return;
    }

    setSyncing(true);
    setSyncStatusLabel('live');
    try {
      await apiClient.runMonitor();
      await fetchData(true);
    } catch (error) {
      console.error('Monitor sync error:', error);
    } finally {
      setSyncing(false);
    }
  }, [fetchData]);

  // Initial load and polling
  useEffect(() => {
    fetchAuth();
  }, [fetchAuth]);

  useEffect(() => {
    if (!authUser) {
      return;
    }

    fetchData();
    fetchApiTokens();
    fetchAuditLogs();
    fetchAccountOverview();
    fetchStats();

    if (!isOnline || !isDocumentVisible) {
      return;
    }

    const interval = setInterval(() => {
      runMonitor();
    }, 10000); 
    return () => clearInterval(interval);
  }, [authUser, fetchApiTokens, fetchAuditLogs, fetchAccountOverview, fetchData, fetchStats, isDocumentVisible, isOnline, runMonitor]);

  useEffect(() => {
    if (!authUser) {
      return;
    }

    fetchSounds();
  }, [authUser, fetchSounds]);

  useEffect(() => {
    if (!authUser || !isOnline || !isDocumentVisible) {
      return;
    }

    fetchData(true);
  }, [authUser, fetchData, isDocumentVisible, isOnline]);

  useEffect(() => {
    if (!authUser || !bookmapSymbol) {
      return;
    }

    fetchBookmap(bookmapSymbol);
    fetchHeatmapPaper();
  }, [authUser, bookmapSymbol, fetchBookmap, fetchHeatmapPaper]);

  useEffect(() => {
    if (!authUser || !isOnline || !isDocumentVisible || currentView !== 'dashboard' || !bookmapSymbol) {
      return;
    }

    const interval = setInterval(() => {
      fetchBookmap(bookmapSymbol, true);
      fetchHeatmapPaper();
    }, 4000);

    return () => clearInterval(interval);
  }, [authUser, bookmapSymbol, currentView, fetchBookmap, fetchHeatmapPaper, isDocumentVisible, isOnline]);

  useEffect(() => {
    if (!authUser) {
      return;
    }

    const latestClosed = closedPositions[0];
    if (!latestClosed) {
      lastSeenClosedIdRef.current = null;
      return;
    }

    if (lastSeenClosedIdRef.current === null) {
      lastSeenClosedIdRef.current = latestClosed.id;
      return;
    }

    if (
      latestClosed.id !== lastSeenClosedIdRef.current &&
      profitSoundEnabled &&
      profitSoundFile &&
      latestClosed.profitLossFiat > 0
    ) {
      const audio = new Audio(`/sounds/${encodeURIComponent(profitSoundFile)}`);
      audio.volume = 0.9;
      audio.play().catch(() => undefined);
    }

    lastSeenClosedIdRef.current = latestClosed.id;
  }, [authUser, closedPositions, profitSoundEnabled, profitSoundFile]);

  useEffect(() => {
    if (!authUser || !bookmapData?.preSignal) {
      return;
    }

    const signal = bookmapData.preSignal;
    const signalKey = signal.actionable
      ? `${bookmapData.symbol}-${signal.bias}-${signal.createdAt}-${signal.entryPrice || 0}`
      : null;

    if (!signalKey) {
      lastBookmapSignalKeyRef.current = null;
      return;
    }

    if (
      signal.actionable &&
      lastBookmapSignalKeyRef.current !== signalKey &&
      profitSoundEnabled &&
      profitSoundFile
    ) {
      const audio = new Audio(`/sounds/${encodeURIComponent(profitSoundFile)}`);
      audio.volume = 0.9;
      audio.play().catch(() => undefined);
    }

    lastBookmapSignalKeyRef.current = signalKey;
  }, [authUser, bookmapData, profitSoundEnabled, profitSoundFile]);

  const submitLogin = async () => {
    setLoginSubmitting(true);
    setLoginError(null);
    try {
      const payload = await apiClient.login(loginIdentifier, loginPassword);
      apiClient.setApiToken(null);
      setAuthUser(payload.data?.user ? { ...payload.data.user, authType: payload.data?.authType } : null);
      setLoginPassword('');
    } catch (error) {
      setLoginError(getApiErrorMessage(error, 'Network error during login'));
    } finally {
      setLoginSubmitting(false);
    }
  };

  const submitTokenLogin = async () => {
    const token = mobileTokenInput.trim();
    if (!token) {
      setLoginError('Paste a valid API token first');
      return;
    }

    setLoginSubmitting(true);
    setLoginError(null);
    try {
      apiClient.setApiToken(token);
      const ok = await fetchAuth();
      if (!ok) {
        apiClient.setApiToken(null);
        setLoginError('Token invalid, expired or revoked');
        return;
      }
      setMobileTokenInput('');
    } catch (error) {
      apiClient.setApiToken(null);
      setLoginError(getApiErrorMessage(error, 'Unable to authenticate with token'));
    } finally {
      setLoginSubmitting(false);
    }
  };

  const logout = async () => {
    await apiClient.logout();
    setCurrentView('dashboard');
    setShowMenu(false);
    resetSessionState();
  };

  const toggleBot = async () => {
    const newValue = botEnabled ? '0' : '1';
    try {
      await apiClient.updateSettings({ bot_enabled: newValue });
      setBotEnabled(!botEnabled);
    } catch (error) {
      console.error('Toggle bot error:', error);
      setErrorPopup(getApiErrorMessage(error, 'Unable to update bot status.'));
    }
  };

  const toggleMode = async () => {
    const newMode = tradingMode === 'demo' ? 'live' : 'demo';
    if (newMode === 'live' && !confirm('⚠️ ATENCIÓN: Activarás el modo EN VIVO. El bot operará con DINERO REAL. ¿Deseas continuar?')) {
      return;
    }
    try {
      await apiClient.updateSettings({ trading_mode: newMode });
      setTradingMode(newMode);
      // Refetch immediately for the new mode
      fetchData(false, newMode);
    } catch (error) {
      console.error('Toggle mode error:', error);
      setErrorPopup(getApiErrorMessage(error, 'Unable to switch trading mode.'));
    }
  };

  const saveCustomAmount = async (val: string) => {
    setCustomAmount(val);
    try {
      await apiClient.updateSettings({ custom_amount: val });
    } catch (error) {
      console.error('Save custom amount error:', error);
      setErrorPopup(getApiErrorMessage(error, 'Unable to save custom amount.'));
    }
  };

  const toggleLeverage = async () => {
    const nextValue = !leverageEnabled;
    try {
      await apiClient.updateSettings({ leverage_enabled: nextValue ? '1' : '0' });
      setLeverageEnabled(nextValue);
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'Unable to update leverage mode.'));
    }
  };

  const saveLeverageValue = async (val: string) => {
    setLeverageValue(val);
    try {
      await apiClient.updateSettings({ leverage_value: val || '1' });
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'Unable to save leverage value.'));
    }
  };

  const toggleApiStopMode = async () => {
    const nextMode = apiStopMode === 'signal' ? 'legacy' : 'signal';
    try {
      await apiClient.updateSettings({ api_stop_mode: nextMode });
      setApiStopMode(nextMode);
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'Unable to update API stop mode.'));
    }
  };

  const toggleProfitSound = async () => {
    const nextValue = !profitSoundEnabled;
    try {
      await apiClient.updateSettings({ profit_sound_enabled: nextValue ? '1' : '0' });
      setProfitSoundEnabled(nextValue);
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'Unable to update profit sound.'));
    }
  };

  const saveProfitSoundFile = async (val: string) => {
    setProfitSoundFile(val);
    try {
      await apiClient.updateSettings({ profit_sound_file: val });
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'Unable to save profit sound.'));
    }
  };

  const previewProfitSound = () => {
    if (!profitSoundFile) {
      setErrorPopup('Select a sound first.');
      return;
    }

    const audio = new Audio(`/sounds/${encodeURIComponent(profitSoundFile)}`);
    audio.volume = 0.9;
    audio.play().catch(() => {
      setErrorPopup('Unable to play the selected sound.');
    });
  };

  const toggleExhaustionGuard = async () => {
    const nextValue = !exhaustionGuardEnabled;
    try {
      await apiClient.updateSettings({ exhaustion_guard_enabled: nextValue ? '1' : '0' });
      setExhaustionGuardEnabled(nextValue);
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'Unable to update exhaustion guard.'));
    }
  };

  const submitNewPosition = async () => {
    try {
      await apiClient.openPosition(newPos);
      setShowModal(false);
      setNewPos({
        symbol: '',
        amount: '100',
        type: 'buy',
        allowTakerFallback: true,
        takerFallbackMode: 'market',
      });
      fetchData();
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'Error de red al intentar abrir la posicion.'));
    }
  };

  const executeHeatmapPreSignal = async () => {
    if (!bookmapData?.preSignal.actionable || bookmapData.preSignal.bias === 'neutral') {
      return;
    }

    const entryType = bookmapData.preSignal.bias === 'long' ? 'buy' : 'sell';
    const confirmed = confirm(
      `Vas a enviar una entrada ${entryType.toUpperCase()} desde Heatmap para ${bookmapSymbol}.\n\n` +
      `Entry: ${bookmapData.preSignal.entryPrice?.toFixed(4) || '-'}\n` +
      `Stop: ${bookmapData.preSignal.stopPrice?.toFixed(4) || '-'}\n` +
      `Target: ${bookmapData.preSignal.targetPrice?.toFixed(4) || '-'}\n` +
      `R/R: ${bookmapData.preSignal.rewardRisk?.toFixed(2) || '-'}`
    );

    if (!confirmed) {
      return;
    }

    setExecutingHeatmapSignal(true);
    try {
      await apiClient.openPosition({
        symbol: bookmapSymbol,
        amount: customAmount || '100',
        type: entryType,
        origin: 'Heatmap',
        timeframe: 'OrderBook',
        stopPrice: bookmapData.preSignal.stopPrice,
        allowTakerFallback: true,
        takerFallbackMode: 'market',
      });
      await fetchData();
      await fetchBookmap(bookmapSymbol, true);
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'No se pudo ejecutar la pre-senal Heatmap.'));
    } finally {
      setExecutingHeatmapSignal(false);
    }
  };

  const trackHeatmapPreSignalOnPaper = async () => {
    if (!bookmapData?.preSignal.actionable || bookmapData.preSignal.bias === 'neutral') {
      return;
    }

    setCreatingHeatmapPaper(true);
    try {
      await apiClient.createHeatmapPaper({
        symbol: bookmapSymbol,
        side: bookmapData.preSignal.bias === 'long' ? 'buy' : 'sell',
        amount: customAmount || '100',
        entryPrice: bookmapData.preSignal.entryPrice,
        stopPrice: bookmapData.preSignal.stopPrice,
        targetPrice: bookmapData.preSignal.targetPrice,
        confidence: bookmapData.preSignal.confidence,
        reasons: bookmapData.preSignal.reasons,
      });
      await fetchHeatmapPaper();
    } catch (error) {
      setErrorPopup(getApiErrorMessage(error, 'No se pudo registrar el paper trade Heatmap.'));
    } finally {
      setCreatingHeatmapPaper(false);
    }
  };

  const manualEject = (pos: Position) => {
    setShowEjectModal(pos);
  };

  const confirmManualEject = async () => {
    if (!showEjectModal) return;
    const { id } = showEjectModal;
    try {
      await apiClient.closePosition(id);
      setShowEjectModal(null);
      fetchData();
    } catch (error) {
      console.error('Manual eject error:', error);
      alert(getApiErrorMessage(error, 'Network error ejecting'));
    }
  };

  const emergencyCloseAll = async () => {
    if (confirm('⚠️ ERES CONSCIENTE DE QUE ESTO CERRARÁ TODAS LAS POSICIONES (REALES Y DEMO)?')) {
      try {
        await apiClient.emergencyClose();
        fetchData();
      } catch (error) {
        alert(getApiErrorMessage(error, 'Error in emergency stop'));
      }
    }
  };

  const clearHistory = async () => {
    if (confirm(`Are you sure you want to clear ${tradingMode.toUpperCase()} history and set Net Profit to zero?`)) {
      try {
        await apiClient.clearHistory(tradingMode);
        fetchData();
      } catch (error) {
        alert(getApiErrorMessage(error, 'Error clearing history'));
      }
    }
  };

  const createApiToken = async () => {
    const name = tokenName.trim();
    if (!name) {
      setTokenMessage('Please add a token name first');
      return;
    }

    setTokenSubmitting(true);
    setTokenMessage(null);
    setNewTokenValue(null);
    try {
      const payload = await apiClient.createApiToken(name);
      setNewTokenValue(payload.data?.token?.value || null);
      setTokenName('');
      setTokenMessage('New iOS token created. Copy it now because it will not be shown again.');
      await fetchApiTokens();
    } catch (error) {
      setTokenMessage(getApiErrorMessage(error, 'Unable to create token'));
    } finally {
      setTokenSubmitting(false);
    }
  };

  const revokeApiToken = async (id: string) => {
    if (!confirm('This will revoke the token immediately. Continue?')) {
      return;
    }

    setTokenMessage(null);
    try {
      await apiClient.revokeApiToken(id);
      setTokenMessage('Token revoked');
      await fetchApiTokens();
    } catch (error) {
      setTokenMessage(getApiErrorMessage(error, 'Unable to revoke token'));
    }
  };

  const totalSecuredProfit = openPositions.reduce((acc, pos) => {
    const isBuy = pos.positionType === 'buy';
    const comm = pos.commission ?? 0.0006;
    const isSafe = (isBuy && pos.stopLoss > pos.entryPrice) || (!isBuy && pos.stopLoss < pos.entryPrice);
    if (isSafe) {
      const entryCost = pos.entryPrice * pos.quantity * comm;
      const exitCost = pos.stopLoss * pos.quantity * comm;
      const secured = isBuy 
        ? ((pos.stopLoss - pos.entryPrice) * pos.quantity) - entryCost - exitCost
        : ((pos.entryPrice - pos.stopLoss) * pos.quantity) - entryCost - exitCost;
      return acc + Math.max(0, secured);
    }
    return acc;
  }, 0);

  if (showSplash) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-slate-50 relative overflow-hidden">
        <motion.div
           initial={{ opacity: 0, scale: 0.9, filter: "blur(10px)" }}
           animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
           transition={{ duration: 2, ease: "easeOut" }}
           className="flex flex-col items-center"
        >
          <motion.div
            animate={{ y: [0, -15, 0], scale: [1, 1.05, 1] }}
            transition={{ duration: 1, ease: "easeInOut", repeat: Infinity }}
            className="mb-5 drop-shadow-[0_0_24px_rgba(251,191,36,0.25)]"
          >
            <Image src={appLogo} alt="Bitget Desk" className="w-[100px] h-[100px] object-contain" priority />
          </motion.div>
          <h1 className="text-[40px] font-black tracking-[2px] m-0">BITGET<span className="text-amber-400">DESK</span></h1>
          <div className="mt-2.5 text-base text-slate-400 tracking-[4px] uppercase">Signal Engine Initializing</div>
        </motion.div>
      </div>
    );
  }

  if (authLoading) {
    return <div className="min-h-screen bg-slate-950" />;
  }

  if (!authUser) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-50 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-[2rem] p-8 shadow-2xl">
          <div className="flex flex-col items-center text-center gap-4 mb-8">
            <Image src={appLogo} alt="Bitget Desk" className="w-20 h-20 object-contain" priority />
            <div>
              <h1 className="text-3xl font-black uppercase tracking-tight">Bitget Desk</h1>
              <p className="text-xs text-slate-400 uppercase tracking-[0.25em] mt-2">Secure Dashboard Access</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-slate-800 bg-slate-950/60 p-1">
              <button
                type="button"
                onClick={() => {
                  setLoginMode('account');
                  setLoginError(null);
                }}
                className={cn(
                  "rounded-2xl px-3 py-3 text-xs font-black uppercase tracking-[0.2em] transition-colors",
                  loginMode === 'account' ? "bg-amber-400 text-slate-950" : "text-slate-400"
                )}
              >
                Account
              </button>
              <button
                type="button"
                onClick={() => {
                  setLoginMode('token');
                  setLoginError(null);
                }}
                className={cn(
                  "rounded-2xl px-3 py-3 text-xs font-black uppercase tracking-[0.2em] transition-colors",
                  loginMode === 'token' ? "bg-cyan-400 text-slate-950" : "text-slate-400"
                )}
              >
                iOS Token
              </button>
            </div>

            {loginMode === 'account' ? (
              <>
                <input
                  type="text"
                  placeholder="Email or username"
                  value={loginIdentifier}
                  onChange={(e) => setLoginIdentifier(e.target.value)}
                  className="w-full bg-slate-950/50 border border-slate-700 p-4 rounded-2xl outline-none focus:border-amber-400 transition-colors placeholder:text-slate-700 font-black"
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  className="w-full bg-slate-950/50 border border-slate-700 p-4 rounded-2xl outline-none focus:border-amber-400 transition-colors placeholder:text-slate-700 font-black"
                />
              </>
            ) : (
              <div className="space-y-3">
                <textarea
                  placeholder="Paste your mobile API token"
                  value={mobileTokenInput}
                  onChange={(e) => setMobileTokenInput(e.target.value)}
                  rows={4}
                  className="w-full resize-none bg-slate-950/50 border border-slate-700 p-4 rounded-2xl outline-none focus:border-cyan-400 transition-colors placeholder:text-slate-700 font-mono text-sm text-slate-100"
                />
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Use this mode in your future iPhone app. Tokens are revocable from the dashboard and stop working immediately if revoked or expired.
                </p>
              </div>
            )}
            {loginError && (
              <div className="px-4 py-3 rounded-2xl bg-rose-950/40 border border-rose-800/40 text-sm text-rose-300">
                {loginError}
              </div>
            )}
            <button
              onClick={loginMode === 'account' ? submitLogin : submitTokenLogin}
              disabled={loginSubmitting}
              className={cn(
                "w-full p-4 rounded-2xl font-black shadow-lg disabled:opacity-60",
                loginMode === 'account'
                  ? "bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-amber-400/20"
                  : "bg-cyan-400 hover:bg-cyan-300 text-slate-950 shadow-cyan-400/20"
              )}
            >
              {loginSubmitting ? 'SIGNING IN...' : loginMode === 'account' ? 'SIGN IN' : 'ENTER WITH TOKEN'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "min-h-screen transition-all duration-1000",
      tradingMode === 'live' ? "bg-rose-950/20" : "bg-transparent"
    )}>
      <div className="mx-auto w-full max-w-[1720px] space-y-8 p-4 md:p-8 xl:px-10 2xl:px-12">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowMenu((current) => !current)}
              className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
            >
              <Menu size={18} />
            </button>
            <div className="text-[11px] font-black uppercase tracking-[0.25em] text-slate-500">
              {currentView === 'dashboard' ? 'Main Dashboard' : currentView === 'stats' ? 'Statistics' : 'Admin Center'}
            </div>
          </div>
          {showMenu && (
            <div className="grid w-full grid-cols-1 gap-2 rounded-2xl border border-slate-800 bg-slate-900/95 px-2 py-2 shadow-xl shadow-slate-950/30 sm:w-auto sm:grid-cols-3 sm:items-center">
              <button
                type="button"
                onClick={() => {
                  setCurrentView('dashboard');
                  setShowMenu(false);
                }}
                className={cn(
                  "rounded-xl px-4 py-3 text-[11px] font-black uppercase tracking-[0.2em] transition-colors",
                  currentView === 'dashboard' ? "bg-amber-400 text-slate-950" : "text-slate-300 hover:text-white"
                )}
                >
                  Dashboard
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCurrentView('stats');
                    setShowMenu(false);
                  }}
                  className={cn(
                    "rounded-xl px-4 py-3 text-[11px] font-black uppercase tracking-[0.2em] transition-colors",
                    currentView === 'stats' ? "bg-emerald-400 text-slate-950" : "text-slate-300 hover:text-white"
                  )}
                >
                  Statistics
                </button>
              {authUser.role === 'admin' && (
                <button
                  type="button"
                  onClick={() => {
                    setCurrentView('admin');
                    setShowMenu(false);
                  }}
                  className={cn(
                    "rounded-xl px-4 py-3 text-[11px] font-black uppercase tracking-[0.2em] transition-colors",
                    currentView === 'admin' ? "bg-cyan-400 text-slate-950" : "text-slate-300 hover:text-white"
                  )}
                >
                  Admin
                </button>
              )}
            </div>
          )}
        </div>

        {/* Header */}
        <header className="flex flex-col gap-5 border-b border-slate-800 pb-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <div className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center shadow-lg shadow-inner rotate-3 transition-colors",
                tradingMode === 'live' ? "bg-amber-500 shadow-amber-500/20" : "bg-amber-400 shadow-amber-400/20"
              )}>
                <Image src={appLogo} alt="Bitget Desk" className="w-7 h-7 object-contain" priority />
              </div>
              <div>
                <h1 className="text-3xl font-black italic tracking-tighter uppercase">
                  {tradingMode === 'live' ? (
                    <>BITGET<span className="text-amber-500">LIVE</span></>
                  ) : (
                    <>BITGET<span className="text-amber-400">SIGNALS</span></>
                  )}
                </h1>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-[0.2em]">Automated trading command center for Bitget Futures</p>
                  <span className="px-2 py-1 rounded-full border border-amber-400/30 bg-amber-400/10 text-[10px] font-black uppercase tracking-[0.2em] text-amber-300">
                    {authUser.role}
                  </span>
                  <span className={cn(
                    "px-2 py-1 rounded-full border text-[10px] font-black uppercase tracking-[0.2em]",
                    authUser.authType === 'api-token'
                      ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
                      : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                  )}>
                    {authUser.authType === 'api-token' ? 'TOKEN SESSION' : 'WEB SESSION'}
                  </span>
                </div>
              </div>
            </div>

              <div className="flex flex-wrap items-center gap-3">
              <div className={cn(
                "flex items-center gap-3 px-5 py-2.5 rounded-full border transition-all duration-500 shadow-lg",
                tradingMode === 'live' ? "bg-rose-500/10 border-rose-500/30 text-rose-400" : "bg-slate-900 border-slate-800 text-slate-400"
              )}>
                {tradingMode === 'live' ? <Zap size={18} className="animate-pulse" /> : <Globe size={18} />}
                <span className="text-sm font-bold uppercase tracking-widest hidden sm:inline">{tradingMode.toUpperCase()} MODE</span>
                <span className="text-sm font-bold uppercase tracking-widest sm:hidden">MODE</span>
                <div 
                  className={cn(
                    "w-10 h-5 rounded-full relative cursor-pointer transition-colors shadow-inner",
                    tradingMode === 'live' ? "bg-rose-600" : "bg-slate-700"
                  )}
                  onClick={toggleMode}
                >
                  <div className={cn(
                    "absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-transform shadow-sm",
                    tradingMode === 'live' ? "translate-x-5" : "translate-x-0"
                  )} />
                </div>
              </div>

              <div className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-full border transition-all duration-500",
                botEnabled ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-rose-500/10 border-rose-500/30 text-rose-400"
              )}>
                <Bot size={18} className={cn(botEnabled && "animate-pulse")} />
                <span className="text-sm font-bold uppercase hidden sm:inline">{botEnabled ? 'BOT ACTIVE' : 'BOT DISABLED'}</span>
                <span className="text-sm font-bold uppercase sm:hidden">{botEnabled ? 'ACTIVE' : 'DISABLED'}</span>
                <div 
                  className={cn(
                    "w-10 h-5 rounded-full relative cursor-pointer transition-colors",
                    botEnabled ? "bg-emerald-500" : "bg-slate-600"
                  )}
                  onClick={toggleBot}
                >
                  <div className={cn(
                    "absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-transform",
                    botEnabled ? "translate-x-5" : "translate-x-0"
                  )} />
                </div>
              </div>
            </div>
            </div>

            <div className="flex items-center gap-3 self-start lg:self-auto">
              <button 
                onClick={() => setShowModal(true)}
                className={cn(
                  "px-4 py-3 rounded-xl font-black flex items-center justify-center gap-2 transition-all transform hover:scale-105 active:scale-95 shadow-lg",
                  "bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-amber-400/20"
                )}
              >
                {tradingMode === 'live' ? <Zap size={20} className="md:w-5 md:h-5" /> : <Plus size={20} className="md:w-5 md:h-5" />}
                <span className="text-xs sm:text-sm">NEW POSITION</span>
              </button>

              <button 
                onClick={emergencyCloseAll}
                className="bg-rose-600 hover:bg-rose-500 text-white px-4 py-3 rounded-xl font-bold flex items-center gap-2 transition-transform transform hover:scale-105 active:scale-95"
              >
                <AlertTriangle size={18} />
              </button>

              <button
                onClick={logout}
                className="bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 px-4 py-3 rounded-xl font-bold transition-colors text-xs sm:text-sm"
              >
                LOG OUT
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="bg-slate-900 border border-slate-800 px-4 py-3 rounded-2xl flex items-center gap-3">
              <Settings size={18} className="text-slate-500 shrink-0" />
              <div className="flex flex-col min-w-0">
                <span className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Entry Amount ({tradingMode === 'live' ? 'USDC' : 'USDT'})</span>
                <input 
                  type="number"
                  placeholder="Auto (JSON)"
                  value={customAmount}
                  onChange={(e) => saveCustomAmount(e.target.value)}
                  className="bg-transparent border-none text-sm font-black text-amber-400 outline-none placeholder:text-slate-700 p-0 m-0 w-full"
                />
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 px-4 py-3 rounded-2xl">
              <p className="text-[10px] text-blue-400/60 uppercase font-black tracking-wider">Secured Profit</p>
              <p className="text-2xl font-black text-blue-400 mt-1">
                {totalSecuredProfit > 0 ? '+' : ''}{totalSecuredProfit.toFixed(2)} <span className="text-[10px] opacity-70">{tradingMode === 'live' ? 'USDC' : 'USDT'}</span>
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 px-4 py-3 rounded-2xl">
              <p className="text-[10px] text-slate-500 uppercase font-black">Net Profit/Loss</p>
              <p className={cn("text-2xl font-black mt-1", totalPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                {totalPnl.toFixed(2)} <span className="text-[10px] opacity-70">{tradingMode === 'live' ? 'USDC' : 'USDT'}</span>
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 px-4 py-3 rounded-2xl flex items-center gap-3">
              <Zap size={18} className={cn("shrink-0", leverageEnabled ? "text-amber-400" : "text-slate-500")} />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Leverage</span>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowLeverageHelp((current) => !current)}
                      onBlur={() => setTimeout(() => setShowLeverageHelp(false), 120)}
                      className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-700 bg-slate-950/70 text-slate-400 transition-colors hover:border-amber-400 hover:text-amber-300"
                      aria-label="Leverage help"
                    >
                      <CircleHelp size={12} />
                    </button>
                    <div
                      className={cn(
                        "absolute left-0 top-7 z-20 w-64 rounded-2xl border border-slate-700 bg-slate-950/95 p-4 text-left shadow-2xl shadow-slate-950/60 transition-all",
                        showLeverageHelp ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                      )}
                    >
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300">How leverage works here</p>
                      <p className="mt-2 text-xs leading-5 text-slate-300">
                        Entry Amount is the exposure you want to open. Leverage changes the margin Bitget uses for that exposure.
                      </p>
                      <p className="mt-2 text-xs leading-5 text-slate-400">
                        Example: if you want a 500 USDT position and your account has 100 USDT, use Entry Amount 500 and Leverage x5.
                      </p>
                    </div>
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={toggleLeverage}
                    className={cn(
                      "rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] transition-colors",
                      leverageEnabled
                        ? "border-amber-400 bg-amber-400 text-slate-950"
                        : "border-slate-700 bg-slate-950/40 text-slate-400"
                    )}
                  >
                    {leverageEnabled ? 'On' : 'Off'}
                  </button>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-black text-slate-500">x</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={leverageValue}
                      onChange={(e) => saveLeverageValue(e.target.value)}
                      className="w-20 bg-transparent border-none text-sm font-black text-amber-400 outline-none p-0 m-0"
                    />
                  </div>
                </div>
                <span className="mt-1 text-[9px] font-bold uppercase tracking-widest text-slate-600">
                  Amount remains exposure. Leverage changes margin used.
                </span>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 px-4 py-3 rounded-2xl flex items-center gap-3">
              <ShieldCheck size={18} className={cn("shrink-0", apiStopMode === 'signal' ? "text-cyan-300" : "text-slate-500")} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[9px] uppercase font-black text-slate-500 tracking-widest">API Initial Stop</span>
                <div className="mt-1 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={toggleApiStopMode}
                    className={cn(
                      "rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] transition-colors",
                      apiStopMode === 'signal'
                        ? "border-cyan-300 bg-cyan-300 text-slate-950"
                        : "border-slate-700 bg-slate-950/40 text-slate-400"
                    )}
                  >
                    {apiStopMode === 'signal' ? 'Signal/API Stop' : 'Legacy 1.2%'}
                  </button>
                </div>
                <span className="mt-1 text-[9px] font-bold uppercase tracking-widest text-slate-600">
                  API and TradingView entries use webhook stop when available, or fall back to 1.2%.
                </span>
              </div>
            </div>

          </div>
        </header>

        {authUser.role === 'admin' && currentView === 'admin' && (
          <section className="rounded-[2rem] border border-slate-800 bg-slate-900/70 p-5 md:p-6 shadow-xl shadow-slate-950/20">
            <div className="flex flex-col gap-5">
              <div className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-violet-400">Bitget Account</p>
                    <h2 className="text-xl font-black uppercase tracking-tight text-white">Account Overview</h2>
                    <p className="mt-2 text-xs text-slate-500">Live and demo summary based on the Bitget APIs available for balances, futures accounts and spot assets.</p>
                  </div>
                  <button
                    onClick={fetchAccountOverview}
                    className="rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-300 transition-colors hover:border-violet-400/40 hover:text-violet-300"
                  >
                    Refresh balances
                  </button>
                </div>

                {accountOverviewMessage && (
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-xs font-bold text-slate-300">
                    {accountOverviewMessage}
                  </div>
                )}

                {accountOverviewLoading && !accountOverview ? (
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-6 text-sm text-slate-400">
                    Loading account overview...
                  </div>
                ) : accountOverview ? (
                  <div className="mt-4 grid gap-4 xl:grid-cols-2">
                    <AccountOverviewCard title="Demo Account" modeData={accountOverview.demo} accent="text-emerald-400" />
                    <AccountOverviewCard title="Live Account" modeData={accountOverview.live} accent="text-rose-400" />
                  </div>
                ) : null}
              </div>

              <div className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-400">Trade Management</p>
                    <h2 className="text-xl font-black uppercase tracking-tight text-white">Exhaustion Guard</h2>
                    <p className="mt-2 text-xs text-slate-500">Optional demo-safe exit layer. It closes a winning trade if it reached at least +1.0%, stopped making new highs for 90 minutes, and already gave back 35% of its best open profit.</p>
                  </div>
                  <button
                    type="button"
                    onClick={toggleExhaustionGuard}
                    className={cn(
                      "rounded-xl border px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] transition-colors",
                      exhaustionGuardEnabled
                        ? "border-amber-400 bg-amber-400 text-slate-950"
                        : "border-slate-700 bg-slate-950/40 text-slate-400"
                    )}
                  >
                    {exhaustionGuardEnabled ? 'Guard On' : 'Guard Off'}
                  </button>
                </div>
                <p className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-xs font-bold text-slate-300">
                  Al apagarlo, el monitor vuelve al sistema actual de trailing y stop sin cierres extra por agotamiento.
                </p>
              </div>

              <div className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-emerald-400">Audio Alerts</p>
                    <h2 className="text-xl font-black uppercase tracking-tight text-white">Profit Sound</h2>
                    <p className="mt-2 text-xs text-slate-500">Plays when a new closed trade arrives with positive net pnl.</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={toggleProfitSound}
                      className={cn(
                        "rounded-xl border px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] transition-colors",
                        profitSoundEnabled
                          ? "border-emerald-400 bg-emerald-400 text-slate-950"
                          : "border-slate-700 bg-slate-950/40 text-slate-400"
                      )}
                    >
                      {profitSoundEnabled ? 'Sound On' : 'Sound Off'}
                    </button>
                    <button
                      type="button"
                      onClick={previewProfitSound}
                      className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300 transition-colors hover:bg-cyan-400/20"
                    >
                      <span className="flex items-center gap-2">
                        <Play size={12} /> Preview
                      </span>
                    </button>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">
                    Selected sound
                  </label>
                  <select
                    value={profitSoundFile}
                    onChange={(e) => saveProfitSoundFile(e.target.value)}
                    className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-4 text-sm font-black text-amber-300 outline-none"
                  >
                    <option value="">No sound selected</option>
                    {availableSounds.map((sound) => (
                      <option key={sound} value={sound}>{sound}</option>
                    ))}
                  </select>
                  <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-600">
                    Add more files in /public/sounds and refresh the dashboard.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-400">iOS Access Tokens</p>
                  <h2 className="text-xl font-black uppercase tracking-tight text-white">Mobile Token Control</h2>
                </div>
                <p className="text-xs text-slate-500 uppercase tracking-[0.2em]">
                  {tokenLoading ? 'Loading tokens...' : `${apiTokens.filter((token) => token.isActive).length} active tokens`}
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
                <div className="space-y-3 rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-4">
                  <label className="block text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">
                    New iOS token name
                  </label>
                  <input
                    type="text"
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    placeholder="iPhone principal"
                    className="w-full rounded-2xl border border-slate-700 bg-slate-950/60 p-4 text-sm font-black text-slate-100 outline-none transition-colors placeholder:text-slate-700 focus:border-amber-400"
                  />
                  <button
                    onClick={createApiToken}
                    disabled={tokenSubmitting}
                    className="w-full rounded-2xl bg-amber-400 px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-slate-950 transition-colors hover:bg-amber-300 disabled:opacity-60"
                  >
                    {tokenSubmitting ? 'Creating...' : 'Create token'}
                  </button>
                  {tokenMessage && (
                    <div className="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-xs font-bold text-slate-300">
                      {tokenMessage}
                    </div>
                  )}
                  {newTokenValue && (
                    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.25em] text-emerald-300">Copy now</p>
                      <p className="mt-2 break-all font-mono text-xs text-emerald-100">{newTokenValue}</p>
                    </div>
                  )}
                </div>

              <div className="overflow-hidden rounded-[1.5rem] border border-slate-800 bg-slate-950/30">
                <div className="divide-y divide-slate-800 md:hidden">
                  {apiTokens.map((token) => (
                    <div key={token.id} className="px-4 py-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-black text-white">{token.name}</p>
                          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
                            ...{token.lastFour} · {token.isActive ? 'Active' : 'Revoked'}
                          </p>
                        </div>
                        {token.isActive ? (
                          <button
                            onClick={() => revokeApiToken(token.id)}
                            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-rose-300"
                          >
                            Revoke
                          </button>
                        ) : (
                          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Inactive</span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Created</p>
                          <p className="text-slate-300">{new Date(token.createdAt).toLocaleString()}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Last used</p>
                          <p className="text-slate-300">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : 'Never'}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="hidden grid-cols-[1.4fr_0.7fr_0.9fr_0.9fr_0.8fr] gap-4 border-b border-slate-800 px-4 py-3 text-[10px] font-black uppercase tracking-[0.25em] text-slate-500 md:grid">
                  <span>Name</span>
                  <span>Ending</span>
                  <span>Created</span>
                    <span>Last used</span>
                    <span className="text-right">Action</span>
                  </div>
                  <div className="divide-y divide-slate-800">
                    {apiTokens.map((token) => (
                      <div key={token.id} className="grid gap-3 px-4 py-4 md:grid-cols-[1.4fr_0.7fr_0.9fr_0.9fr_0.8fr] md:items-center">
                        <div>
                          <p className="font-black text-white">{token.name}</p>
                          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
                            {token.isActive ? 'Active token' : 'Revoked'}
                          </p>
                        </div>
                        <div className="text-sm font-mono text-slate-300">...{token.lastFour}</div>
                        <div className="text-xs text-slate-400">{new Date(token.createdAt).toLocaleString()}</div>
                        <div className="text-xs text-slate-500">
                          {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : 'Never'}
                        </div>
                        <div className="flex md:justify-end">
                          {token.isActive ? (
                            <button
                              onClick={() => revokeApiToken(token.id)}
                              className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-rose-300 transition-colors hover:bg-rose-500/20"
                            >
                              Revoke
                            </button>
                          ) : (
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Inactive</span>
                          )}
                        </div>
                      </div>
                    ))}
                    {!tokenLoading && apiTokens.length === 0 && (
                      <div className="px-4 py-8 text-center text-sm italic text-slate-500">
                        No mobile tokens created yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {authUser.role === 'admin' && currentView === 'admin' && (
          <section className="rounded-[2rem] border border-slate-800 bg-slate-900/60 p-5 md:p-6 shadow-xl shadow-slate-950/20">
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-400">Audit Trail</p>
                  <h2 className="text-xl font-black uppercase tracking-tight text-white">Recent Critical Activity</h2>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-xs text-slate-500 uppercase tracking-[0.2em]">
                    {auditLoading ? 'Loading activity...' : `${auditLogs.length} records`}
                  </p>
                  <button
                    onClick={fetchAuditLogs}
                    className="rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-300"
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {auditMessage && (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-xs font-bold text-slate-300">
                  {auditMessage}
                </div>
              )}

              <div className="overflow-hidden rounded-[1.5rem] border border-slate-800 bg-slate-950/30">
                <div className="divide-y divide-slate-800 md:hidden">
                  {auditLogs.map((log) => (
                    <div key={log.id} className="px-4 py-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-black text-white">{formatAuditAction(log.action)}</p>
                          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
                            {log.targetType || 'general'}{log.targetId ? ` #${log.targetId}` : ''}
                          </p>
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-400/80">
                          {log.user?.role || 'system'}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-2 text-xs text-slate-300">
                        <p>{new Date(log.createdAt).toLocaleString()}</p>
                        <p>{formatAuditActor(log)}</p>
                        <p>{formatAuditMetadata(log.metadata || null)}</p>
                        {log.ipAddress && (
                          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-600">{log.ipAddress}</p>
                        )}
                      </div>
                    </div>
                  ))}
                  {!auditLoading && auditLogs.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm italic text-slate-500">
                      No audit events recorded yet.
                    </div>
                  )}
                </div>
                <div className="hidden grid-cols-[1fr_1.1fr_1.2fr_1.7fr] gap-4 border-b border-slate-800 px-4 py-3 text-[10px] font-black uppercase tracking-[0.25em] text-slate-500 md:grid">
                  <span>When</span>
                  <span>Action</span>
                  <span>Actor</span>
                  <span>Details</span>
                </div>
                <div className="divide-y divide-slate-800">
                  {auditLogs.map((log) => (
                    <div key={log.id} className="grid gap-3 px-4 py-4 md:grid-cols-[1fr_1.1fr_1.2fr_1.7fr] md:items-start">
                      <div>
                        <p className="text-sm font-bold text-slate-200">{new Date(log.createdAt).toLocaleString()}</p>
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-600">
                          {log.ipAddress || 'No IP'}
                        </p>
                      </div>
                      <div>
                        <p className="font-black text-white">{formatAuditAction(log.action)}</p>
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
                          {log.targetType || 'general'}{log.targetId ? ` #${log.targetId}` : ''}
                        </p>
                      </div>
                      <div>
                        <p className="font-bold text-slate-200">{formatAuditActor(log)}</p>
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400/80">
                          {log.user?.role || 'system'}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-300">{formatAuditMetadata(log.metadata || null)}</p>
                        {log.userAgent && (
                          <p className="mt-1 line-clamp-1 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-600">
                            {log.userAgent}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                  {!auditLoading && auditLogs.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm italic text-slate-500">
                      No audit events recorded yet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {currentView === 'dashboard' ? (
        <main className="space-y-12">
          {tradingMode === 'live' && (
            <motion.div 
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              className="bg-rose-600 text-white py-1 px-4 text-[10px] font-black uppercase tracking-[0.4em] text-center rounded-full overflow-hidden whitespace-nowrap shadow-xl"
            >
              Executing In Real-Time Production Environment — Capital At Risk
            </motion.div>
          )}

          <section>
            {/* Last entry error banner */}
            {lastEntryError && lastEntryError.detail && hiddenEntryErrorKey !== `${lastEntryError.timestamp}-${lastEntryError.symbol}-${lastEntryError.type}-${lastEntryError.detail}` && (
              <button
                type="button"
                onClick={() => setHiddenEntryErrorKey(`${lastEntryError.timestamp}-${lastEntryError.symbol}-${lastEntryError.type}-${lastEntryError.detail}`)}
                className="mb-4 w-full px-4 py-3 bg-rose-950/40 border border-rose-800/40 rounded-xl flex items-start gap-3 text-left"
              >
                <AlertTriangle size={16} className="text-rose-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-rose-400 font-bold uppercase tracking-wider mb-1">Último error de entrada</p>
                  <p className="text-xs text-rose-300/80 break-all leading-relaxed">{lastEntryError.detail}</p>
                  <p className="text-[10px] text-rose-500/60 mt-1">
                    {lastEntryError.symbol} · {lastEntryError.type?.toUpperCase()} · {new Date(lastEntryError.timestamp).toLocaleString()}
                  </p>
                </div>
              </button>
            )}

            <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-xl font-black flex flex-wrap items-center gap-3 text-slate-300">
                <Activity className={cn(tradingMode === 'live' ? "text-amber-500" : "text-amber-400")} />
                <span>{openPositions.length}</span>
                <span>ACTIVE POSITIONS</span>
                {syncing && <RefreshCw size={14} className="animate-spin text-blue-400 ml-2" />}
              </h2>
              <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                Tap any card to monitor live risk
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <AnimatePresence mode='popLayout'>
                {openPositions?.length === 0 ? (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="col-span-full border-2 border-dashed border-slate-800 rounded-3xl p-12 flex flex-col items-center justify-center text-slate-500 space-y-4"
                  >
                    <TrendingUp size={48} className="opacity-10" />
                    <p className="font-bold text-center">No trades in orbit for {tradingMode}.<br/><span className="text-xs font-normal opacity-50">Launch a new signal to begin.</span></p>
                  </motion.div>
                ) : (
                  openPositions?.map((pos) => (
                    <PositionCard key={pos.id} pos={pos} onEject={manualEject} />
                  ))
                )}
              </AnimatePresence>

          {/* Modal Manual Eject Confirmation */}
          <AnimatePresence>
            {showEjectModal && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md"
              >
                <motion.div 
                  initial={{ scale: 0.9, opacity: 0, y: 20 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.9, opacity: 0, y: 20 }}
                  className="glass-card w-full max-w-sm p-8 flex flex-col items-center text-center gap-6"
                >
                  <div className="w-16 h-16 bg-rose-500/10 rounded-full flex items-center justify-center mb-2">
                    <AlertTriangle size={32} className="text-rose-500 animate-pulse" />
                  </div>
                  
                  <div className="space-y-2">
                    <h3 className="text-xl font-black text-white uppercase tracking-wider">Manual Exit Confirmation</h3>
                    <p className="text-slate-400 text-sm leading-relaxed">
                      Are you sure you want to close your <span className="text-white font-bold">{showEjectModal.symbol}</span> position in <span className="text-rose-400 font-bold">{showEjectModal.tradingMode.toUpperCase()}</span>? 
                      <br/>This will execute a market order.
                    </p>
                  </div>

                  <div className="flex flex-col w-full gap-3 mt-4">
                    <button 
                      onClick={confirmManualEject}
                      className="w-full bg-rose-600 hover:bg-rose-500 text-white font-black py-4 rounded-2xl transition-all shadow-lg shadow-rose-600/20 uppercase tracking-widest text-xs"
                    >
                      Yes, Eject Now
                    </button>
                    <button 
                      onClick={() => setShowEjectModal(null)}
                      className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-4 rounded-2xl transition-all uppercase tracking-widest text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
            </div>
          </section>

          <BookmapPanel
            symbol={bookmapSymbol}
            onSymbolChange={setBookmapSymbol}
            data={bookmapData}
            loading={bookmapLoading}
            message={bookmapMessage}
            expanded={bookmapExpanded}
            onToggleExpanded={() => setBookmapExpanded((current) => !current)}
            onExecutePreSignal={executeHeatmapPreSignal}
            executingPreSignal={executingHeatmapSignal}
            onTrackPaperSignal={trackHeatmapPreSignalOnPaper}
            creatingPaperSignal={creatingHeatmapPaper}
            paperData={heatmapPaperData}
            paperMessage={heatmapPaperMessage}
          />

          {/* History */}
          <section className="bg-slate-900/30 border border-slate-800/50 rounded-3xl overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-slate-800 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center bg-slate-900/50">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-black flex items-center gap-3">
                  <History className="text-amber-400" /> {tradingMode.toUpperCase()} TRADE LOGS
                </h2>
                {isPhonePortrait && (
                  <button
                    type="button"
                    onClick={() => setTradeLogsExpanded((current) => !current)}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 sm:hidden"
                  >
                    {tradeLogsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {tradeLogsExpanded ? 'Hide' : 'Show'}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">
                  Last {recentClosedPositions.length} {tradingMode}
                </p>
                <button onClick={clearHistory} className="text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-rose-400 flex items-center gap-2 transition-colors">
                  <Trash2 size={14} /> Clear {tradingMode} History
                </button>
              </div>
            </div>

            {tradeLogsExpanded && (
            <>
            <div className="divide-y divide-slate-800/40 md:hidden">
              {recentClosedPositions.map((pos) => {
                const durationStr = formatClosedDuration(pos.createdAt, pos.closedAt);
                return (
                  <div key={pos.id} className="px-4 py-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-white">{pos.symbol}</p>
                      </div>
                      <span className={cn(pos.positionType === 'buy' ? 'text-emerald-400' : 'text-rose-400', "font-bold text-xs uppercase")}>
                        {pos.positionType}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Entry</p>
                        <p className="font-mono text-slate-300">{formatPrice(pos.entryPrice, pos.pricePrecision)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">PnL %</p>
                        <p className={cn("font-black", pos.profitLossPercent >= 0 ? "text-emerald-400" : "text-rose-400")}>
                          {pos.profitLossPercent > 0 ? '+' : ''}{pos.profitLossPercent.toFixed(2)}%
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Net</p>
                        <p className={cn("font-black", pos.profitLossFiat >= 0 ? "text-emerald-400" : "text-rose-400")}>
                          {pos.profitLossFiat > 0 ? '+' : ''}{pos.profitLossFiat.toFixed(2)} {tradingMode === 'live' ? 'USDC' : 'USDT'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">Duration</p>
                        <p className="font-mono text-slate-400">{durationStr}</p>
                      </div>
                    </div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-500">
                      Closed {pos.closedAt ? new Date(pos.closedAt).toLocaleString() : '-'}
                    </p>
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-500">
                      Origin / TF {pos.origin || '-'}{pos.timeframe ? ` / ${pos.timeframe}` : ''}
                    </p>
                  </div>
                );
              })}
              {recentClosedPositions.length === 0 && (
                <div className="px-6 py-12 text-center text-slate-600 italic text-sm">No missions completed yet in {tradingMode}.</div>
              )}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-[10px] text-slate-500 uppercase tracking-widest font-black border-b border-slate-800/50">
                    <th className="px-6 py-4">Symbol</th>
                    <th className="px-6 py-4">Type</th>
                    <th className="px-6 py-4">Entry</th>
                    <th className="px-6 py-4">PnL %</th>
                    <th className="px-6 py-4">PnL {tradingMode === 'live' ? 'USDC' : 'USDT'}</th>
                    <th className="px-6 py-4">Closed At</th>
                    <th className="px-6 py-4">Duration</th>
                    <th className="px-6 py-4">Origin / TF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/30">
                  {recentClosedPositions?.map(pos => {
                    const durationStr = formatClosedDuration(pos.createdAt, pos.closedAt);

                    const tooltipData = `Entry Time: ${new Date(pos.createdAt).toLocaleString()}
Close Time: ${pos.closedAt ? new Date(pos.closedAt).toLocaleString() : '-'}
Duration: ${durationStr}
Amount: ${pos.amount} ${pos.tradingMode === 'live' ? 'USDC' : 'USDT'}
Symbol: ${pos.symbol}
Type: ${pos.positionType.toUpperCase()}
Quantity: ${pos.quantity}
Entry Price: ${formatPrice(pos.entryPrice, pos.pricePrecision)}
Stop Target: ${formatPrice(pos.stopLoss, pos.pricePrecision)}
Commission: ${((pos.commission ?? 0.0006) * 100).toFixed(4)}%
PnL %: ${pos.profitLossPercent.toFixed(2)}%
PnL ${pos.tradingMode === 'live' ? 'USDC' : 'USDT'}: ${pos.profitLossFiat.toFixed(2)} ${pos.tradingMode === 'live' ? 'USDC' : 'USDT'}`;
                    
                    return (
                    <tr key={pos.id} title={tooltipData} className="text-sm hover:bg-slate-800/20 transition-colors group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-slate-300">{pos.symbol}</span>
                          <ExternalLink size={12} className="opacity-0 group-hover:opacity-30 transition-opacity" />
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={cn(pos.positionType === 'buy' ? 'text-emerald-400' : 'text-rose-400', "font-bold text-xs uppercase")}>
                          {pos.positionType}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-400">{formatPrice(pos.entryPrice, pos.pricePrecision)}</td>
                      <td className={cn("px-6 py-4 font-black", pos.profitLossPercent >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {pos.profitLossPercent > 0 ? '+' : ''}{pos.profitLossPercent.toFixed(2)}%
                      </td>
                      <td className={cn("px-6 py-4 font-black", pos.profitLossFiat >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {pos.profitLossFiat > 0 ? '+' : ''}{pos.profitLossFiat.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 text-xs text-slate-500 font-medium">
                        {new Date(pos.closedAt!).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-500">
                        {durationStr}
                      </td>
                      <td className="px-6 py-4 text-xs font-bold text-slate-500">
                        {pos.origin || '-'}{pos.timeframe ? ` / ${pos.timeframe}` : ''}
                      </td>
                    </tr>
                  )})}
                  {recentClosedPositions.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-12 text-center text-slate-600 italic text-sm">No missions completed yet in {tradingMode}.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            </>
            )}
          </section>
        </main>
        ) : currentView === 'stats' ? (
          <main className="space-y-8">
            <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-[2rem] border border-slate-800 bg-slate-900/40 p-6 shadow-xl shadow-slate-950/20">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-emerald-400">Statistics</p>
                <h2 className="mt-2 text-2xl font-black uppercase tracking-tight text-white">Closed Positions Analytics</h2>
                <p className="mt-2 text-sm text-slate-400">Separated between demo and live using all closed positions recorded so far.</p>
              </div>
              <button
                onClick={fetchStats}
                className="rounded-xl border border-slate-700 bg-slate-950/50 px-4 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-slate-300 transition-colors hover:border-emerald-400/40 hover:text-emerald-300"
              >
                Refresh stats
              </button>
            </section>

            {statsMessage && (
              <div className="rounded-2xl border border-rose-800/40 bg-rose-950/20 px-4 py-3 text-sm text-rose-300">
                {statsMessage}
              </div>
            )}

            {statsLoading && !statsData ? (
              <section className="rounded-[2rem] border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-400">
                Loading statistics...
              </section>
            ) : statsData ? (
              <div className="grid gap-8 xl:grid-cols-2">
                <StatsModeSection title="Demo Statistics" mode="demo" stats={statsData.demo} />
                <StatsModeSection title="Live Statistics" mode="live" stats={statsData.live} />
              </div>
            ) : null}
          </main>
        ) : (
          <main className="space-y-6">
            <section className="rounded-[2rem] border border-slate-800 bg-slate-900/40 p-8 text-center shadow-xl shadow-slate-950/20">
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-400">Admin View</p>
              <h2 className="mt-3 text-2xl font-black uppercase tracking-tight text-white">Management Center</h2>
              <p className="mt-3 text-sm text-slate-400">
                Here you can manage iOS access tokens and review the audit trail without loading the main trading dashboard.
              </p>
            </section>
          </main>
        )}

        <footer className="pt-4 pb-12 flex flex-col items-center gap-2">
          <div className="text-[10px] uppercase flex items-center gap-2 font-black tracking-widest">
            <span className={cn(
              "inline-block w-2 h-2 rounded-full",
              syncStatusLabel === 'live' ? "bg-emerald-400" : syncStatusLabel === 'paused' ? "bg-amber-400" : "bg-rose-400"
            )} />
            <span className={cn(
              syncStatusLabel === 'live' ? "text-emerald-400/80" : syncStatusLabel === 'paused' ? "text-amber-400/80" : "text-rose-400/80"
            )}>
              {syncStatusLabel === 'live' ? 'Foreground sync active' : syncStatusLabel === 'paused' ? 'Sync paused in background' : 'Offline mode'}
            </span>
          </div>
          <div className="text-[10px] text-slate-500 uppercase flex items-center gap-2 opacity-60 font-black tracking-widest">
            <Clock size={12} /> Last heartbeat: {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : 'Pending first sync'}
          </div>
          <div className="text-[10px] text-slate-500/40 uppercase flex items-center gap-2 font-black tracking-[0.2em]">
            <Hammer size={12} /> Build Bitget Sync Rev: {buildInfo.timestamp}
          </div>
        </footer>

        {/* NEW POSITION MODAL */}
        <AnimatePresence>
          {showModal && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xl"
            >
              <motion.div 
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                className="bg-slate-900 border border-slate-700 w-full max-w-md rounded-[2rem] p-8 shadow-2xl relative overflow-hidden"
              >
                {/* Background accent */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-amber-400/10 blur-3xl -z-10 rounded-full" />
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-yellow-300/10 blur-3xl -z-10 rounded-full" />

                <h3 className="text-2xl font-black italic tracking-tighter mb-8 flex items-center gap-3">
                  <ShieldCheck className={tradingMode === 'live' ? "text-amber-500" : "text-amber-400"} /> OPEN {tradingMode.toUpperCase()} BITGET SIGNAL
                </h3>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Instrument Pairing</label>
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Select or search symbol"
                        className="w-full bg-slate-950/50 border border-slate-700 p-4 rounded-2xl outline-none focus:border-amber-400 transition-colors placeholder:text-slate-700 font-black"
                        value={newPos.symbol}
                        onFocus={() => setShowSymbolOptions(true)}
                        onBlur={() => setTimeout(() => setShowSymbolOptions(false), 120)}
                        onChange={(e) => {
                          setNewPos({...newPos, symbol: e.target.value.toUpperCase()});
                          setShowSymbolOptions(true);
                        }}
                      />
                      <TrendingUp className="absolute right-4 top-4 text-slate-700" size={18} />
                      {showSymbolOptions && (
                        <div className="absolute z-20 mt-2 w-full max-h-64 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950/95 shadow-2xl shadow-slate-950/50">
                          {filteredSymbols.length > 0 ? (
                            filteredSymbols.map((symbol) => (
                              <button
                                key={symbol}
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  setNewPos({ ...newPos, symbol });
                                  setShowSymbolOptions(false);
                                }}
                                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-black text-slate-200 transition-colors hover:bg-slate-800 hover:text-amber-300"
                              >
                                <span>{symbol}</span>
                                <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Bitget</span>
                              </button>
                            ))
                          ) : (
                            <div className="px-4 py-3 text-sm text-slate-500">No matching symbols.</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Signal Budget ({tradingMode === 'live' ? 'USDC' : 'USDT'})</label>
                    <input 
                      type="number" 
                      placeholder="100.00" 
                      className="w-full bg-slate-950/50 border border-slate-700 p-4 rounded-2xl outline-none focus:border-amber-400 transition-colors placeholder:text-slate-700 font-black"
                      value={newPos.amount}
                      onChange={(e) => setNewPos({...newPos, amount: e.target.value})}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <button 
                      onClick={() => setNewPos({...newPos, type: 'buy'})}
                      className={cn(
                        "p-4 rounded-2xl font-black text-sm transition-all border",
                        newPos.type === 'buy' ? "bg-emerald-500 text-slate-950 border-emerald-400" : "bg-slate-950/50 border-slate-800 text-slate-400 opacity-50 hover:opacity-100"
                      )}
                    >
                      LONG / BUY
                    </button>
                    <button 
                      onClick={() => setNewPos({...newPos, type: 'sell'})}
                      className={cn(
                        "p-4 rounded-2xl font-black text-sm transition-all border",
                        newPos.type === 'sell' ? "bg-rose-500 text-white border-rose-400" : "bg-slate-950/50 border-slate-800 text-slate-400 opacity-50 hover:opacity-100"
                      )}
                    >
                      SHORT / SELL
                    </button>
                  </div>

                  <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Execution Policy</p>
                        <p className="mt-1 text-sm font-bold text-slate-200">Maker first with controlled fallback</p>
                        <p className="mt-1 text-xs text-slate-500">Intentaremos entrar como maker y, si no ejecuta a tiempo, podra usar un fallback taker acotado.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setNewPos({ ...newPos, allowTakerFallback: !newPos.allowTakerFallback })}
                        className={cn(
                          "min-w-[116px] rounded-2xl border px-3 py-2 text-[11px] font-black uppercase tracking-widest transition-colors",
                          newPos.allowTakerFallback
                            ? "border-amber-400 bg-amber-400 text-slate-950"
                            : "border-slate-700 bg-slate-900 text-slate-400"
                        )}
                      >
                        {newPos.allowTakerFallback ? 'Fallback On' : 'Fallback Off'}
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        disabled={!newPos.allowTakerFallback}
                        onClick={() => setNewPos({ ...newPos, takerFallbackMode: 'ioc' })}
                        className={cn(
                          "rounded-2xl border p-3 text-xs font-black uppercase tracking-widest transition-all",
                          newPos.allowTakerFallback && newPos.takerFallbackMode === 'ioc'
                            ? "border-emerald-400 bg-emerald-500 text-slate-950"
                            : "border-slate-800 bg-slate-950/50 text-slate-400",
                          !newPos.allowTakerFallback && "cursor-not-allowed opacity-40"
                        )}
                      >
                        IOC Fallback
                      </button>
                      <button
                        type="button"
                        disabled={!newPos.allowTakerFallback}
                        onClick={() => setNewPos({ ...newPos, takerFallbackMode: 'market' })}
                        className={cn(
                          "rounded-2xl border p-3 text-xs font-black uppercase tracking-widest transition-all",
                          newPos.allowTakerFallback && newPos.takerFallbackMode === 'market'
                            ? "border-rose-400 bg-rose-500 text-white"
                            : "border-slate-800 bg-slate-950/50 text-slate-400",
                          !newPos.allowTakerFallback && "cursor-not-allowed opacity-40"
                        )}
                      >
                        Market Fallback
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-4 pt-4">
                    <button 
                      onClick={() => setShowModal(false)}
                      className="flex-1 p-4 rounded-2xl font-bold text-slate-500 hover:bg-slate-800 transition-colors"
                    >
                      Abort
                    </button>
                    <button 
                      onClick={submitNewPosition}
                      className={cn(
                        "flex-[2] p-4 rounded-2xl font-black shadow-lg",
                        "bg-amber-400 hover:bg-amber-300 text-slate-950 shadow-amber-400/20"
                      )}
                    >
                      CONFIRM SIGNAL
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ERROR DETAIL POPUP */}
        <AnimatePresence>
          {errorPopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                className="bg-slate-900 border border-rose-700/50 w-full max-w-md rounded-[2rem] p-8 shadow-2xl relative overflow-hidden"
              >
                <div className="absolute top-0 right-0 w-40 h-40 bg-rose-500/10 blur-3xl -z-10 rounded-full" />
                <div className="flex flex-col items-center text-center gap-5">
                  <div className="w-16 h-16 bg-rose-500/10 rounded-full flex items-center justify-center">
                    <AlertTriangle size={32} className="text-rose-500" />
                  </div>
                  <h3 className="text-xl font-black text-white uppercase tracking-wider">Error de Apertura</h3>
                  <p className="text-sm text-rose-300/80 leading-relaxed break-all bg-slate-950/50 border border-slate-800 rounded-xl p-4 w-full text-left font-mono">
                    {errorPopup}
                  </p>
                  <button
                    onClick={() => setErrorPopup(null)}
                    className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-black py-4 rounded-2xl transition-all uppercase tracking-widest text-xs mt-2"
                  >
                    Cerrar
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function PositionCard({ pos, onEject }: { pos: Position, onEject: (pos: Position) => void }) {
  const isBuy = pos.positionType === 'buy';
  const comm = pos.commission ?? 0.0006;
  const LEGACY_STOP_PERCENT = 1.2;
  const entryCost = pos.entryPrice * pos.quantity * comm;
  const exitCost = pos.stopLoss * pos.quantity * comm;
  const grossPercent = pos.profitLossPercent;
  const netPercent = pos.entryPrice > 0 && pos.quantity > 0
    ? (pos.profitLossFiat / (pos.entryPrice * pos.quantity)) * 100
    : 0;
  const pnlSafe = isBuy 
    ? ((pos.stopLoss - pos.entryPrice) * pos.quantity) - entryCost - exitCost
    : ((pos.entryPrice - pos.stopLoss) * pos.quantity) - entryCost - exitCost;
  const stopDistancePercent = pos.entryPrice > 0
    ? ((pos.stopLoss - pos.entryPrice) / pos.entryPrice) * 100
    : 0;
  const riskDistancePercent = isBuy ? -stopDistancePercent : stopDistancePercent;
  const isLegacyStop = Math.abs(Math.abs(riskDistancePercent) - LEGACY_STOP_PERCENT) < 0.05;
  const stopAdjustedByApp = !isLegacyStop;
  
  const isSafe = pnlSafe > 0;
  const isBreakeven = Math.abs(pnlSafe) < 0.05;
  const slAtEntry = Math.abs(pos.stopLoss - pos.entryPrice) < Math.max(0.0000001, pos.entryPrice * 0.0001);

  const exchangeUrl = `https://www.bitget.com/en/futures/usdt/${pos.symbol}`;
  const tradingViewUrl = `https://www.tradingview.com/chart/?symbol=BITGET%3A${encodeURIComponent(`${pos.symbol}.P`)}`;

  return (
    <motion.div 
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="glass-card p-5 flex flex-col gap-4 relative overflow-hidden group"
    >
      {/* Dynamic Background */}
      <div className={cn(
        "absolute -right-8 -top-8 w-24 h-24 blur-3xl rounded-full opacity-20 -z-10 group-hover:opacity-40 transition-opacity duration-700",
        isBuy ? "bg-emerald-500" : "bg-rose-500"
      )} />

      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl font-black tracking-tight text-white">
              {pos.symbol}
            </span>
            <div className="flex items-center gap-2">
              <a
                href={exchangeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-amber-400/25 bg-amber-400/10 p-1 transition-colors hover:border-amber-300/60 hover:bg-amber-400/20"
                aria-label={`Open ${pos.symbol} on Bitget`}
                title="Open on Bitget"
              >
                <Image src="/bitget-mark.svg" alt="Bitget" width={32} height={32} className="h-8 w-8" />
              </a>
              <a
                href={tradingViewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-cyan-400/25 bg-cyan-400/10 p-1 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/20"
                aria-label={`Open ${pos.symbol} on TradingView`}
                title="Open on TradingView"
              >
                <Image src="/tradingview-mark.svg" alt="TradingView" width={32} height={32} className="h-8 w-8" />
              </a>
            </div>
            {pos.tradingMode === 'live' && <span className="bg-rose-500 text-[8px] font-black px-1.5 py-0.5 rounded text-white animate-pulse">LIVE</span>}
          </div>
          <span className="text-[10px] text-slate-500 font-bold tracking-widest uppercase flex gap-2">
            ID: CMD-{pos.id.toString().padStart(4, '0')}
            {(pos.origin || pos.timeframe) && ` | ${[pos.origin, pos.timeframe].filter(Boolean).join(' - ')}`}
          </span>
        </div>
        <span className={cn(isBuy ? "badge-buy" : "badge-sell", "flex items-center gap-1.5")}>
          {isBuy ? <TrendingUp size={10}/> : <TrendingDown size={10}/>} {pos.positionType}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        <div className="space-y-1">
          <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider">Entry Level</p>
          <p className="text-sm font-mono text-slate-300">
            {formatPrice(pos.entryPrice, pos.pricePrecision)}
            <span className="ml-2 text-[10px] font-black uppercase tracking-[0.15em] text-slate-500">
              ({pos.amount.toFixed(0)} {pos.tradingMode === 'live' ? 'USDC' : 'USDT'})
            </span>
          </p>
          <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider">
            {new Date(pos.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="space-y-1 text-right">
          <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider">Stop Target</p>
          <p className={cn("text-sm font-mono", isSafe ? "text-emerald-400" : "text-rose-400/80")}>
            {formatPrice(pos.stopLoss, pos.pricePrecision)}
          </p>
          <p className={cn("text-[11px] font-black uppercase tracking-[0.15em]", stopAdjustedByApp ? "text-cyan-300" : "text-slate-500")}>
            {stopDistancePercent > 0 ? '+' : ''}{stopDistancePercent.toFixed(2)}% vs entry
          </p>
          <p className={cn("text-[10px] font-black uppercase tracking-[0.18em]", stopAdjustedByApp ? "text-cyan-300" : "text-slate-600")}>
            {stopAdjustedByApp ? 'Adapted By App' : 'Legacy 1.2% Default'}
          </p>
        </div>
      </div>

      {(pos.commission !== undefined && pos.commission !== null) && (
        <div className="px-3 py-1 bg-slate-800/50 rounded-lg self-start">
          <p className="text-[9px] text-slate-500 font-bold uppercase">Fee: {(pos.commission * 100).toFixed(4)}%</p>
        </div>
      )}

      <div className="bg-slate-950/50 rounded-2xl p-3 border border-slate-800/50">
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-start">
          <div className="space-y-1">
             <p className="text-[10px] text-emerald-400/50 font-black uppercase tracking-tighter">Real-time PnL</p>
             <p className={cn("text-2xl font-black", grossPercent >= 0 ? "text-emerald-400" : "text-rose-400")}>
                {grossPercent > 0 ? '+' : ''}{grossPercent.toFixed(2)}<span className="text-xs opacity-50">%</span>
             </p>
             <p className={cn("text-[11px] font-bold uppercase tracking-wide", netPercent >= 0 ? "text-emerald-500/80" : "text-rose-500/80")}>
                Net {netPercent > 0 ? '+' : ''}{netPercent.toFixed(2)}%
             </p>
          </div>
          <div className="text-left sm:text-right">
            <p className={cn("text-sm font-black opacity-90", pos.profitLossFiat >= 0 ? "text-emerald-500" : "text-rose-500")}>
              Net {pos.profitLossFiat > 0 ? '+' : ''}{pos.profitLossFiat.toFixed(2)} {pos.tradingMode === 'live' ? 'USDC' : 'USDT'}
            </p>
            <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider mt-1">
              Duration {formatOpenDuration(pos.createdAt)}
            </p>
          </div>
        </div>
      </div>

      {isSafe && (
        <div className="badge-safe justify-center py-2 animate-none bg-emerald-500/10 border-emerald-500/10">
          <ShieldCheck size={14} className="text-emerald-400" /> 
          {isBreakeven ? 'BREAKEVEN SECURED' : `+${pnlSafe.toFixed(2)} ${pos.tradingMode === 'live' ? 'USDC' : 'USDT'} SECURED`}
        </div>
      )}

      {slAtEntry && (
        <div className="px-3 py-2 rounded-xl border border-amber-500/20 bg-amber-500/10 text-center text-[11px] font-black uppercase tracking-[0.2em] text-amber-300">
          Breakeven Plus Fees
        </div>
      )}

      <button 
        onClick={() => onEject(pos)}
        className="w-full bg-rose-600 hover:bg-rose-500 text-white rounded-xl py-2.5 text-xs font-black uppercase tracking-[0.2em] flex items-center justify-center gap-2 transition-transform transform hover:scale-105 active:scale-95 shadow-lg shadow-rose-600/20 mt-1"
      >
        <AlertTriangle size={14} /> MANUAL EJECT
      </button>
    </motion.div>
  );
}

function StatsModeSection({ title, mode, stats }: { title: string; mode: 'demo' | 'live'; stats: StatsMode }) {
  const currency = mode === 'live' ? 'USDC' : 'USDT';

  return (
    <section className="rounded-[2rem] border border-slate-800 bg-slate-900/50 p-6 shadow-xl shadow-slate-950/20">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className={cn(
            "text-[10px] font-black uppercase tracking-[0.3em]",
            mode === 'live' ? "text-rose-400" : "text-emerald-400"
          )}>
            {mode}
          </p>
          <h3 className="mt-2 text-xl font-black uppercase tracking-tight text-white">{title}</h3>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-right">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Closed trades</p>
          <p className="text-2xl font-black text-white">{stats.closedCount}</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <StatsCard
          title="Success vs Failure"
          chart={<DonutChart values={[stats.successCount, stats.failedCount]} colors={['#10b981', '#f43f5e']} />}
          lines={[
            `${stats.successCount} successful · ${stats.successPercent.toFixed(1)}%`,
            `${stats.failedCount} failed · ${stats.failedPercent.toFixed(1)}%`,
          ]}
        />
        <StatsCard
          title={`Profit vs Loss (${currency})`}
          chart={<DonutChart values={[stats.profitAmount, stats.lossAmount]} colors={['#22c55e', '#ef4444']} />}
          lines={[
            `+${stats.profitAmount.toFixed(2)} ${currency} · ${stats.profitPercent.toFixed(1)}%`,
            `-${stats.lossAmount.toFixed(2)} ${currency} · ${stats.lossPercent.toFixed(1)}%`,
          ]}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SourceStatsCard
          title="Source effectiveness by usage"
          subtitle="Win rate based on how many times each source was used"
          items={stats.sourceByCount.map((item) => ({
            label: item.source,
            percent: item.effectivenessPercent,
            detail: `${item.winCount}/${item.totalCount} winning signals`,
          }))}
        />
        <SourceStatsCard
          title="Source effectiveness by duration"
          subtitle="Winning time divided by total closed-trade time for each source"
          items={stats.sourceByDuration.map((item) => ({
            label: item.source,
            percent: item.effectivenessPercent,
            detail: `${formatDurationMs(item.winDurationMs)} win time / ${formatDurationMs(item.totalDurationMs)} total`,
          }))}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <BarStatsCard
          title="Trades by weekday"
          subtitle="Based on the opening date of each closed trade"
          items={stats.tradesByWeekday}
          barColor={mode === 'live' ? 'bg-rose-500' : 'bg-emerald-500'}
        />
        <BarStatsCard
          title="Trades by opening hour"
          subtitle="Based on the opening hour of each closed trade"
          items={stats.tradesByHour}
          barColor={mode === 'live' ? 'bg-cyan-500' : 'bg-amber-400'}
          compact
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <MetricBarStatsCard
          title="Symbol effectiveness by winning trades"
          subtitle="Winning operations by symbol and success rate"
          items={stats.symbolByWins.map((item) => ({
            label: item.symbol,
            value: item.winCount,
            detail: `${item.winCount}/${item.totalCount} wins · ${item.effectivenessPercent.toFixed(1)}%`,
          }))}
          barColor={mode === 'live' ? 'bg-fuchsia-500' : 'bg-lime-500'}
        />
        <MetricBarStatsCard
          title={`Symbol effectiveness by accumulated profit (${currency})`}
          subtitle="Net accumulated profit for each symbol"
          items={stats.symbolByProfit.map((item) => ({
            label: item.symbol,
            value: item.profitAmount,
            detail: `${item.profitAmount >= 0 ? '+' : ''}${item.profitAmount.toFixed(2)} ${currency} · ${item.totalCount} trades`,
          }))}
          barColor={mode === 'live' ? 'bg-sky-500' : 'bg-amber-500'}
          valueFormatter={(value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`}
        />
      </div>
    </section>
  );
}

function StatsCard({ title, chart, lines }: { title: string; chart: ReactNode; lines: string[] }) {
  return (
    <div className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-5">
      <p className="text-sm font-black uppercase tracking-[0.15em] text-white">{title}</p>
      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row">
        {chart}
        <div className="space-y-2 text-sm text-slate-300">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function SourceStatsCard({
  title,
  subtitle,
  items,
}: {
  title: string;
  subtitle: string;
  items: Array<{ label: string; percent: number; detail: string }>;
}) {
  return (
    <div className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-5">
      <p className="text-sm font-black uppercase tracking-[0.15em] text-white">{title}</p>
      <p className="mt-2 text-xs text-slate-500">{subtitle}</p>
      <div className="mt-5 space-y-4">
        {items.length === 0 ? (
          <p className="text-sm italic text-slate-500">No source data available yet.</p>
        ) : (
          items.map((item) => (
            <div key={item.label} className="flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
              <DonutChart values={[item.percent, Math.max(0, 100 - item.percent)]} colors={['#06b6d4', '#1f2937']} size={84} strokeWidth={12} centerLabel={`${item.percent.toFixed(0)}%`} />
              <div>
                <p className="font-black text-white">{item.label}</p>
                <p className="mt-1 text-xs text-slate-400">{item.detail}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function BarStatsCard({
  title,
  subtitle,
  items,
  barColor,
  compact = false,
}: {
  title: string;
  subtitle: string;
  items: Array<{ label: string; count: number }>;
  barColor: string;
  compact?: boolean;
}) {
  const maxCount = Math.max(...items.map((item) => item.count), 1);

  return (
    <div className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-5">
      <p className="text-sm font-black uppercase tracking-[0.15em] text-white">{title}</p>
      <p className="mt-2 text-xs text-slate-500">{subtitle}</p>
      <div className={cn("mt-5 grid items-end gap-2", compact ? "grid-cols-12 xl:grid-cols-12" : "grid-cols-7")}>
        {items.map((item) => {
          const heightPercent = Math.max(6, (item.count / maxCount) * 100);

          return (
            <div key={item.label} className="flex min-w-0 flex-col items-center gap-2">
              <span className="text-[10px] font-black text-slate-400">{item.count}</span>
              <div className="flex h-40 w-full items-end justify-center rounded-2xl border border-slate-800 bg-slate-900/40 px-1 py-2">
                <div
                  className={cn("w-full rounded-xl transition-all", barColor)}
                  style={{ height: `${heightPercent}%` }}
                />
              </div>
              <span className={cn("text-[10px] font-black uppercase tracking-[0.15em] text-slate-500", compact && "tracking-[0.05em]")}>
                {item.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AccountOverviewCard({
  title,
  modeData,
  accent,
}: {
  title: string;
  modeData: AccountOverviewMode;
  accent: string;
}) {
  const totalUsdt = modeData.summary.reduce((sum, item) => sum + item.usdtBalance, 0);
  const totalBtc = modeData.summary.reduce((sum, item) => sum + item.btcBalance, 0);
  const futuresRows = modeData.futures.usdt;

  return (
    <div className="rounded-[1.5rem] border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className={cn("text-[10px] font-black uppercase tracking-[0.3em]", accent)}>{title}</p>
          <h3 className="mt-2 text-lg font-black uppercase tracking-tight text-white">Bitget Balances</h3>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Approx Total</p>
          <p className="text-xl font-black text-white">{totalUsdt.toFixed(2)} USDT</p>
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-600">{totalBtc.toFixed(8)} BTC</p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {modeData.summary.map((item) => (
          <div key={item.accountType} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">{item.accountType}</p>
            <p className="mt-2 text-lg font-black text-white">{item.usdtBalance.toFixed(2)} USDT</p>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-600">{item.btcBalance.toFixed(8)} BTC</p>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
        <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">Futures Accounts · USDT Only</p>
        {futuresRows.length === 0 ? (
          <p className="mt-3 text-sm italic text-slate-500">No USDT futures balance data returned.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {futuresRows.map((row, index) => (
              <div key={`${row.marginCoin}-${index}`} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-black text-white">{row.marginCoin}</p>
                  <p className="text-sm font-black text-slate-200">{row.accountEquity.toFixed(2)} equity</p>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
                  <p>Available: {row.available.toFixed(2)}</p>
                  <p>Locked: {row.locked.toFixed(2)}</p>
                  <p>Unrealized: {row.unrealizedPnl.toFixed(2)}</p>
                  <p>Cross avail: {row.crossedMaxAvailable.toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
        <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">Spot Assets</p>
        {modeData.spotAssets.length === 0 ? (
          <p className="mt-3 text-sm italic text-slate-500">No spot assets returned.</p>
        ) : (
          <div className="mt-4 grid gap-2">
            {modeData.spotAssets.map((asset) => (
              <div key={asset.coin} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm">
                <span className="font-black text-white">{asset.coin}</span>
                <span className="text-slate-300">{asset.total.toFixed(6)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricBarStatsCard({
  title,
  subtitle,
  items,
  barColor,
  valueFormatter,
}: {
  title: string;
  subtitle: string;
  items: Array<{ label: string; value: number; detail: string }>;
  barColor: string;
  valueFormatter?: (value: number) => string;
}) {
  const positiveItems = items.filter((item) => item.value > 0);
  const data = positiveItems.length > 0 ? positiveItems : items.slice(0, 8);
  const maxValue = Math.max(...data.map((item) => Math.max(0, item.value)), 1);

  return (
    <div className="rounded-[1.5rem] border border-slate-800 bg-slate-950/40 p-5">
      <p className="text-sm font-black uppercase tracking-[0.15em] text-white">{title}</p>
      <p className="mt-2 text-xs text-slate-500">{subtitle}</p>
      <div className="mt-5 space-y-4">
        {data.length === 0 ? (
          <p className="text-sm italic text-slate-500">No symbol data available yet.</p>
        ) : (
          data.map((item) => {
            const widthPercent = Math.max(6, (Math.max(0, item.value) / maxValue) * 100);
            const formattedValue = valueFormatter ? valueFormatter(item.value) : item.value.toString();

            return (
              <div key={item.label} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-black text-white">{item.label}</p>
                  <p className="text-xs font-black text-slate-300">{formattedValue}</p>
                </div>
                <div className="h-3 overflow-hidden rounded-full border border-slate-800 bg-slate-900/60">
                  <div
                    className={cn("h-full rounded-full transition-all", barColor)}
                    style={{ width: `${widthPercent}%` }}
                  />
                </div>
                <p className="text-[11px] text-slate-500">{item.detail}</p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function DonutChart({
  values,
  colors,
  size = 128,
  strokeWidth = 16,
  centerLabel,
}: {
  values: number[];
  colors: string[];
  size?: number;
  strokeWidth?: number;
  centerLabel?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  let offset = 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#1f2937"
          strokeWidth={strokeWidth}
        />
        {values.map((value, index) => {
          const safeValue = Math.max(0, value);
          const dash = total > 0 ? (safeValue / total) * circumference : 0;
          const segment = (
            <circle
              key={`${index}-${value}`}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={colors[index] || '#94a3b8'}
              strokeWidth={strokeWidth}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="round"
            />
          );
          offset += dash;
          return segment;
        })}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-center">
        <span className="text-sm font-black text-white">{centerLabel || `${total.toFixed(0)}`}</span>
      </div>
    </div>
  );
}

function formatDurationMs(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatExchangeLabel(exchange: string) {
  if (exchange === 'bybit') return 'Bybit';
  if (exchange === 'binance') return 'Binance';
  if (exchange === 'bitget') return 'Bitget';
  return exchange;
}

function formatAgeMs(ageMs: number | null) {
  if (ageMs === null) return '-';
  if (ageMs < 1000) return `${ageMs} ms`;
  return `${(ageMs / 1000).toFixed(1)} s`;
}

function HeatmapChart({ data }: { data: BookmapSummary | null }) {
  const rows = data?.heatmap.rows || [];
  const columns = data?.heatmap.columns || [];
  const mids = data?.heatmap.mids || [];
  const cells = data?.heatmap.cells || [];
  const overlayTrades = data?.heatmapTrades || [];
  const supportZones = data?.zones.supports || [];
  const resistanceZones = data?.zones.resistances || [];
  const supportDiagnostics = data?.zoneDiagnostics.supports || [];
  const resistanceDiagnostics = data?.zoneDiagnostics.resistances || [];

  if (rows.length === 0 || columns.length === 0 || cells.length === 0) {
    return (
      <div className="flex h-[380px] items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/50 text-sm text-slate-500">
        El heatmap se esta calentando. Esperando suficiente historico de liquidez.
      </div>
    );
  }

  const priceLine = columns.map((_, columnIndex) => {
    const mid = mids[columnIndex] ?? data?.composite.mid ?? rows[Math.floor(rows.length / 2)];
    let nearestRow = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const distance = Math.abs(rows[rowIndex] - mid);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestRow = rowIndex;
      }
    }
    return nearestRow;
  });

  const findRowIndex = (price: number) => {
    let nearestRow = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const distance = Math.abs(rows[rowIndex] - price);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestRow = rowIndex;
      }
    }
    return nearestRow;
  };

  const zoneBands = [
    ...supportZones.map((zone) => ({
      type: 'support' as const,
      rowIndex: findRowIndex(zone.price),
      label: `BUY ${zone.price.toFixed(4)}`,
      price: zone.price,
      strength: zone.totalNotional,
      status: supportDiagnostics.find((item) => item.price === zone.price)?.status || 'holding',
    })),
    ...resistanceZones.map((zone) => ({
      type: 'resistance' as const,
      rowIndex: findRowIndex(zone.price),
      label: `SELL ${zone.price.toFixed(4)}`,
      price: zone.price,
      strength: zone.totalNotional,
      status: resistanceDiagnostics.find((item) => item.price === zone.price)?.status || 'holding',
    })),
  ]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 4);

  const visibleSupports = supportZones
    .slice(0, 2)
    .map((zone) => `${zone.price.toFixed(4)} (${zone.distancePercent.toFixed(2)}%)`);
  const visibleResistances = resistanceZones
    .slice(0, 2)
    .map((zone) => `${zone.price.toFixed(4)} (${zone.distancePercent.toFixed(2)}%)`);
  const latestProfile = rows.map((_, rowIndex) => cells[rowIndex]?.[columns.length - 1] ?? 0);
  const latestProfileMax = Math.max(...latestProfile, 0.0001);
  const currentMid = mids[mids.length - 1] ?? data?.composite.mid ?? rows[Math.floor(rows.length / 2)];
  const activeSweepRow = data?.liquiditySetup.sweep.sweptZonePrice ? findRowIndex(data.liquiditySetup.sweep.sweptZonePrice) : null;
  const targetRow = data?.liquiditySetup.target.targetZonePrice ? findRowIndex(data.liquiditySetup.target.targetZonePrice) : null;
  const pricePathPoints = priceLine
    .map((rowIndex, columnIndex) => `${((columnIndex + 0.5) / columns.length) * 100},${((rowIndex + 0.5) / rows.length) * 100}`)
    .join(' ');
  const heatColor = (intensity: number) => {
    if (intensity >= 0.92) return `rgba(245, 248, 255, ${Math.min(1, 0.85 + intensity * 0.15)})`;
    if (intensity >= 0.78) return `rgba(255, 214, 102, ${0.28 + intensity * 0.5})`;
    if (intensity >= 0.58) return `rgba(124, 214, 255, ${0.18 + intensity * 0.5})`;
    if (intensity >= 0.32) return `rgba(44, 154, 255, ${0.12 + intensity * 0.45})`;
    if (intensity >= 0.12) return `rgba(33, 91, 160, ${0.08 + intensity * 0.35})`;
    return `rgba(6, 25, 49, ${0.92})`;
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-black uppercase tracking-[0.2em] text-white">Heatmap</p>
          <p className="mt-1 text-[11px] text-slate-500">
            Brillo = liquidez resting. La linea blanca sigue el precio medio y la barra lateral muestra donde esta ahora la liquidez mas fuerte.
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Range</p>
          <p className="text-xs font-black text-slate-300">{rows[0].toFixed(4)} / {rows[rows.length - 1].toFixed(4)}</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[64px_minmax(0,1fr)_72px] gap-2 sm:grid-cols-[78px_minmax(0,1fr)_88px] sm:gap-3">
        <div className="grid h-[380px]" style={{ gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))` }}>
          {rows.map((price, index) => (
            <div key={`${price}-${index}`} className="flex items-center text-[10px] font-black text-slate-500">
              {price.toFixed(4)}
            </div>
          ))}
        </div>

        <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70">
          <div
            className="pointer-events-none absolute inset-0 z-[1] grid"
            style={{
              gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))`,
            }}
          >
            {zoneBands.map((band, index) => (
              <div
                key={`${band.type}-${band.rowIndex}-${index}`}
                className="col-span-full flex items-center"
                style={{ gridColumn: `1 / span ${columns.length}`, gridRow: band.rowIndex + 1 }}
              >
                <div
                  className={cn(
                    "w-full rounded-full",
                    band.type === 'support'
                      ? band.status === 'pulling'
                        ? 'bg-emerald-500/40'
                        : band.status === 'consumed'
                          ? 'bg-amber-300/70'
                          : 'bg-emerald-300/75'
                      : band.status === 'pulling'
                        ? 'bg-rose-500/40'
                        : band.status === 'consumed'
                          ? 'bg-amber-300/70'
                          : 'bg-rose-300/75'
                  )}
                  style={{ height: `${band.strength > 500000 ? 6 : band.strength > 150000 ? 4 : 2}px` }}
                />
              </div>
            ))}
            {activeSweepRow !== null && (
              <div className="col-span-full flex items-center" style={{ gridColumn: `1 / span ${columns.length}`, gridRow: activeSweepRow + 1 }}>
                <div className="h-[2px] w-full border-t border-dashed border-amber-300/90" />
              </div>
            )}
            {targetRow !== null && (
              <div className="col-span-full flex items-center" style={{ gridColumn: `1 / span ${columns.length}`, gridRow: targetRow + 1 }}>
                <div className="h-[2px] w-full border-t border-dashed border-cyan-300/90" />
              </div>
            )}
          </div>

          <div
            className="grid h-[380px] w-full relative z-0"
            style={{
              gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))`,
            }}
          >
            {rows.map((_, rowIndex) =>
              columns.map((column, columnIndex) => {
                const intensity = cells[rowIndex]?.[columnIndex] ?? 0;

                return (
                  <div
                    key={`${rowIndex}-${column}`}
                    style={{ backgroundColor: heatColor(intensity) }}
                    className="border-[0.5px] border-slate-950/30"
                    title={`${rows[rowIndex].toFixed(4)} | ${new Date(column).toLocaleTimeString()} | ${(intensity * 100).toFixed(1)}%`}
                  />
                );
              })
            )}
          </div>

          <svg className="pointer-events-none absolute inset-0 z-[2] h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="rgba(255,255,255,0.9)"
              strokeWidth="0.45"
              points={pricePathPoints}
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          <div
            className="pointer-events-none absolute inset-0 z-[3] grid"
            style={{
              gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))`,
            }}
          >
            {priceLine.map((rowIndex, columnIndex) => (
              <div
                key={`line-${columnIndex}`}
                className="flex items-center justify-center"
                style={{ gridColumn: columnIndex + 1, gridRow: rowIndex + 1 }}
              >
                <div className="h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]" />
              </div>
            ))}
          </div>

          <div
            className="pointer-events-none absolute inset-0 z-[4] grid"
            style={{
              gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))`,
            }}
          >
            {overlayTrades.map((trade, index) => (
              <div
                key={`trade-${trade.timestamp}-${index}`}
                className="flex items-center justify-center"
                style={{ gridColumn: trade.columnIndex + 1, gridRow: trade.rowIndex + 1 }}
                title={`${trade.side} ${trade.size.toFixed(4)} @ ${trade.price.toFixed(4)} · ${formatExchangeLabel(trade.exchange)}`}
              >
                <div
                  className={cn(
                    "rounded-full border shadow-[0_0_10px_rgba(0,0,0,0.4)]",
                    trade.side === 'buy'
                      ? "border-emerald-200 bg-emerald-300"
                      : "border-rose-200 bg-rose-300"
                  )}
                  style={{
                    width: `${Math.min(10, 4 + trade.size * 1.5)}px`,
                    height: `${Math.min(10, 4 + trade.size * 1.5)}px`,
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2">
          <p className="mb-2 text-center text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Now</p>
          <div className="grid h-[380px]" style={{ gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))` }}>
            {rows.map((price, rowIndex) => {
              const intensity = latestProfile[rowIndex] ?? 0;
              const widthPercent = Math.max(4, (intensity / latestProfileMax) * 100);
              const isAboveMid = price > currentMid;
              return (
                <div key={`profile-${price}-${rowIndex}`} className="flex items-center">
                  <div className="h-[70%] w-full rounded-full bg-slate-900/80">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        isAboveMid ? 'bg-rose-300/80' : 'bg-emerald-300/80'
                      )}
                      style={{ width: `${widthPercent}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 md:grid-cols-3">
        <span>Supports: {visibleSupports.length ? visibleSupports.join(' · ') : '-'}</span>
        <span className="text-center">max intensity {data?.heatmap.maxIntensity.toFixed(0) || 0}</span>
        <span className="text-right">Resistances: {visibleResistances.length ? visibleResistances.join(' · ') : '-'}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-[0.18em]">
        {supportDiagnostics.slice(0, 2).map((zone) => (
          <span key={`support-state-${zone.price}`} className="rounded-full border border-emerald-800/50 bg-emerald-950/20 px-3 py-1 text-emerald-200">
            Buy {zone.price.toFixed(4)} {zone.status}
          </span>
        ))}
        {resistanceDiagnostics.slice(0, 2).map((zone) => (
          <span key={`resistance-state-${zone.price}`} className="rounded-full border border-rose-800/50 bg-rose-950/20 px-3 py-1 text-rose-200">
            Sell {zone.price.toFixed(4)} {zone.status}
          </span>
        ))}
        {data?.liquiditySetup.sweep.sweptZonePrice && (
          <span className="rounded-full border border-amber-700/50 bg-amber-950/20 px-3 py-1 text-amber-200">
            Sweep {data.liquiditySetup.sweep.sweptZonePrice.toFixed(4)}
          </span>
        )}
        {data?.liquiditySetup.target.targetZonePrice && (
          <span className="rounded-full border border-cyan-700/50 bg-cyan-950/20 px-3 py-1 text-cyan-200">
            Target {data.liquiditySetup.target.targetZonePrice.toFixed(4)}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
        <span>{new Date(columns[0]).toLocaleTimeString()}</span>
        <span>{new Date(columns[columns.length - 1]).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

function BookmapPanel({
  symbol,
  onSymbolChange,
  data,
  loading,
  message,
  expanded,
  onToggleExpanded,
  onExecutePreSignal,
  executingPreSignal,
  onTrackPaperSignal,
  creatingPaperSignal,
  paperData,
  paperMessage,
}: {
  symbol: string;
  onSymbolChange: (value: string) => void;
  data: BookmapSummary | null;
  loading: boolean;
  message: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onExecutePreSignal: () => void;
  executingPreSignal: boolean;
  onTrackPaperSignal: () => void;
  creatingPaperSignal: boolean;
  paperData: HeatmapPaperPayload | null;
  paperMessage: string | null;
}) {
  return (
    <section className="rounded-[2rem] border border-cyan-900/50 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.14),_transparent_30%),linear-gradient(180deg,rgba(2,6,23,0.96),rgba(2,6,23,0.88))] p-6 shadow-2xl shadow-slate-950/40">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.35em] text-cyan-300">Bookmap Lab</p>
          <h2 className="mt-2 text-2xl font-black uppercase tracking-tight text-white">Cross-Exchange Liquidity Radar</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Bybit y Binance alimentan el mapa de liquidez. Bitget queda expuesto como referencia del venue de ejecucion.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-xs font-black uppercase tracking-[0.2em] text-slate-200 transition-colors hover:border-cyan-400 hover:text-white"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded ? 'Hide' : 'Show'}
          </button>
          <select
            value={symbol}
            onChange={(event) => onSymbolChange(event.target.value)}
            className="rounded-2xl border border-slate-700 bg-slate-950/80 px-4 py-3 text-sm font-black uppercase tracking-[0.15em] text-white outline-none transition-colors hover:border-cyan-400"
          >
            {AVAILABLE_SYMBOLS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Signal Bias</p>
            <p className={cn(
              "mt-1 text-sm font-black uppercase",
              data?.trigger.bias === 'long'
                ? 'text-emerald-400'
                : data?.trigger.bias === 'short'
                  ? 'text-rose-400'
                  : 'text-amber-300'
            )}>
              {data?.trigger.bias || 'loading'}
            </p>
          </div>
        </div>
      </div>

      {message && (
        <div className="mt-5 rounded-2xl border border-rose-800/40 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">
          {message}
        </div>
      )}

      {expanded ? (
      <div className="mt-6 grid gap-4">
        <div className="grid gap-4 2xl:grid-cols-2">
          <div className="rounded-2xl border border-cyan-900/40 bg-cyan-950/10 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">Liquidity Setup</p>
                <h3 className={cn(
                  "mt-2 text-xl font-black uppercase",
                  data?.liquiditySetup.decision.state === 'EXECUTABLE'
                    ? 'text-emerald-300'
                    : data?.liquiditySetup.decision.state === 'VALID' || data?.liquiditySetup.decision.state === 'CANDIDATE'
                      ? 'text-cyan-300'
                      : data?.liquiditySetup.decision.state === 'WATCH'
                        ? 'text-amber-300'
                        : 'text-rose-300'
                )}>
                  {data?.liquiditySetup.decision.setupType === 'LONG_SWEEP_REVERSAL'
                    ? 'Long Sweep Reversal'
                    : data?.liquiditySetup.decision.setupType === 'SHORT_SWEEP_REVERSAL'
                      ? 'Short Sweep Reversal'
                      : 'No Valid Sweep Setup'}
                </h3>
                <p className="mt-2 text-sm text-slate-300">
                  {data?.liquiditySetup.decision.state === 'EXECUTABLE'
                    ? 'El barrido, el giro y la economia del trade ya permiten tratarlo como setup ejecutable.'
                    : data?.liquiditySetup.decision.state === 'REJECTED'
                      ? 'La idea esta descartada por falta de recorrido, reversal flojo o camino sucio hacia la siguiente liquidez.'
                      : 'El setup existe, pero aun necesita mas confirmacion antes de convertirse en entrada.'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 lg:min-w-[340px]">
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">State</p>
                  <p className="mt-1 text-lg font-black text-white">{data?.liquiditySetup.decision.state || '-'}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Probability</p>
                  <p className="mt-1 text-lg font-black text-cyan-300">
                    {data ? `${(data.liquiditySetup.score.probabilityToTarget * 100).toFixed(0)}%` : '-'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Target Move</p>
                  <p className="mt-1 text-sm font-black text-white">
                    {data?.liquiditySetup.economics.targetMovePercent ? `${data.liquiditySetup.economics.targetMovePercent.toFixed(2)}%` : '-'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Final Score</p>
                  <p className="mt-1 text-sm font-black text-white">
                    {data?.liquiditySetup.score.finalScore?.toFixed(1) || '-'}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Sweep</p>
                <p className="mt-1 text-sm font-black text-white">{data?.liquiditySetup.score.sweepScore?.toFixed(0) || '-'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Reversal</p>
                <p className="mt-1 text-sm font-black text-white">{data?.liquiditySetup.score.reversalScore?.toFixed(0) || '-'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Target</p>
                <p className="mt-1 text-sm font-black text-white">{data?.liquiditySetup.score.targetScore?.toFixed(0) || '-'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Economics</p>
                <p className="mt-1 text-sm font-black text-white">{data?.liquiditySetup.score.economicsScore?.toFixed(0) || '-'}</p>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Sweeped Zone</p>
                <p className="mt-1 text-sm font-black text-white">{data?.liquiditySetup.sweep.sweptZonePrice?.toFixed(4) || '-'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Target Zone</p>
                <p className="mt-1 text-sm font-black text-white">{data?.liquiditySetup.target.targetZonePrice?.toFixed(4) || '-'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Reward / Risk</p>
                <p className="mt-1 text-sm font-black text-white">{data?.liquiditySetup.economics.rewardRisk?.toFixed(2) || '-'}</p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {(data?.liquiditySetup.decision.hardRejectReasons.length
                ? data.liquiditySetup.decision.hardRejectReasons
                : data?.liquiditySetup.decision.reasons.slice(0, 4) || []
              ).map((reason, index) => (
                <span
                  key={`${reason}-${index}`}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em]",
                    data?.liquiditySetup.decision.hardRejectReasons.length
                      ? 'border-rose-800/50 bg-rose-950/30 text-rose-200'
                      : 'border-cyan-800/50 bg-cyan-950/30 text-cyan-200'
                  )}
                >
                  {reason}
                </span>
              ))}
            </div>
            {data?.paperCalibration && (
              <p className="mt-3 text-xs font-bold text-slate-400">
                Paper adj {data.paperCalibration.adjustment >= 0 ? '+' : ''}{(data.paperCalibration.adjustment * 100).toFixed(1)} pts
                {data.paperCalibration.sampleSize > 0
                  ? ` · sample ${data.paperCalibration.sampleSize} · symbol win ${data.paperCalibration.symbolWinRate?.toFixed(1) || 0}%`
                  : ''}
              </p>
            )}
          </div>

          <div className={cn(
            "rounded-2xl border p-4",
            data?.preSignal.actionable
              ? data.preSignal.bias === 'long'
                ? 'border-emerald-700/50 bg-emerald-950/20'
                : 'border-rose-700/50 bg-rose-950/20'
              : 'border-slate-800 bg-slate-950/60'
          )}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500">Pre-Signal</p>
                <h3 className={cn(
                  "mt-2 text-xl font-black uppercase",
                  data?.preSignal.bias === 'long'
                    ? 'text-emerald-300'
                    : data?.preSignal.bias === 'short'
                      ? 'text-rose-300'
                      : 'text-white'
                )}>
                  {data?.preSignal.actionable
                    ? `${data.preSignal.bias.toUpperCase()} ${data.preSignal.mode}`
                    : 'Watching setup'}
                </h3>
                <p className="mt-2 text-sm text-slate-300">
                  {data?.preSignal.actionable
                    ? 'La microestructura ya permite preparar una entrada condicionada.'
                    : 'Aun no hay suficiente confluencia para tratarlo como setup ejecutable.'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 lg:min-w-[320px]">
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Confidence</p>
                  <p className="mt-1 text-lg font-black text-cyan-300">{data ? `${(data.preSignal.confidence * 100).toFixed(0)}%` : '-'}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Mode</p>
                  <p className="mt-1 text-lg font-black text-white">{data?.preSignal.mode || '-'}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Entry</p>
                  <p className="mt-1 text-sm font-black text-white">{data?.preSignal.entryPrice?.toFixed(4) || '-'}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">R/R</p>
                  <p className="mt-1 text-sm font-black text-white">{data?.preSignal.rewardRisk?.toFixed(2) || '-'}</p>
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Stop</p>
                <p className="mt-1 text-sm font-black text-rose-300">{data?.preSignal.stopPrice?.toFixed(4) || '-'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Target</p>
                <p className="mt-1 text-sm font-black text-emerald-300">{data?.preSignal.targetPrice?.toFixed(4) || '-'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Invalidation</p>
                <p className="mt-1 text-xs font-bold text-slate-300">{data?.preSignal.invalidation || '-'}</p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {data?.preSignal.reasons.map((reason, index) => (
                <span key={`${reason}-${index}`} className="rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-slate-300">
                  {reason}
                </span>
              )) || null}
            </div>
            {data?.preSignal.invalidationReason && (
              <p className="mt-3 text-xs font-bold text-amber-300">
                Ultimo cambio de estado: {data.preSignal.invalidationReason}
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onExecutePreSignal}
                disabled={!data?.preSignal.actionable || executingPreSignal}
                className={cn(
                  "rounded-2xl px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition-all",
                  data?.preSignal.actionable && !executingPreSignal
                    ? data.preSignal.bias === 'long'
                      ? "bg-emerald-400 text-slate-950 hover:bg-emerald-300"
                      : "bg-rose-400 text-slate-950 hover:bg-rose-300"
                    : "cursor-not-allowed border border-slate-800 bg-slate-950/50 text-slate-500"
                )}
              >
                {executingPreSignal
                  ? 'Executing...'
                  : data?.preSignal.actionable
                    ? `Send ${data.preSignal.bias.toUpperCase()} to Entry`
                    : 'Waiting for executable setup'}
              </button>
              <button
                type="button"
                onClick={onTrackPaperSignal}
                disabled={!data?.preSignal.actionable || creatingPaperSignal}
                className={cn(
                  "rounded-2xl border px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition-all",
                  data?.preSignal.actionable && !creatingPaperSignal
                    ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200 hover:border-cyan-300 hover:text-cyan-100"
                    : "cursor-not-allowed border-slate-800 bg-slate-950/50 text-slate-500"
                )}
              >
                {creatingPaperSignal ? 'Tracking...' : 'Track on Paper'}
              </button>
              <p className="text-xs text-slate-400">
                La ejecucion usa `Entry` con `origin: Heatmap`, asi que sigue respetando el bloqueo global de nuevas entradas.
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3 2xl:col-span-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Composite Mid</p>
              <p className="mt-2 text-2xl font-black text-white">
                {data?.composite.mid ? data.composite.mid.toFixed(4) : '-'}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Spread {data?.composite.spreadBps !== null && data?.composite.spreadBps !== undefined ? `${data.composite.spreadBps.toFixed(2)} bps` : '-'}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Tape Imbalance</p>
              <p className={cn(
                "mt-2 text-2xl font-black",
                (data?.tape.imbalance || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
              )}>
                {data ? `${(data.tape.imbalance * 100).toFixed(1)}%` : '-'}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Buys {data?.tape.buyVolume.toFixed(3) || '-'} / Sells {data?.tape.sellVolume.toFixed(3) || '-'}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Trigger Confidence</p>
              <p className="mt-2 text-2xl font-black text-cyan-300">
                {data ? `${(data.trigger.confidence * 100).toFixed(0)}%` : '-'}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Ref {data?.trigger.referencePrice ? data.trigger.referencePrice.toFixed(4) : 'waiting'}
              </p>
            </div>
          </div>

          <div className="2xl:col-span-2">
            <HeatmapChart data={data} />
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-black uppercase tracking-[0.2em] text-white">Absorption</p>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Tape against resting liquidity</p>
            </div>
            <div className="mt-4 space-y-3">
              {data?.absorptionSignals.length ? data.absorptionSignals.map((signal, index) => (
                <div key={`${signal.side}-${signal.price}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className={cn(
                      "text-sm font-black uppercase",
                      signal.side === 'bullish' ? 'text-emerald-300' : 'text-rose-300'
                    )}>
                      {signal.side === 'bullish' ? 'Bullish Absorption' : 'Bearish Absorption'}
                    </p>
                    <p className="text-xs font-black text-slate-200">{(signal.confidence * 100).toFixed(0)}%</p>
                  </div>
                  <p className="mt-2 text-xs text-slate-300">{signal.note}</p>
                  <p className="mt-2 text-[11px] text-slate-500">
                    Nivel {signal.price.toFixed(4)} · volumen absorbido {signal.absorbedVolume.toFixed(4)} · prints {signal.tradeCount}
                  </p>
                </div>
              )) : (
                <p className="text-sm text-slate-500">
                  Todavia no hay una absorcion suficientemente clara. Busca repeticion de prints contra una zona que no cede.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-black uppercase tracking-[0.2em] text-white">Paper Tracking</p>
                <p className="mt-1 text-[11px] text-slate-500">Seguimiento teorico de senales Heatmap sin enviar orden real.</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Closed PnL</p>
                <p className={cn(
                  "text-lg font-black",
                  (paperData?.summary.totalPnl || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'
                )}>
                  {paperData ? `${paperData.summary.totalPnl.toFixed(2)}` : '-'}
                </p>
              </div>
            </div>
            {paperMessage && (
              <div className="mt-3 rounded-xl border border-rose-800/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                {paperMessage}
              </div>
            )}
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Open Paper Trades</p>
                <div className="mt-3 space-y-3">
                  {paperData?.open.length ? paperData.open.map((trade) => (
                    <div key={trade.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-black text-white">{trade.symbol}</p>
                        <span className={cn(
                          "text-[10px] font-black uppercase",
                          trade.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'
                        )}>
                          {trade.side}
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-400">
                        Entry {trade.entryPrice.toFixed(4)} · Stop {trade.stopPrice.toFixed(4)} · Target {trade.targetPrice.toFixed(4)}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Conf {(trade.confidence * 100).toFixed(0)}% · {new Date(trade.createdAt).toLocaleTimeString()}
                      </p>
                    </div>
                  )) : (
                    <p className="text-sm text-slate-500">No hay paper trades abiertos ahora mismo.</p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Recent Results</p>
                <div className="mt-3 space-y-3">
                  {paperData?.history.length ? paperData.history.slice(0, 6).map((trade) => (
                    <div key={trade.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-black text-white">{trade.symbol}</p>
                        <p className={cn(
                          "text-sm font-black",
                          (trade.profitLossFiat || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'
                        )}>
                          {(trade.profitLossFiat || 0).toFixed(2)}
                        </p>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-400">
                        {trade.side.toUpperCase()} · exit {trade.exitReason || '-'} · {(trade.profitLossPercent || 0).toFixed(2)}%
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {trade.closedAt ? new Date(trade.closedAt).toLocaleString() : '-'}
                      </p>
                    </div>
                  )) : (
                    <p className="text-sm text-slate-500">Todavia no hay resultados cerrados para Heatmap paper.</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 2xl:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-black uppercase tracking-[0.2em] text-white">Paper Analytics</p>
                <p className="mt-1 text-[11px] text-slate-500">Metricas especificas del comportamiento de las pre-senales Heatmap.</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Win Rate</p>
                <p className="mt-1 text-lg font-black text-emerald-300">
                  {paperData ? `${paperData.analytics.winRate.toFixed(1)}%` : '-'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Targets / Stops</p>
                <p className="mt-1 text-lg font-black text-white">
                  {paperData ? `${paperData.analytics.targetHits} / ${paperData.analytics.stopHits}` : '-'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Avg Duration</p>
                <p className="mt-1 text-lg font-black text-white">
                  {paperData ? formatDurationMs(paperData.analytics.averageDurationMs) : '-'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Closed</p>
                <p className="mt-1 text-lg font-black text-white">
                  {paperData ? paperData.analytics.closedCount : '-'}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Top Symbols</p>
              <div className="mt-3 space-y-3">
                {paperData?.analytics.symbolPerformance.length ? paperData.analytics.symbolPerformance.map((item) => (
                  <div key={item.symbol} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-black text-white">{item.symbol}</p>
                      <p className={cn(
                        "text-sm font-black",
                        item.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'
                      )}>
                        {item.pnl.toFixed(2)}
                      </p>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-400">
                      {item.total} trades · wins {item.wins} · win rate {item.winRate.toFixed(1)}%
                    </p>
                  </div>
                )) : (
                  <p className="text-sm text-slate-500">Aun no hay suficiente historial Heatmap paper para analytics por simbolo.</p>
                )}
              </div>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">By Setup</p>
                <div className="mt-3 space-y-3">
                  {paperData?.analytics.setupPerformance.length ? paperData.analytics.setupPerformance.map((item) => (
                    <div key={item.setup} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="max-w-[75%] text-xs font-black text-white">{item.setup}</p>
                        <p className={cn(
                          "text-sm font-black",
                          item.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'
                        )}>
                          {item.pnl.toFixed(2)}
                        </p>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-400">
                        {item.total} trades · wins {item.wins} · win rate {item.winRate.toFixed(1)}%
                      </p>
                    </div>
                  )) : (
                    <p className="text-sm text-slate-500">Aun no hay setups suficientes para comparar patrones.</p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">By Confidence</p>
                <div className="mt-3 space-y-3">
                  {paperData?.analytics.confidencePerformance.length ? paperData.analytics.confidencePerformance.map((item) => (
                    <div key={item.bucket} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-black text-white">{item.bucket}</p>
                        <p className={cn(
                          "text-sm font-black",
                          item.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'
                        )}>
                          {item.pnl.toFixed(2)}
                        </p>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-400">
                        {item.total} trades · wins {item.wins} · win rate {item.winRate.toFixed(1)}%
                      </p>
                    </div>
                  )) : (
                    <p className="text-sm text-slate-500">Aun no hay suficientes resultados por confianza.</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 2xl:col-span-2">
            <div className="rounded-2xl border border-emerald-900/40 bg-emerald-950/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-black uppercase tracking-[0.2em] text-emerald-300">Nearest Buy Wall</p>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">El resto ya se ve en el heatmap</p>
              </div>
              <div className="mt-4 space-y-3">
                {data?.zones.supports.length ? data.zones.supports.slice(0, 1).map((zone) => (
                  <div key={`support-${zone.price}`} className="rounded-2xl border border-emerald-900/30 bg-slate-950/50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-black text-white">{zone.price.toFixed(4)}</p>
                      <p className="text-xs font-black text-emerald-300">{zone.totalNotional.toFixed(0)} notion.</p>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-400">
                      {zone.exchangeCount} venues · {zone.exchanges.map(formatExchangeLabel).join(', ')} · dist {zone.distancePercent.toFixed(3)}%
                    </p>
                  </div>
                )) : (
                  <p className="text-sm text-slate-500">{loading ? 'Loading support zones...' : 'No support zones ready yet.'}</p>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-rose-900/40 bg-rose-950/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-black uppercase tracking-[0.2em] text-rose-300">Nearest Sell Wall</p>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">El resto ya se ve en el heatmap</p>
              </div>
              <div className="mt-4 space-y-3">
                {data?.zones.resistances.length ? data.zones.resistances.slice(0, 1).map((zone) => (
                  <div key={`resistance-${zone.price}`} className="rounded-2xl border border-rose-900/30 bg-slate-950/50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-black text-white">{zone.price.toFixed(4)}</p>
                      <p className="text-xs font-black text-rose-300">{zone.totalNotional.toFixed(0)} notion.</p>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-400">
                      {zone.exchangeCount} venues · {zone.exchanges.map(formatExchangeLabel).join(', ')} · dist {zone.distancePercent.toFixed(3)}%
                    </p>
                  </div>
                )) : (
                  <p className="text-sm text-slate-500">{loading ? 'Loading resistance zones...' : 'No resistance zones ready yet.'}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="text-sm font-black uppercase tracking-[0.2em] text-white">Venue Snapshot</p>
            <div className="mt-4 space-y-3">
              {data?.exchanges.length ? data.exchanges.map((exchange) => (
                <div key={exchange.exchange} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-black text-white">{formatExchangeLabel(exchange.exchange)}</p>
                    <span className={cn(
                      "rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-[0.2em]",
                      exchange.isFresh
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : 'bg-amber-500/10 text-amber-300'
                    )}>
                      {exchange.status}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
                    <p>Bid: {exchange.bestBid?.toFixed(4) || '-'}</p>
                    <p>Ask: {exchange.bestAsk?.toFixed(4) || '-'}</p>
                    <p>Spread: {exchange.spreadBps !== null ? `${exchange.spreadBps.toFixed(2)} bps` : '-'}</p>
                    <p>Age: {formatAgeMs(exchange.lastUpdateAgeMs)}</p>
                  </div>
                </div>
              )) : (
                <p className="text-sm text-slate-500">{loading ? 'Connecting to venues...' : 'No venue snapshot yet.'}</p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="text-sm font-black uppercase tracking-[0.2em] text-white">Trigger Notes</p>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              {data?.trigger.reason || 'Waiting for a first confirmed confluence between zone and tape.'}
            </p>
            <div className="mt-4 h-3 overflow-hidden rounded-full border border-slate-800 bg-slate-900/60">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  data?.trigger.bias === 'long'
                    ? 'bg-emerald-400'
                    : data?.trigger.bias === 'short'
                      ? 'bg-rose-400'
                      : 'bg-amber-300'
                )}
                style={{ width: `${Math.max(8, (data?.trigger.confidence || 0) * 100)}%` }}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="text-sm font-black uppercase tracking-[0.2em] text-white">Recent Tape</p>
            <div className="mt-4 space-y-2">
              {data?.tape.recentTrades.length ? data.tape.recentTrades.slice(-8).reverse().map((trade, index) => (
                <div key={`${trade.exchange}-${trade.timestamp}-${index}`} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs">
                  <div>
                    <p className="font-black text-white">{formatExchangeLabel(trade.exchange)}</p>
                    <p className="text-slate-500">{new Date(trade.timestamp).toLocaleTimeString()}</p>
                  </div>
                  <div className="text-right">
                    <p className={cn("font-black uppercase", trade.side === 'buy' ? 'text-emerald-300' : 'text-rose-300')}>
                      {trade.side} {trade.size.toFixed(4)}
                    </p>
                    <p className="text-slate-400">{trade.price.toFixed(4)}</p>
                  </div>
                </div>
              )) : (
                <p className="text-sm text-slate-500">{loading ? 'Loading tape...' : 'No trades yet.'}</p>
              )}
            </div>
          </div>
        </div>
      </div>
      ) : (
        <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-5 text-sm text-slate-400">
          Panel oculto. Mantiene el seguimiento del simbolo y volvera a abrirse cuando quieras.
        </div>
      )}
    </section>
  );
}

