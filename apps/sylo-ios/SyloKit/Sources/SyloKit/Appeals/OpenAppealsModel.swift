import Foundation
import Observation

/// How many ban appeals are open on one server, for the badge on the Moderation tab. Several
/// places feed it, and the newest value wins: the first look when the server screen opens, the
/// overview (which carries `openAppeals`), and the appeals screen after it loads or after every
/// decision, wherever that screen was opened from.
@MainActor
@Observable
public final class OpenAppealsModel {
    /// The open appeals; nil until the first value arrives.
    public private(set) var count: Int?

    private let server: ServerID
    private let session: AppSession
    /// Goes up with every ``update(_:)``, so a slow first look cannot overwrite a newer count.
    private var version = 0

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Takes a count that is newer than anything before it.
    public func update(_ open: Int) {
        version += 1
        count = open
    }

    /// Asks the server how many appeals are open. A failure leaves the count as it was (the badge
    /// is a hint, not worth an error), and so does an answer older than an ``update(_:)``.
    public func refresh() async {
        let started = version
        do {
            let review = try await session.send(Endpoints.LoadAppeals(server: server))
            guard started == version else { return }
            count = review.open
        } catch {
            // Not worth showing: the Appeals screen explains a failure itself.
        }
    }
}
