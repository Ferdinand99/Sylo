import Foundation

// Auto-moderation (src/modules/automod.js, normaliseAutomodConfig; web form
// web-v2/src/moduleForms/Automod.jsx): checks that scan new and edited messages and act on the
// first match (delete, warn or timeout), optionally mirrored onto Discord's native AutoMod.
//
// The web form sends its whole config back, with the allowed domains and the word list as typed
// text (comma or newline separated); the server splits them. It ignores `deleteMessage` (always
// true) and `exemptRoles` (the immunity roles, saved with their own endpoint), which are sent
// back unchanged.

/// The Auto-moderation settings page.
public struct AutomodPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "automod"

    public let settings: AutomodSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// Discord's own keyword lists that native AutoMod can turn on.
    public let presetKeys: [String]
    /// Where actions are logged ("" when the server has no mod-log channel).
    public let modlogChannelId: String
    /// Whether the server's platform has native AutoMod rules (Discord); from the server, so
    /// the app never guesses. False on a Sylo from before the flag.
    public let supportsNativeAutomod: Bool

    public static let defaultPresetKeys = ["profanity", "sexual", "slurs"]

    public init(settings: AutomodSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                presetKeys: [String] = AutomodPage.defaultPresetKeys, modlogChannelId: String = "",
                supportsNativeAutomod: Bool = true) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.presetKeys = presetKeys
        self.modlogChannelId = modlogChannelId
        self.supportsNativeAutomod = supportsNativeAutomod
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, presetKeys, modlogChannelId
        case supportsNativeAutomod = "nativeAutomod"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: AutomodSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        presetKeys = try c.decode(forKey: .presetKeys, or: AutomodPage.defaultPresetKeys)
        modlogChannelId = try c.decode(forKey: .modlogChannelId, or: "")
        supportsNativeAutomod = try c.decode(forKey: .supportsNativeAutomod, or: false)
    }
}

/// What a check does to a matching message.
public enum AutomodAction: String, Codable, Sendable, CaseIterable {
    /// Delete the message.
    case delete
    /// Delete it and warn the author.
    case warn
    /// Delete it and time the author out.
    case timeout

    public init(from decoder: any Decoder) throws {
        self = AutomodAction(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .delete
    }
}

/// A check's one choice in the form: off, or on with an action.
public enum AutomodMode: String, Sendable, CaseIterable {
    case off, delete, warn, timeout
}

/// What every check has: whether it is on, and its action.
public protocol AutomodCheck {
    var enabled: Bool { get set }
    var action: AutomodAction { get set }
}

extension AutomodCheck {
    /// Off, or the action. Turning a check off resets its action to delete, like the web form.
    public var mode: AutomodMode {
        get {
            guard enabled else { return .off }
            switch action {
            case .delete: return .delete
            case .warn: return .warn
            case .timeout: return .timeout
            }
        }
        set {
            switch newValue {
            case .off: enabled = false; action = .delete
            case .delete: enabled = true; action = .delete
            case .warn: enabled = true; action = .warn
            case .timeout: enabled = true; action = .timeout
            }
        }
    }
}

public struct AutomodSettings: Codable, Sendable, Equatable {
    /// Always true on the server; sent back unchanged.
    public let deleteMessage: Bool
    /// Used by the timeout action.
    public var timeoutMinutes: Int
    /// Channels automod never acts in.
    public var exemptChannels: [String]
    /// The immunity roles (read only here; the server keeps its own copy on save).
    public let exemptRoles: [String]
    public var native: Native
    public var rules: Rules

    public init(deleteMessage: Bool = true, timeoutMinutes: Int = 10, exemptChannels: [String] = [],
                exemptRoles: [String] = [], native: Native = Native(), rules: Rules = Rules()) {
        self.deleteMessage = deleteMessage
        self.timeoutMinutes = timeoutMinutes
        self.exemptChannels = exemptChannels
        self.exemptRoles = exemptRoles
        self.native = native
        self.rules = rules
    }

    /// Discord's timeout cap, in minutes (28 days).
    public static let timeoutRange = 1...40320

    private enum CodingKeys: String, CodingKey {
        case deleteMessage, timeoutMinutes, exemptChannels, exemptRoles, native, rules
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            deleteMessage: try c.decode(forKey: .deleteMessage, or: true),
            timeoutMinutes: try c.decode(forKey: .timeoutMinutes, or: 10),
            exemptChannels: try c.decode(forKey: .exemptChannels, or: []),
            exemptRoles: try c.decode(forKey: .exemptRoles, or: []),
            native: try c.decode(forKey: .native, or: Native()),
            rules: try c.decode(forKey: .rules, or: Rules()))
    }

    /// Mirrors the mappable checks onto Discord's own AutoMod (Discord servers only).
    public struct Native: Codable, Sendable, Equatable {
        /// The master switch.
        public var enabled: Bool
        public var words: Bool
        public var mentions: Bool
        public var spam: Bool
        /// Discord keyword presets that are on (see ``AutomodPage/presetKeys``).
        public var presets: [String]

        public init(enabled: Bool = false, words: Bool = false, mentions: Bool = false, spam: Bool = false,
                    presets: [String] = []) {
            self.enabled = enabled
            self.words = words
            self.mentions = mentions
            self.spam = spam
            self.presets = presets
        }

        /// Whether a keyword preset is on, for a toggle (`$native[preset: "slurs"]`).
        public subscript(preset key: String) -> Bool {
            get { presets.contains(key) }
            set {
                if newValue {
                    if !presets.contains(key) { presets.append(key) }
                } else {
                    presets.removeAll { $0 == key }
                }
            }
        }

        private enum CodingKeys: String, CodingKey { case enabled, words, mentions, spam, presets }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                enabled: try c.decode(forKey: .enabled, or: false),
                words: try c.decode(forKey: .words, or: false),
                mentions: try c.decode(forKey: .mentions, or: false),
                spam: try c.decode(forKey: .spam, or: false),
                presets: try c.decode(forKey: .presets, or: []))
        }
    }

    /// A check with no settings of its own (invites, zalgo, repeated text).
    public struct BasicRule: AutomodCheck, Encodable, Sendable, Equatable {
        public var enabled: Bool
        public var action: AutomodAction

        public init(enabled: Bool = false, action: AutomodAction = .delete) {
            self.enabled = enabled
            self.action = action
        }
    }

    /// External links, with the domains that are still allowed.
    public struct LinksRule: AutomodCheck, Encodable, Sendable, Equatable {
        public var enabled: Bool
        public var action: AutomodAction
        /// Comma or newline separated; empty blocks every link.
        public var allowedText: String

        public init(enabled: Bool = false, action: AutomodAction = .delete, allowedText: String = "") {
            self.enabled = enabled
            self.action = action
            self.allowedText = allowedText
        }

        private enum CodingKeys: String, CodingKey {
            case enabled, action
            case allowedText = "allowed"
        }
    }

    /// One member sending too many messages in a short window.
    public struct SpamRule: AutomodCheck, Encodable, Sendable, Equatable {
        public var enabled: Bool
        public var action: AutomodAction
        /// Messages allowed per window.
        public var max: Int
        /// The window, in seconds.
        public var seconds: Int

        public init(enabled: Bool = false, action: AutomodAction = .delete, max: Int = 5, seconds: Int = 5) {
            self.enabled = enabled
            self.action = action
            self.max = max
            self.seconds = seconds
        }

        public static let maxRange = 2...30
        public static let secondsRange = 1...60
    }

    /// More than `max` of something in one message (mentions, emoji, spoiler tags).
    public struct CountRule: AutomodCheck, Encodable, Sendable, Equatable {
        public var enabled: Bool
        public var action: AutomodAction
        public var max: Int

        public init(enabled: Bool = false, action: AutomodAction = .delete, max: Int) {
            self.enabled = enabled
            self.action = action
            self.max = max
        }
    }

    /// Messages that are mostly uppercase.
    public struct CapsRule: AutomodCheck, Encodable, Sendable, Equatable {
        public var enabled: Bool
        public var action: AutomodAction
        /// Shorter messages are never checked.
        public var minLength: Int
        public var percent: Int

        public init(enabled: Bool = false, action: AutomodAction = .delete, minLength: Int = 10, percent: Int = 70) {
            self.enabled = enabled
            self.action = action
            self.minLength = minLength
            self.percent = percent
        }

        public static let minLengthRange = 4...200
        public static let percentRange = 50...100
    }

    /// Listed words or phrases.
    public struct WordsRule: AutomodCheck, Encodable, Sendable, Equatable {
        public var enabled: Bool
        public var action: AutomodAction
        /// Comma or newline separated.
        public var listText: String

        public init(enabled: Bool = false, action: AutomodAction = .delete, listText: String = "") {
            self.enabled = enabled
            self.action = action
            self.listText = listText
        }

        private enum CodingKeys: String, CodingKey {
            case enabled, action
            case listText = "list"
        }
    }

    public struct Rules: Codable, Sendable, Equatable {
        public var words: WordsRule
        public var `repeat`: BasicRule
        public var invites: BasicRule
        public var links: LinksRule
        public var caps: CapsRule
        public var emojis: CountRule
        public var spoilers: CountRule
        public var mentions: CountRule
        public var zalgo: BasicRule
        public var spam: SpamRule

        public init(words: WordsRule = WordsRule(), repeat: BasicRule = BasicRule(), invites: BasicRule = BasicRule(),
                    links: LinksRule = LinksRule(), caps: CapsRule = CapsRule(),
                    emojis: CountRule = CountRule(max: 8), spoilers: CountRule = CountRule(max: 4),
                    mentions: CountRule = CountRule(max: 5), zalgo: BasicRule = BasicRule(),
                    spam: SpamRule = SpamRule()) {
            self.words = words
            self.repeat = `repeat`
            self.invites = invites
            self.links = links
            self.caps = caps
            self.emojis = emojis
            self.spoilers = spoilers
            self.mentions = mentions
            self.zalgo = zalgo
            self.spam = spam
        }

        /// Limits for the mention, emoji and spoiler counts.
        public static let mentionsRange = 1...50
        public static let emojisRange = 1...50
        public static let spoilersRange = 1...30

        private enum CodingKeys: String, CodingKey {
            case words, `repeat`, invites, links, caps, emojis, spoilers, mentions, zalgo, spam
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            func raw(_ key: CodingKeys) throws -> AutomodStoredRule {
                try c.decode(forKey: key, or: AutomodStoredRule())
            }
            let words = try raw(.words), rep = try raw(.repeat), invites = try raw(.invites)
            let links = try raw(.links), caps = try raw(.caps), emojis = try raw(.emojis)
            let spoilers = try raw(.spoilers), mentions = try raw(.mentions), zalgo = try raw(.zalgo)
            let spam = try raw(.spam)
            self.init(
                words: WordsRule(enabled: words.on, action: words.act,
                                 listText: (words.list ?? []).joined(separator: ", ")),
                repeat: BasicRule(enabled: rep.on, action: rep.act),
                invites: BasicRule(enabled: invites.on, action: invites.act),
                links: LinksRule(enabled: links.on, action: links.act,
                                 allowedText: (links.allowed ?? []).joined(separator: ", ")),
                caps: CapsRule(enabled: caps.on, action: caps.act, minLength: caps.minLength ?? 10,
                               percent: caps.percent ?? 70),
                emojis: CountRule(enabled: emojis.on, action: emojis.act, max: emojis.max ?? 8),
                spoilers: CountRule(enabled: spoilers.on, action: spoilers.act, max: spoilers.max ?? 4),
                mentions: CountRule(enabled: mentions.on, action: mentions.act, max: mentions.max ?? 5),
                zalgo: BasicRule(enabled: zalgo.on, action: zalgo.act),
                spam: SpamRule(enabled: spam.on, action: spam.act, max: spam.max ?? 5, seconds: spam.seconds ?? 5))
        }
    }
}

/// Any check as stored: every field optional, so each check fills in its own defaults.
private struct AutomodStoredRule: Decodable {
    var enabled: Bool?
    var action: AutomodAction?
    var max: Int?
    var seconds: Int?
    var minLength: Int?
    var percent: Int?
    var allowed: [String]?
    var list: [String]?

    var on: Bool { enabled ?? false }
    var act: AutomodAction { action ?? .delete }
}
