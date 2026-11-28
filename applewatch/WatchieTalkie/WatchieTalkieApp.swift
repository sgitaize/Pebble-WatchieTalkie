import SwiftUI

@main
struct WatchieTalkieApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                if model.setUp { ChatListView() } else { OnboardingView() }
            }
            .environmentObject(model)
            .onAppear { model.becameActive() }
            .onChange(of: phase) { _, p in
                if p == .active { model.becameActive() } else if p == .background { model.stopPolling() }
            }
        }
    }
}
