import SwiftUI

struct AdminView: View {
    @EnvironmentObject private var appModel: AppViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Admin")
                    .font(.largeTitle.bold())

                settingsCard
                backgroundCard

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

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Text("Initial Stop")
                    .font(.headline)
                Text("Signal Stop First")
                    .font(.subheadline.bold())
                    .foregroundStyle(.cyan)
                Text("Si el JSON trae un Stop Loss valido, la app lo respeta como SL inicial. Si no llega, el backend cae al 1.2% legacy.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Toggle("Exhaustion Guard", isOn: Binding(
                get: { appModel.exhaustionGuardEnabled },
                set: { newValue in
                    Task { await appModel.updateSetting(key: "exhaustion_guard_enabled", value: newValue ? "1" : "0") }
                }
            ))

            Toggle("Take Profit Auto-Close", isOn: Binding(
                get: { appModel.takeProfitAutoCloseEnabled },
                set: { newValue in
                    Task { await appModel.updateSetting(key: "take_profit_auto_close_enabled", value: newValue ? "1" : "0") }
                }
            ))

            Text("Por defecto queda desactivado. Si una entrada no trae `takeProfit`, este ajuste no cambia nada.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle("Profit Sound", isOn: Binding(
                get: { appModel.profitSoundEnabled },
                set: { newValue in
                    Task { await appModel.updateSetting(key: "profit_sound_enabled", value: newValue ? "1" : "0") }
                }
            ))

            LabeledContent("Selected Sound") {
                Text(appModel.profitSoundFile.isEmpty ? "None" : appModel.profitSoundFile)
                    .foregroundStyle(appModel.profitSoundFile.isEmpty ? .secondary : .primary)
            }
        }
        .padding()
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var backgroundCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Background Sync")
                .font(.title3.bold())

            Text(appModel.backgroundStatusSummary)
                .font(.subheadline)

            if let lastSuccess = appModel.backgroundLastRefreshAt {
                LabeledContent("Last Success") {
                    Text(AppFormatters.dateTime(lastSuccess))
                }
            }

            if let lastError = appModel.backgroundLastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            Text("iOS no permite un monitor continuo en segundo plano. Esta configuracion usa BGAppRefresh, Background Fetch y remote notifications para despertar la app cuando el sistema lo permita y lanzar la sincronizacion.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Button("Run Monitor Now") {
                    Task { await appModel.runMonitor() }
                }
                .buttonStyle(.borderedProminent)

                Button("Reschedule") {
                    BackgroundSyncService.shared.scheduleAppRefresh(after: 60)
                    appModel.loadBackgroundStatus()
                }
                .buttonStyle(.bordered)
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
