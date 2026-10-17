import SwiftUI
import SyloKit

@main struct SyloApp: App {
    @State private var session: AppSession

    init() {
        let session = AppSession.live()
        // Reads the remembered server and token before the first frame, so a signed-in launch
        // never flashes the sign-in screen.
        session.start()
        _session = State(initialValue: session)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
        }
    }
}
