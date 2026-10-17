import Foundation

// Moderation (src/modules/moderation.js, normaliseThresholds; GET/POST in
// src/web/routes/v2Api.js; web form web-v2/src/moduleForms/Moderation.jsx): DMs on punishment,
// automatic actions at warning counts, and how long closed cases are kept. Warnings and bans
// themselves are managed elsewhere.

/// The Moderation settings page.
public struct ModerationPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "moderation"

    public let settings: ModerationSettings

    public init(settings: ModerationSettings) {
        self.settings = settings
    }

    private enum CodingKeys: String, CodingKey { case settings = "config" }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: ModerationSettings())
    }
}

/// What a warning threshold does.
public enum ModerationThresholdAction: String, Codable, Sendable, CaseIterable {
    case timeout, kick, ban

    public init(from decoder: any Decoder) throws {
        self = ModerationThresholdAction(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .timeout
    }
}

public struct ModerationSettings: Codable, Sendable, Equatable {
    /// DM the member when they are punished.
    public var dmOnPunish: Bool
    /// Automatic actions at warning counts; the strictest matching rule wins. The server sorts
    /// them by count.
    public var warnThresholds: [WarnThreshold]
    /// Delete deleted or resolved cases after this many days; 0 keeps them forever.
    public var infractionRetentionDays: Int

    public init(dmOnPunish: Bool = true, warnThresholds: [WarnThreshold] = [], infractionRetentionDays: Int = 0) {
        self.dmOnPunish = dmOnPunish
        self.warnThresholds = warnThresholds
        self.infractionRetentionDays = infractionRetentionDays
    }

    public static let retentionRange = 0...3650

    public struct WarnThreshold: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// The warning number that triggers it.
        public var count: Int
        public var action: ModerationThresholdAction
        /// Only used for timeouts.
        public var durationMinutes: Int

        public init(count: Int = 3, action: ModerationThresholdAction = .timeout, durationMinutes: Int = 60) {
            id = UUID()
            self.count = count
            self.action = action
            self.durationMinutes = durationMinutes
        }

        public static let countRange = 1...100
        /// Discord's timeout cap is 28 days.
        public static let durationRange = 1...40320

        private enum CodingKeys: String, CodingKey { case count, action, durationMinutes }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                count: try c.decode(forKey: .count, or: 3),
                action: try c.decode(forKey: .action, or: .timeout),
                durationMinutes: try c.decode(forKey: .durationMinutes, or: 60))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(count, forKey: .count)
            try c.encode(action, forKey: .action)
            try c.encode(durationMinutes, forKey: .durationMinutes)
        }
    }

    private enum CodingKeys: String, CodingKey { case dmOnPunish, warnThresholds, infractionRetentionDays }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dmOnPunish = try c.decode(forKey: .dmOnPunish, or: true)
        warnThresholds = try c.decode(forKey: .warnThresholds, or: [])
        infractionRetentionDays = try c.decode(forKey: .infractionRetentionDays, or: 0)
    }
}
