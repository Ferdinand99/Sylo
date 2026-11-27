import Foundation
import Observation

// The Bridge module (Sylo 5.3, `bridge` in `GET /api/mobile/info`; src/web/routes/v2Bridge.js, the dashboard page
// is web-v2/src/moduleForms/Bridge.jsx). One channel on Discord and one on Fluxer share a conversation. One server
// asks for a link and gets a one-time code; the owner of the other server uses the code and picks a channel.
//
// Reading the page needs View. Every change (asking, using a code, cancelling a request, the options of this
// server's side, pause, resume and unlink) is the server owner's alone: the owner the platform reports for this
// server. Edit access, Administrator and the bot-master roles are not enough, and the server answers 403. The page's
// `owner` says whether the signed-in person may change anything. Every answer carries the fresh overview.

extension ServerFeature {
    /// The Bridge module's routes under `/api/v2/guilds/:id/modules/bridge/`.
    public static let bridge = ServerFeature(rawValue: "bridge")
}

/// A time the server sends as milliseconds since 1970; nil for 0, a missing value or one that is not a number.
enum MillisecondTime {
    static func date(_ value: Double?) -> Date? {
        guard let value, value.isFinite, value > 0 else { return nil }
        return Date(timeIntervalSince1970: value / 1000)
    }
}

/// What one side of a link shares about itself.
public struct BridgeOptions: Sendable, Hashable {
    /// Messages from other bot accounts of this server cross. Off until asked for.
    public var bots: Bool
    /// A short "joined" line on the other side when someone joins this server. Off until asked for.
    public var joinMessages: Bool
    /// Files up to 8 MB are uploaded again on the other side; off sends them as links.
    public var uploadFiles: Bool

    /// The server's defaults (`DEFAULT_OPTIONS` in src/modules/lib/bridgeText.js).
    public static let defaults = BridgeOptions()

    public init(bots: Bool = false, joinMessages: Bool = false, uploadFiles: Bool = true) {
        self.bots = bots
        self.joinMessages = joinMessages
        self.uploadFiles = uploadFiles
    }

    /// The switches, in the dashboard's order.
    public enum Key: String, CaseIterable, Sendable, Identifiable {
        case bots, joinMessages, uploadFiles

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .bots: String(localized: "Share Messages from Bots")
            case .joinMessages: String(localized: "Share Who Joins")
            case .uploadFiles: String(localized: "Copy Files Across")
            }
        }

        public var hint: String {
            switch self {
            case .bots:
                String(localized: "Off by default. Messages from other bot accounts of this server cross. Webhook messages (what bridges post) and Sylo itself never cross.")
            case .joinMessages:
                String(localized: "Off by default. A short \"joined\" line appears on the other side when someone joins this server.")
            case .uploadFiles:
                String(localized: "Files up to 8 MB are uploaded again on the other side; bigger ones, or all of them when this is off, cross as a link.")
            }
        }
    }

    public subscript(key: Key) -> Bool {
        get {
            switch key {
            case .bots: bots
            case .joinMessages: joinMessages
            case .uploadFiles: uploadFiles
            }
        }
        set {
            switch key {
            case .bots: bots = newValue
            case .joinMessages: joinMessages = newValue
            case .uploadFiles: uploadFiles = newValue
            }
        }
    }
}

extension BridgeOptions: Codable {
    private enum CodingKeys: String, CodingKey { case bots, joinMessages, uploadFiles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            bots: (try? c.decodeIfPresent(Bool.self, forKey: .bots)) ?? false,
            joinMessages: (try? c.decodeIfPresent(Bool.self, forKey: .joinMessages)) ?? false,
            uploadFiles: (try? c.decodeIfPresent(Bool.self, forKey: .uploadFiles)) ?? true)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(bots, forKey: .bots)
        try c.encode(joinMessages, forKey: .joinMessages)
        try c.encode(uploadFiles, forKey: .uploadFiles)
    }
}

/// How a link stands.
public enum BridgeLinkStatus: Hashable, Sendable, RawRepresentable {
    /// Messages cross.
    case active
    /// One of the two servers paused it (or the mirror holds it).
    case paused
    /// Sylo stopped it: a webhook or a channel is gone, or a permission is missing (``BridgeLink/problem``).
    case failed
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "active": self = .active
        case "paused": self = .paused
        case "failed": self = .failed
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .active: "active"
        case .paused: "paused"
        case .failed: "failed"
        case .other(let raw): raw
        }
    }
}

extension BridgeLinkStatus: Decodable {
    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One end of a link: the server and the channel.
public struct BridgeEnd: Decodable, Sendable, Hashable {
    public let platform: Platform
    public let server: String
    public let channel: String
    public let ageRestricted: Bool
    /// Only for this server's own end.
    public let channelId: String?

    public init(
        platform: Platform = .discord, server: String = "", channel: String = "", ageRestricted: Bool = false,
        channelId: String? = nil
    ) {
        self.platform = platform
        self.server = server
        self.channel = channel
        self.ageRestricted = ageRestricted
        self.channelId = channelId
    }

    private enum CodingKeys: String, CodingKey { case platform, server, channel, ageRestricted, channelId }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let channelId = (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? nil
        self.init(
            platform: (try? c.decodeIfPresent(Platform.self, forKey: .platform)) ?? .discord,
            server: (try? c.decodeIfPresent(String.self, forKey: .server)) ?? "",
            channel: (try? c.decodeIfPresent(String.self, forKey: .channel)) ?? "",
            ageRestricted: (try? c.decodeIfPresent(Bool.self, forKey: .ageRestricted)) ?? false,
            channelId: (channelId?.isEmpty ?? true) ? nil : channelId)
    }
}

/// A bridged channel as this server sees it (never a webhook token).
public struct BridgeLink: Decodable, Sendable, Identifiable, Hashable {
    public let id: Int
    public let status: BridgeLinkStatus
    public let pausedByMe: Bool
    public let pausedByThem: Bool
    /// Whether the owner here can press Resume; nil on a server that does not say (then: a stopped link or
    /// one this server paused).
    public let resumable: Bool?
    /// Why Sylo stopped the link, in words; nil while it runs.
    public let problem: String?
    /// Why a paused link is paused beyond "a server paused it" (the mirror holds it, its owner changed).
    public let pauseNote: String?
    public let mine: BridgeEnd
    public let theirs: BridgeEnd
    public let options: BridgeOptions
    public let theirOptions: BridgeOptions
    /// Messages waiting to be sent, and dropped while busy.
    public let queued: Int
    public let dropped: Int

    public init(
        id: Int, status: BridgeLinkStatus = .active, pausedByMe: Bool = false, pausedByThem: Bool = false,
        resumable: Bool? = nil, problem: String? = nil, pauseNote: String? = nil, mine: BridgeEnd = BridgeEnd(),
        theirs: BridgeEnd = BridgeEnd(platform: .fluxer), options: BridgeOptions = .defaults,
        theirOptions: BridgeOptions = .defaults, queued: Int = 0, dropped: Int = 0
    ) {
        self.id = id
        self.status = status
        self.pausedByMe = pausedByMe
        self.pausedByThem = pausedByThem
        self.resumable = resumable
        self.problem = problem
        self.pauseNote = pauseNote
        self.mine = mine
        self.theirs = theirs
        self.options = options
        self.theirOptions = theirOptions
        self.queued = queued
        self.dropped = dropped
    }

    private enum CodingKeys: String, CodingKey {
        case id, status, pausedByMe, pausedByThem, resumable, problem, pauseNote, mine, theirs, options,
             theirOptions, queued, dropped
    }

    private struct Problem: Decodable {
        let text: String?
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let problem = ((try? c.decodeIfPresent(Problem.self, forKey: .problem)) ?? nil)?.text
        let note = (try? c.decodeIfPresent(String.self, forKey: .pauseNote)) ?? nil
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            status: (try? c.decodeIfPresent(BridgeLinkStatus.self, forKey: .status)) ?? .other(""),
            pausedByMe: (try? c.decodeIfPresent(Bool.self, forKey: .pausedByMe)) ?? false,
            pausedByThem: (try? c.decodeIfPresent(Bool.self, forKey: .pausedByThem)) ?? false,
            resumable: (try? c.decodeIfPresent(Bool.self, forKey: .resumable)) ?? nil,
            problem: (problem?.isEmpty ?? true) ? nil : problem,
            pauseNote: (note?.isEmpty ?? true) ? nil : note,
            mine: (try? c.decodeIfPresent(BridgeEnd.self, forKey: .mine)) ?? BridgeEnd(),
            theirs: (try? c.decodeIfPresent(BridgeEnd.self, forKey: .theirs)) ?? BridgeEnd(),
            options: (try? c.decodeIfPresent(BridgeOptions.self, forKey: .options)) ?? .defaults,
            theirOptions: (try? c.decodeIfPresent(BridgeOptions.self, forKey: .theirOptions)) ?? .defaults,
            queued: (try? c.decodeIfPresent(Int.self, forKey: .queued)) ?? 0,
            dropped: (try? c.decodeIfPresent(Int.self, forKey: .dropped)) ?? 0)
    }

    /// Whether the owner here can resume it: what the server says, else a stopped link or one this server paused.
    public var canResume: Bool {
        status != .active && (resumable ?? (status == .failed || pausedByMe))
    }

    /// "Running", "Paused by this server", "Paused by the other server", "Stopped".
    public var statusTitle: String {
        switch status {
        case .active: String(localized: "Running")
        case .paused:
            pausedByMe ? String(localized: "Paused by this server") : String(localized: "Paused by the other server")
        case .failed: String(localized: "Stopped")
        case .other(let raw): raw
        }
    }

    /// "Fluxer Lounge on Fluxer · age-restricted · 3 waiting to send".
    public var details: String {
        var parts = [String(localized: "\(theirs.server) on \(theirs.platform.displayName)")]
        if mine.ageRestricted { parts.append(String(localized: "age-restricted")) }
        if queued > 0 { parts.append(String(localized: "\(queued) waiting to send")) }
        if dropped > 0 { parts.append(String(localized: "\(dropped) dropped while busy")) }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// "The other server shares bot messages: no. Who joins: yes."
    public var theirSharing: String {
        let bots = theirOptions.bots ? String(localized: "shared") : String(localized: "not shared")
        let joins = theirOptions.joinMessages ? String(localized: "shared") : String(localized: "not shared")
        return String(localized: "The other server decides for itself what it shares. Bot messages: \(bots). Who joins: \(joins).")
    }
}

/// A request this server made that waits for the other server.
public struct BridgeRequest: Decodable, Sendable, Identifiable, Hashable {
    public let id: Int
    public let channelId: String
    public let channel: String
    /// When the code stops working.
    public let expiresAt: Date?
    /// Who asked, by their dashboard name.
    public let requestedBy: String

    public init(id: Int, channelId: String = "", channel: String = "", expiresAt: Date? = nil, requestedBy: String = "") {
        self.id = id
        self.channelId = channelId
        self.channel = channel
        self.expiresAt = expiresAt
        self.requestedBy = requestedBy
    }

    private enum CodingKeys: String, CodingKey { case id, channelId, channel, expiresAt, requestedBy }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            channelId: (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? "",
            channel: (try? c.decodeIfPresent(String.self, forKey: .channel)) ?? "",
            expiresAt: MillisecondTime.date((try? c.decodeIfPresent(Double.self, forKey: .expiresAt)) ?? nil),
            requestedBy: (try? c.decodeIfPresent(String.self, forKey: .requestedBy)) ?? "")
    }
}

/// A text channel of this server, for the pickers.
public struct BridgeChannel: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let ageRestricted: Bool
    /// Already in a link or a request.
    public let taken: Bool

    public init(id: String, name: String, ageRestricted: Bool = false, taken: Bool = false) {
        self.id = id
        self.name = name
        self.ageRestricted = ageRestricted
        self.taken = taken
    }

    private enum CodingKeys: String, CodingKey { case id, name, ageRestricted, taken }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        self.init(
            id: id,
            name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? id,
            ageRestricted: (try? c.decodeIfPresent(Bool.self, forKey: .ageRestricted)) ?? false,
            taken: (try? c.decodeIfPresent(Bool.self, forKey: .taken)) ?? false)
    }

    /// "#general (age-restricted)".
    public var label: String {
        ageRestricted ? String(localized: "#\(name) (age-restricted)") : "#\(name)"
    }
}

/// Everything the Bridge page shows for a server.
public struct BridgeOverview: Decodable, Sendable, Equatable {
    public let platform: Platform
    /// Sylo runs on both Discord and Fluxer; without that there is nothing to bridge to.
    public let bothPlatforms: Bool
    /// The module is on.
    public let enabled: Bool
    /// The most links and waiting requests this server can have.
    public let maxLinks: Int
    public let maxRequests: Int
    public let links: [BridgeLink]
    public let requests: [BridgeRequest]
    public let channels: [BridgeChannel]
    /// Whether the signed-in person owns this server and so may change the bridge. False when the server
    /// does not say.
    public let isOwner: Bool

    public init(
        platform: Platform = .discord, bothPlatforms: Bool = true, enabled: Bool = true, maxLinks: Int = 100,
        maxRequests: Int = 5, links: [BridgeLink] = [], requests: [BridgeRequest] = [],
        channels: [BridgeChannel] = [], isOwner: Bool = true
    ) {
        self.platform = platform
        self.bothPlatforms = bothPlatforms
        self.enabled = enabled
        self.maxLinks = maxLinks
        self.maxRequests = maxRequests
        self.links = links
        self.requests = requests
        self.channels = channels
        self.isOwner = isOwner
    }

    private enum CodingKeys: String, CodingKey {
        case platform, bothPlatforms, enabled, limits, links, requests, channels, owner
    }

    private struct Limits: Decodable {
        let links: Int?
        let requests: Int?
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let limits = (try? c.decodeIfPresent(Limits.self, forKey: .limits)) ?? nil
        self.init(
            platform: (try? c.decodeIfPresent(Platform.self, forKey: .platform)) ?? .discord,
            bothPlatforms: (try? c.decodeIfPresent(Bool.self, forKey: .bothPlatforms)) ?? false,
            enabled: (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false,
            maxLinks: limits?.links ?? 100,
            maxRequests: limits?.requests ?? 5,
            links: try c.decodeLossyArray(of: BridgeLink.self, forKey: .links),
            requests: try c.decodeLossyArray(of: BridgeRequest.self, forKey: .requests),
            channels: try c.decodeLossyArray(of: BridgeChannel.self, forKey: .channels),
            isOwner: (try? c.decodeIfPresent(Bool.self, forKey: .owner)) ?? false)
    }

    /// The platform on the other side of every link: Fluxer for a Discord server, and the other way round.
    public var otherPlatform: Platform { platform == .fluxer ? .discord : .fluxer }

    /// Both platforms are there and the module is on: a link can be asked for or a code used.
    public var isReady: Bool { bothPlatforms && enabled }

    /// The channels not in a link or a request yet.
    public var freeChannels: [BridgeChannel] { channels.filter { !$0.taken } }

    /// "Bridged channels (3 of 100)", or "(103)" when the server has more than the limit.
    public var linksTitle: String {
        links.count <= maxLinks
            ? String(localized: "Bridged Channels (\(links.count) of \(maxLinks))")
            : String(localized: "Bridged Channels (\(links.count))")
    }

    /// Why no new link can be made, when the server is at or over its limit; nil otherwise.
    public var limitNote: String? {
        guard links.count >= maxLinks else { return nil }
        let start = links.count > maxLinks
            ? String(localized: "This server has more bridged channels than the limit of \(maxLinks). No new link can be made until some are unlinked or the limit is raised.")
            : String(localized: "This server has reached the limit of \(maxLinks) bridged channels, so no new link can be made, and a server mirror stops linking channels.")
        return start + " " + String(localized: "The limit is set by whoever runs this Sylo (the BRIDGE_MAX_LINKS setting); if that is not you, ask them.")
    }
}

/// The answer to every change: the page as it is now.
public struct BridgeAnswer: Decodable, Sendable, Equatable {
    public let overview: BridgeOverview?

    public init(overview: BridgeOverview? = nil) { self.overview = overview }

    private enum CodingKeys: String, CodingKey { case overview }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        overview = (try? c.decodeIfPresent(BridgeOverview.self, forKey: .overview)) ?? nil
    }
}

/// The code a request gave: shown once, since the server keeps only its hash.
public struct BridgeIssuedCode: Decodable, Sendable, Equatable {
    public let code: String
    public let expiresAt: Date?
    public let overview: BridgeOverview?

    public init(code: String, expiresAt: Date? = nil, overview: BridgeOverview? = nil) {
        self.code = code
        self.expiresAt = expiresAt
        self.overview = overview
    }

    private enum CodingKeys: String, CodingKey { case code, expiresAt, overview }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            code: (try? c.decodeIfPresent(String.self, forKey: .code)) ?? "",
            expiresAt: MillisecondTime.date((try? c.decodeIfPresent(Double.self, forKey: .expiresAt)) ?? nil),
            overview: (try? c.decodeIfPresent(BridgeOverview.self, forKey: .overview)) ?? nil)
    }
}

/// `{ channelId, options }`, for asking for a link.
struct BridgeRequestBody: Encodable, Sendable {
    let channelId: String
    let options: BridgeOptions
}

/// `{ code, channelId, options }`, for using a code.
struct BridgeAcceptBody: Encodable, Sendable {
    let code: String
    let channelId: String
    let options: BridgeOptions
}

/// `{ options: { <key>: <on> } }`: one switch of this server's side. The server keeps the rest.
struct BridgeOptionBody: Encodable, Sendable {
    let key: BridgeOptions.Key
    let on: Bool

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        var options = c.nestedContainer(keyedBy: Key.self, forKey: Key(stringValue: "options"))
        try options.encode(on, forKey: Key(stringValue: key.rawValue))
    }
}

/// What can be done to a link.
public enum BridgeLinkAction: String, Sendable, CaseIterable {
    case pause, resume, unlink
}

extension Endpoints {
    private static func bridgeBase(_ server: ServerID) -> String {
        "/api/v2/guilds/\(server.pathComponent)/modules/bridge"
    }

    /// `GET .../modules/bridge/config`: the page (View).
    public struct LoadBridge: APIEndpoint {
        public typealias Response = BridgeOverview
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.bridgeBase(server) + "/config" }
    }

    /// `POST .../modules/bridge/request`: a code for the other server.
    public struct RequestBridgeLink: APIEndpoint {
        public typealias Response = BridgeIssuedCode
        public let server: ServerID
        public let channelID: String
        public let options: BridgeOptions

        public init(server: ServerID, channelID: String, options: BridgeOptions) {
            self.server = server
            self.channelID = channelID
            self.options = options
        }

        public var path: String { Endpoints.bridgeBase(server) + "/request" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { BridgeRequestBody(channelId: channelID, options: options) }
    }

    /// `POST .../modules/bridge/requests/:id/cancel`: the code stops working.
    public struct CancelBridgeRequest: APIEndpoint {
        public typealias Response = BridgeAnswer
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { Endpoints.bridgeBase(server) + "/requests/\(id)/cancel" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST .../modules/bridge/accept`: use a code from the other server.
    public struct AcceptBridgeLink: APIEndpoint {
        public typealias Response = BridgeAnswer
        public let server: ServerID
        public let code: String
        public let channelID: String
        public let options: BridgeOptions

        public init(server: ServerID, code: String, channelID: String, options: BridgeOptions) {
            self.server = server
            self.code = code
            self.channelID = channelID
            self.options = options
        }

        public var path: String { Endpoints.bridgeBase(server) + "/accept" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            BridgeAcceptBody(code: code, channelId: channelID, options: options)
        }
    }

    /// `POST .../modules/bridge/links/:id/options`: one switch of what this server shares.
    public struct SetBridgeOption: APIEndpoint {
        public typealias Response = BridgeAnswer
        public let server: ServerID
        public let id: Int
        public let key: BridgeOptions.Key
        public let on: Bool

        public init(server: ServerID, id: Int, key: BridgeOptions.Key, on: Bool) {
            self.server = server
            self.id = id
            self.key = key
            self.on = on
        }

        public var path: String { Endpoints.bridgeBase(server) + "/links/\(id)/options" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { BridgeOptionBody(key: key, on: on) }
    }

    /// `POST .../modules/bridge/links/:id/pause`, `/resume` or `/unlink`.
    public struct ChangeBridgeLink: APIEndpoint {
        public typealias Response = BridgeAnswer
        public let server: ServerID
        public let id: Int
        public let action: BridgeLinkAction

        public init(server: ServerID, id: Int, action: BridgeLinkAction) {
            self.server = server
            self.id = id
            self.action = action
        }

        public var path: String { Endpoints.bridgeBase(server) + "/links/\(id)/\(action.rawValue)" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }
}

/// The Bridge screen's state: the page, the two forms (ask for a link, use a code), and every action. Each answer
/// carries the page as it is now, which replaces the one shown.
@MainActor
@Observable
public final class BridgeModel {
    public let server: ServerID
    public private(set) var overview: BridgeOverview?
    public private(set) var isLoading = false
    /// Why the page could not be loaded (the last page, if any, stays).
    public var errorMessage: String?
    /// Why the last action did not go through.
    public var actionError: String?
    /// What the last action did, in a sentence.
    public var notice: String?
    /// The code the last request gave. It is shown once: the server keeps only its hash.
    public private(set) var issuedCode: BridgeIssuedCode?
    public private(set) var isWorking = false
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0

    /// Ask the other server: the channel here and what it shares.
    public var askChannelID = ""
    public var askOptions = BridgeOptions.defaults
    /// Use a code: the code, the channel here and what it shares.
    public var code = ""
    public var useChannelID = ""
    public var useOptions = BridgeOptions.defaults

    /// The longest code the field takes (the code is XXXX-XXXX-XXXX; a pasted one may carry spaces).
    public static let codeFieldLength = 24

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var hasLoaded: Bool { overview != nil }
    /// Only the server owner may change the bridge.
    public var isOwner: Bool { overview?.isOwner ?? false }

    private var trimmedCode: String { code.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var canAsk: Bool {
        isOwner && (overview?.isReady ?? false) && !isWorking && !askChannelID.isEmpty
    }

    public var canUseCode: Bool {
        isOwner && (overview?.isReady ?? false) && !isWorking && !trimmedCode.isEmpty && !useChannelID.isEmpty
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            overview = try await session.send(Endpoints.LoadBridge(server: server))
            errorMessage = nil
        } catch {
            if let message = ListFailure.message(for: error) { errorMessage = message }
        }
    }

    /// Asks for a link for the picked channel; the code is kept in ``issuedCode``.
    @discardableResult
    public func requestLink() async -> Bool {
        guard canAsk else { return false }
        let channel = askChannelID
        let options = askOptions
        return await perform {
            let answer = try await self.session.send(
                Endpoints.RequestBridgeLink(server: self.server, channelID: channel, options: options))
            self.issuedCode = answer.code.isEmpty ? nil : answer
            self.askChannelID = ""
            return answer.overview
        }
    }

    /// Uses the code from the other server for the picked channel.
    @discardableResult
    public func acceptCode() async -> Bool {
        guard canUseCode else { return false }
        let code = trimmedCode
        let channel = useChannelID
        let options = useOptions
        let ok = await perform {
            try await self.session.send(
                Endpoints.AcceptBridgeLink(server: self.server, code: code, channelID: channel, options: options)
            ).overview
        }
        if ok {
            self.code = ""
            useChannelID = ""
            notice = String(localized: "The bridge is on.")
        }
        return ok
    }

    public func cancel(_ request: BridgeRequest) async {
        await perform {
            try await self.session.send(Endpoints.CancelBridgeRequest(server: self.server, id: request.id)).overview
        }
    }

    /// Turns one switch of what this server shares on a link on or off.
    public func setOption(_ key: BridgeOptions.Key, to on: Bool, on link: BridgeLink) async {
        guard isOwner else { return }
        await perform {
            try await self.session.send(
                Endpoints.SetBridgeOption(server: self.server, id: link.id, key: key, on: on)
            ).overview
        }
    }

    public func change(_ link: BridgeLink, _ action: BridgeLinkAction) async {
        guard isOwner else { return }
        await perform {
            try await self.session.send(Endpoints.ChangeBridgeLink(server: self.server, id: link.id, action: action))
                .overview
        }
    }

    /// Forgets the code once it was shown and copied.
    public func dismissCode() { issuedCode = nil }

    /// Runs one change; its answer's page replaces the one shown (a missing one is loaded again).
    @discardableResult
    private func perform(_ call: @MainActor () async throws -> BridgeOverview?) async -> Bool {
        guard !isWorking else {
            actionError = CommunityMessage.busy
            return false
        }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        notice = nil
        do {
            if let next = try await call() {
                overview = next
            } else {
                await load()
            }
            successCount += 1
            return true
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
            return false
        }
    }
}
