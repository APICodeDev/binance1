import Foundation
import SwiftUI

@MainActor
final class AppViewModel: ObservableObject {
    @AppStorage("native.baseURL") var baseURL: String = "http://localhost:3000"
    @Published var token: String? = KeychainStore.loadToken()
    @Published var authUser: AuthUser?
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var tradingMode: String = "demo"
    @Published var botEnabled = true
    @Published var customAmount = ""
    @Published var leverageEnabled = false
    @Published var leverageValue = "1"
    @Published var apiStopMode = "signal"
    @Published var openPositions: [Position] = []
    @Published var closedPositions: [Position] = []
    @Published var totalPnl: Double = 0
    @Published var bookmapSymbol = "ETHUSDT"
    @Published var bookmap: BookmapSummary?
    @Published var stats: StatsPayload?
    @Published var heatmapPaper: HeatmapPaperPayload?
    @Published var accountOverview: AccountOverviewPayload?
    @Published var apiTokens: [ApiToken] = []
    @Published var auditLogs: [AuditLog] = []
    @Published var availableSounds: [String] = []
    @Published var profitSoundEnabled = false
    @Published var profitSoundFile = ""

    private let api = APIClient.shared
    private var refreshTask: Task<Void, Never>?
    private var refreshTick = 0

    init() {
        if token != nil {
            Task { await restoreSession() }
        }
    }

    var currencyLabel: String {
        tradingMode == "live" ? "USDC" : "USDT"
    }

    func restoreSession() async {
        guard let token else { return }
        do {
            authUser = try await api.authMe(baseURL: baseURL, token: token)
            await refreshAll()
            startAutoRefresh()
        } catch {
            self.errorMessage = error.localizedDescription
            signOut()
        }
    }

    func login(identifier: String, password: String) async {
        isLoading = true
        defer { isLoading = false }

        do {
            let user = try await api.login(baseURL: baseURL, identifier: identifier, password: password)
            authUser = user
            token = nil
            await refreshAll()
            startAutoRefresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loginWithToken(_ token: String) async {
        isLoading = true
        defer { isLoading = false }

        do {
            let user = try await api.authMe(baseURL: baseURL, token: token)
            self.token = token
            KeychainStore.saveToken(token)
            authUser = user
            await refreshAll()
            startAutoRefresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signOut() {
        refreshTask?.cancel()
        refreshTask = nil
        Task { await api.logout(baseURL: baseURL, token: token) }
        token = nil
        authUser = nil
        KeychainStore.clearToken()
        openPositions = []
        closedPositions = []
        stats = nil
        bookmap = nil
        heatmapPaper = nil
        accountOverview = nil
        apiTokens = []
        auditLogs = []
    }

    func refreshAll() async {
        guard authUser != nil || token != nil else { return }
        isLoading = true
        defer { isLoading = false }

        async let settings = loadSettings()
        async let positions = loadPositions()
        async let bookmap = loadBookmap()
        async let stats = loadStats()
        async let paper = loadHeatmapPaper()
        async let sounds = loadSounds()
        _ = await [settings, positions, bookmap, stats, paper, sounds]

        if authUser?.role == "admin" {
            async let overview = loadAccountOverview()
            async let tokens = loadApiTokens()
            async let audits = loadAuditLogs()
            _ = await [overview, tokens, audits]
        }
    }

    func loadSettings() async {
        do {
            let settings = try await api.getSettings(baseURL: baseURL, token: token)
            botEnabled = settings.bot_enabled == "1"
            customAmount = settings.custom_amount
            tradingMode = settings.trading_mode
            leverageEnabled = settings.leverage_enabled == "1"
            leverageValue = settings.leverage_value
            apiStopMode = settings.api_stop_mode
            profitSoundEnabled = settings.profit_sound_enabled == "1"
            profitSoundFile = settings.profit_sound_file
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadPositions() async {
        do {
            let payload = try await api.getPositions(baseURL: baseURL, token: token, mode: tradingMode)
            openPositions = payload.open
            closedPositions = payload.history
            totalPnl = payload.totalPnl
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadBookmap() async {
        do {
            bookmap = try await api.getBookmap(baseURL: baseURL, token: token, symbol: bookmapSymbol)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadStats() async {
        do {
            stats = try await api.getStats(baseURL: baseURL, token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadHeatmapPaper() async {
        do {
            heatmapPaper = try await api.getHeatmapPaper(baseURL: baseURL, token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadAccountOverview() async {
        do {
            accountOverview = try await api.getAccountOverview(baseURL: baseURL, token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadApiTokens() async {
        do {
            apiTokens = try await api.getTokens(baseURL: baseURL, token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadAuditLogs() async {
        do {
            auditLogs = try await api.getAuditLogs(baseURL: baseURL, token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadSounds() async {
        do {
            availableSounds = try await api.getSounds(baseURL: baseURL, token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func updateSetting(key: String, value: Any) async {
        do {
            try await api.updateSettings(baseURL: baseURL, token: token, payload: [key: value])
            await loadSettings()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func runMonitor() async {
        do {
            try await api.runMonitor(baseURL: baseURL, token: token)
            await loadPositions()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func emergencyClose() async {
        do {
            try await api.emergencyClose(baseURL: baseURL, token: token)
            await loadPositions()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func closePosition(_ position: Position) async {
        do {
            try await api.closePosition(baseURL: baseURL, token: token, id: position.id)
            await loadPositions()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func openPosition(symbol: String, amount: String, side: String, stopPrice: Double? = nil, origin: String? = nil, timeframe: String? = nil) async {
        var payload: [String: Any] = [
            "symbol": symbol,
            "amount": amount,
            "type": side,
            "allowTakerFallback": true,
            "takerFallbackMode": "market"
        ]
        if let stopPrice { payload["stopPrice"] = stopPrice }
        if let origin { payload["origin"] = origin }
        if let timeframe { payload["timeframe"] = timeframe }

        do {
            try await api.openPosition(baseURL: baseURL, token: token, payload: payload)
            await loadPositions()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createHeatmapPaperFromSignal() async {
        guard let signal = bookmap?.preSignal, signal.actionable else { return }
        let payload: [String: Any] = [
            "symbol": bookmapSymbol,
            "side": signal.bias == "long" ? "buy" : "sell",
            "amount": customAmount.isEmpty ? "100" : customAmount,
            "entryPrice": signal.entryPrice ?? 0,
            "stopPrice": signal.stopPrice ?? 0,
            "targetPrice": signal.targetPrice ?? 0,
            "confidence": signal.confidence,
            "reasons": signal.reasons
        ]
        do {
            try await api.createHeatmapPaper(baseURL: baseURL, token: token, payload: payload)
            await loadHeatmapPaper()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func executeHeatmapSignal() async {
        guard let signal = bookmap?.preSignal, signal.actionable else { return }
        await openPosition(
            symbol: bookmapSymbol,
            amount: customAmount.isEmpty ? "100" : customAmount,
            side: signal.bias == "long" ? "buy" : "sell",
            stopPrice: signal.stopPrice,
            origin: "Heatmap",
            timeframe: "OrderBook"
        )
    }

    func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTick = 0
        refreshTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { break }
                await runMonitor()
                refreshTick += 1
                if refreshTick % 6 == 0 {
                    await refreshAll()
                } else {
                    await loadSettings()
                }
            }
        }
    }
}
