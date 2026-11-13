import Foundation
import Observation

// Finding a member of a server by name, for the screens that act on one (warn, member data, XP,
// economy). The dashboard has no search of its own for these (people paste ids), so the server gets
// `GET /api/v2/guilds/:id/members?q=` (gap S1). Until a server has it, the app asks the Temporary
// roles search instead, which answers the same shape on every 5.x server and works whether or not
// that module is on.

/// A member a search found.
public struct MemberMatch: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    /// The server nickname, else the account name.
    public let name: String
    /// The account name (`ferdi`); empty when the server did not send it.
    public let username: String

    public init(id: String, name: String, username: String = "") {
        self.id = id
        self.name = name
        self.username = username
    }

    private enum CodingKeys: String, CodingKey { case id, name, username }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        let name = try c.decode(forKey: .name, or: "")
        self.init(id: id, name: name.isEmpty ? id : name, username: try c.decode(forKey: .username, or: ""))
    }
}

/// The answer of a member search, `{members: [{id, name, username}]}`.
public struct MemberSearchResult: Decodable, Sendable, Equatable {
    public let members: [MemberMatch]

    public init(members: [MemberMatch] = []) { self.members = members }

    private enum CodingKeys: String, CodingKey { case members }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        members = try c.decodeLossyArray(of: MemberMatch.self, forKey: .members)
    }
}

/// Someone picked for an action: a search result, or an id (or mention) that was pasted.
public struct MemberChoice: Sendable, Hashable, Identifiable {
    public let id: String
    /// Their name, or the id itself when only an id is known.
    public let name: String

    public init(id: String, name: String? = nil) {
        self.id = id
        self.name = (name?.isEmpty == false ? name : nil) ?? id
    }

    public init(_ match: MemberMatch) {
        self.init(id: match.id, name: match.name)
    }

    /// Whether a name is known, not only the id.
    public var hasName: Bool { name != id }
}

/// Reads a member id out of what a person pasted.
public enum MemberReference {
    /// The id in `123456789012345678`, `<@123456789012345678>` or `<@!123456789012345678>` (spaces
    /// around are fine), or nil for anything else, including role and channel mentions. Ids are 17
    /// to 20 digits, as on the server.
    public static func id(in text: String) -> String? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("<@"), value.hasSuffix(">") {
            value = String(value.dropFirst(2).dropLast())
            if value.hasPrefix("!") { value.removeFirst() }
        }
        guard (17...20).contains(value.count), value.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return value
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/members?q=` (server gap S1): members whose name matches, at most 25,
    /// no bots; an exact id is looked up live. 404 on a server that does not have it yet.
    public struct SearchMembers: APIEndpoint {
        public typealias Response = MemberSearchResult
        public let server: ServerID
        public let text: String

        public init(server: ServerID, text: String) {
            self.server = server
            self.text = text
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/members" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "q", value: String(text.prefix(100)))] }
    }

    /// `GET /api/v2/guilds/:id/modules/temp-roles/members?q=`: the Temporary roles module's member
    /// search, the fallback for a server without ``SearchMembers``. Same answer shape.
    public struct SearchTempRoleMembers: APIEndpoint {
        public typealias Response = MemberSearchResult
        public let server: ServerID
        public let text: String

        public init(server: ServerID, text: String) {
            self.server = server
            self.text = text
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/temp-roles/members" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "q", value: String(text.prefix(100)))] }
    }
}

/// Searches a server's members as the person types. Call ``search()`` after a short pause in typing
/// (the view's `.task(id: query)` does); a newer query cancels the older search.
@MainActor
@Observable
public final class MemberSearchModel {
    public let server: ServerID

    /// What the person typed.
    public var query = ""
    /// The members found for ``searchedText``.
    public private(set) var results: [MemberMatch] = []
    /// The text ``results`` belong to (trimmed); nil before a search finished.
    public private(set) var searchedText: String?
    public private(set) var isSearching = false
    /// Why the last search failed; the results shown are the ones from before.
    public private(set) var errorMessage: String?
    /// False once neither search route exists on this server: only a pasted id or mention works.
    public private(set) var isAvailable = true

    private var usesFallback = false
    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// The member id the typed text spells out, when it is an id or a mention.
    public var pastedID: String? { MemberReference.id(in: query) }

    /// Searches for the typed text: the server's `/members`, and on a 404 the Temporary roles
    /// search (remembered, so later searches go straight there). Empty text clears the results.
    public func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            results = []
            searchedText = nil
            errorMessage = nil
            return
        }
        guard isAvailable else { return }
        isSearching = true
        defer { isSearching = false }
        do {
            let found = try await load(text)
            // The person kept typing while this ran.
            guard text == query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            results = found.members
            searchedText = text
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized { return }
            if !isAvailable { return }
            errorMessage = error.userMessage
        }
    }

    private func load(_ text: String) async throws -> MemberSearchResult {
        if !usesFallback {
            do {
                return try await session.send(Endpoints.SearchMembers(server: server, text: text))
            } catch NetworkError.notFound {
                usesFallback = true
            }
        }
        do {
            return try await session.send(Endpoints.SearchTempRoleMembers(server: server, text: text))
        } catch NetworkError.notFound {
            isAvailable = false
            throw NetworkError.notFound
        }
    }
}
