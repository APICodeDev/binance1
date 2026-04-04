'use client';

import { useState, useEffect, useCallback } from 'react';
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
  Hammer
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { buildInfo } from '@/lib/buildInfo';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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
}

export default function Dashboard() {
  const [openPositions, setOpenPositions] = useState<Position[]>([]);
  const [closedPositions, setClosedPositions] = useState<Position[]>([]);
  const [botEnabled, setBotEnabled] = useState(true);
  const [tradingMode, setTradingMode] = useState<'demo' | 'live'>('demo');
  const [customAmount, setCustomAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [newPos, setNewPos] = useState({ symbol: '', amount: '100', type: 'buy' });
  const [totalPnl, setTotalPnl] = useState(0);
  const [showSplash, setShowSplash] = useState(true);
  const [showEjectModal, setShowEjectModal] = useState<Position | null>(null);
  const [lastEntryError, setLastEntryError] = useState<{timestamp: string; symbol: string; type: string; detail: string} | null>(null);
  const [errorPopup, setErrorPopup] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 4100);
    return () => clearTimeout(timer);
  }, []);

  const fetchData = useCallback(async (isSilent = false, overrideMode?: 'demo' | 'live') => {
    if (!isSilent) setLoading(true);
    const modeToUse = overrideMode || tradingMode;
    try {
      // Fetch positions with mode filter
      const res = await fetch(`/api/positions?mode=${modeToUse}`);
      const data = await res.json();
      setOpenPositions(data.open || []);
      setClosedPositions(data.history || []);
      setTotalPnl(data.totalPnl || 0);

      // Fetch bot status and global mode
      const settingsRes = await fetch('/api/settings');
      const settings = await settingsRes.json();
      setBotEnabled(settings.bot_enabled === '1');
      setCustomAmount(settings.custom_amount || '');
      setTradingMode(settings.trading_mode || 'demo');
      
      // Parse last entry error
      if (settings.last_entry_error) {
        try {
          const parsed = JSON.parse(settings.last_entry_error);
          setLastEntryError(parsed);
        } catch { setLastEntryError(null); }
      } else {
        setLastEntryError(null);
      }
    } catch (error) {
      console.error('Fetch error:', error);
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [tradingMode]);

  const runMonitor = useCallback(async () => {
    setSyncing(true);
    try {
      await fetch('/api/monitor');
      await fetchData(true);
    } catch (error) {
      console.error('Monitor sync error:', error);
    } finally {
      setSyncing(false);
    }
  }, [fetchData]);

  // Initial load and polling
  useEffect(() => {
    fetchData();
    const interval = setInterval(() => {
      runMonitor();
    }, 10000); 
    return () => clearInterval(interval);
  }, [fetchData, runMonitor]);

  const toggleBot = async () => {
    const newValue = botEnabled ? '0' : '1';
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_enabled: newValue }),
      });
      setBotEnabled(!botEnabled);
    } catch (error) {
      console.error('Toggle bot error:', error);
    }
  };

  const toggleMode = async () => {
    const newMode = tradingMode === 'demo' ? 'live' : 'demo';
    if (newMode === 'live' && !confirm('⚠️ ATENCIÓN: Activarás el modo EN VIVO. El bot operará con DINERO REAL. ¿Deseas continuar?')) {
      return;
    }
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trading_mode: newMode }),
      });
      setTradingMode(newMode);
      // Refetch immediately for the new mode
      fetchData(false, newMode);
    } catch (error) {
      console.error('Toggle mode error:', error);
    }
  };

  const saveCustomAmount = async (val: string) => {
    setCustomAmount(val);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_amount: val }),
      });
    } catch (error) {
      console.error('Save custom amount error:', error);
    }
  };

  const submitNewPosition = async () => {
    try {
      const res = await fetch('/api/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPos),
      });
      const data = await res.json();
      if (!data.error) {
        setShowModal(false);
        setNewPos({ symbol: '', amount: '100', type: 'buy' });
        fetchData();
      } else {
        setShowModal(false);
        setErrorPopup(data.detail || data.message || 'Unknown error');
        fetchData();
      }
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
      const res = await fetch('/api/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!data.error) {
        setShowEjectModal(null);
        fetchData();
      } else {
        alert('Error: ' + data.message);
      }
    } catch (error) {
      console.error('Manual eject error:', error);
      alert('Network error ejecting');
    }
  };

  const emergencyCloseAll = async () => {
    if (confirm('⚠️ ERES CONSCIENTE DE QUE ESTO CERRARÁ TODAS LAS POSICIONES (REALES Y DEMO)?')) {
      try {
        await fetch('/api/emergency', { method: 'POST' });
        fetchData();
      } catch (error) {
        alert('Error in emergency stop');
      }
    }
  };

  const clearHistory = async () => {
    if (confirm(`Are you sure you want to clear ${tradingMode.toUpperCase()} history and set Net Profit to zero?`)) {
      try {
        await fetch(`/api/positions?mode=${tradingMode}`, { method: 'DELETE' });
        fetchData();
      } catch (error) {
        alert('Error clearing history');
      }
    }
  };

  const totalSecuredProfit = openPositions.reduce((acc, pos) => {
    const isBuy = pos.positionType === 'buy';
    const comm = pos.commission ?? 0.0004;
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
          <motion.svg 
            animate={{ y: [0, -15, 0], scale: [1, 1.05, 1] }} 
            transition={{ duration: 1, ease: "easeInOut", repeat: Infinity }}
            className="w-[100px] h-[100px] mb-5 text-yellow-400" 
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
          </motion.svg>
          <h1 className="text-[40px] font-black tracking-[2px] m-0">TRADE<span className="text-yellow-400">BOT</span></h1>
          <div className="mt-2.5 text-base text-slate-400 tracking-[4px] uppercase">System Initializing</div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className={cn(
      "min-h-screen transition-all duration-1000",
      tradingMode === 'live' ? "bg-rose-950/20" : "bg-transparent"
    )}>
      <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 border-b border-slate-800 pb-8">
          <div className="flex items-center gap-4">
            <div className={cn(
              "w-12 h-12 rounded-xl flex items-center justify-center shadow-lg shadow-inner rotate-3 transition-colors",
              tradingMode === 'live' ? "bg-rose-500 shadow-rose-500/20" : "bg-yellow-400 shadow-yellow-400/20"
            )}>
              <Activity className="text-slate-900 w-8 h-8" />
            </div>
            <div>
              <h1 className="text-3xl font-black italic tracking-tighter uppercase">
                {tradingMode === 'live' ? (
                  <>LIVE<span className="text-rose-500">TRADING</span></>
                ) : (
                  <>BINANCE<span className="text-yellow-400">SYNC</span></>
                )}
              </h1>
              <p className="text-xs text-slate-400 font-medium uppercase tracking-[0.2em]">Automated Trading Command Center</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {/* Mode Toggle Switch (Prominent) */}
            <div className={cn(
              "flex items-center gap-3 px-5 py-2.5 rounded-full border transition-all duration-500 shadow-lg",
              tradingMode === 'live' ? "bg-rose-500/10 border-rose-500/30 text-rose-400" : "bg-slate-900 border-slate-800 text-slate-400"
            )}>
              {tradingMode === 'live' ? <Zap size={18} className="animate-pulse" /> : <Globe size={18} />}
              <span className="text-sm font-bold uppercase tracking-widest">{tradingMode.toUpperCase()} MODE</span>
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

            {/* Bot Enabled Toggle */}
            <div className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-full border transition-all duration-500",
              botEnabled ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-rose-500/10 border-rose-500/30 text-rose-400"
            )}>
              <Bot size={18} className={cn(botEnabled && "animate-pulse")} />
              <span className="text-sm font-bold uppercase">{botEnabled ? 'BOT ACTIVE' : 'BOT DISABLED'}</span>
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

            <div className="bg-slate-900 border border-slate-800 px-4 py-2 rounded-xl hidden md:flex items-center gap-3">
              <Settings size={18} className="text-slate-500" />
              <div className="flex flex-col">
                <span className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Entry Amount ({tradingMode === 'live' ? 'USDC' : 'USDT'})</span>
                <input 
                  type="number"
                  placeholder="Auto (JSON)"
                  value={customAmount}
                  onChange={(e) => saveCustomAmount(e.target.value)}
                  className="bg-transparent border-none text-sm font-black text-yellow-400 w-28 outline-none placeholder:text-slate-700 p-0 m-0"
                />
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 px-6 py-2 rounded-xl flex items-center gap-3">
              <div className="text-right">
                  <p className="text-[10px] text-blue-400/60 uppercase font-black tracking-wider">Secured Profit</p>
                  <p className="text-xl font-black text-blue-400">
                    {totalSecuredProfit > 0 ? '+' : ''}{totalSecuredProfit.toFixed(2)} <span className="text-[10px] opacity-70">{tradingMode === 'live' ? 'USDC' : 'USDT'}</span>
                  </p>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 px-6 py-2 rounded-xl flex items-center gap-3">
              <div className="text-right">
                  <p className="text-[10px] text-slate-500 uppercase font-black">Net Profit/Loss</p>
                  <p className={cn("text-xl font-black", totalPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                    {totalPnl.toFixed(2)} <span className="text-[10px] opacity-70">{tradingMode === 'live' ? 'USDC' : 'USDT'}</span>
                  </p>
              </div>
            </div>
            
            <button 
              onClick={() => setShowModal(true)}
              className={cn(
                "p-3 md:px-6 md:py-3 rounded-xl font-black flex items-center justify-center gap-2 transition-all transform hover:scale-105 active:scale-95 shadow-lg",
                "bg-yellow-400 hover:bg-yellow-300 text-slate-950 shadow-yellow-400/20"
              )}
            >
              {tradingMode === 'live' ? <Zap size={22} className="md:w-5 md:h-5" /> : <Plus size={22} className="md:w-5 md:h-5" />}
              <span className="hidden md:inline">NEW {tradingMode.toUpperCase()} POSITION</span>
            </button>

            <button 
              onClick={emergencyCloseAll}
              className="bg-rose-600 hover:bg-rose-500 text-white px-4 py-3 rounded-xl font-bold flex items-center gap-2 transition-transform transform hover:scale-105 active:scale-95"
            >
              <AlertTriangle size={18} />
            </button>
          </div>
        </header>

        {/* Main Grid */}
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
            {lastEntryError && lastEntryError.detail && (
              <div className="mb-4 px-4 py-3 bg-rose-950/40 border border-rose-800/40 rounded-xl flex items-start gap-3">
                <AlertTriangle size={16} className="text-rose-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-rose-400 font-bold uppercase tracking-wider mb-1">Último error de entrada</p>
                  <p className="text-xs text-rose-300/80 break-all leading-relaxed">{lastEntryError.detail}</p>
                  <p className="text-[10px] text-rose-500/60 mt-1">
                    {lastEntryError.symbol} · {lastEntryError.type?.toUpperCase()} · {new Date(lastEntryError.timestamp).toLocaleString()}
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-black flex items-center gap-3 text-slate-300">
                <Activity className={cn(tradingMode === 'live' ? "text-rose-500" : "text-yellow-400")} /> ACTIVE POSITIONS ({tradingMode.toUpperCase()})
                <span className="bg-slate-800 text-[10px] py-1 px-3 rounded-full text-white">{openPositions.length}</span>
                {syncing && <RefreshCw size={14} className="animate-spin text-blue-400 ml-2" />}
              </h2>
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
            <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
              <h2 className="text-lg font-black flex items-center gap-3">
                <History className="text-blue-400" /> {tradingMode.toUpperCase()} FLIGHT LOGS
              </h2>
              <button onClick={clearHistory} className="text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-rose-400 flex items-center gap-2 transition-colors">
                <Trash2 size={14} /> Clear {tradingMode} History
              </button>
            </div>
            
            <div className="overflow-x-auto">
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
                    let durationStr = '-';
                    if (pos.closedAt) {
                      const diffMs = new Date(pos.closedAt).getTime() - new Date(pos.createdAt).getTime();
                      const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
                      const hours = Math.floor(totalSeconds / 3600);
                      const minutes = Math.floor((totalSeconds % 3600) / 60);
                      const seconds = totalSeconds % 60;
                      durationStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                    }

                    const tooltipData = `Entry Time: ${new Date(pos.createdAt).toLocaleString()}
Close Time: ${pos.closedAt ? new Date(pos.closedAt).toLocaleString() : '-'}
Duration: ${durationStr}
Amount: ${pos.amount} ${pos.tradingMode === 'live' ? 'USDC' : 'USDT'}
Symbol: ${pos.symbol}
Type: ${pos.positionType.toUpperCase()}
Quantity: ${pos.quantity}
Entry Price: ${pos.entryPrice}
Stop Target: ${pos.stopLoss}
Commission: ${((pos.commission ?? 0.0004) * 100).toFixed(4)}%
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
                      <td className="px-6 py-4 font-mono text-xs text-slate-400">{pos.entryPrice.toFixed(4)}</td>
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

        <footer className="pt-4 pb-12 flex flex-col items-center gap-2">
          <div className="text-[10px] text-slate-500 uppercase flex items-center gap-2 opacity-60 font-black tracking-widest">
            <Clock size={12} /> Last heartbeat: Every 10s
          </div>
          <div className="text-[10px] text-slate-500/40 uppercase flex items-center gap-2 font-black tracking-[0.2em]">
            <Hammer size={12} /> Engine Built on: {buildInfo.timestamp}
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
                <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-400/10 blur-3xl -z-10 rounded-full" />
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-blue-400/10 blur-3xl -z-10 rounded-full" />

                <h3 className="text-2xl font-black italic tracking-tighter mb-8 flex items-center gap-3">
                  <ShieldCheck className={tradingMode === 'live' ? "text-rose-500" : "text-yellow-400"} /> DEPLOY {tradingMode.toUpperCase()} SIGNAL
                </h3>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Instrument Pairing</label>
                    <div className="relative">
                      <input 
                        type="text" 
                        placeholder={tradingMode === 'live' ? "BTCUSDC" : "BTCUSDT"} 
                        className="w-full bg-slate-950/50 border border-slate-700 p-4 rounded-2xl outline-none focus:border-yellow-400 transition-colors placeholder:text-slate-700 font-black"
                        value={newPos.symbol}
                        onChange={(e) => setNewPos({...newPos, symbol: e.target.value.toUpperCase()})}
                      />
                      <TrendingUp className="absolute right-4 top-4 text-slate-700" size={18} />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Deployment Budget ({tradingMode === 'live' ? 'USDC' : 'USDT'})</label>
                    <input 
                      type="number" 
                      placeholder="100.00" 
                      className="w-full bg-slate-950/50 border border-slate-700 p-4 rounded-2xl outline-none focus:border-yellow-400 transition-colors placeholder:text-slate-700 font-black"
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
                        "bg-yellow-400 hover:bg-yellow-300 text-slate-950 shadow-yellow-400/20"
                      )}
                    >
                      CONFIRM DEPLOY
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
  const comm = pos.commission ?? 0.0004;
  const entryCost = pos.entryPrice * pos.quantity * comm;
  const exitCost = pos.stopLoss * pos.quantity * comm;
  const pnlSafe = isBuy 
    ? ((pos.stopLoss - pos.entryPrice) * pos.quantity) - entryCost - exitCost
    : ((pos.entryPrice - pos.stopLoss) * pos.quantity) - entryCost - exitCost;
  
  const isSafe = pnlSafe > 0;
  const isBreakeven = Math.abs(pnlSafe) < 0.05;

  const binanceUrl = pos.tradingMode === 'live'
    ? `https://www.binance.com/en/trade/${pos.symbol.replace(/(USDC|USDT)$/, '_$1')}?type=cross`
    : `https://demo.binance.com/en/futures/${pos.symbol}`;

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
              href={binanceUrl} 
              target="_blank" 
              rel="noopener noreferrer" 
              className="group/link flex items-center gap-2"
            >
              <span className="text-2xl font-black tracking-tight text-white group-hover/link:text-yellow-400 transition-colors">
                {pos.symbol}
              </span>
              <ExternalLink size={16} className="text-slate-600 group-hover/link:text-yellow-400 transition-colors" />
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

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider">Entry Level</p>
          <p className="text-sm font-mono text-slate-300">{pos.entryPrice.toFixed(4)}</p>
        </div>
        <div className="space-y-1 text-right">
          <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider">Stop Target</p>
          <p className={cn("text-sm font-mono", isSafe ? "text-emerald-400" : "text-rose-400/80")}>
            {pos.stopLoss.toFixed(4)}
          </p>
        </div>
      </div>

      {(pos.commission !== undefined && pos.commission !== null) && (
        <div className="px-3 py-1 bg-slate-800/50 rounded-lg self-start">
          <p className="text-[9px] text-slate-500 font-bold uppercase">Fee: {(pos.commission * 100).toFixed(4)}%</p>
        </div>
      )}

      <div className="bg-slate-950/50 rounded-2xl p-3 border border-slate-800/50">
        <div className="flex justify-between items-end">
          <div className="space-y-1">
             <p className="text-[10px] text-emerald-400/50 font-black uppercase tracking-tighter">Real-time PnL</p>
             <p className={cn("text-2xl font-black", pos.profitLossPercent >= 0 ? "text-emerald-400" : "text-rose-400")}>
                {pos.profitLossPercent > 0 ? '+' : ''}{pos.profitLossPercent.toFixed(2)}<span className="text-xs opacity-50">%</span>
             </p>
          </div>
          <p className={cn("text-sm font-black mb-1 opacity-70", pos.profitLossPercent >= 0 ? "text-emerald-600" : "text-rose-600")}>
            {pos.profitLossFiat.toFixed(2)} {pos.tradingMode === 'live' ? 'USDC' : 'USDT'}
          </p>
        </div>
      </div>

      {isSafe && (
        <div className="badge-safe justify-center py-2 animate-none bg-emerald-500/10 border-emerald-500/10">
          <ShieldCheck size={14} className="text-emerald-400" /> 
          {isBreakeven ? 'BREAKEVEN SECURED' : `+${pnlSafe.toFixed(2)} ${pos.tradingMode === 'live' ? 'USDC' : 'USDT'} SECURED`}
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
