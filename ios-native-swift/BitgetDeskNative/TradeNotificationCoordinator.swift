import Foundation
import UserNotifications

private struct TradeNotificationState: Codable {
    let seeded: Bool
    let openIDs: [Int]
    let closedIDs: [Int]
}

final class TradeNotificationCoordinator {
    static let shared = TradeNotificationCoordinator()

    private let userDefaults = UserDefaults.standard
    private let maxStoredClosedIDs = 200

    private init() {}

    func processPositionsSnapshot(mode: String, payload: PositionsPayload) async {
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
            return
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
    }

    func resetAll() {
        let keys = userDefaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("native.tradeNotifications.") }
        for key in keys {
            userDefaults.removeObject(forKey: key)
        }
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
