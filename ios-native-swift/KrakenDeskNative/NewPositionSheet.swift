import SwiftUI

struct NewPositionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appModel: AppViewModel

    @State private var symbol = "ETHUSDT"
    @State private var amount = "100"
    @State private var side = "buy"

    let symbols = [
        "ADAUSDT", "ATOMUSD", "AVAXUSDT", "DOGEUSDT", "ETCUSDT", "ETHUSDT", "FILUSDT",
        "HBARUSDT", "LINKUSDT", "LTCUSDT", "NEARUSDT", "RENDERUSDT", "SANDUSDT",
        "SOLUSDT", "SUIUSDT", "UNIUSDT", "XRPUSDT"
    ]

    var body: some View {
        NavigationStack {
            Form {
                Picker("Symbol", selection: $symbol) {
                    ForEach(symbols, id: \.self) { Text($0).tag($0) }
                }

                TextField("Amount", text: $amount)
                    .keyboardType(.decimalPad)

                Picker("Side", selection: $side) {
                    Text("BUY").tag("buy")
                    Text("SELL").tag("sell")
                }
                .pickerStyle(.segmented)
            }
            .navigationTitle("New Position")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Open") {
                        Task {
                            await appModel.openPosition(symbol: symbol, amount: amount, side: side)
                            dismiss()
                        }
                    }
                }
            }
        }
    }
}
