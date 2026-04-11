import SwiftUI

@main
struct BitgetDeskNativeApp: App {
    @StateObject private var appModel = AppViewModel()

    var body: some Scene {
        WindowGroup {
            RootContainerView()
                .environmentObject(appModel)
                .preferredColorScheme(.dark)
        }
    }
}
