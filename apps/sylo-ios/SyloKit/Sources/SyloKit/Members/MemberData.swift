import Foundation
import Observation

// Member data (src/web/routes/v2GuildData.js, src/web/lib/guildData.js, src/db/purge.js; the
// dashboard page web-v2/src/pages/MemberData.jsx): what Sylo stores about one member of a server,
// counted per source, and the "forget this member" erasure used for a data-erasure request.
//
// This is personal data. Nothing here is logged or kept longer than the screen needs it: the model
// drops the lookup when the screen goes away, and the erasure needs a typed confirmation. The reason
// is optional, as on the dashboard: when given it goes in the audit log and in the message to the
// member.

/// Who the lookup is about, as the server sees them.
public struct MemberProfile: Decodable, Sendable, Equatable {
    public let id: String
    /// Their account tag (`ferdi#0001`, `ferdi`); nil when the server could not look them up.
    public let tag: String?
    /// A small picture link on the platform's own host; nil when they have none or are unknown.
    public let avatar: URL?

    public init(id: String, tag: String? = nil, avatar: URL? = nil) {
        self.id = id
        self.tag = tag
        self.avatar = avatar
    }

    private enum CodingKeys: String, CodingKey { case id, tag, avatar }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let tag = try c.decodeIfPresent(String.self, forKey: .tag)
        self.tag = (tag?.isEmpty ?? true) ? nil : tag
        // Only an https link is ever shown.
        let link = try c.decodeIfPresent(String.self, forKey: .avatar).flatMap(URL.init(string:))
        avatar = link?.scheme?.lowercased() == "https" ? link : nil
    }

    /// The name to show: the tag, else a plain "Unknown member".
    public var title: String { tag ?? "Unknown member" }
}

/// One place Sylo keeps data about the member, and how many records are there.
public struct MemberDataItem: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let label: String
    public let count: Int
    /// A safety record (moderation cases, a temporary ban, honeypot catches, a counting penalty):
    /// forgetting the member leaves it alone.
    public let isKept: Bool

    public var id: String { key }

    public init(key: String, label: String, count: Int, isKept: Bool = false) {
        self.key = key
        self.label = label
        self.count = count
        self.isKept = isKept
    }

    private enum CodingKeys: String, CodingKey { case key, label, count, kept }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let key = try c.decode(String.self, forKey: .key)
        self.init(
            key: key,
            label: try c.decode(forKey: .label, or: key),
            count: max(0, c.lenientCount(.count)),
            isKept: try c.decode(forKey: .kept, or: false))
    }
}

/// What Sylo stores about the member: the sources with something in them, and the totals.
public struct MemberDataSummary: Decodable, Sendable, Equatable {
    /// Every source the server counts, including the empty ones.
    public let items: [MemberDataItem]
    public let total: Int
    /// What forgetting the member would remove or anonymise (the total without the kept records).
    public let erasable: Int

    public init(items: [MemberDataItem] = [], total: Int? = nil, erasable: Int? = nil) {
        self.items = items
        self.total = total ?? items.reduce(0) { $0 + $1.count }
        self.erasable = erasable ?? items.filter { !$0.isKept }.reduce(0) { $0 + $1.count }
    }

    /// The sources that hold something, in the server's order.
    public var filled: [MemberDataItem] { items.filter { $0.count > 0 } }

    private enum CodingKeys: String, CodingKey { case items, total, erasable }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let items = try c.decodeLossyArray(of: MemberDataItem.self, forKey: .items)
        self.init(
            items: items,
            total: c.contains(.total) ? c.lenientCount(.total) : nil,
            erasable: c.contains(.erasable) ? c.lenientCount(.erasable) : nil)
    }
}

/// A member and what is stored about them.
public struct MemberDataLookup: Decodable, Sendable, Equatable {
    public let profile: MemberProfile
    public let data: MemberDataSummary

    public init(profile: MemberProfile, data: MemberDataSummary) {
        self.profile = profile
        self.data = data
    }

    private enum CodingKeys: String, CodingKey { case profile, data }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        profile = try c.decode(MemberProfile.self, forKey: .profile)
        data = try c.decode(forKey: .data, or: MemberDataSummary())
    }
}

/// The answer of `GET /member-data`: `lookup` is null when no member was asked for.
public struct MemberDataAnswer: Decodable, Sendable, Equatable {
    public let lookup: MemberDataLookup?
    /// What a deletion leaves alone, in the server's words.
    public let unaffected: String

    public init(lookup: MemberDataLookup? = nil, unaffected: String = "") {
        self.lookup = lookup
        self.unaffected = unaffected
    }

    private enum CodingKeys: String, CodingKey { case lookup, unaffected }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A lookup that is there but cannot be read is an error, not "nothing found".
        lookup = try c.decodeIfPresent(MemberDataLookup.self, forKey: .lookup)
        unaffected = try c.decode(forKey: .unaffected, or: "")
    }
}

/// The answer of `POST /member-data/forget`.
public struct ForgetMemberResult: Decodable, Sendable, Equatable {
    /// Whether Sylo could send the member the confirmation message (a shared server and open
    /// messages are needed); when not, staff should tell them directly.
    public let dmDelivered: Bool

    public init(dmDelivered: Bool) { self.dmDelivered = dmDelivered }

    private enum CodingKeys: String, CodingKey { case dmDelivered }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dmDelivered = try c.decode(forKey: .dmDelivered, or: false)
    }

    /// What to tell staff once the data is gone, in the dashboard's words.
    public var message: String {
        dmDelivered
            ? "Member data deleted. Sylo sent the member a message listing what was removed."
            : "Member data deleted, but Sylo could not message the member (no shared server, or their messages are closed). Let them know directly."
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/member-data?user=`: what Sylo stores about one member. The server
    /// reads a member id or an @mention; 400 for anything else.
    public struct LookupMemberData: APIEndpoint {
        public typealias Response = MemberDataAnswer
        public let server: ServerID
        public let userID: String

        public init(server: ServerID, userID: String) {
            self.server = server
            self.userID = userID
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/member-data" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "user", value: userID)] }
    }

    /// `POST /api/v2/guilds/:id/member-data/forget` with `{userId, reason, confirm: true}`: deletes
    /// the member's data and messages them what was removed. The server refuses without
    /// `confirm: true`. Safety records stay.
    public struct ForgetMemberData: APIEndpoint {
        public typealias Response = ForgetMemberResult
        public let server: ServerID
        public let userID: String
        public let reason: String

        public init(server: ServerID, userID: String, reason: String) {
            self.server = server
            self.userID = userID
            self.reason = reason
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/member-data/forget" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userID, reason: reason, confirm: true) }

        private struct Body: Encodable, Sendable {
            let userId: String
            let reason: String
            let confirm: Bool
        }
    }
}

/// The rules for forgetting a member, apart from the screen so they can be tested.
public enum MemberForget {
    /// The word to type before the erasure goes ahead (the dashboard asks for the same).
    public static let confirmationWord = "DELETE"
    /// The server keeps at most this many characters of the reason.
    public static let reasonLength = 500

    /// Whether what was typed is exactly the confirmation word, as the dashboard compares it.
    public static func isConfirmed(_ typed: String) -> Bool {
        typed == confirmationWord
    }

    /// The reason as it is sent: trimmed and cut at the server's limit. Empty when none was given,
    /// which is allowed.
    public static func cleanedReason(_ text: String) -> String {
        let cut = UTF16Limit.truncated(text.trimmingCharacters(in: .whitespacesAndNewlines), to: reasonLength)
        return cut.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Looks up one member and, when asked, forgets them. Holds personal data only while the screen
/// uses it: ``clear()`` drops it, and the screen calls that when it goes away.
@MainActor
@Observable
public final class MemberDataModel {
    public let server: ServerID
    /// The member last looked up.
    public private(set) var lookup: MemberDataLookup?
    /// What a deletion leaves alone, as the server worded it.
    public private(set) var unaffected = ""
    public private(set) var isLoading = false
    public private(set) var isForgetting = false
    /// Why the lookup failed.
    public var errorMessage: String?
    /// Why the erasure failed (the data is then still there).
    public var forgetError: String?
    /// What to tell staff after an erasure.
    public private(set) var forgetNotice: String?

    private let session: AppSession
    private var request = 0

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Looks the member up. A newer lookup wins over an older answer.
    public func look(up member: MemberChoice) async {
        request += 1
        let mine = request
        isLoading = true
        errorMessage = nil
        forgetError = nil
        forgetNotice = nil
        lookup = nil
        defer { if mine == request { isLoading = false } }
        do {
            let answer = try await session.send(Endpoints.LookupMemberData(server: server, userID: member.id))
            guard mine == request else { return }
            lookup = answer.lookup
            unaffected = answer.unaffected
        } catch {
            let error = NetworkError(error)
            if mine == request, error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Deletes the looked-up member's data, then looks again so the screen shows what is left.
    /// - Parameters:
    ///   - reason: Why. Optional (empty is fine); it goes in the audit log and in the message to the member.
    ///   - typed: What the person typed to confirm; must be ``MemberForget/confirmationWord``.
    /// - Returns: Whether the data was deleted.
    @discardableResult
    public func forget(reason: String, typed: String) async -> Bool {
        guard let lookup, !isForgetting else { return false }
        guard MemberForget.isConfirmed(typed) else {
            forgetError = "Type \(MemberForget.confirmationWord) to confirm."
            return false
        }
        let cleaned = MemberForget.cleanedReason(reason)
        isForgetting = true
        forgetError = nil
        forgetNotice = nil
        defer { isForgetting = false }
        let id = lookup.profile.id
        do {
            let result = try await session.send(Endpoints.ForgetMemberData(server: server, userID: id, reason: cleaned))
            forgetNotice = result.message
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { forgetError = error.userMessage }
            return false
        }
        // The data is gone whatever this read says; a failure here only leaves the old counts up.
        if let again = try? await session.send(Endpoints.LookupMemberData(server: server, userID: id)),
           let fresh = again.lookup {
            self.lookup = fresh
        }
        return true
    }

    /// Drops everything about the member from memory.
    public func clear() {
        request += 1
        lookup = nil
        unaffected = ""
        errorMessage = nil
        forgetError = nil
        forgetNotice = nil
        isLoading = false
    }
}
