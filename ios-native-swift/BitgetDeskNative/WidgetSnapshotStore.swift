import Foundation
import WidgetKit

enum WidgetSnapshotStore {
    static let appGroupID = "group.com.bitgetdesk.nativeclone.shared"

    private enum Keys {
        static let securedAmount = "widget.securedAmount"
        static let totalPnl = "widget.totalPnl"
        static let currency = "widget.currency"
        static let tradingMode = "widget.tradingMode"
        static let updatedAt = "widget.updatedAt"
    }

    static func save(securedAmount: Double, totalPnl: Double, currency: String, tradingMode: String) {
        guard let defaults = UserDefaults(suiteName: appGroupID) else { return }
        defaults.set(securedAmount, forKey: Keys.securedAmount)
        defaults.set(totalPnl, forKey: Keys.totalPnl)
        defaults.set(currency, forKey: Keys.currency)
        defaults.set(tradingMode, forKey: Keys.tradingMode)
        defaults.set(Date().timeIntervalSince1970, forKey: Keys.updatedAt)
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func clear() {
        guard let defaults = UserDefaults(suiteName: appGroupID) else { return }
        defaults.removeObject(forKey: Keys.securedAmount)
        defaults.removeObject(forKey: Keys.totalPnl)
        defaults.removeObject(forKey: Keys.currency)
        defaults.removeObject(forKey: Keys.tradingMode)
        defaults.removeObject(forKey: Keys.updatedAt)
        WidgetCenter.shared.reloadAllTimelines()
    }
}
