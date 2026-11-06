import SwiftUI
import SyloKit

/// Which modules have a settings screen in the app, and the screen for each, plus the server tools
/// that are not modules (appeals, moderation, commands, audit log, member data, leaderboard). Every
/// module and tool has a screen: the app never sends anyone to the web dashboard.
enum ModuleScreens {
    static func hasScreen(_ moduleID: String) -> Bool { ids.contains(moduleID) }

    private static let ids: Set<String> = [
        "afk", "appeals", "apple-connect", "auto-react", "automod", "autoresponder", "birthdays",
        "counting", "free-games", "giveaways", "honeypot", "invite-tracker", "kick-alerts", "leveling",
        "logging", "moderation", "polls", "rss", "server-stats", "starboard", "sticky", "temp-voice",
        "tickets", "twitch-alerts", "verification", "welcome", "welcome-channel", "youtube-alerts",
        "events", "suggestions", "temp-roles", "auto-threads", "quote-board",
        "roles", "custom-commands", "reminders", "insights", "game-stats", "channel-cleanup", "github",
        // The Embed messages card, which is not a module but opens in the app too.
        "messages",
        // Server tools of the dashboard that are not modules.
        "commands", "appeals-inbox", "moderation-hub", "audit-log", "member-data", "leaderboard",
    ]

    @ViewBuilder
    static func screen(for moduleID: String, server: ServerID, session: AppSession) -> some View {
        switch moduleID {
        // Moderation and safety
        case "moderation": ModerationSettingsView(server: server, session: session)
        case "automod": AutomodSettingsView(server: server, session: session)
        case "honeypot": HoneypotSettingsView(server: server, session: session)
        case "logging": LoggingSettingsView(server: server, session: session)
        case "verification": VerificationSettingsView(server: server, session: session)
        case "tickets": TicketsSettingsView(server: server, session: session)
        case "appeals": AppealsSettingsView(server: server, session: session)
        // Members and engagement
        case "welcome": WelcomeSettingsView(server: server, session: session)
        case "welcome-channel": WelcomeChannelSettingsView(server: server, session: session)
        case "roles": RolesSettingsView(server: server, session: session)
        case "custom-commands": CustomCommandsSettingsView(server: server, session: session)
        case "birthdays": BirthdaysSettingsView(server: server, session: session)
        case "leveling": LevelingSettingsView(server: server, session: session)
        case "invite-tracker": InviteTrackerSettingsView(server: server, session: session)
        case "afk": AfkSettingsView(server: server, session: session)
        case "counting": CountingSettingsView(server: server, session: session)
        case "starboard": StarboardSettingsView(server: server, session: session)
        case "giveaways": GiveawaysSettingsView(server: server, session: session)
        case "polls": PollsSettingsView(server: server, session: session)
        case "events": EventsSettingsView(server: server, session: session)
        case "suggestions": SuggestionsSettingsView(server: server, session: session)
        case "temp-roles": TempRolesSettingsView(server: server, session: session)
        case "quote-board": QuoteBoardSettingsView(server: server, session: session)
        // Messages and channels
        case "messages": EmbedMessagesView(server: server, session: session)
        case "reminders": RemindersSettingsView(server: server, session: session)
        case "channel-cleanup": ChannelCleanupSettingsView(server: server, session: session)
        case "autoresponder": AutoresponderSettingsView(server: server, session: session)
        case "auto-react": AutoReactSettingsView(server: server, session: session)
        case "sticky": StickySettingsView(server: server, session: session)
        case "temp-voice": TempVoiceSettingsView(server: server, session: session)
        case "server-stats": ServerStatsSettingsView(server: server, session: session)
        case "auto-threads": AutoThreadsSettingsView(server: server, session: session)
        // Server tools
        case "commands": CommandsView(server: server, session: session)
        case "appeals-inbox": AppealsView(server: server, session: session)
        case "moderation-hub": ModerationView(server: server, session: session)
        case "audit-log": AuditLogView(server: server, session: session)
        case "member-data": MemberDataView(server: server, session: session)
        case "leaderboard": LeaderboardView(server: server, session: session)
        // Insights
        case "insights": InsightsView(server: server, session: session)
        case "game-stats": GameStatsSettingsView(server: server, session: session)
        // Alerts
        case "github": GithubSettingsView(server: server, session: session)
        case "twitch-alerts": TwitchAlertsSettingsView(server: server, session: session)
        case "kick-alerts": KickAlertsSettingsView(server: server, session: session)
        case "youtube-alerts": YoutubeAlertsSettingsView(server: server, session: session)
        case "rss": RssSettingsView(server: server, session: session)
        case "free-games": FreeGamesSettingsView(server: server, session: session)
        case "apple-connect": AppleConnectSettingsView(server: server, session: session)
        default:
            // A module this app build does not know yet (a newer Sylo): update the app.
            ContentUnavailableView(
                "Update the App", systemImage: "arrow.down.app",
                description: Text("This module is newer than this version of the app. Update the app to change its settings."))
        }
    }
}

/// A module settings screen to push from the overview.
///
/// `nonisolated` so SwiftUI can hash and compare it as a navigation value on any thread; a
/// main-actor `Hashable` conformance (this app's default) would trap off the main thread.
nonisolated struct ModuleRoute: Hashable {
    let moduleID: String
}
