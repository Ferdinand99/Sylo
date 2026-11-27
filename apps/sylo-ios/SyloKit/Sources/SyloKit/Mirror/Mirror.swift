import Foundation
import Observation

// Mirror to Fluxer (Sylo 5.3; src/web/routes/v2Mirror.js, the dashboard page is web-v2/src/pages/Mirror.jsx with its words in web-v2/src/mirrorModel.js). Sylo copies a Discord
// server's categories, channels, roles, emoji, stickers and its own settings to a Fluxer server and keeps them in
// step. The same page serves both servers of a pair: the Discord server (the source) asks, previews and copies; the
// Fluxer server (the target) agrees with the code the request showed, may allow real deletion, and may pause or stop.
//
// The feature string is `mirror` in `GET /api/mobile/info`. Reading the page, the preview and the report needs View.
// Every change needs the owner of the server the call is made on: an Administrator, an Edit holder or a bot master
// gets 403 (`code: "owner-only"`). The state's `isOwner` says whether the signed-in person may change anything.

extension ServerFeature {
    /// The Mirror to Fluxer routes under `/api/v2/guilds/:id/mirror`.
    public static let mirror = ServerFeature(rawValue: "mirror")
}

/// One switch of what a mirror copies.
public enum MirrorOptionKey: String, CaseIterable, Sendable, Identifiable {
    case name, icon, banner, roles, channels, emoji, stickers, modules, continuous, mirrorDeletes

    public var id: String { rawValue }

    /// What the dashboard calls it.
    public var title: String {
        switch self {
        case .name: String(localized: "Server name")
        case .icon: String(localized: "Server icon")
        case .banner: String(localized: "Server banner")
        case .roles: String(localized: "Roles")
        case .channels: String(localized: "Channels and categories")
        case .emoji: String(localized: "Emoji")
        case .stickers: String(localized: "Stickers")
        case .modules: String(localized: "Sylo's own settings (welcome, tickets, moderation and the rest)")
        case .continuous: String(localized: "Keep the Fluxer server in step afterwards")
        case .mirrorDeletes: String(localized: "Delete on Fluxer what is deleted on Discord")
        }
    }

    /// A word of warning under the switch, where it needs one.
    public var hint: String? {
        switch self {
        case .mirrorDeletes:
            String(localized: "Off (the default): a channel or role deleted on Discord stays on Fluxer, locked and marked as removed, and its messages are kept. On: it is deleted on Fluxer too, with all its messages. Only what Sylo made is ever deleted. Turning it on only asks: the owner of the Fluxer server has to allow it on that server's Mirror page.")
        default: nil
        }
    }

    /// The server's default (`DEFAULT_OPTIONS` in src/mirror/spec.js).
    public var defaultValue: Bool { self != .mirrorDeletes }
}

/// What a mirror copies. Every switch the server knows is a boolean; one the server did not send has its default.
public struct MirrorOptions: Sendable, Hashable, Decodable {
    /// As the server sent them, with the keys this app does not know.
    public let values: [String: Bool]

    public init(_ values: [String: Bool] = [:]) { self.values = values }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        var values: [String: Bool] = [:]
        for key in c.allKeys {
            if let on = try? c.decode(Bool.self, forKey: key) { values[key.stringValue] = on }
        }
        self.values = values
    }

    public subscript(key: MirrorOptionKey) -> Bool { values[key.rawValue] ?? key.defaultValue }

    /// Real deletion on Fluxer is on: the Discord side asked and the Fluxer owner allowed it.
    public var mirrorDeletes: Bool { values["mirrorDeletes"] ?? false }
    /// The Discord side asked for real deletion; it waits for the Fluxer owner.
    public var mirrorDeletesRequested: Bool { values["mirrorDeletesRequested"] ?? false }

    /// What the switch shows: real deletion counts as on from the moment it was asked for.
    public func shows(_ key: MirrorOptionKey) -> Bool {
        key == .mirrorDeletes ? mirrorDeletes || mirrorDeletesRequested : self[key]
    }

    /// Asked for, not allowed yet.
    public var deletesWaitForFluxer: Bool { mirrorDeletesRequested && !mirrorDeletes }
}

/// A coding key for any name.
struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// Where a pair stands.
public enum MirrorPairStatus: Hashable, Sendable, RawRepresentable {
    /// Asked, waiting for the Fluxer server's owner to agree.
    case pending
    /// Both agreed, nothing copied yet.
    case ready
    case copying
    /// Copied and kept in step.
    case live
    /// Copied once, not kept in step.
    case done
    case paused
    case stopped
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "pending": self = .pending
        case "ready": self = .ready
        case "copying": self = .copying
        case "live": self = .live
        case "done": self = .done
        case "paused": self = .paused
        case "stopped": self = .stopped
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .pending: "pending"
        case .ready: "ready"
        case .copying: "copying"
        case .live: "live"
        case .done: "done"
        case .paused: "paused"
        case .stopped: "stopped"
        case .other(let raw): raw
        }
    }

    /// The dashboard's words for it.
    public var title: String {
        switch self {
        case .pending: String(localized: "Waiting for the Fluxer server")
        case .ready: String(localized: "Agreed, not copied yet")
        case .copying: String(localized: "Copying")
        case .live: String(localized: "Mirroring")
        case .done: String(localized: "Copied")
        case .paused: String(localized: "Paused")
        case .stopped: String(localized: "Stopped")
        case .other(let raw): raw.isEmpty ? String(localized: "Unknown") : raw
        }
    }

    /// A copy or a sync runs, so Pause is offered.
    public var isRunning: Bool { self == .copying || self == .live }
}

extension MirrorPairStatus: Decodable {
    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// Which server of the pair this one is.
public enum MirrorSide: String, Sendable, Hashable {
    /// The Discord server, which is copied.
    case source
    /// The Fluxer server, which receives the copy.
    case target
}

/// The pair this server is part of, as this side sees it (never a code, a hash or a secret).
public struct MirrorPair: Decodable, Sendable, Hashable {
    public let id: Int
    public let side: MirrorSide
    public let status: MirrorPairStatus
    public let options: MirrorOptions
    /// The other server's key (`fluxer:<id>` on the Discord side).
    public let otherID: String
    /// The other server's name. The Discord side learns the Fluxer server's name only once its owner agreed.
    public let otherName: String?
    /// Who asked, by their dashboard name; only on the server they asked from.
    public let requestedBy: String
    /// Why it is paused: `owner`, `deletes` (a burst of deletes to confirm), `ownership` (a server changed hands), …
    public let pauseKind: String
    /// Who paused it: `source`, `target` or `system`; "" when it is not paused.
    public let pausedBy: String
    /// When the code of a waiting request stops working.
    public let codeExpiresAt: Date?
    /// Why it paused or what went wrong last, in words.
    public let lastError: String
    /// When the first copy finished.
    public let copiedAt: Date?
    /// How many copies were started (0: none yet).
    public let copyRun: Int

    public init(
        id: Int, side: MirrorSide = .source, status: MirrorPairStatus = .ready, options: MirrorOptions = MirrorOptions(),
        otherID: String = "", otherName: String? = nil, requestedBy: String = "", pauseKind: String = "",
        pausedBy: String = "", codeExpiresAt: Date? = nil, lastError: String = "", copiedAt: Date? = nil,
        copyRun: Int = 0
    ) {
        self.id = id
        self.side = side
        self.status = status
        self.options = options
        self.otherID = otherID
        self.otherName = otherName
        self.requestedBy = requestedBy
        self.pauseKind = pauseKind
        self.pausedBy = pausedBy
        self.codeExpiresAt = codeExpiresAt
        self.lastError = lastError
        self.copiedAt = copiedAt
        self.copyRun = copyRun
    }

    private enum CodingKeys: String, CodingKey {
        case id, side, status, options, otherId, otherName, requestedBy, pauseKind, pausedBy, codeExpiresAt,
             lastError, copiedAt, copyRun
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let side = (try? c.decodeIfPresent(String.self, forKey: .side)) ?? nil
        let name = (try? c.decodeIfPresent(String.self, forKey: .otherName)) ?? nil
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            side: side.flatMap(MirrorSide.init(rawValue:)) ?? .source,
            status: (try? c.decodeIfPresent(MirrorPairStatus.self, forKey: .status)) ?? .other(""),
            options: (try? c.decodeIfPresent(MirrorOptions.self, forKey: .options)) ?? MirrorOptions(),
            otherID: (try? c.decodeIfPresent(String.self, forKey: .otherId)) ?? "",
            otherName: (name?.isEmpty ?? true) ? nil : name,
            requestedBy: (try? c.decodeIfPresent(String.self, forKey: .requestedBy)) ?? "",
            pauseKind: (try? c.decodeIfPresent(String.self, forKey: .pauseKind)) ?? "",
            pausedBy: (try? c.decodeIfPresent(String.self, forKey: .pausedBy)) ?? "",
            codeExpiresAt: MillisecondTime.date((try? c.decodeIfPresent(Double.self, forKey: .codeExpiresAt)) ?? nil),
            lastError: (try? c.decodeIfPresent(String.self, forKey: .lastError)) ?? "",
            copiedAt: MillisecondTime.date((try? c.decodeIfPresent(Double.self, forKey: .copiedAt)) ?? nil),
            copyRun: (try? c.decodeIfPresent(Int.self, forKey: .copyRun)) ?? 0)
    }

    /// May this side resume it? Only the side whose owner paused it can; a pause Sylo made is open to both.
    public var canResume: Bool { pausedBy.isEmpty || pausedBy == "system" || pausedBy == side.rawValue }

    /// The button that resumes it, by why it paused.
    public var resumeTitle: String {
        switch pauseKind {
        case "deletes": String(localized: "Review the Deletions")
        case "ownership": String(localized: "Confirm the Mirror as the Owner")
        default: String(localized: "Resume")
        }
    }

    /// Who may resume it when this side may not.
    public var resumeNote: String? {
        guard status == .paused, !canResume else { return nil }
        return pausedBy == "source"
            ? String(localized: "The owner of the Discord server paused this mirror, so only that owner can resume it.")
            : String(localized: "The owner of the Fluxer server paused this mirror, so only that owner can resume it.")
    }

    /// "Copy again" is offered once a copy is there.
    public var canCopyAgain: Bool { status == .live || status == .done }
}

/// A deletion that waits to be applied on Fluxer.
public struct MirrorDeletion: Decodable, Sendable, Hashable {
    public let kind: String
    public let name: String
    /// `lock` or `delete`.
    public let action: String

    public init(kind: String, name: String, action: String = "lock") {
        self.kind = kind
        self.name = name
        self.action = action
    }

    private enum CodingKeys: String, CodingKey { case kind, name, action }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            kind: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "",
            name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "",
            action: (try? c.decodeIfPresent(String.self, forKey: .action)) ?? "lock")
    }
}

/// A copy left on Fluxer whose Discord original was deleted: locked, not deleted.
public struct MirrorRemoved: Decodable, Sendable, Hashable {
    public let kind: String
    public let label: String

    public init(kind: String, label: String) {
        self.kind = kind
        self.label = label
    }

    private enum CodingKeys: String, CodingKey { case kind, label }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            kind: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "",
            label: (try? c.decodeIfPresent(String.self, forKey: .label)) ?? "")
    }
}

/// How far a pair is: the steps of the latest copy, the changes waiting, the deletes to confirm and what was removed.
public struct MirrorProgress: Decodable, Sendable, Hashable {
    public let total: Int
    public let done: Int
    public let skipped: Int
    public let failed: Int
    public let waiting: Int
    /// 0 to 100.
    public let percent: Int
    public let waitingChanges: Int
    public let pendingDeletes: [MirrorDeletion]
    public let removed: [MirrorRemoved]

    public init(
        total: Int = 0, done: Int = 0, skipped: Int = 0, failed: Int = 0, waiting: Int = 0, percent: Int = 0,
        waitingChanges: Int = 0, pendingDeletes: [MirrorDeletion] = [], removed: [MirrorRemoved] = []
    ) {
        self.total = total
        self.done = done
        self.skipped = skipped
        self.failed = failed
        self.waiting = waiting
        self.percent = percent
        self.waitingChanges = waitingChanges
        self.pendingDeletes = pendingDeletes
        self.removed = removed
    }

    private enum CodingKeys: String, CodingKey {
        case total, done, skipped, failed, waiting, percent, waitingChanges, pendingDeletes, removed
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func int(_ key: CodingKeys) -> Int { (try? c.decodeIfPresent(Int.self, forKey: key)) ?? 0 }
        self.init(
            total: int(.total), done: int(.done), skipped: int(.skipped), failed: int(.failed),
            waiting: int(.waiting), percent: min(100, max(0, int(.percent))), waitingChanges: int(.waitingChanges),
            pendingDeletes: try c.decodeLossyArray(of: MirrorDeletion.self, forKey: .pendingDeletes),
            removed: try c.decodeLossyArray(of: MirrorRemoved.self, forKey: .removed))
    }

    /// "12 of 40 steps done, 1 failed".
    public var text: String {
        guard total > 0 else { return String(localized: "Nothing queued.") }
        var parts = [String(localized: "\(total - waiting) of \(total) steps done")]
        if failed > 0 { parts.append(String(localized: "\(failed) failed")) }
        if skipped > 0 { parts.append(String(localized: "\(skipped) skipped")) }
        return parts.joined(separator: ", ")
    }
}

/// The Mirror page of a server.
public struct MirrorState: Decodable, Sendable, Hashable {
    public let platform: Platform
    /// Only a Discord server can be mirrored (it is the source).
    public let canMirror: Bool
    /// This Sylo runs on Fluxer.
    public let fluxerConnected: Bool
    /// The signed-in person owns this server and may change the mirror. False when the server does not say.
    public let isOwner: Bool
    public let pair: MirrorPair?
    public let progress: MirrorProgress?
    /// The most emoji and stickers a copy takes.
    public let emojiLimit: Int
    public let stickerLimit: Int

    public init(
        platform: Platform = .discord, canMirror: Bool = true, fluxerConnected: Bool = true, isOwner: Bool = true,
        pair: MirrorPair? = nil, progress: MirrorProgress? = nil, emojiLimit: Int = 500, stickerLimit: Int = 500
    ) {
        self.platform = platform
        self.canMirror = canMirror
        self.fluxerConnected = fluxerConnected
        self.isOwner = isOwner
        self.pair = pair
        self.progress = progress
        self.emojiLimit = emojiLimit
        self.stickerLimit = stickerLimit
    }

    private enum CodingKeys: String, CodingKey {
        case platform, canMirror, fluxerConnected, isOwner, pair, progress, limits
    }

    private struct Limits: Decodable {
        let emoji: Int?
        let stickers: Int?
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let platform = (try? c.decodeIfPresent(Platform.self, forKey: .platform)) ?? .discord
        let limits = (try? c.decodeIfPresent(Limits.self, forKey: .limits)) ?? nil
        self.init(
            platform: platform,
            canMirror: (try? c.decodeIfPresent(Bool.self, forKey: .canMirror)) ?? (platform == .discord),
            fluxerConnected: (try? c.decodeIfPresent(Bool.self, forKey: .fluxerConnected)) ?? false,
            isOwner: (try? c.decodeIfPresent(Bool.self, forKey: .isOwner)) ?? false,
            pair: (try? c.decodeIfPresent(MirrorPair.self, forKey: .pair)) ?? nil,
            progress: (try? c.decodeIfPresent(MirrorProgress.self, forKey: .progress)) ?? nil,
            emojiLimit: limits?.emoji ?? 500,
            stickerLimit: limits?.stickers ?? 500)
    }

    /// A copy or a sync runs, so the page asks for progress every few seconds.
    public var isBusy: Bool {
        guard let pair else { return false }
        return pair.status == .copying || (pair.status == .live && (progress?.waitingChanges ?? 0) > 0)
    }

    /// The wizard's step on the Discord side.
    public var step: MirrorStep {
        guard let pair else { return .ask }
        switch pair.status {
        case .pending: return .agree
        case .ready: return .preview
        default: return .copy
        }
    }
}

/// The steps of the Discord side, in order.
public enum MirrorStep: Int, CaseIterable, Sendable, Comparable {
    case ask, agree, preview, copy

    public var title: String {
        switch self {
        case .ask: String(localized: "Ask")
        case .agree: String(localized: "Agree")
        case .preview: String(localized: "Preview")
        case .copy: String(localized: "Copy")
        }
    }

    public static func < (lhs: MirrorStep, rhs: MirrorStep) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// The answer to a request: the page, and the one-time code (or none, when the same person owns the Fluxer
/// server too and both sides agreed at once).
public struct MirrorRequestAnswer: Decodable, Sendable, Hashable {
    public let state: MirrorState
    public let code: String?
    public let agreed: Bool

    public init(state: MirrorState, code: String? = nil, agreed: Bool = false) {
        self.state = state
        self.code = code
        self.agreed = agreed
    }

    private enum CodingKeys: String, CodingKey { case code, agreed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let code = (try? c.decodeIfPresent(String.self, forKey: .code)) ?? nil
        self.init(
            state: try MirrorState(from: decoder),
            code: (code?.isEmpty ?? true) ? nil : code,
            agreed: (try? c.decodeIfPresent(Bool.self, forKey: .agreed)) ?? false)
    }
}

/// Something about a Fluxer server, a preview or a report, with the server's words.
public struct MirrorNotice: Decodable, Sendable, Hashable {
    public let code: String
    public let message: String

    public init(code: String = "", message: String) {
        self.code = code
        self.message = message
    }

    private enum CodingKeys: String, CodingKey { case code, message }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            code: (try? c.decodeIfPresent(String.self, forKey: .code)) ?? "",
            message: (try? c.decodeIfPresent(String.self, forKey: .message)) ?? "")
    }
}

/// One Fluxer server the signed-in person owns and Sylo is in, for the target picker.
public struct MirrorFluxerChoice: Decodable, Sendable, Hashable, Identifiable {
    /// The key to send (`fluxer:<id>`).
    public let id: String
    public let name: String
    public let iconURL: URL?
    public let memberCount: Int?
    /// Already part of a mirror, so it cannot be picked.
    public let inUse: Bool
    /// What Sylo still needs there (Administrator, the top role).
    public let notes: [MirrorNotice]

    public init(
        id: String, name: String, iconURL: URL? = nil, memberCount: Int? = nil, inUse: Bool = false,
        notes: [MirrorNotice] = []
    ) {
        self.id = id
        self.name = name
        self.iconURL = iconURL
        self.memberCount = memberCount
        self.inUse = inUse
        self.notes = notes
    }

    private enum CodingKeys: String, CodingKey { case id, name, icon, memberCount, inUse, notes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        let count = (try? c.decodeIfPresent(Int.self, forKey: .memberCount)) ?? nil
        self.init(
            id: id,
            name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? id,
            iconURL: (try? c.decodeURLIfPresent(forKey: .icon)) ?? nil,
            memberCount: (count ?? 0) > 0 ? count : nil,
            inUse: (try? c.decodeIfPresent(Bool.self, forKey: .inUse)) ?? false,
            notes: try c.decodeLossyArray(of: MirrorNotice.self, forKey: .notes))
    }

    /// "1 member", "1,204 members", or a plain note when Fluxer did not say.
    public var memberText: String {
        guard let memberCount else { return String(localized: "Members not known") }
        return memberCount == 1
            ? String(localized: "1 member")
            : String(localized: "\(memberCount.formatted()) members")
    }
}

/// The Fluxer servers to pick from.
public struct MirrorFluxerServers: Decodable, Sendable, Hashable {
    /// This Sylo runs on Fluxer.
    public let fluxerConnected: Bool
    /// The signed-in account has a Fluxer login; without it nothing can be listed.
    public let connected: Bool
    public let servers: [MirrorFluxerChoice]

    public init(fluxerConnected: Bool = true, connected: Bool = true, servers: [MirrorFluxerChoice] = []) {
        self.fluxerConnected = fluxerConnected
        self.connected = connected
        self.servers = servers
    }

    private enum CodingKeys: String, CodingKey { case fluxerConnected, connected, servers }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            fluxerConnected: (try? c.decodeIfPresent(Bool.self, forKey: .fluxerConnected)) ?? true,
            connected: (try? c.decodeIfPresent(Bool.self, forKey: .connected)) ?? true,
            servers: try c.decodeLossyArray(of: MirrorFluxerChoice.self, forKey: .servers))
    }
}

/// Something that cannot be carried over, or a word about it.
public struct MirrorNote: Decodable, Sendable, Hashable {
    public let code: String
    /// What it is about: `role`, `channel`, `emoji`, `sticker`, `module` or `guild`.
    public let scope: String
    public let message: String

    public init(code: String = "", scope: String, message: String) {
        self.code = code
        self.scope = scope
        self.message = message
    }

    private enum CodingKeys: String, CodingKey { case code, scope, message }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            code: (try? c.decodeIfPresent(String.self, forKey: .code)) ?? "",
            scope: (try? c.decodeIfPresent(String.self, forKey: .scope)) ?? "",
            message: (try? c.decodeIfPresent(String.self, forKey: .message)) ?? "")
    }
}

/// Notes of one scope, for one section.
public struct MirrorNoteGroup: Sendable, Hashable, Identifiable {
    public let scope: String
    public let title: String
    public let notes: [MirrorNote]
    public var id: String { scope }

    private static let order = ["role", "channel", "emoji", "sticker", "module", "guild"]

    private static func title(of scope: String) -> String {
        switch scope {
        case "role": String(localized: "Roles")
        case "channel": String(localized: "Channels and permissions")
        case "emoji": String(localized: "Emoji")
        case "sticker": String(localized: "Stickers")
        case "module": String(localized: "Sylo's settings")
        case "guild": String(localized: "The server itself")
        default: scope
        }
    }

    /// The notes grouped by what they are about, in the dashboard's order (an unknown scope last).
    public static func groups(_ notes: [MirrorNote]) -> [MirrorNoteGroup] {
        var scopes: [String] = []
        var byScope: [String: [MirrorNote]] = [:]
        for note in notes {
            if byScope[note.scope] == nil { scopes.append(note.scope) }
            byScope[note.scope, default: []].append(note)
        }
        let rank = { (scope: String) in order.firstIndex(of: scope) ?? order.count }
        return scopes
            .enumerated()
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .map { MirrorNoteGroup(scope: $0.element, title: title(of: $0.element), notes: byScope[$0.element] ?? []) }
    }
}

/// What a copy would do with one kind.
public struct MirrorCounts: Decodable, Sendable, Hashable {
    public let create: Int
    public let update: Int
    public let unchanged: Int
    public let skip: Int

    public init(create: Int = 0, update: Int = 0, unchanged: Int = 0, skip: Int = 0) {
        self.create = create
        self.update = update
        self.unchanged = unchanged
        self.skip = skip
    }

    private enum CodingKeys: String, CodingKey { case create, update, unchanged, skip }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func int(_ key: CodingKeys) -> Int { (try? c.decodeIfPresent(Int.self, forKey: key)) ?? 0 }
        self.init(create: int(.create), update: int(.update), unchanged: int(.unchanged), skip: int(.skip))
    }
}

/// One step of a preview.
public struct MirrorPlanStep: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let kind: String
    public let name: String
    /// `create`, `update`, `unchanged` or `skip`.
    public let op: String
    public let reason: String?
    public var id: String { key }

    public init(key: String, kind: String = "", name: String = "", op: String = "create", reason: String? = nil) {
        self.key = key
        self.kind = kind
        self.name = name
        self.op = op
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case key, kind, name, op, reason }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
        let name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        self.init(
            key: (try? c.decodeIfPresent(String.self, forKey: .key)) ?? UUID().uuidString,
            kind: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "",
            name: name,
            op: (try? c.decodeIfPresent(String.self, forKey: .op)) ?? "",
            reason: (reason?.isEmpty ?? true) ? nil : reason)
    }
}

/// The dry run: what a copy would do now, and everything that cannot be carried over. It creates nothing.
public struct MirrorPreview: Decodable, Sendable, Hashable {
    /// Nothing blocks the copy.
    public let ok: Bool
    public let blockers: [MirrorNotice]
    public let warnings: [MirrorNotice]
    public let summary: [String: MirrorCounts]
    public let notes: [MirrorNote]
    public let targetName: String?
    public let steps: [MirrorPlanStep]

    public init(
        ok: Bool = true, blockers: [MirrorNotice] = [], warnings: [MirrorNotice] = [],
        summary: [String: MirrorCounts] = [:], notes: [MirrorNote] = [], targetName: String? = nil,
        steps: [MirrorPlanStep] = []
    ) {
        self.ok = ok
        self.blockers = blockers
        self.warnings = warnings
        self.summary = summary
        self.notes = notes
        self.targetName = targetName
        self.steps = steps
    }

    private enum CodingKeys: String, CodingKey { case ok, blockers, warnings, summary, notes, target, steps }

    private struct Target: Decodable {
        let name: String?
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var summary: [String: MirrorCounts] = [:]
        if let raw = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: .summary) {
            for key in raw.allKeys {
                if let counts = try? raw.decode(MirrorCounts.self, forKey: key) { summary[key.stringValue] = counts }
            }
        }
        let target = (try? c.decodeIfPresent(Target.self, forKey: .target)) ?? nil
        let blockers = try c.decodeLossyArray(of: MirrorNotice.self, forKey: .blockers)
        self.init(
            ok: ((try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil) ?? blockers.isEmpty,
            blockers: blockers,
            warnings: try c.decodeLossyArray(of: MirrorNotice.self, forKey: .warnings),
            summary: summary,
            notes: try c.decodeLossyArray(of: MirrorNote.self, forKey: .notes),
            targetName: (target?.name?.isEmpty ?? true) ? nil : target?.name,
            steps: try c.decodeLossyArray(of: MirrorPlanStep.self, forKey: .steps))
    }

    private static let kinds: [(key: String, one: String, many: String)] = [
        ("guild", String(localized: "the server name, icon and banner"), String(localized: "the server name, icon and banner")),
        ("role", String(localized: "role"), String(localized: "roles")),
        ("channel", String(localized: "channel"), String(localized: "channels")),
        ("emoji", String(localized: "emoji"), String(localized: "emoji")),
        ("sticker", String(localized: "sticker"), String(localized: "stickers")),
        ("module", String(localized: "module setup"), String(localized: "module setups")),
    ]

    /// The summary as one line per kind: "Create 5 channels, update 1, skip 2".
    public var summaryLines: [String] {
        Self.kinds.compactMap { kind in
            guard let s = summary[kind.key] else { return nil }
            // The server's name, icon and banner are one thing: no count in front of them.
            let noun = { (n: Int) in kind.key == "guild" ? kind.one : "\(n) \(n == 1 ? kind.one : kind.many)" }
            var parts: [String] = []
            if s.create > 0 { parts.append(String(localized: "create \(noun(s.create))")) }
            if s.update > 0 {
                parts.append(s.create > 0 ? String(localized: "update \(s.update)") : String(localized: "update \(noun(s.update))"))
            }
            if s.skip > 0 { parts.append(String(localized: "skip \(s.skip)")) }
            if s.unchanged > 0 { parts.append(String(localized: "\(s.unchanged) already match")) }
            guard let first = parts.first else { return nil }
            parts[0] = first.prefix(1).uppercased() + first.dropFirst()
            return parts.joined(separator: ", ")
        }
    }
}

/// One step of the latest copy that could not be done.
public struct MirrorReportItem: Decodable, Sendable, Hashable {
    public let kind: String
    public let name: String
    public let status: String
    public let detail: String

    public init(kind: String = "", name: String, status: String = "failed", detail: String = "") {
        self.kind = kind
        self.name = name
        self.status = status
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey { case kind, name, status, detail, sourceId }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let source = (try? c.decodeIfPresent(String.self, forKey: .sourceId)) ?? nil
        self.init(
            kind: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "",
            name: ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? source ?? "",
            status: (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "",
            detail: ((try? c.decodeIfPresent(String.self, forKey: .detail)) ?? nil) ?? "")
    }
}

/// What became of the latest copy.
public struct MirrorReport: Decodable, Sendable, Hashable {
    public let failed: [MirrorReportItem]
    public let notes: [MirrorNote]
    /// How linking the copied channels through the bridge went: "done" with a sentence, else waiting.
    public let bridgeStatus: String?
    public let bridgeDetail: String

    public init(failed: [MirrorReportItem] = [], notes: [MirrorNote] = [], bridgeStatus: String? = nil, bridgeDetail: String = "") {
        self.failed = failed
        self.notes = notes
        self.bridgeStatus = bridgeStatus
        self.bridgeDetail = bridgeDetail
    }

    private enum CodingKeys: String, CodingKey { case failed, notes, bridge }

    private struct Bridge: Decodable {
        let status: String?
        let detail: String?
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let bridge = (try? c.decodeIfPresent(Bridge.self, forKey: .bridge)) ?? nil
        self.init(
            failed: try c.decodeLossyArray(of: MirrorReportItem.self, forKey: .failed),
            notes: try c.decodeLossyArray(of: MirrorNote.self, forKey: .notes),
            bridgeStatus: bridge?.status ?? (bridge == nil ? nil : ""),
            bridgeDetail: bridge?.detail ?? "")
    }

    /// "Linking channels through the bridge: 12 linked." or "…: waiting."; nil when there is no bridge step.
    public var bridgeLine: String? {
        guard let bridgeStatus else { return nil }
        let what = bridgeStatus == "done" ? bridgeDetail : String(localized: "waiting")
        return String(localized: "Linking channels through the bridge: \(what).")
    }
}

/// The mirror's words that do not belong to one type.
public enum MirrorText {
    /// "lock channel #chat, delete role Mod, and 3 more".
    public static func deleteSummary(_ items: [MirrorDeletion], count: Int? = nil) -> String {
        let shown = items.prefix(10).map { "\($0.action) \($0.kind) \($0.name)" }
        let more = (count ?? items.count) - shown.count
        return shown.joined(separator: ", ") + (more > 0 ? String(localized: ", and \(more) more") : "")
    }

    /// The time left of a code, as "42 minutes"; nil once it has run out.
    public static func codeLeft(until expiry: Date?, now: Date = .now) -> String? {
        guard let expiry else { return nil }
        let seconds = expiry.timeIntervalSince(now)
        guard seconds > 0 else { return nil }
        let minutes = Int((seconds / 60).rounded(.up))
        return minutes == 1 ? String(localized: "1 minute") : String(localized: "\(minutes) minutes")
    }

    /// Whether the text is a Fluxer server id the server takes: a raw id or "fluxer:<id>".
    public static func isTargetID(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = trimmed.hasPrefix("fluxer:") ? String(trimmed.dropFirst("fluxer:".count)) : trimmed
        return (17...20).contains(digits.count) && digits.allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// A code long enough to try (like K7QW-H2NP).
    public static func isCode(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 8
    }
}

/// `{ "<key>": <on> }`: one switch of the mirror. The server keeps the rest.
struct MirrorOptionBody: Encodable, Sendable {
    let key: MirrorOptionKey
    let on: Bool

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(on, forKey: AnyKey(stringValue: key.rawValue))
    }
}

struct MirrorTargetBody: Encodable, Sendable { let targetGuildId: String }
struct MirrorCodeBody: Encodable, Sendable { let code: String }
struct MirrorAllowBody: Encodable, Sendable { let allow: Bool }
struct MirrorConfirmBody: Encodable, Sendable { let confirm: Bool }

/// What either server of a pair can do to it.
public enum MirrorControl: String, Sendable, CaseIterable {
    case pause, resume, stop, remove
}

extension Endpoints {
    private static func mirrorBase(_ server: ServerID) -> String {
        "/api/v2/guilds/\(server.pathComponent)/mirror"
    }

    /// `GET .../mirror`: the page (View).
    public struct LoadMirror: APIEndpoint {
        public typealias Response = MirrorState
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.mirrorBase(server) }
    }

    /// `GET .../mirror/fluxer-servers`: the Fluxer servers the signed-in person owns and Sylo is in (owner only).
    public struct LoadMirrorFluxerServers: APIEndpoint {
        public typealias Response = MirrorFluxerServers
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.mirrorBase(server) + "/fluxer-servers" }
    }

    /// `GET .../mirror/preview`: the dry run (View, once both servers agreed).
    public struct LoadMirrorPreview: APIEndpoint {
        public typealias Response = MirrorPreview
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.mirrorBase(server) + "/preview" }
    }

    /// `GET .../mirror/report`: what became of the latest copy (View).
    public struct LoadMirrorReport: APIEndpoint {
        public typealias Response = MirrorReport
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.mirrorBase(server) + "/report" }
    }

    /// `POST .../mirror/request` `{ targetGuildId }`, on the Discord server.
    public struct RequestMirror: APIEndpoint {
        public typealias Response = MirrorRequestAnswer
        public let server: ServerID
        public let targetID: String

        public init(server: ServerID, targetID: String) {
            self.server = server
            self.targetID = targetID
        }

        public var path: String { Endpoints.mirrorBase(server) + "/request" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            MirrorTargetBody(targetGuildId: targetID.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// `POST .../mirror/accept` `{ code }`, on the Fluxer server.
    public struct AcceptMirror: APIEndpoint {
        public typealias Response = MirrorState
        public let server: ServerID
        public let code: String

        public init(server: ServerID, code: String) {
            self.server = server
            self.code = code
        }

        public var path: String { Endpoints.mirrorBase(server) + "/accept" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            MirrorCodeBody(code: code.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// `POST .../mirror/options` `{ <key>: <on> }`, on the Discord server.
    public struct SetMirrorOption: APIEndpoint {
        public typealias Response = MirrorState
        public let server: ServerID
        public let key: MirrorOptionKey
        public let on: Bool

        public init(server: ServerID, key: MirrorOptionKey, on: Bool) {
            self.server = server
            self.key = key
            self.on = on
        }

        public var path: String { Endpoints.mirrorBase(server) + "/options" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { MirrorOptionBody(key: key, on: on) }
    }

    /// `POST .../mirror/deletes` `{ allow }`, on the Fluxer server: allow or stop real deletion there.
    public struct AllowMirrorDeletes: APIEndpoint {
        public typealias Response = MirrorState
        public let server: ServerID
        public let allow: Bool

        public init(server: ServerID, allow: Bool) {
            self.server = server
            self.allow = allow
        }

        public var path: String { Endpoints.mirrorBase(server) + "/deletes" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { MirrorAllowBody(allow: allow) }
    }

    /// `POST .../mirror/start` `{ confirm: true }`: copy now.
    public struct StartMirror: APIEndpoint {
        public typealias Response = MirrorState
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.mirrorBase(server) + "/start" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { MirrorConfirmBody(confirm: true) }
    }

    /// `POST .../mirror/pause`, `/resume`, `/stop` or `/remove`. A resume after a burst of deletes sends
    /// `{ confirm: true }` once the person has seen them; everything else sends `{}`.
    public struct ChangeMirror: APIEndpoint {
        public typealias Response = MirrorState
        public let server: ServerID
        public let action: MirrorControl
        public let confirm: Bool

        public init(server: ServerID, action: MirrorControl, confirm: Bool = false) {
            self.server = server
            self.action = action
            self.confirm = confirm
        }

        public var path: String { Endpoints.mirrorBase(server) + "/\(action.rawValue)" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            if action == .resume, confirm { return MirrorConfirmBody(confirm: true) }
            return CommunityEmptyBody()
        }
    }
}

/// The Mirror screen's state on either server of a pair.
@MainActor
@Observable
public final class MirrorModel {
    public enum ListState: Equatable, Sendable {
        case idle, loading, loaded, failed
    }

    public let server: ServerID
    public private(set) var state: MirrorState?
    public private(set) var isLoading = false
    /// Why the page could not be loaded (the last page, if any, stays).
    public var errorMessage: String?
    /// Why the last action did not go through.
    public var actionError: String?
    /// What the last action did, in a sentence.
    public var notice: String?
    public private(set) var isWorking = false
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0

    /// The code the last request gave; shown while the request waits, and only on this device (the server keeps
    /// only its hash).
    public private(set) var code: String?

    /// The Fluxer servers to pick the target from.
    public private(set) var fluxerServers: MirrorFluxerServers?
    public private(set) var fluxerListState = ListState.idle
    /// The Fluxer server picked or typed (`fluxer:<id>` or a raw id).
    public var targetID = ""

    /// The code typed on the Fluxer server.
    public var acceptCode = ""

    /// The latest preview, and the options it was made for: it no longer holds once they change.
    private var previewResult: (options: MirrorOptions, preview: MirrorPreview)?
    public private(set) var isLoadingPreview = false
    public var previewError: String?

    /// The latest report, and the copy it was for.
    private var reportResult: (key: String, report: MirrorReport)?

    /// Deletions the person has to confirm before the mirror resumes.
    public var deletionsToConfirm: [MirrorDeletion]?

    /// The answer to the last request, for its code.
    private var lastRequest: MirrorRequestAnswer?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var hasLoaded: Bool { state != nil }
    public var isOwner: Bool { state?.isOwner ?? false }
    public var pair: MirrorPair? { state?.pair }

    /// The preview, while the options are the ones it was made for.
    public var preview: MirrorPreview? {
        guard let previewResult, let options = pair?.options, previewResult.options == options else { return nil }
        return previewResult.preview
    }

    private var reportKey: String? { pair.map { "\($0.copyRun):\($0.status.rawValue)" } }

    /// The report, while it is about the copy that is shown.
    public var report: MirrorReport? {
        guard let reportResult, reportResult.key == reportKey else { return nil }
        return reportResult.report
    }

    public var canAsk: Bool {
        isOwner && (state?.fluxerConnected ?? false) && !isWorking && MirrorText.isTargetID(targetID)
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            apply(try await session.send(Endpoints.LoadMirror(server: server)))
            errorMessage = nil
        } catch {
            if let message = ListFailure.message(for: error) { errorMessage = message }
        }
    }

    /// While a copy or a sync runs, reads the page again every `interval` until it is done or the task ends.
    public func followProgress(every interval: Duration = .seconds(3)) async {
        while !Task.isCancelled, state?.isBusy == true {
            try? await Task.sleep(for: interval)
            if Task.isCancelled { return }
            if let next = try? await session.send(Endpoints.LoadMirror(server: server)) { apply(next) }
        }
    }

    /// Reads the person's Fluxer servers for the picker: only for the owner of a Discord server with no mirror yet.
    public func loadFluxerServers() async {
        guard let state, state.canMirror, state.pair == nil, state.isOwner, state.fluxerConnected else {
            fluxerListState = .failed
            return
        }
        fluxerListState = .loading
        do {
            fluxerServers = try await session.send(Endpoints.LoadMirrorFluxerServers(server: server))
            fluxerListState = .loaded
        } catch {
            fluxerListState = .failed
        }
    }

    /// Asks for a mirror to ``targetID`` (Discord side). The code, if any, is kept in ``code``.
    @discardableResult
    public func requestMirror(again target: String? = nil) async -> Bool {
        let target = target ?? targetID
        guard isOwner, MirrorText.isTargetID(target) else { return false }
        lastRequest = nil
        let ok = await perform {
            let got = try await self.session.send(Endpoints.RequestMirror(server: self.server, targetID: target))
            self.lastRequest = got
            return got.state
        }
        if ok, let answer = lastRequest {
            code = answer.code
            targetID = ""
            notice = answer.agreed
                ? String(localized: "Both servers agreed. Look at the preview next.")
                : String(localized: "A code was made. Give it to the owner of the Fluxer server.")
        }
        return ok
    }

    /// Agrees to be the mirror with the code (Fluxer side).
    @discardableResult
    public func agree() async -> Bool {
        let typed = acceptCode
        guard isOwner, MirrorText.isCode(typed) else { return false }
        let ok = await perform { try await self.session.send(Endpoints.AcceptMirror(server: self.server, code: typed)) }
        if ok {
            acceptCode = ""
            notice = String(localized: "You agreed to the mirror.")
        }
        return ok
    }

    /// Turns one switch of what is mirrored on or off (Discord side).
    public func setOption(_ key: MirrorOptionKey, to on: Bool) async {
        guard isOwner else { return }
        await perform { try await self.session.send(Endpoints.SetMirrorOption(server: self.server, key: key, on: on)) }
    }

    /// Allows or stops real deletion (Fluxer side).
    public func allowDeletes(_ allow: Bool) async {
        guard isOwner else { return }
        let ok = await perform {
            try await self.session.send(Endpoints.AllowMirrorDeletes(server: self.server, allow: allow))
        }
        if ok {
            notice = allow ? String(localized: "Deleting is allowed.") : String(localized: "Deleting is switched off.")
        }
    }

    /// Makes the dry run (anyone who can see the page).
    public func loadPreview() async {
        guard let options = pair?.options, !isLoadingPreview else { return }
        isLoadingPreview = true
        defer { isLoadingPreview = false }
        previewError = nil
        do {
            previewResult = (options, try await session.send(Endpoints.LoadMirrorPreview(server: server)))
        } catch {
            previewError = ListFailure.message(for: error)
        }
    }

    /// Starts the copy (Discord side, after the preview).
    @discardableResult
    public func start() async -> Bool {
        guard isOwner else { return false }
        return await perform { try await self.session.send(Endpoints.StartMirror(server: self.server)) }
    }

    public func loadReport() async {
        do {
            let report = try await session.send(Endpoints.LoadMirrorReport(server: server))
            if let reportKey { reportResult = (reportKey, report) }
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
        }
    }

    public func pause() async {
        if await control(.pause) { notice = String(localized: "The mirror is paused.") }
    }

    public func stop() async {
        if await control(.stop) { notice = String(localized: "The mirror was stopped.") }
    }

    /// Removes the pair: cancels a waiting request, declines one on the Fluxer side, or removes a stopped mirror.
    public func remove() async {
        let wasPending = pair?.status == .pending
        if await control(.remove) {
            code = nil
            notice = wasPending ? String(localized: "The request was cancelled.") : String(localized: "The mirror was removed.")
            // Back at the start: the picker needs the person's Fluxer servers.
            if pair == nil { await loadFluxerServers() }
        }
    }

    /// Resumes a paused mirror. Deletions that wait are shown first (``deletionsToConfirm``); the person confirms
    /// them with ``confirmDeletions()``. When the server asks for a confirmation the page did not show yet, the page
    /// is read again and the deletions are shown.
    public func resume() async {
        guard isOwner, let pair, pair.canResume else { return }
        if let waiting = state?.progress?.pendingDeletes, !waiting.isEmpty {
            deletionsToConfirm = waiting
            return
        }
        if await control(.resume) {
            notice = String(localized: "The mirror goes on.")
            return
        }
        // A 409 can mean "confirm the deletions first": the fresh page lists them.
        await load()
        if let waiting = state?.progress?.pendingDeletes, !waiting.isEmpty {
            actionError = nil
            deletionsToConfirm = waiting
        }
    }

    public func confirmDeletions() async {
        deletionsToConfirm = nil
        if await control(.resume, confirm: true) { notice = String(localized: "The mirror goes on.") }
    }

    @discardableResult
    private func control(_ action: MirrorControl, confirm: Bool = false) async -> Bool {
        guard isOwner else { return false }
        return await perform {
            try await self.session.send(Endpoints.ChangeMirror(server: self.server, action: action, confirm: confirm))
        }
    }

    private func apply(_ next: MirrorState) {
        state = next
        // The code belongs to a request that waits; once it is answered or gone the code means nothing.
        if next.pair?.status != .pending { code = nil }
    }

    @discardableResult
    private func perform(_ call: @MainActor () async throws -> MirrorState) async -> Bool {
        guard !isWorking else {
            actionError = CommunityMessage.busy
            return false
        }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        notice = nil
        do {
            apply(try await call())
            successCount += 1
            return true
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
            return false
        }
    }
}
