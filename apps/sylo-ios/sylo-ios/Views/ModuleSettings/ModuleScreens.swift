import SwiftUI
import SyloKit

/// Which modules have a settings screen in the app, and the screen for each. Modules without one
/// keep their switch on the overview and open in the web dashboard.
enum ModuleScreens {
    static func hasScreen(_ moduleID: String) -> Bool { ids.contains(moduleID) }

    private static let ids: Set<String> = [
        "afk", "appeals", "apple-connect", "auto-react", "automod", "autoresponder", "birthdays",
        "counting", "free-games", "giveaways", "honeypot", "invite-tracker", "kick-alerts", "leveling",
        "logging", "moderation", "polls", "rss", "server-stats", "starboard", "sticky", "temp-voice",
        "tickets", "twitch-alerts", "verification", "welcome", "welcome-channel", "youtube-alerts",
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
        case "birthdays": BirthdaysSettingsView(server: server, session: session)
        case "leveling": LevelingSettingsView(server: server, session: session)
        case "invite-tracker": InviteTrackerSettingsView(server: server, session: session)
        case "afk": AfkSettingsView(server: server, session: session)
        case "counting": CountingSettingsView(server: server, session: session)
        case "starboard": StarboardSettingsView(server: server, session: session)
        case "giveaways": GiveawaysSettingsView(server: server, session: session)
        case "polls": PollsSettingsView(server: server, session: session)
        // Messages and channels
        case "autoresponder": AutoresponderSettingsView(server: server, session: session)
        case "auto-react": AutoReactSettingsView(server: server, session: session)
        case "sticky": StickySettingsView(server: server, session: session)
        case "temp-voice": TempVoiceSettingsView(server: server, session: session)
        case "server-stats": ServerStatsSettingsView(server: server, session: session)
        // Alerts
        case "twitch-alerts": TwitchAlertsSettingsView(server: server, session: session)
        case "kick-alerts": KickAlertsSettingsView(server: server, session: session)
        case "youtube-alerts": YoutubeAlertsSettingsView(server: server, session: session)
        case "rss": RssSettingsView(server: server, session: session)
        case "free-games": FreeGamesSettingsView(server: server, session: session)
        case "apple-connect": AppleConnectSettingsView(server: server, session: session)
        default:
            ContentUnavailableView(
                "Not in the App Yet", systemImage: "square.grid.2x2",
                description: Text("Change this module's settings in the web dashboard for now."))
        }
    }
}

/// A module settings screen to push from the overview.
struct ModuleRoute: Hashable {
    let moduleID: String
}
