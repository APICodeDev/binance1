import SwiftUI

struct PositionCardView: View {
    @EnvironmentObject private var appModel: AppViewModel
    let position: Position

    var body: some View {
        let isBuy = position.positionType == "buy"
        let managementMode = (position.managementMode ?? "auto").lowercased() == "self" ? "SELF" : "AUTO"
        let stopDelta = position.entryPrice == 0 ? 0 : ((position.stopLoss - position.entryPrice) / position.entryPrice) * 100
        let legacyDistance = abs(abs(isBuy ? -stopDelta : stopDelta) - 1.2) < 0.05
        let fillDeltaPercent = signedFillDeltaPercent
        let fillDeltaColor: Color = fillDeltaPercent >= 0 ? .cyan : .orange

        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(position.symbol)
                        .font(.title3.bold())
                    Text("\(position.positionType.uppercased()) - \(cardMetaLine(managementMode: managementMode))")
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
                    if let requestedEntryPrice = position.requestedEntryPrice, requestedEntryPrice > 0 {
                        Text("JSON \(AppFormatters.price(requestedEntryPrice, precision: position.pricePrecision))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Fill \(fillDeltaPercent >= 0 ? "+" : "")\(String(format: "%.2f", fillDeltaPercent))%")
                            .font(.caption.bold())
                            .foregroundStyle(fillDeltaColor)
                    }
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
                        .foregroundStyle(legacyDistance ? Color.secondary : Color.cyan)
                    Text(legacyDistance ? "Legacy 1.2% Default" : "Adapted By App")
                        .font(.caption2.bold())
                        .foregroundStyle(legacyDistance ? Color.secondary : Color.cyan)
                    if let takeProfit = position.takeProfit, takeProfit > 0 {
                        Text("TP \(AppFormatters.price(takeProfit, precision: position.pricePrecision))")
                            .font(.caption.bold())
                            .foregroundStyle(.yellow)
                    }
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

    private var signedFillDeltaPercent: Double {
        guard let requestedEntryPrice = position.requestedEntryPrice, requestedEntryPrice > 0 else {
            return 0
        }

        let rawPercent = ((position.entryPrice - requestedEntryPrice) / requestedEntryPrice) * 100
        return position.positionType == "sell" ? rawPercent : -rawPercent
    }

    private var resolvedTakeProfitTargetPercent: Double? {
        if let takeProfitTargetPercent = position.takeProfitTargetPercent, takeProfitTargetPercent > 0 {
            return takeProfitTargetPercent
        }

        guard let takeProfit = position.takeProfit, takeProfit > 0, position.entryPrice > 0 else {
            return nil
        }

        if position.positionType == "sell" {
            return ((position.entryPrice - takeProfit) / position.entryPrice) * 100
        }

        return ((takeProfit - position.entryPrice) / position.entryPrice) * 100
    }

    private func cardMetaLine(managementMode: String) -> String {
        var parts: [String] = []

        if let origin = position.origin?.trimmingCharacters(in: .whitespacesAndNewlines), !origin.isEmpty {
            parts.append(origin)
        }

        if let timeframe = position.timeframe?.trimmingCharacters(in: .whitespacesAndNewlines), !timeframe.isEmpty {
            parts.append(timeframe)
        }

        parts.append(managementMode)

        if managementMode == "SELF", let takeProfitTargetPercent = resolvedTakeProfitTargetPercent, takeProfitTargetPercent > 0 {
            parts.append(String(format: "TP %.2f%%", takeProfitTargetPercent))
        }

        return parts.joined(separator: " - ")
    }
}
