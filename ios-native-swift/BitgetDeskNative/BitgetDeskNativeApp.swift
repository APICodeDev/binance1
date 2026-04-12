import SwiftUI

@main
struct BitgetDeskNativeApp: App {
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
        }
    }
}
