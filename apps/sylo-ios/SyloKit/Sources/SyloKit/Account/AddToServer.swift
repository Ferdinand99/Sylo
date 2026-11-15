import Foundation
import Observation

/// The links to add Sylo to a server: one per platform this Sylo runs on, each the platform's own
/// authorise page (opened in the browser, not in the app).
@MainActor
@Observable
public final class AddToServerModel {
    public private(set) var invites: [ServerInvite] = []
    public private(set) var hasLoaded = false
    /// Why the links could not be loaded.
    public var errorMessage: String?

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public func load() async {
        do {
            invites = try await session.send(Endpoints.Invites()).invites
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized { return }
            // An older Sylo has no such list; nothing to show, nothing to explain.
            if error == .notFound {
                invites = []
                hasLoaded = true
                return
            }
            errorMessage = error.userMessage
        }
    }
}
