import SwiftUI

struct RootTabView: View {
    @EnvironmentObject private var appModel: AppViewModel

    var body: some View {
        TabView {
            NavigationStack { DashboardView() }
                .tabItem { Label("Dashboard", systemImage: "speedometer") }

            NavigationStack { HeatmapView() }
                .tabItem { Label("Heatmap", systemImage: "waveform.path.ecg") }

            NavigationStack { StatsView() }
                .tabItem { Label("Stats", systemImage: "chart.bar.fill") }

            NavigationStack { AdminView() }
                .tabItem { Label("Admin", systemImage: "gearshape.2.fill") }
        }
        .task {
            await appModel.refreshAll()
            appModel.startAutoRefresh()
        }
    }
}
