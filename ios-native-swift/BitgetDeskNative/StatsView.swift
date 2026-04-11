import SwiftUI

struct StatsView: View {
    @EnvironmentObject private var appModel: AppViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Statistics")
                    .font(.largeTitle.bold())

                if let stats = appModel.stats {
                    StatsModeCard(title: "Demo", mode: stats.demo, tint: .green, currency: "USDT")
                    StatsModeCard(title: "Live", mode: stats.live, tint: .red, currency: "USDC")
                } else {
                    EmptyStateCard(text: "Statistics not available yet.")
                }
            }
            .padding()
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle("Stats")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh") { Task { await appModel.loadStats() } }
            }
        }
    }
}

struct StatsModeCard: View {
    let title: String
    let mode: StatsPayload.StatsMode
    let tint: Color
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.title3.bold())
            HStack {
                MetricTile(title: "Closed", value: "\(mode.closedCount)", tint: tint)
                MetricTile(title: "Success", value: "\(mode.successPercent, specifier: "%.1f")%", tint: .green)
            }
            HStack {
                MetricTile(title: "Profit", value: "\(AppFormatters.compact(mode.profitAmount)) \(currency)", tint: .green)
                MetricTile(title: "Loss", value: "\(AppFormatters.compact(mode.lossAmount)) \(currency)", tint: .red)
            }

            if !mode.symbolByProfit.isEmpty {
                Text("Top Symbols")
                    .font(.headline)
                ForEach(mode.symbolByProfit.prefix(5)) { item in
                    HStack {
                        Text(item.symbol)
                        Spacer()
                        Text("\(item.profitAmount >= 0 ? "+" : "")\(AppFormatters.compact(item.profitAmount))")
                            .foregroundStyle(item.profitAmount >= 0 ? .green : .red)
                    }
                    .font(.subheadline)
                }
            }

            if !mode.sourceByCount.isEmpty {
                Divider()
                Text("Top Sources")
                    .font(.headline)
                ForEach(mode.sourceByCount.prefix(5)) { item in
                    HStack {
                        Text(item.source)
                        Spacer()
                        Text("\(item.effectivenessPercent, specifier: "%.1f")%")
                    }
                    .font(.subheadline)
                }
            }
        }
        .padding()
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
