import Foundation
import SyloKit

// Capture-only: this file lives on a branch that is never merged. With the launch argument the app
// starts signed in to a canned Sylo 5.2 (see SyloKit's SneakDemo), so screen recordings need no account.

extension AppSession {
    static func sneakDemo() -> AppSession {
        let server = ServerURL.hosted
        let tokens = InMemoryTokenStore()
        try? tokens.save(StoredToken(token: "sylo_demo", expiresAt: .distantFuture), for: server.description)
        return AppSession(
            tokens: tokens,
            preference: PreviewServerPreference(server),
            deviceName: "iPhone",
            makeClient: { server, token in SneakDemo.makeClient(server: server, token: token) }
        )
    }
}
