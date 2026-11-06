#if DEBUG
import Foundation
import SyloKit

/// Sample answers for the staff screens of the demo launch (appeals, moderation, commands, audit log).
nonisolated extension PreviewData {
    private static func ago(_ seconds: TimeInterval) -> Date { Date().addingTimeInterval(-seconds) }

    static let appeals = AppealsInboxPage(
        appeals: [
            Appeal(
                id: 12, user: "ada#0001", userId: "111111111111111111", banReason: "Spamming invite links in #general",
                answers: [
                    AppealAnswer(question: "Why were you banned?", answer: "I posted invite links in a few channels. I did not know it was against the rules."),
                    AppealAnswer(question: "Why should we unban you?", answer: "I have read the rules now and it will not happen again. I have been a member for two years."),
                ],
                status: .open, submittedAt: ago(7_200)),
            Appeal(
                id: 11, user: "mallory", userId: "222222222222222222", banReason: "Harassment",
                answers: [AppealAnswer(question: "Why were you banned?", answer: "A misunderstanding.")],
                status: .open, submittedAt: ago(90_000)),
            Appeal(
                id: 9, user: "grace", userId: "333333333333333333", banReason: "Raid", answers: [],
                status: .denied, decidedBy: "Alex (dashboard)", decisionReason: "The ban stands for now. You can appeal again in a month.",
                submittedAt: ago(400_000), decidedAt: ago(300_000)),
            Appeal(
                id: 8, user: "eve", userId: "444444444444444444", banReason: "Self-promotion", answers: [],
                status: .accepted, decidedBy: "you", decisionReason: "Welcome back.", submittedAt: ago(900_000),
                decidedAt: ago(800_000)),
        ],
        moduleEnabled: true, configured: true)

    static let moderation = ModerationHubPage(
        cases: [
            ModerationCase(
                caseNumber: 41, action: "warn", user: "ada#0001", moderator: "Dashboard", reason: "Spam in #general",
                at: ago(3_600)),
            ModerationCase(
                caseNumber: 40, action: "timeout", user: "mallory", moderator: "AutoMod", reason: "Bad word", detail: "10 minutes",
                at: ago(18_000)),
            ModerationCase(
                caseNumber: 39, action: "ban", isActive: false, user: "eve", moderator: "Alex", reason: "Raid", at: ago(200_000)),
        ],
        caseTotal: 41,
        bans: [BannedMember(id: "444444444444444444", tag: "eve#0001", reason: "Raid")],
        channelLocks: [ChannelLock(channelId: "c1", name: "general", lockedBy: "Alex (dashboard)", isLockdown: true, at: ago(600))],
        tempBans: [TempBan(userId: "555555555555555555", tag: "trent", reason: "Cooling off", remaining: "2h 5m")])

    static let commands = CommandsPage(
        commands: [
            CommandLimit(name: "ban", description: "Ban a member from the server", allowedRoles: ["r1"]),
            CommandLimit(name: "giveaway", description: "Start, end or reroll a giveaway", allowedChannels: ["c1", "c2"]),
            CommandLimit(name: "stats", description: "Look up game stats for a player", isEnabled: false),
            CommandLimit(name: "warn", description: "Warn a member"),
            CommandLimit(name: "poll", description: "Start a poll"),
        ],
        channels: [ChannelOption(id: "c1", name: "general"), ChannelOption(id: "c2", name: "giveaways")],
        roles: [RoleOption(id: "r1", name: "Moderators")])

    static let audit = AuditPage(
        entries: [
            AuditEntry(id: 5, actor: "Alex (dashboard)", action: "appeal:accepted", detail: "#8 eve", at: ago(800_000)),
            AuditEntry(id: 4, actor: "Alex (dashboard)", action: "module:starboard", detail: "settings saved", at: ago(5_000)),
            AuditEntry(id: 3, actor: "Alex (dashboard)", action: "moderation:lockdown", detail: "locked 12 channel(s)", at: ago(600)),
            AuditEntry(id: 2, actor: "Sam (dashboard)", action: "settings:server", detail: "", at: ago(86_400)),
        ])
}
#endif
