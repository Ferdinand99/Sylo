import Foundation

// Temporary voice (src/modules/tempVoice.js, normaliseTempVoiceConfig; web form
// web-v2/src/moduleForms/TempVoice.jsx): "Join to create" hubs. A member who joins a hub gets a
// personal voice channel, cleaned up after everyone leaves.

/// The Temporary voice settings page.
public struct TempVoicePage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "temp-voice"

    public let settings: TempVoiceSettings
    /// Voice and stage channels, for the hub.
    public let voiceChannels: [ChannelOption]
    /// Categories, for where the temporary channels go.
    public let categories: [ChannelOption]
    public let roles: [RoleOption]

    public init(settings: TempVoiceSettings, voiceChannels: [ChannelOption] = [], categories: [ChannelOption] = [],
                roles: [RoleOption] = []) {
        self.settings = settings
        self.voiceChannels = voiceChannels
        self.categories = categories
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case voiceChannels, categories, roles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: TempVoiceSettings())
        voiceChannels = try c.decode(forKey: .voiceChannels, or: [])
        categories = try c.decode(forKey: .categories, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

/// How a hub's role list is used: `allow` lets everyone join except the listed roles, `deny`
/// lets only the listed roles join (the server's names).
public enum TempVoiceRoleMode: String, Codable, Sendable, CaseIterable {
    case allow, deny

    public init(from decoder: any Decoder) throws {
        self = TempVoiceRoleMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .allow
    }
}

public struct TempVoiceSettings: Codable, Sendable, Equatable {
    public var hubs: [Hub]

    public init(hubs: [Hub] = []) {
        self.hubs = hubs
    }

    /// The server keeps at most this many hubs (and drops a hub without a channel).
    public static let maxHubs = 25
    public static let defaultNameTemplate = "#{index} - {username}'s Channel"
    public static let maxNameTemplateLength = 95
    /// 0 for no limit.
    public static let userLimitRange = 0...99
    /// In kbps, 0 for the server's default.
    public static let bitrateRange = 0...384
    /// How long an empty channel is kept, in minutes: -1 never deletes it, 0 deletes it at once.
    public static let keepAliveOptions = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

    /// A channel name from a template, the way the web form previews it.
    public static func previewName(_ template: String) -> String {
        let name = (template.isEmpty ? defaultNameTemplate : template)
            .replacingOccurrences(of: "{index}", with: "1")
            .replacingOccurrences(of: "{count}", with: "1")
            .replacingOccurrences(of: "{username}", with: "player")
            .replacingOccurrences(of: "{user}", with: "Player")
        return String(name.prefix(100))
    }

    public struct OwnerPermissions: Codable, Sendable, Equatable {
        /// Rename and set the user limit.
        public var manageChannels: Bool
        public var managePermissions: Bool
        public var prioritySpeaker: Bool
        public var moveMembers: Bool

        public init(manageChannels: Bool = true, managePermissions: Bool = false, prioritySpeaker: Bool = false,
                    moveMembers: Bool = false) {
            self.manageChannels = manageChannels
            self.managePermissions = managePermissions
            self.prioritySpeaker = prioritySpeaker
            self.moveMembers = moveMembers
        }

        private enum CodingKeys: String, CodingKey { case manageChannels, managePermissions, prioritySpeaker, moveMembers }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                manageChannels: try c.decode(forKey: .manageChannels, or: true),
                managePermissions: try c.decode(forKey: .managePermissions, or: false),
                prioritySpeaker: try c.decode(forKey: .prioritySpeaker, or: false),
                moveMembers: try c.decode(forKey: .moveMembers, or: false))
        }
    }

    public struct TextChannel: Codable, Sendable, Equatable {
        /// Create a paired temporary text channel.
        public var enabled: Bool
        /// Only allow the /voice-* commands in it.
        public var restrictCommands: Bool
        /// Pin a message listing the /voice-* commands.
        public var pinUsages: Bool
        /// Only connected members (and moderators) can read it.
        public var restrict: Bool

        public init(enabled: Bool = false, restrictCommands: Bool = false, pinUsages: Bool = false,
                    restrict: Bool = false) {
            self.enabled = enabled
            self.restrictCommands = restrictCommands
            self.pinUsages = pinUsages
            self.restrict = restrict
        }

        private enum CodingKeys: String, CodingKey { case enabled, restrictCommands, pinUsages, restrict }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                enabled: try c.decode(forKey: .enabled, or: false),
                restrictCommands: try c.decode(forKey: .restrictCommands, or: false),
                pinUsages: try c.decode(forKey: .pinUsages, or: false),
                restrict: try c.decode(forKey: .restrict, or: false))
        }
    }

    public struct Hub: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// The server's id for the hub, sent back as `id` so its channels stay linked ("" for a new
        /// hub; the server numbers it).
        public var hubId: String
        /// The "Join to create" voice channel.
        public var hubChannelId: String
        /// Where the temporary channels go ("" for the hub's own category).
        public var categoryId: String
        public var nameTemplate: String
        public var userLimit: Int
        public var bitrate: Int
        public var keepAliveMinutes: Int
        /// Don't hand the channel to someone else when the owner leaves.
        public var ownershipLock: Bool
        public var syncCategory: Bool
        public var syncChannel: Bool
        public var roleMode: TempVoiceRoleMode
        public var roleList: [String]
        /// Also use the role list to gate access to the temporary channels.
        public var useRolesForAccess: Bool
        /// Not affected by /voice-*.
        public var ignoredRoles: [String]
        /// Can run /voice-* on any temporary channel.
        public var moderatorRoles: [String]
        public var ownerPerms: OwnerPermissions
        public var textChannel: TextChannel

        public init(hubId: String = "", hubChannelId: String = "", categoryId: String = "",
                    nameTemplate: String = TempVoiceSettings.defaultNameTemplate, userLimit: Int = 0,
                    bitrate: Int = 0, keepAliveMinutes: Int = 0, ownershipLock: Bool = false,
                    syncCategory: Bool = false, syncChannel: Bool = false, roleMode: TempVoiceRoleMode = .allow,
                    roleList: [String] = [], useRolesForAccess: Bool = false, ignoredRoles: [String] = [],
                    moderatorRoles: [String] = [], ownerPerms: OwnerPermissions = OwnerPermissions(),
                    textChannel: TextChannel = TextChannel()) {
            id = UUID()
            self.hubId = hubId
            self.hubChannelId = hubChannelId
            self.categoryId = categoryId
            self.nameTemplate = nameTemplate
            self.userLimit = userLimit
            self.bitrate = bitrate
            self.keepAliveMinutes = keepAliveMinutes
            self.ownershipLock = ownershipLock
            self.syncCategory = syncCategory
            self.syncChannel = syncChannel
            self.roleMode = roleMode
            self.roleList = roleList
            self.useRolesForAccess = useRolesForAccess
            self.ignoredRoles = ignoredRoles
            self.moderatorRoles = moderatorRoles
            self.ownerPerms = ownerPerms
            self.textChannel = textChannel
        }

        private enum CodingKeys: String, CodingKey {
            case hubId = "id"
            case hubChannelId, categoryId, nameTemplate, userLimit, bitrate, keepAliveMinutes, ownershipLock,
                 syncCategory, syncChannel, roleMode, roleList, useRolesForAccess, ignoredRoles, moderatorRoles,
                 ownerPerms, textChannel
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                hubId: try c.decode(forKey: .hubId, or: ""),
                hubChannelId: try c.decode(forKey: .hubChannelId, or: ""),
                categoryId: try c.decode(forKey: .categoryId, or: ""),
                nameTemplate: try c.decode(forKey: .nameTemplate, or: TempVoiceSettings.defaultNameTemplate),
                userLimit: try c.decode(forKey: .userLimit, or: 0),
                bitrate: try c.decode(forKey: .bitrate, or: 0),
                keepAliveMinutes: try c.decode(forKey: .keepAliveMinutes, or: 0),
                ownershipLock: try c.decode(forKey: .ownershipLock, or: false),
                syncCategory: try c.decode(forKey: .syncCategory, or: false),
                syncChannel: try c.decode(forKey: .syncChannel, or: false),
                roleMode: try c.decode(forKey: .roleMode, or: .allow),
                roleList: try c.decode(forKey: .roleList, or: []),
                useRolesForAccess: try c.decode(forKey: .useRolesForAccess, or: false),
                ignoredRoles: try c.decode(forKey: .ignoredRoles, or: []),
                moderatorRoles: try c.decode(forKey: .moderatorRoles, or: []),
                ownerPerms: try c.decode(forKey: .ownerPerms, or: OwnerPermissions()),
                textChannel: try c.decode(forKey: .textChannel, or: TextChannel()))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(hubId, forKey: .hubId)
            try c.encode(hubChannelId, forKey: .hubChannelId)
            try c.encode(categoryId, forKey: .categoryId)
            try c.encode(nameTemplate, forKey: .nameTemplate)
            try c.encode(userLimit, forKey: .userLimit)
            try c.encode(bitrate, forKey: .bitrate)
            try c.encode(keepAliveMinutes, forKey: .keepAliveMinutes)
            try c.encode(ownershipLock, forKey: .ownershipLock)
            try c.encode(syncCategory, forKey: .syncCategory)
            try c.encode(syncChannel, forKey: .syncChannel)
            try c.encode(roleMode, forKey: .roleMode)
            try c.encode(roleList, forKey: .roleList)
            try c.encode(useRolesForAccess, forKey: .useRolesForAccess)
            try c.encode(ignoredRoles, forKey: .ignoredRoles)
            try c.encode(moderatorRoles, forKey: .moderatorRoles)
            try c.encode(ownerPerms, forKey: .ownerPerms)
            try c.encode(textChannel, forKey: .textChannel)
        }
    }

    private enum CodingKeys: String, CodingKey { case hubs }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hubs = try c.decode(forKey: .hubs, or: [])
    }
}
