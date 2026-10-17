import Foundation

// Verification (src/modules/verification.js, normaliseVerificationConfig; web form
// web-v2/src/moduleForms/Verification.jsx): a Verify button message that gives new members a
// role, optionally behind a Turnstile captcha, and kicks members who never verify.

/// The Verification settings page.
public struct VerificationPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "verification"

    public let settings: VerificationSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// Whether the server has Turnstile keys; without them captcha mode behaves like button mode.
    public let turnstileEnabled: Bool

    public init(settings: VerificationSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                turnstileEnabled: Bool = false) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.turnstileEnabled = turnstileEnabled
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, turnstileEnabled
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: VerificationSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        turnstileEnabled = try c.decode(forKey: .turnstileEnabled, or: false)
    }
}

/// How members verify.
public enum VerificationMode: String, Codable, Sendable, CaseIterable {
    /// Click the Verify button.
    case button
    /// The button sends a private link to a Cloudflare Turnstile check first.
    case captcha

    public init(from decoder: any Decoder) throws {
        self = VerificationMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .button
    }
}

public struct VerificationSettings: Codable, Sendable, Equatable {
    public var mode: VerificationMode
    /// Granted on success.
    public var verifiedRoleId: String
    /// Where the verify message is posted.
    public var channelId: String
    public var title: String
    public var message: String
    /// The reply after verifying.
    public var successMessage: String
    public var logChannelId: String
    /// Kick members who haven't verified after this many minutes; 0 never kicks.
    public var kickAfterMinutes: Int

    public static let defaultTitle = "Verification"
    public static let defaultMessage = "Click the button below to verify and unlock the rest of the server."
    public static let defaultSuccessMessage = "You are verified — welcome!"

    public static let maxTitleLength = 200
    public static let maxMessageLength = 1500
    public static let maxSuccessMessageLength = 1000
    /// Up to 7 days.
    public static let kickAfterRange = 0...10080

    public init(mode: VerificationMode = .button, verifiedRoleId: String = "", channelId: String = "",
                title: String = VerificationSettings.defaultTitle, message: String = VerificationSettings.defaultMessage,
                successMessage: String = VerificationSettings.defaultSuccessMessage, logChannelId: String = "",
                kickAfterMinutes: Int = 0) {
        self.mode = mode
        self.verifiedRoleId = verifiedRoleId
        self.channelId = channelId
        self.title = title
        self.message = message
        self.successMessage = successMessage
        self.logChannelId = logChannelId
        self.kickAfterMinutes = kickAfterMinutes
    }

    // `messageId` (the posted verify message) is bot-managed: never decoded into the draft and
    // never sent; the server keeps its own.
    private enum CodingKeys: String, CodingKey {
        case mode, verifiedRoleId, channelId, title, message, successMessage, logChannelId, kickAfterMinutes
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            mode: try c.decode(forKey: .mode, or: .button),
            verifiedRoleId: try c.decode(forKey: .verifiedRoleId, or: ""),
            channelId: try c.decode(forKey: .channelId, or: ""),
            title: try c.decode(forKey: .title, or: Self.defaultTitle),
            message: try c.decode(forKey: .message, or: Self.defaultMessage),
            successMessage: try c.decode(forKey: .successMessage, or: Self.defaultSuccessMessage),
            logChannelId: try c.decode(forKey: .logChannelId, or: ""),
            kickAfterMinutes: try c.decode(forKey: .kickAfterMinutes, or: 0))
    }
}
