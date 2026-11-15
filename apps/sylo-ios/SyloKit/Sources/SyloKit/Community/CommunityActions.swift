import Foundation

// What the community actions (events, suggestions, quotes, giveaways) share: how a failed call is
// worded, and the empty JSON body the dashboard posts for an action without parameters.

extension NetworkError {
    /// The sentence to show when an action was refused: the server's own words when it sent some
    /// ("The start time must be in the future."), else the app's words for that failure. None of the
    /// community routes answers with a machine code that needs wording here.
    public var communityMessage: String {
        serverMessage ?? userMessage
    }

    /// Like ``communityMessage``, for a call that hands a role out. The server explains a refused
    /// role in its own sentence, which wins. Only when a 403 comes without one, the rule is worded
    /// here instead of the generic "no access".
    public func communityMessage(grantingRole: Bool) -> String {
        if let message = serverMessage { return message }
        if grantingRole, case .forbidden = self {
            return "You can't hand out that role: it must rank below your highest role, and a role with elevated permissions needs Manage Roles. Pick another role, or none."
        }
        return userMessage
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
