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

    /// Like ``communityMessage``, for a call that hands a role out. The server refuses a role the
    /// person may not give with a 403 and its own sentence, which the app's error type does not
    /// keep, so the reason (its rule for roles) is worded here instead of the generic "no access".
    public func communityMessage(grantingRole: Bool) -> String {
        if grantingRole, self == .forbidden {
            return "You can't hand out that role: it must rank below your highest role, and a role with elevated permissions needs Manage Roles. Pick another role, or none."
        }
        return communityMessage
    }
}

/// What the community actions say when they are asked for while another one is still running, so a
/// tap never does nothing without a word.
public enum CommunityMessage {
    public static let busy = "Another action is still running. Wait a moment, then try again."
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
