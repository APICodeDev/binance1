'use client';

import Image from 'next/image';
import { useState, useEffect, useCallback, type ReactNode } from 'react';
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
  Bot,
  Zap,
  Globe,
  Hammer,
  Menu
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
}

interface StatsPayload {
  demo: StatsMode;
  live: StatsMode;
  timestamp: string;
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
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [newPos, setNewPos] = useState({ symbol: '', amount: '100', type: 'buy' });
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
  const [isOnline, setIsOnline] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [syncStatusLabel, setSyncStatusLabel] = useState<'live' | 'paused' | 'offline'>('live');
  const [statsData, setStatsData] = useState<StatsPayload | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsMessage, setStatsMessage] = useState<string | null>(null);

  const filteredSymbols = AVAILABLE_SYMBOLS.filter((symbol) =>
    symbol.includes(newPos.symbol.toUpperCase())
  );

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
    fetchStats();

    if (!isOnline || !isDocumentVisible) {
      return;
    }

    const interval = setInterval(() => {
      runMonitor();
    }, 10000); 
    return () => clearInterval(interval);
  }, [authUser, fetchApiTokens, fetchAuditLogs, fetchData, fetchStats, isDocumentVisible, isOnline, runMonitor]);

  useEffect(() => {
    if (!authUser || !isOnline || !isDocumentVisible) {
      return;
    }

    fetchData(true);
  }, [authUser, fetchData, isDocumentVisible, isOnline]);

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

  const submitNewPosition = async () => {
    try {
      await apiClient.openPosition(newPos);
      setShowModal(false);
      setNewPos({ symbol: '', amount: '100', type: 'buy' });
      fetchData();
    } catch (error) {
      setErrorPopup('Error de red al intentar abrir la posición.');
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
      <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-8">
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
          </div>
        </header>

        {authUser.role === 'admin' && currentView === 'admin' && (
          <section className="rounded-[2rem] border border-slate-800 bg-slate-900/70 p-5 md:p-6 shadow-xl shadow-slate-950/20">
            <div className="flex flex-col gap-5">
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

          {/* History */}
          <section className="bg-slate-900/30 border border-slate-800/50 rounded-3xl overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-slate-800 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center bg-slate-900/50">
              <h2 className="text-lg font-black flex items-center gap-3">
                <History className="text-amber-400" /> {tradingMode.toUpperCase()} TRADE LOGS
              </h2>
              <button onClick={clearHistory} className="text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-rose-400 flex items-center gap-2 transition-colors">
                <Trash2 size={14} /> Clear {tradingMode} History
              </button>
            </div>

            <div className="divide-y divide-slate-800/40 md:hidden">
              {closedPositions.map((pos) => {
                const durationStr = formatClosedDuration(pos.createdAt, pos.closedAt);
                return (
                  <div key={pos.id} className="px-4 py-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-white">{pos.symbol}</p>
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
                          {pos.origin || '-'}{pos.timeframe ? ` / ${pos.timeframe}` : ''}
                        </p>
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
                  </div>
                );
              })}
              {closedPositions.length === 0 && (
                <div className="px-6 py-12 text-center text-slate-600 italic text-sm">No missions completed yet in {tradingMode}.</div>
              )}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-[10px] text-slate-500 uppercase tracking-widest font-black border-b border-slate-800/50">
                    <th className="px-6 py-4">Symbol</th>
                    <th className="px-6 py-4">Origin / TF</th>
                    <th className="px-6 py-4">Type</th>
                    <th className="px-6 py-4">Entry</th>
                    <th className="px-6 py-4">PnL %</th>
                    <th className="px-6 py-4">PnL {tradingMode === 'live' ? 'USDC' : 'USDT'}</th>
                    <th className="px-6 py-4">Closed At</th>
                    <th className="px-6 py-4">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/30">
                  {closedPositions?.map(pos => {
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
                      <td className="px-6 py-4 text-xs font-bold text-slate-500">
                        {pos.origin || '-'}{pos.timeframe ? ` / ${pos.timeframe}` : ''}
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
                    </tr>
                  )})}
                  {closedPositions.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-12 text-center text-slate-600 italic text-sm">No missions completed yet in {tradingMode}.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
  const entryCost = pos.entryPrice * pos.quantity * comm;
  const exitCost = pos.stopLoss * pos.quantity * comm;
  const grossPercent = pos.profitLossPercent;
  const netPercent = pos.entryPrice > 0 && pos.quantity > 0
    ? (pos.profitLossFiat / (pos.entryPrice * pos.quantity)) * 100
    : 0;
  const pnlSafe = isBuy 
    ? ((pos.stopLoss - pos.entryPrice) * pos.quantity) - entryCost - exitCost
    : ((pos.entryPrice - pos.stopLoss) * pos.quantity) - entryCost - exitCost;
  
  const isSafe = pnlSafe > 0;
  const isBreakeven = Math.abs(pnlSafe) < 0.05;
  const slAtEntry = Math.abs(pos.stopLoss - pos.entryPrice) < Math.max(0.0000001, pos.entryPrice * 0.0001);

  const exchangeUrl = `https://www.bitget.com/en/futures/usdt/${pos.symbol}`;

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
          <div className="flex items-center gap-2">
            <a 
              href={exchangeUrl} 
              target="_blank" 
              rel="noopener noreferrer" 
              className="group/link flex items-center gap-2"
            >
              <span className="text-2xl font-black tracking-tight text-white group-hover/link:text-amber-400 transition-colors">
                {pos.symbol}
              </span>
              <ExternalLink size={16} className="text-slate-600 group-hover/link:text-amber-400 transition-colors" />
            </a>
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
          <p className="text-sm font-mono text-slate-300">{formatPrice(pos.entryPrice, pos.pricePrecision)}</p>
          <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider">
            {new Date(pos.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="space-y-1 text-right">
          <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider">Stop Target</p>
          <p className={cn("text-sm font-mono", isSafe ? "text-emerald-400" : "text-rose-400/80")}>
            {formatPrice(pos.stopLoss, pos.pricePrecision)}
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

