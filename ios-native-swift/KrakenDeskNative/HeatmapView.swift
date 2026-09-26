import SwiftUI

struct HeatmapView: View {
    @EnvironmentObject private var appModel: AppViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Heatmap")
                        .font(.largeTitle.bold())
                    Spacer()
                    Picker("Symbol", selection: $appModel.bookmapSymbol) {
                        ForEach(["ETHUSDT", "SOLUSDT", "XRPUSDT", "LINKUSDT", "DOGEUSDT"], id: \.self) { symbol in
                            Text(symbol).tag(symbol)
                        }
                    }
                    .onChange(of: appModel.bookmapSymbol) { _ in
                        Task { await appModel.loadBookmap() }
                    }
                }

                if let bookmap = appModel.bookmap {
                    GroupBox("Pre-Signal") {
                        VStack(alignment: .leading, spacing: 10) {
                            statLine("Bias", bookmap.preSignal.bias.uppercased())
                            statLine("Mode", bookmap.preSignal.mode)
                            statLine("Confidence", "\(Int(bookmap.preSignal.confidence * 100))%")
                            statLine("Entry", bookmap.preSignal.entryPrice.map(AppFormatters.compact) ?? "-")
                            statLine("Stop", bookmap.preSignal.stopPrice.map(AppFormatters.compact) ?? "-")
                            statLine("Target", bookmap.preSignal.targetPrice.map(AppFormatters.compact) ?? "-")
                            statLine("R/R", bookmap.preSignal.rewardRisk.map(AppFormatters.compact) ?? "-")

                            if !bookmap.preSignal.reasons.isEmpty {
                                Divider().padding(.vertical, 4)
                                ForEach(bookmap.preSignal.reasons, id: \.self) { reason in
                                    Text("• \(reason)")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }

                            HStack {
                                Button("Send To Entry") {
                                    Task { await appModel.executeHeatmapSignal() }
                                }
                                .buttonStyle(SecondaryButtonStyle(tint: .yellow))
                                .disabled(!bookmap.preSignal.actionable)

                                Button("Track On Paper") {
                                    Task { await appModel.createHeatmapPaperFromSignal() }
                                }
                                .buttonStyle(SecondaryButtonStyle(tint: .cyan))
                                .disabled(!bookmap.preSignal.actionable)
                            }
                            .padding(.top, 8)
                        }
                    }

                    GroupBox("Composite") {
                        VStack(alignment: .leading, spacing: 8) {
                            statLine("Last Price", bookmap.lastPrice.map(AppFormatters.compact) ?? "-")
                            statLine("Best Bid", bookmap.composite.bestBid.map(AppFormatters.compact) ?? "-")
                            statLine("Best Ask", bookmap.composite.bestAsk.map(AppFormatters.compact) ?? "-")
                            statLine("Spread", bookmap.composite.spreadBps.map { "\(String(format: "%.2f", $0)) bps" } ?? "-")
                        }
                    }

                    GroupBox("Liquidity Zones") {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Supports")
                                .font(.headline)
                            ForEach(bookmap.supports.prefix(3)) { zone in
                                zoneRow(zone)
                            }
                            Divider()
                            Text("Resistances")
                                .font(.headline)
                            ForEach(bookmap.resistances.prefix(3)) { zone in
                                zoneRow(zone)
                            }
                        }
                    }
                } else {
                    EmptyStateCard(text: "No heatmap data yet.")
                }

                if let paper = appModel.heatmapPaper {
                    GroupBox("Paper Tracking") {
                        VStack(alignment: .leading, spacing: 10) {
                            statLine("Closed", "\(paper.summary.closedCount)")
                            statLine("Win Rate", "\(String(format: "%.1f", paper.analytics.winRate))%")
                            statLine("PnL", AppFormatters.compact(paper.summary.totalPnl))

                            if !paper.open.isEmpty {
                                Divider()
                                Text("Open Paper Trades")
                                    .font(.headline)
                                ForEach(paper.open.prefix(5)) { trade in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("\(trade.symbol) • \(trade.side.uppercased())")
                                            .font(.subheadline.bold())
                                        Text("Entry \(AppFormatters.compact(trade.entryPrice)) • Stop \(AppFormatters.compact(trade.stopPrice)) • Target \(AppFormatters.compact(trade.targetPrice))")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding()
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle("Heatmap")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh") {
                    Task {
                        await appModel.loadBookmap()
                        await appModel.loadHeatmapPaper()
                    }
                }
            }
        }
    }

    private func statLine(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title.uppercased())
                .font(.caption2.bold())
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline.monospacedDigit())
        }
    }

    private func zoneRow(_ zone: BookmapSummary.Zone) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(AppFormatters.compact(zone.price))
                    .font(.subheadline.bold())
                Text("\(zone.exchangeCount) exchanges • \(String(format: "%.2f", zone.distancePercent))%")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(AppFormatters.compact(zone.totalNotional))
                .font(.caption.bold())
        }
    }
}
