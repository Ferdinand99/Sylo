import Foundation

// What the community actions (events, suggestions, quotes, giveaways) share: how a failed call is
// worded, and the empty JSON body the dashboard posts for an action without parameters.

extension NetworkError {
    /// The sentence to show when an action was refused. A 400 carries the server's own words
    /// ("The start time must be in the future."), which say more than the generic text; every
    /// other failure reads like it does everywhere else in the app.
    public var communityMessage: String {
        if case .badRequest(let message) = self, let message, !message.isEmpty, message != "invalid_grant" {
            return message
        }
        return userMessage
    }
}

/// `{}`, what the dashboard posts for an action that takes nothing (cancel, end, delete).
struct CommunityEmptyBody: Encodable, Sendable {}

/// A message about what an action did, for an alert.
public struct CommunityNotice: Equatable, Sendable {
    public let message: String
    /// Something did not go through.
    public let isError: Bool

    public init(_ message: String, isError: Bool = false) {
        self.message = message
        self.isError = isError
    }
}
