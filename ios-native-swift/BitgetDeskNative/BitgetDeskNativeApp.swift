import SwiftUI

@main
struct BitgetDeskNativeApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var appModel = AppViewModel()

    var body: some Scene {
        WindowGroup {
            RootContainerView()
                .environmentObject(appModel)
                .preferredColorScheme(.dark)
                .task {
                    await appModel.requestPushAuthorizationIfNeeded()
                }
                .onChange(of: scenePhase) { _, newPhase in
                    Task {
                        await appModel.handleScenePhaseChange(newPhase)
                    }
                }
        }
    }
}
