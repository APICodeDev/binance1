import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var appModel: AppViewModel
    @State private var showNewPosition = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                settingsPanel
                actionBar
                openPositionsPanel
                closedPositionsPanel
            }
            .padding()
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Salir") {
                    appModel.signOut()
                }
            }
        }
        .sheet(isPresented: $showNewPosition) {
            NewPositionSheet()
        }
    }

    private var settingsPanel: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                HighlightMetricTile(
                    title: "PnL",
                    value: "\(AppFormatters.signedCompact(appModel.totalPnl)) \(appModel.currencyLabel)",
                    background: appModel.totalPnl >= 0 ? Color.green : Color.red
                )
                MetricTile(
                    title: "Amount Secure",
                    value: "\(AppFormatters.compact(appModel.securedAmount)) \(appModel.currencyLabel)",
                    tint: appModel.securedAmount > 0 ? .cyan : .gray,
                    titleColor: .white.opacity(0.82)
                )
            }
            HStack(spacing: 12) {
                MetricTile(title: "Mode", value: appModel.tradingMode.uppercased(), tint: appModel.tradingMode == "live" ? .red : .yellow)
                MetricTile(title: "Bot", value: appModel.botEnabled ? "ACTIVE" : "OFF", tint: appModel.botEnabled ? .green : .gray)
            }
            HStack(spacing: 12) {
                MetricTile(title: "Amount", value: appModel.customAmount.isEmpty ? "AUTO" : appModel.customAmount, tint: .orange)
                MetricTile(title: "TP Auto", value: appModel.takeProfitAutoCloseEnabled ? "ON" : "OFF", tint: .cyan)
            }
            HStack(spacing: 12) {
                MetricTile(title: "Leverage", value: appModel.leverageEnabled ? "x\(appModel.leverageValue)" : "OFF", tint: .purple)
                MetricTile(title: "Open", value: "\(appModel.openPositions.count)", tint: .blue)
            }
        }
    }

    private var actionBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                Button("Refresh") { Task { await appModel.refreshAll() } }
                    .buttonStyle(SecondaryButtonStyle(tint: .blue))
                Button("Monitor") { Task { await appModel.runMonitor() } }
                    .buttonStyle(SecondaryButtonStyle(tint: .cyan))
                Button("New Position") { showNewPosition = true }
                    .buttonStyle(SecondaryButtonStyle(tint: .yellow))
                Button("Emergency Close") { Task { await appModel.emergencyClose() } }
                    .buttonStyle(SecondaryButtonStyle(tint: .red))
            }
        }
    }

    private var openPositionsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Open Positions")
                .font(.title3.bold())
            if appModel.openPositions.isEmpty {
                EmptyStateCard(text: "No active positions.")
            } else {
                ForEach(appModel.openPositions) { position in
                    PositionCardView(position: position)
                }
            }
        }
    }

    private var closedPositionsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Recent Closed")
                .font(.title3.bold())
            if appModel.closedPositions.isEmpty {
                EmptyStateCard(text: "No closed positions yet.")
            } else {
                ForEach(appModel.closedPositions.prefix(8)) { position in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(position.symbol)
                                .font(.headline)
                            Text("\(position.positionType.uppercased()) - \(position.managementModeLabel) - \(AppFormatters.dateTime(position.closedAt))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 6) {
                            Text(position.managementModeLabel)
                                .font(.caption2.bold())
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.white.opacity(0.08))
                                .clipShape(Capsule())
                            Text("\(position.profitLossFiat >= 0 ? "+" : "")\(AppFormatters.compact(position.profitLossFiat)) \(position.tradingMode == "live" ? "USDC" : "USDT")")
                                .font(.subheadline.bold())
                                .foregroundStyle(position.profitLossFiat >= 0 ? .green : .red)
                        }
                    }
                    .padding()
                    .background(Color.white.opacity(0.05))
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }
}

struct MetricTile: View {
    let title: String
    let value: String
    let tint: Color
    var titleColor: Color = .secondary
    var valueColor: Color = .white

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption2.bold())
                .foregroundStyle(titleColor)
            Text(value)
                .font(.headline.bold())
                .foregroundStyle(valueColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(tint.opacity(0.14))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(tint.opacity(0.25), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct HighlightMetricTile: View {
    let title: String
    let value: String
    let background: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption2.bold())
                .foregroundStyle(.white.opacity(0.78))
            Text(value)
                .font(.headline.bold())
                .foregroundStyle(.white)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(background.opacity(0.92))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct EmptyStateCard: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(Color.white.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.bold())
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(tint.opacity(configuration.isPressed ? 0.22 : 0.16))
            .foregroundStyle(.white)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(tint.opacity(0.35), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
