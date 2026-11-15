import Foundation

/// The screens only for the people who run a Sylo server (its operators). The server answers them
/// only to an operator account (`requireOwner`, which also accepts an app token); the app shows them
/// only to one too, as a convenience: ``AccountModel/operatorFeatures`` is empty for everyone else, so
/// the rows are not there at all (never shown disabled).
public enum OperatorFeature: String, CaseIterable, Sendable, Hashable, Identifiable {
    /// Status, database, backups and the dev log.
    case health
    /// The bot's name, picture, presence and the announcement everyone sees.
    case personalizer
    /// The game-stats lookups every server shares.
    case statsCache
    /// Reviewing and posting on the public roadmap.
    case roadmapAdmin

    public var id: String { rawValue }
}

/// What an operator-only call answers a person who is not one (403), in the app's words.
public enum OperatorOnly {
    public static let refusal = "This is only for the people who run this Sylo."

    /// Whether the server refused the call because the account is not an operator.
    public static func isRefusal(_ error: NetworkError) -> Bool {
        if case .forbidden = error { return true }
        return false
    }
}
