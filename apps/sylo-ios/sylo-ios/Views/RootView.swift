import SwiftUI
import SyloKit

/// Shows the screen for where the session is: choosing a server, signing in, or signed in.
struct RootView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        Group {
            switch session.phase {
            case .starting:
                ProgressView()
            case .choosingServer:
                ServerChoiceView()
            case .signIn(let server):
                SignInView(server: server)
                    .id(server)
            case .signedIn(let server):
                MainView(server: server, session: session)
                    .id(server)
            }
        }
        .animation(.default, value: session.phase)
    }
}

#Preview("Choose a server") {
    RootView()
        .environment(AppSession.preview(.choosingServer))
}

#Preview("Sign in") {
    RootView()
        .environment(AppSession.preview(.signIn))
}

#Preview("Signed in") {
    let session = AppSession.preview(.signedIn)
    RootView()
        .environment(session)
        .environment(PushCoordinator(session: session))
}
