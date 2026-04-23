import Foundation
import SwiftUI
import UIKit
import UserNotifications

private struct TradeNotificationState: Codable {
    let seeded: Bool
    let openIDs: [Int]
    let closedIDs: [Int]
}

struct TradeNotificationDelta {
    let newOpenPositions: [Position]
    let newClosedPositions: [Position]

    static let empty = TradeNotificationDelta(newOpenPositions: [], newClosedPositions: [])
}

final class TradeNotificationCoordinator {
    static let shared = TradeNotificationCoordinator()

    private let userDefaults = UserDefaults.standard
    private let maxStoredClosedIDs = 200

    private init() {}

    func processPositionsSnapshot(mode: String, payload: PositionsPayload) async -> TradeNotificationDelta {
        let state = loadState(mode: mode)
        let currentOpenIDs = payload.open.map(\.id)
        let currentClosedIDs = payload.history.map(\.id)

        guard state.seeded else {
            saveState(
                mode: mode,
                state: TradeNotificationState(
                    seeded: true,
                    openIDs: currentOpenIDs,
                    closedIDs: Array(currentClosedIDs.prefix(maxStoredClosedIDs))
                )
            )
            return .empty
        }

        let knownOpen = Set(state.openIDs)
        let knownClosed = Set(state.closedIDs)
        let newOpenPositions = payload.open.filter { !knownOpen.contains($0.id) }
        let newClosedPositions = payload.history.filter { !knownClosed.contains($0.id) }

        for position in newOpenPositions.sorted(by: { $0.id < $1.id }) {
            await notifyOpen(position: position)
        }

        let accumulatedPnL = payload.totalPnl
        for position in newClosedPositions.sorted(by: { $0.id < $1.id }) {
            await notifyClose(position: position, accumulatedPnL: accumulatedPnL)
        }

        let mergedClosedIDs = Array((currentClosedIDs + state.closedIDs).uniqued().prefix(maxStoredClosedIDs))
        saveState(
            mode: mode,
            state: TradeNotificationState(
                seeded: true,
                openIDs: currentOpenIDs,
                closedIDs: mergedClosedIDs
            )
        )

        return TradeNotificationDelta(
            newOpenPositions: newOpenPositions,
            newClosedPositions: newClosedPositions
        )
    }

    func resetAll() {
        let keys = userDefaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("native.tradeNotifications.") }
        for key in keys {
            userDefaults.removeObject(forKey: key)
        }
    }

    func notifyConfirmedOpen(position: Position) async {
        await notifyOpen(position: position)
    }

    func notifyConfirmedClose(position: Position, accumulatedPnL: Double) async {
        await notifyClose(position: position, accumulatedPnL: accumulatedPnL)
    }

    private func notifyOpen(position: Position) async {
        let title = "Nueva operacion abierta: \(position.symbol)"
        let body = "\(position.positionType.uppercased()) | Entrada \(AppFormatters.price(position.entryPrice, precision: position.pricePrecision)) | \(position.tradingMode.uppercased())"
        await enqueueNotification(
            identifier: "trade-open-\(position.id)",
            title: title,
            body: body
        )
    }

    private func notifyClose(position: Position, accumulatedPnL: Double) async {
        let currency = AppFormatters.currency(for: position.tradingMode)
        let modeLabel = position.tradingMode.uppercased()
        let resultText = "\(AppFormatters.signedCompact(position.profitLossFiat)) \(currency)"
        let accumulatedText = "\(AppFormatters.signedCompact(accumulatedPnL)) \(currency)"
        let title = "Operacion cerrada: \(position.symbol)"
        let body = "Resultado \(resultText) | Acumulado \(modeLabel) \(accumulatedText)"
        await enqueueNotification(
            identifier: "trade-close-\(position.id)",
            title: title,
            body: body
        )
    }

    private func enqueueNotification(identifier: String, title: String, body: String) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        let allowedStatuses: Set<UNAuthorizationStatus> = [.authorized, .provisional, .ephemeral]
        guard allowedStatuses.contains(settings.authorizationStatus) else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        try? await center.add(request)
    }

    private func stateKey(mode: String) -> String {
        "native.tradeNotifications.\(mode.lowercased())"
    }

    private func loadState(mode: String) -> TradeNotificationState {
        let key = stateKey(mode: mode)
        guard let data = userDefaults.data(forKey: key),
              let state = try? JSONDecoder().decode(TradeNotificationState.self, from: data) else {
            return TradeNotificationState(seeded: false, openIDs: [], closedIDs: [])
        }
        return state
    }

    private func saveState(mode: String, state: TradeNotificationState) {
        let key = stateKey(mode: mode)
        guard let data = try? JSONEncoder().encode(state) else { return }
        userDefaults.set(data, forKey: key)
    }
}

private extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

@MainActor
final class AppViewModel: ObservableObject {
    @AppStorage("native.baseURL") var baseURL: String = "https://trades.apicode.cloud"
    @AppStorage("native.pushDeviceToken") private var pushDeviceTokenStorage: String = ""
    @AppStorage("native.pushDeviceTokenUploaded") private var uploadedPushDeviceTokenStorage: String = ""
    @AppStorage("native.pushPermissionRequested") private var pushPermissionRequested = false
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
    @Published var exhaustionGuardEnabled = true
    @Published var takeProfitAutoCloseEnabled = false
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
    @Published var backgroundLastRefreshAt: Date?
    @Published var backgroundLastError: String?
    @Published var backgroundStatusSummary = "Background sync pending."

    private let api = APIClient.shared
    private var refreshTask: Task<Void, Never>?
    private var refreshTick = 0
    private var notificationObservers: [NSObjectProtocol] = []
    private let activeRefreshIntervalNs: UInt64 = 5_000_000_000

    init() {
        let tokenObserver = NotificationCenter.default.addObserver(
            forName: .didReceiveAPNSToken,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let token = notification.object as? String else { return }
            Task { @MainActor in
                self?.handleReceivedPushToken(token)
            }
        }

        let failureObserver = NotificationCenter.default.addObserver(
            forName: .didFailAPNSRegistration,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let message = notification.object as? String else { return }
            self?.errorMessage = "Push registration: \(message)"
        }

        notificationObservers = [tokenObserver, failureObserver]

        migrateLegacyBaseURLIfNeeded()
        loadBackgroundStatus()
        if hasPersistedSessionCandidate {
            Task { await restoreSession() }
        }
    }

    deinit {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    var currencyLabel: String {
        tradingMode == "live" ? "USDC" : "USDT"
    }

    private func shouldSilenceTransientError(_ error: Error) -> Bool {
        guard let apiError = error as? APIError else { return false }
        return apiError.isTransient
    }

    private func presentNonCriticalError(_ prefix: String, error: Error) {
        guard !shouldSilenceTransientError(error) else { return }
        errorMessage = "\(prefix): \(error.localizedDescription)"
    }

    private var hasPersistedSessionCandidate: Bool {
        token != nil || !(HTTPCookieStorage.shared.cookies ?? []).isEmpty
    }

    private func migrateLegacyBaseURLIfNeeded() {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "http://localhost:3000" || trimmed == "http://127.0.0.1:3000" {
            baseURL = "https://trades.apicode.cloud"
            return
        }

        if !trimmed.hasPrefix("http://") && !trimmed.hasPrefix("https://") {
            baseURL = "https://\(trimmed)"
        }
    }

    func restoreSession() async {
        guard hasPersistedSessionCandidate else { return }
        do {
            authUser = try await api.authMe(baseURL: baseURL, token: token)
            await syncPushRegistrationIfPossible()
            await refreshAll()
            startAutoRefresh()
            BackgroundSyncService.shared.scheduleAppRefresh()
        } catch let error as APIError {
            errorMessage = error.localizedDescription
            if case .unauthorized = error {
                signOut()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func login(identifier: String, password: String) async {
        isLoading = true
        defer { isLoading = false }

        do {
            let result = try await api.login(baseURL: baseURL, identifier: identifier, password: password)
            authUser = result.user
            token = result.sessionToken
            if let sessionToken = result.sessionToken, !sessionToken.isEmpty {
                KeychainStore.saveToken(sessionToken)
            } else {
                KeychainStore.clearToken()
            }
            await syncPushRegistrationIfPossible()
            await refreshAll()
            startAutoRefresh()
            BackgroundSyncService.shared.scheduleAppRefresh()
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
            await syncPushRegistrationIfPossible()
            await refreshAll()
            startAutoRefresh()
            BackgroundSyncService.shared.scheduleAppRefresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signOut() {
        refreshTask?.cancel()
        refreshTask = nil
        let currentToken = token
        let deviceToken = pushDeviceToken
        if !deviceToken.isEmpty {
            Task { try? await api.unregisterPushDevice(baseURL: baseURL, token: currentToken, deviceToken: deviceToken) }
        }
        Task { await api.logout(baseURL: baseURL, token: currentToken) }
        BackgroundSyncService.shared.cancelPendingRefresh()
        token = nil
        authUser = nil
        uploadedPushDeviceToken = ""
        KeychainStore.clearToken()
        TradeNotificationCoordinator.shared.resetAll()
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
        loadBackgroundStatus()

        if authUser?.role == "admin" {
            async let overview = loadAccountOverview()
            async let tokens = loadApiTokens()
            async let audits = loadAuditLogs()
            _ = await [overview, tokens, audits]
        }
    }

    var pushDeviceToken: String {
        pushDeviceTokenStorage
    }

    private var uploadedPushDeviceToken: String {
        get { uploadedPushDeviceTokenStorage }
        set { uploadedPushDeviceTokenStorage = newValue }
    }

    func requestPushAuthorizationIfNeeded() async {
        let center = UNUserNotificationCenter.current()

        if !pushPermissionRequested {
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
                pushPermissionRequested = true
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            } catch {
                errorMessage = "Push permission: \(error.localizedDescription)"
            }
            return
        }

        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional || settings.authorizationStatus == .ephemeral {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    private func handleReceivedPushToken(_ token: String) {
        pushDeviceTokenStorage = token
        Task {
            await syncPushRegistrationIfPossible()
        }
    }

    func syncPushRegistrationIfPossible() async {
        guard !pushDeviceToken.isEmpty else { return }
        guard authUser != nil || token != nil else { return }
        guard uploadedPushDeviceToken != pushDeviceToken else { return }

        do {
            try await api.registerPushDevice(
                baseURL: baseURL,
                token: token,
                deviceToken: pushDeviceToken,
                environment: pushEnvironment,
                appVersion: appVersion,
                deviceName: UIDevice.current.name
            )
            uploadedPushDeviceToken = pushDeviceToken
        } catch {
            errorMessage = "Push device: \(error.localizedDescription)"
        }
    }

    private var pushEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private var appVersion: String? {
        let shortVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let buildNumber = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        switch (shortVersion, buildNumber) {
        case let (version?, build?) where !version.isEmpty && !build.isEmpty:
            return "\(version) (\(build))"
        case let (version?, _):
            return version
        case let (_, build?):
            return build
        default:
            return nil
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
            exhaustionGuardEnabled = settings.exhaustion_guard_enabled != "0"
            takeProfitAutoCloseEnabled = settings.take_profit_auto_close_enabled == "1"
            profitSoundEnabled = settings.profit_sound_enabled == "1"
            profitSoundFile = settings.profit_sound_file
        } catch {
            presentNonCriticalError("Settings", error: error)
        }
    }

    private func syncPositionsSnapshot() async -> TradeNotificationDelta {
        do {
            let payload = try await api.getPositions(baseURL: baseURL, token: token, mode: tradingMode)
            openPositions = payload.open
            closedPositions = payload.history
            totalPnl = payload.totalPnl
            return await TradeNotificationCoordinator.shared.processPositionsSnapshot(
                mode: payload.mode ?? tradingMode,
                payload: payload
            )
        } catch {
            presentNonCriticalError("Positions", error: error)
            return .empty
        }
    }

    func loadPositions() async {
        _ = await syncPositionsSnapshot()
    }

    func loadBookmap() async {
        do {
            bookmap = try await api.getBookmap(baseURL: baseURL, token: token, symbol: bookmapSymbol)
        } catch {
            presentNonCriticalError("Bookmap", error: error)
        }
    }

    func loadStats() async {
        do {
            stats = try await api.getStats(baseURL: baseURL, token: token)
        } catch {
            presentNonCriticalError("Stats", error: error)
        }
    }

    func loadHeatmapPaper() async {
        do {
            heatmapPaper = try await api.getHeatmapPaper(baseURL: baseURL, token: token)
        } catch {
            presentNonCriticalError("Heatmap Paper", error: error)
        }
    }

    func loadAccountOverview() async {
        do {
            accountOverview = try await api.getAccountOverview(baseURL: baseURL, token: token)
        } catch {
            presentNonCriticalError("Account Overview", error: error)
        }
    }

    func loadApiTokens() async {
        do {
            apiTokens = try await api.getTokens(baseURL: baseURL, token: token)
        } catch {
            presentNonCriticalError("API Tokens", error: error)
        }
    }

    func loadAuditLogs() async {
        do {
            auditLogs = try await api.getAuditLogs(baseURL: baseURL, token: token)
        } catch {
            presentNonCriticalError("Audit Logs", error: error)
        }
    }

    func loadSounds() async {
        do {
            availableSounds = try await api.getSounds(baseURL: baseURL, token: token)
        } catch {
            presentNonCriticalError("Sounds", error: error)
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
            try await api.runMonitor(baseURL: baseURL, token: token, mode: tradingMode)
            await loadPositions()
        } catch {
            presentNonCriticalError("Monitor", error: error)
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
            let delta = await syncPositionsSnapshot()
            if delta.newClosedPositions.isEmpty,
               let closed = closedPositions.first(where: { $0.id == position.id }) {
                await TradeNotificationCoordinator.shared.notifyConfirmedClose(position: closed, accumulatedPnL: totalPnl)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func openPosition(
        symbol: String,
        amount: String,
        side: String,
        entryPrice: Double? = nil,
        stopPrice: Double? = nil,
        takeProfit: Double? = nil,
        origin: String? = nil,
        timeframe: String? = nil
    ) async {
        var payload: [String: Any] = [
            "symbol": symbol,
            "amount": amount,
            "type": side,
            "allowTakerFallback": true,
            "takerFallbackMode": "market"
        ]
        if let entryPrice { payload["entryPrice"] = entryPrice }
        if let stopPrice { payload["stopPrice"] = stopPrice }
        if let takeProfit { payload["takeProfit"] = takeProfit }
        if let origin { payload["origin"] = origin }
        if let timeframe { payload["timeframe"] = timeframe }

        do {
            try await api.openPosition(baseURL: baseURL, token: token, payload: payload)
            let delta = await syncPositionsSnapshot()
            if delta.newOpenPositions.isEmpty,
               let opened = openPositions.first(where: {
                   $0.symbol.uppercased() == symbol.uppercased() &&
                   $0.positionType == side &&
                   $0.tradingMode == tradingMode
               }) {
                await TradeNotificationCoordinator.shared.notifyConfirmedOpen(position: opened)
            }
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
            entryPrice: signal.entryPrice,
            stopPrice: signal.stopPrice,
            takeProfit: signal.targetPrice,
            origin: "Heatmap",
            timeframe: "OrderBook"
        )
    }

    func handleScenePhaseChange(_ phase: ScenePhase) async {
        switch phase {
        case .active:
            loadBackgroundStatus()
            if authUser != nil || token != nil {
                startAutoRefresh()
            }
        case .background:
            refreshTask?.cancel()
            refreshTask = nil
            BackgroundSyncService.shared.scheduleAppRefresh(after: 60)
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    func loadBackgroundStatus() {
        let status = BackgroundSyncService.shared.currentStatus()
        backgroundLastRefreshAt = status.lastSuccessAt
        backgroundLastError = status.lastError

        if let lastSuccessAt = status.lastSuccessAt {
            backgroundStatusSummary = "Last successful wake-up: \(AppFormatters.dateTime(lastSuccessAt))."
        } else if let lastError = status.lastError, !lastError.isEmpty {
            backgroundStatusSummary = "Last background attempt failed: \(lastError)"
        } else {
            backgroundStatusSummary = "Background sync ready. iOS will wake the app when the system allows it."
        }
    }

    func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTick = 0
        refreshTask = Task {
            await refreshAll()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: activeRefreshIntervalNs)
                if Task.isCancelled { break }
                refreshTick += 1
                if refreshTick % 6 == 0 {
                    await refreshAll()
                } else if refreshTick % 3 == 0 {
                    await runMonitor()
                } else {
                    await loadPositions()
                    await loadSettings()
                }
            }
        }
    }
}
