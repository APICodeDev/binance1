import SwiftUI

struct AdminView: View {
    @EnvironmentObject private var appModel: AppViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Admin")
                    .font(.largeTitle.bold())

                settingsCard

                if appModel.authUser?.role == "admin" {
                    accountCard
                    tokenCard
                    auditCard
                } else {
                    EmptyStateCard(text: "Admin-only sections require an admin session.")
                }
            }
            .padding()
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle("Admin")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh") {
                    Task { await appModel.refreshAll() }
                }
            }
        }
    }

    private var settingsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Settings")
                .font(.title3.bold())

            Toggle("Bot Enabled", isOn: Binding(
                get: { appModel.botEnabled },
                set: { newValue in
                    Task { await appModel.updateSetting(key: "bot_enabled", value: newValue ? "1" : "0") }
                }
            ))

            Picker("Trading Mode", selection: Binding(
                get: { appModel.tradingMode },
                set: { newValue in
                    Task { await appModel.updateSetting(key: "trading_mode", value: newValue) }
                }
            )) {
                Text("Demo").tag("demo")
                Text("Live").tag("live")
            }

            Picker("API Stop Mode", selection: Binding(
                get: { appModel.apiStopMode },
                set: { newValue in
                    Task { await appModel.updateSetting(key: "api_stop_mode", value: newValue) }
                }
            )) {
                Text("Signal").tag("signal")
                Text("Legacy").tag("legacy")
            }

            Toggle("Leverage Enabled", isOn: Binding(
                get: { appModel.leverageEnabled },
                set: { newValue in
                    Task { await appModel.updateSetting(key: "leverage_enabled", value: newValue ? "1" : "0") }
                }
            ))

            LabeledContent("Custom Amount") {
                TextField("Amount", text: Binding(
                    get: { appModel.customAmount },
                    set: { appModel.customAmount = $0 }
                ))
                .multilineTextAlignment(.trailing)
                .onSubmit {
                    Task { await appModel.updateSetting(key: "custom_amount", value: appModel.customAmount) }
                }
            }
        }
        .padding()
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Account Overview")
                .font(.title3.bold())
            if let overview = appModel.accountOverview {
                overviewMode("Demo", mode: overview.demo)
                Divider()
                overviewMode("Live", mode: overview.live)
            } else {
                Text("No account overview loaded.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func overviewMode(_ title: String, mode: AccountOverviewPayload.ModeData) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            ForEach(mode.summary) { item in
                HStack {
                    Text(item.accountType)
                    Spacer()
                    Text("USDT \(AppFormatters.compact(item.usdtBalance))")
                }
                .font(.subheadline)
            }
        }
    }

    private var tokenCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("API Tokens")
                .font(.title3.bold())
            if appModel.apiTokens.isEmpty {
                Text("No tokens found.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(appModel.apiTokens) { token in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(token.name)
                                .font(.headline)
                            Text("••••\(token.lastFour)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(token.isActive ? "ACTIVE" : "OFF")
                            .font(.caption.bold())
                            .foregroundStyle(token.isActive ? Color.green : Color.secondary)
                    }
                }
            }
        }
        .padding()
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var auditCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Audit Trail")
                .font(.title3.bold())
            if appModel.auditLogs.isEmpty {
                Text("No audit logs loaded.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(appModel.auditLogs.prefix(12)) { log in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(log.action)
                            .font(.headline)
                        Text("\(log.targetType ?? "-") • \(AppFormatters.dateTime(log.createdAt))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .padding()
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
