import SwiftUI
import WidgetKit

private enum TradingWidgetStore {
    static let appGroupID = "group.com.bitgetdesk.nativeclone.shared"

    private enum Keys {
        static let securedAmount = "widget.securedAmount"
        static let totalPnl = "widget.totalPnl"
        static let currency = "widget.currency"
        static let tradingMode = "widget.tradingMode"
        static let updatedAt = "widget.updatedAt"
    }

    static func loadEntry(date: Date) -> TradingSummaryEntry {
        let defaults = UserDefaults(suiteName: appGroupID)
        let securedAmount = defaults?.double(forKey: Keys.securedAmount) ?? 0
        let totalPnl = defaults?.double(forKey: Keys.totalPnl) ?? 0
        let currency = defaults?.string(forKey: Keys.currency) ?? "USDT"
        let tradingMode = defaults?.string(forKey: Keys.tradingMode) ?? "demo"
        let updatedAtInterval = defaults?.double(forKey: Keys.updatedAt) ?? 0
        let updatedAt = updatedAtInterval > 0 ? Date(timeIntervalSince1970: updatedAtInterval) : date

        return TradingSummaryEntry(
            date: date,
            securedAmount: securedAmount,
            totalPnl: totalPnl,
            currency: currency,
            tradingMode: tradingMode,
            updatedAt: updatedAt
        )
    }
}

struct TradingSummaryEntry: TimelineEntry {
    let date: Date
    let securedAmount: Double
    let totalPnl: Double
    let currency: String
    let tradingMode: String
    let updatedAt: Date
}

struct TradingSummaryProvider: TimelineProvider {
    func placeholder(in context: Context) -> TradingSummaryEntry {
        TradingSummaryEntry(
            date: Date(),
            securedAmount: 18.45,
            totalPnl: 246.82,
            currency: "USDT",
            tradingMode: "demo",
            updatedAt: Date()
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (TradingSummaryEntry) -> Void) {
        completion(TradingWidgetStore.loadEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TradingSummaryEntry>) -> Void) {
        let entry = TradingWidgetStore.loadEntry(date: Date())
        let nextRefresh = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

struct TradingSummaryWidgetEntryView: View {
    var entry: TradingSummaryProvider.Entry
    @Environment(\.widgetFamily) private var family

    private var pnlBackground: LinearGradient {
        let colors: [Color] = entry.totalPnl >= 0
            ? [Color.green.opacity(0.95), Color.green.opacity(0.55)]
            : [Color.red.opacity(0.95), Color.red.opacity(0.55)]
        return LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color.black.opacity(0.92))

            VStack(alignment: .leading, spacing: family == .systemSmall ? 10 : 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entry.tradingMode.uppercased())
                            .font(.caption2.bold())
                            .foregroundStyle(.white.opacity(0.7))
                        Text("Amount Secure")
                            .font(.caption.bold())
                            .foregroundStyle(.cyan.opacity(0.95))
                        Text("\(compact(entry.securedAmount)) \(entry.currency)")
                            .font(family == .systemSmall ? .headline.bold() : .title3.bold())
                            .foregroundStyle(.white)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 6) {
                        Text("Updated")
                            .font(.caption2.bold())
                            .foregroundStyle(.white.opacity(0.55))
                        Text(entry.updatedAt, style: .time)
                            .font(.caption.bold())
                            .foregroundStyle(.white.opacity(0.8))
                    }
                }

                Spacer(minLength: 0)

                VStack(alignment: .leading, spacing: 8) {
                    Text("PnL Acumulado")
                        .font(.caption.bold())
                        .foregroundStyle(.white.opacity(0.82))

                    Text("\(signedCompact(entry.totalPnl))")
                        .font(family == .systemSmall ? .system(size: 30, weight: .black, design: .rounded) : .system(size: 38, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)

                    Text(entry.currency)
                        .font(.caption.bold())
                        .foregroundStyle(.white.opacity(0.88))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, family == .systemSmall ? 14 : 16)
                .background(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(pnlBackground)
                )
            }
            .padding(16)
        }
        .containerBackground(for: .widget) {
            Color.black
        }
    }

    private func compact(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
    }

    private func signedCompact(_ value: Double) -> String {
        let prefix = value >= 0 ? "+" : ""
        return "\(prefix)\(compact(value))"
    }
}

struct TradingSummaryWidget: Widget {
    let kind = "TradingSummaryWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TradingSummaryProvider()) { entry in
            TradingSummaryWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Trading Summary")
        .description("Shows secured amount and accumulated PnL.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
