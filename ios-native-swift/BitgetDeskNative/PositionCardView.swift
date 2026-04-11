import SwiftUI

struct PositionCardView: View {
    @EnvironmentObject private var appModel: AppViewModel
    let position: Position

    var body: some View {
        let isBuy = position.positionType == "buy"
        let stopDelta = position.entryPrice == 0 ? 0 : ((position.stopLoss - position.entryPrice) / position.entryPrice) * 100
        let legacyDistance = abs(abs(isBuy ? -stopDelta : stopDelta) - 1.2) < 0.05

        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(position.symbol)
                        .font(.title3.bold())
                    Text("\(position.positionType.uppercased()) • \(position.origin ?? "Manual")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(position.tradingMode.uppercased())
                    .font(.caption.bold())
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(position.tradingMode == "live" ? Color.red.opacity(0.2) : Color.green.opacity(0.2))
                    .clipShape(Capsule())
            }

            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Entry")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                    Text(AppFormatters.price(position.entryPrice, precision: position.pricePrecision))
                        .font(.headline.monospacedDigit())
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Text("Stop")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                    Text(AppFormatters.price(position.stopLoss, precision: position.pricePrecision))
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(position.profitLossFiat >= 0 ? .green : .red)
                    Text("\(stopDelta >= 0 ? "+" : "")\(String(format: "%.2f", stopDelta))% vs entry")
                        .font(.caption.bold())
                        .foregroundStyle(legacyDistance ? .secondary : .cyan)
                    Text(legacyDistance ? "Legacy 1.2% Default" : "Adapted By App")
                        .font(.caption2.bold())
                        .foregroundStyle(legacyDistance ? .secondary : .cyan)
                }
            }

            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("PnL")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                    Text("\(position.profitLossPercent >= 0 ? "+" : "")\(String(format: "%.2f", position.profitLossPercent))%")
                        .font(.headline.bold())
                        .foregroundStyle(position.profitLossPercent >= 0 ? .green : .red)
                }
                Spacer()
                Text("\(position.profitLossFiat >= 0 ? "+" : "")\(AppFormatters.compact(position.profitLossFiat)) \(position.tradingMode == "live" ? "USDC" : "USDT")")
                    .font(.subheadline.bold())
                    .foregroundStyle(position.profitLossFiat >= 0 ? .green : .red)
            }

            HStack {
                Text(AppFormatters.dateTime(position.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Manual Eject") {
                    Task { await appModel.closePosition(position) }
                }
                .buttonStyle(SecondaryButtonStyle(tint: .red))
            }
        }
        .padding()
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
