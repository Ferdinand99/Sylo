import Foundation

// Economy (src/modules/lib/economyConfig.js, normaliseEconomyConfig; page route
// src/web/routes/v2Economy.js; web form web-v2/src/moduleForms/Economy.jsx): a server currency
// members earn by chatting, voice, /daily and /work, with a bank, payments and optional robbing.
//
// The app edits every setting of the Settings tab. The shop items, the staff changes to a member's
// money and the danger-zone reset stay in the web dashboard; the app adds a read only balance
// lookup (see Economy/EconomyMembers.swift). The server builds the whole config from what it is
// sent, so a save always carries every field.

/// The Economy settings page.
public struct EconomyPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "economy"

    public let settings: EconomySettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The most a member can hold in cash and bank together.
    public let maxBalance: Int
    /// Whether the minimum message length can be applied. Discord sends no message text without
    /// the Message Content intent, so there the setting does nothing.
    public let messageLengthChecked: Bool

    public init(settings: EconomySettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                maxBalance: Int = 1_000_000_000, messageLengthChecked: Bool = true) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.maxBalance = maxBalance
        self.messageLengthChecked = messageLengthChecked
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, maxBalance, messageLengthChecked
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: EconomySettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        maxBalance = try c.decode(forKey: .maxBalance, or: 1_000_000_000)
        messageLengthChecked = try c.decode(forKey: .messageLengthChecked, or: true)
    }
}

public struct EconomySettings: Codable, Sendable, Equatable {
    // Currency
    public var currencyName: String
    public var currencyEmoji: String
    public var startingBalance: Int

    // Chat
    public var messageEnabled: Bool
    public var messageMin: Int
    public var messageMax: Int
    public var messageCooldownSeconds: Int
    public var messageMinLength: Int
    public var ignoredChannels: [String]
    public var ignoredRoles: [String]

    // Voice
    public var voiceEnabled: Bool
    public var voiceAmount: Int

    // Daily and work
    public var dailyBase: Int
    public var dailyStreakBonus: Int
    public var workMin: Int
    public var workMax: Int
    public var workCooldownMinutes: Int

    // Bank and payments
    public var bankEnabled: Bool
    public var payEnabled: Bool
    public var payTaxPercent: Int

    // Robbing
    public var robEnabled: Bool
    public var robChancePercent: Int
    public var robMinPercent: Int
    public var robMaxPercent: Int
    public var robFinePercent: Int
    public var robFineMin: Int
    public var robCooldownHours: Int
    public var robVictimMinCash: Int
    public var robNewMemberHours: Int
    public var robProtectionMinutes: Int

    // Shop, leaderboard and log
    public var webShop: Bool
    /// Custom shop items post their "please fulfil this" notice here; "" = nowhere.
    public var shopChannelId: String
    public var publicLeaderboard: Bool
    /// Where staff changes to a member's money are posted; "" = nowhere.
    public var logChannelId: String

    /// The server's defaults for a setting it has not stored.
    public init(
        currencyName: String = "coins", currencyEmoji: String = "🪙", startingBalance: Int = 0,
        messageEnabled: Bool = true, messageMin: Int = 5, messageMax: Int = 15, messageCooldownSeconds: Int = 60,
        messageMinLength: Int = 3, ignoredChannels: [String] = [], ignoredRoles: [String] = [],
        voiceEnabled: Bool = false, voiceAmount: Int = 10,
        dailyBase: Int = 100, dailyStreakBonus: Int = 10, workMin: Int = 50, workMax: Int = 150,
        workCooldownMinutes: Int = 60,
        bankEnabled: Bool = true, payEnabled: Bool = true, payTaxPercent: Int = 0,
        robEnabled: Bool = false, robChancePercent: Int = 40, robMinPercent: Int = 10, robMaxPercent: Int = 30,
        robFinePercent: Int = 10, robFineMin: Int = 25, robCooldownHours: Int = 4, robVictimMinCash: Int = 100,
        robNewMemberHours: Int = 24, robProtectionMinutes: Int = 60,
        webShop: Bool = false, shopChannelId: String = "", publicLeaderboard: Bool = true, logChannelId: String = ""
    ) {
        self.currencyName = currencyName
        self.currencyEmoji = currencyEmoji
        self.startingBalance = startingBalance
        self.messageEnabled = messageEnabled
        self.messageMin = messageMin
        self.messageMax = messageMax
        self.messageCooldownSeconds = messageCooldownSeconds
        self.messageMinLength = messageMinLength
        self.ignoredChannels = ignoredChannels
        self.ignoredRoles = ignoredRoles
        self.voiceEnabled = voiceEnabled
        self.voiceAmount = voiceAmount
        self.dailyBase = dailyBase
        self.dailyStreakBonus = dailyStreakBonus
        self.workMin = workMin
        self.workMax = workMax
        self.workCooldownMinutes = workCooldownMinutes
        self.bankEnabled = bankEnabled
        self.payEnabled = payEnabled
        self.payTaxPercent = payTaxPercent
        self.robEnabled = robEnabled
        self.robChancePercent = robChancePercent
        self.robMinPercent = robMinPercent
        self.robMaxPercent = robMaxPercent
        self.robFinePercent = robFinePercent
        self.robFineMin = robFineMin
        self.robCooldownHours = robCooldownHours
        self.robVictimMinCash = robVictimMinCash
        self.robNewMemberHours = robNewMemberHours
        self.robProtectionMinutes = robProtectionMinutes
        self.webShop = webShop
        self.shopChannelId = shopChannelId
        self.publicLeaderboard = publicLeaderboard
        self.logChannelId = logChannelId
    }

    /// The limits the server clamps to (src/modules/lib/economyConfig.js, LIMITS).
    public static let maxCurrencyNameLength = 20
    public static let maxCurrencyEmojiLength = 64
    public static let startingBalanceRange = 0...1_000_000
    public static let messageAmountRange = 1...1000
    public static let messageCooldownRange = 0...3600
    public static let messageMinLengthRange = 0...100
    public static let maxIgnoredChannels = 100
    public static let maxIgnoredRoles = 100
    public static let voiceAmountRange = 1...1000
    public static let dailyBaseRange = 1...100_000
    public static let dailyStreakBonusRange = 0...10_000
    public static let workAmountRange = 1...100_000
    public static let workCooldownRange = 1...1440
    public static let payTaxRange = 0...50
    public static let robChanceRange = 1...99
    public static let robPercentRange = 1...100
    public static let robFinePercentRange = 0...100
    public static let robFineMinRange = 0...100_000
    public static let robCooldownRange = 1...168
    public static let robVictimMinCashRange = 0...1_000_000
    public static let robNewMemberRange = 0...720
    public static let robProtectionRange = 0...1440

    /// Why the draft cannot be saved: the server falls back to its default name and emoji when they
    /// are empty, which would change what the person sees after saving.
    public var currencyProblem: String? {
        if currencyName.trimmingCharacters(in: .whitespaces).isEmpty { return "Give the currency a name." }
        if currencyEmoji.trimmingCharacters(in: .whitespaces).isEmpty { return "Give the currency an emoji." }
        return nil
    }

    private enum CodingKeys: String, CodingKey {
        case currencyName, currencyEmoji, startingBalance
        case messageEnabled, messageMin, messageMax, messageCooldownSeconds, messageMinLength
        case ignoredChannels, ignoredRoles
        case voiceEnabled, voiceAmount
        case dailyBase, dailyStreakBonus, workMin, workMax, workCooldownMinutes
        case bankEnabled, payEnabled, payTaxPercent
        case robEnabled, robChancePercent, robMinPercent, robMaxPercent, robFinePercent, robFineMin
        case robCooldownHours, robVictimMinCash, robNewMemberHours, robProtectionMinutes
        case webShop, shopChannelId, publicLeaderboard, logChannelId
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = EconomySettings()
        currencyName = try c.decode(forKey: .currencyName, or: d.currencyName)
        currencyEmoji = try c.decode(forKey: .currencyEmoji, or: d.currencyEmoji)
        startingBalance = try c.decode(forKey: .startingBalance, or: d.startingBalance)
        messageEnabled = try c.decode(forKey: .messageEnabled, or: d.messageEnabled)
        messageMin = try c.decode(forKey: .messageMin, or: d.messageMin)
        messageMax = try c.decode(forKey: .messageMax, or: d.messageMax)
        messageCooldownSeconds = try c.decode(forKey: .messageCooldownSeconds, or: d.messageCooldownSeconds)
        messageMinLength = try c.decode(forKey: .messageMinLength, or: d.messageMinLength)
        ignoredChannels = try c.decode(forKey: .ignoredChannels, or: [])
        ignoredRoles = try c.decode(forKey: .ignoredRoles, or: [])
        voiceEnabled = try c.decode(forKey: .voiceEnabled, or: d.voiceEnabled)
        voiceAmount = try c.decode(forKey: .voiceAmount, or: d.voiceAmount)
        dailyBase = try c.decode(forKey: .dailyBase, or: d.dailyBase)
        dailyStreakBonus = try c.decode(forKey: .dailyStreakBonus, or: d.dailyStreakBonus)
        workMin = try c.decode(forKey: .workMin, or: d.workMin)
        workMax = try c.decode(forKey: .workMax, or: d.workMax)
        workCooldownMinutes = try c.decode(forKey: .workCooldownMinutes, or: d.workCooldownMinutes)
        bankEnabled = try c.decode(forKey: .bankEnabled, or: d.bankEnabled)
        payEnabled = try c.decode(forKey: .payEnabled, or: d.payEnabled)
        payTaxPercent = try c.decode(forKey: .payTaxPercent, or: d.payTaxPercent)
        robEnabled = try c.decode(forKey: .robEnabled, or: d.robEnabled)
        robChancePercent = try c.decode(forKey: .robChancePercent, or: d.robChancePercent)
        robMinPercent = try c.decode(forKey: .robMinPercent, or: d.robMinPercent)
        robMaxPercent = try c.decode(forKey: .robMaxPercent, or: d.robMaxPercent)
        robFinePercent = try c.decode(forKey: .robFinePercent, or: d.robFinePercent)
        robFineMin = try c.decode(forKey: .robFineMin, or: d.robFineMin)
        robCooldownHours = try c.decode(forKey: .robCooldownHours, or: d.robCooldownHours)
        robVictimMinCash = try c.decode(forKey: .robVictimMinCash, or: d.robVictimMinCash)
        robNewMemberHours = try c.decode(forKey: .robNewMemberHours, or: d.robNewMemberHours)
        robProtectionMinutes = try c.decode(forKey: .robProtectionMinutes, or: d.robProtectionMinutes)
        webShop = try c.decode(forKey: .webShop, or: d.webShop)
        shopChannelId = try c.decode(forKey: .shopChannelId, or: "")
        publicLeaderboard = try c.decode(forKey: .publicLeaderboard, or: d.publicLeaderboard)
        logChannelId = try c.decode(forKey: .logChannelId, or: "")
    }
}
