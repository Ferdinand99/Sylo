import SwiftUI
import SyloKit
import UserNotifications

@main struct SyloApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var session: AppSession
    @State private var push: PushCoordinator

    init() {
        let session = AppSession.live()
        // Reads the remembered server and token before the first frame, so a signed-in launch
        // never flashes the sign-in screen.
        session.start()
        _session = State(initialValue: session)
        let push = PushCoordinator(session: session)
        // Before launch finishes, so the tap on a notification that launched the app arrives.
        UNUserNotificationCenter.current().delegate = push
        _push = State(initialValue: push)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(push)
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            guard phase == .active else { return }
            appDelegate.push = push
            // The permission may have changed in the Settings app, and the token can change.
            Task { await push.refresh() }
        }
    }
}
