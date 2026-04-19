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
                MetricTile(title: "Success", value: "\(String(format: "%.1f", mode.successPercent))%", tint: .green)
            }
            HStack {
                MetricTile(title: "Profit", value: "\(AppFormatters.compact(mode.profitAmount)) \(currency)", tint: .green)
                MetricTile(title: "Loss", value: "\(AppFormatters.compact(mode.lossAmount)) \(currency)", tint: .red)
            }

            EntryExecutionDeltaCard(mode: mode)

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
                        Text("\(String(format: "%.1f", item.effectivenessPercent))%")
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

struct EntryExecutionDeltaCard: View {
    let mode: StatsPayload.StatsMode

    var body: some View {
        HStack(spacing: 16) {
            DonutSummaryView(
                favorable: mode.entryExecutionDelta.favorablePercentTotal,
                unfavorable: mode.entryExecutionDelta.unfavorablePercentTotal,
                centerText: mode.entryExecutionDelta.sampleCount > 0
                    ? String(format: "%.2f%%", mode.entryExecutionDelta.averageAbsPercent)
                    : "0%"
            )

            VStack(alignment: .leading, spacing: 8) {
                Text("JSON Entry vs Real Fill")
                    .font(.headline)
                Text("\(mode.entryExecutionDelta.sampleCount) trades with JSON entry")
                    .font(.subheadline)
                Text("Favorable total \(String(format: "%.2f", mode.entryExecutionDelta.favorablePercentTotal))%")
                    .font(.caption)
                    .foregroundStyle(.cyan)
                Text("Unfavorable total \(String(format: "%.2f", mode.entryExecutionDelta.unfavorablePercentTotal))%")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Text("Avg signed \(mode.entryExecutionDelta.averageSignedPercent >= 0 ? "+" : "")\(String(format: "%.2f", mode.entryExecutionDelta.averageSignedPercent))%")
                    .font(.caption.bold())
                    .foregroundStyle(mode.entryExecutionDelta.averageSignedPercent >= 0 ? .cyan : .orange)
            }
            Spacer(minLength: 0)
        }
        .padding()
        .background(Color.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct DonutSummaryView: View {
    let favorable: Double
    let unfavorable: Double
    let centerText: String

    private var total: Double {
        max(favorable + unfavorable, 0.0001)
    }

    private var favorableTrim: Double {
        favorable / total
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.08), lineWidth: 14)

            Circle()
                .trim(from: 0, to: favorableTrim)
                .stroke(Color.cyan, style: StrokeStyle(lineWidth: 14, lineCap: .round))
                .rotationEffect(.degrees(-90))

            Circle()
                .trim(from: favorableTrim, to: 1)
                .stroke(Color.orange, style: StrokeStyle(lineWidth: 14, lineCap: .round))
                .rotationEffect(.degrees(-90))

            Text(centerText)
                .font(.caption.bold())
                .multilineTextAlignment(.center)
        }
        .frame(width: 86, height: 86)
    }
}
