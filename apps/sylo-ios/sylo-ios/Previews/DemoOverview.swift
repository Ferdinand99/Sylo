#if DEBUG
import SyloKit

/// The demo launch's server list and overview: a made-up "Pixel Harbor" with the whole module
/// catalogue (40 modules, 28 on) and nothing that needs attention, so the screenshots show the app
/// the way a healthy server looks. Debug builds only; the shared preview data stays as it is.
nonisolated extension PreviewData {
    static let demoServers = [
        ServerSummary(id: "1", name: "Pixel Harbor", platform: .discord, openTickets: 2, unreadTickets: 1,
                      memberCount: 2_431, messagesToday: 1_284),
        ServerSummary(id: "2", name: "Gaming Night", platform: .discord, memberCount: 1_204, messagesToday: 1_840),
        ServerSummary(id: "4", name: "Midnight Library", platform: .discord, memberCount: 86),
        ServerSummary(id: "fluxer:3", name: "Fluxer Friends", platform: .fluxer, openTickets: 1,
                      memberCount: 24, messagesToday: 57),
    ]

    private static func demoModule(
        _ id: String, _ name: String, icon: String, on: Bool, beta: Bool = false, line: (String, String)? = nil
    ) -> OverviewCard {
        OverviewCard(
            kind: .module, id: id, name: name, icon: icon, hasToggle: true, isEnabled: on, isBeta: beta,
            status: on ? .on : .off,
            lines: line.map { [StatusLine(label: $0.0, value: $0.1, state: on ? .on : .neutral)] } ?? [])
    }

    static let demoOverview = ServerOverview(
        server: OverviewServer(id: "1", name: "Pixel Harbor", memberCount: 2_431),
        openTickets: 2,
        openAppeals: 2,
        groups: [
            OverviewGroup(title: "Core", cards: [
                OverviewCard(kind: .link, id: "general", name: "Settings", icon: "gear", hasToggle: false,
                             isEnabled: nil, status: .link),
            ]),
            OverviewGroup(title: "Moderation and safety", cards: [
                demoModule("moderation", "Moderation", icon: "gavel", on: true, line: ("Mod-log", "#mod-log")),
                demoModule("automod", "Auto-moderation", icon: "shield", on: true, line: ("Rules", "6 active")),
                demoModule("honeypot", "Honeypot", icon: "target", on: true, line: ("Traps", "2 channels")),
                demoModule("logging", "Logging", icon: "file-text", on: true, line: ("Log channel", "#audit")),
                demoModule("verification", "Verification", icon: "shield-check", on: true, line: ("Role", "@Member")),
                demoModule("tickets", "Tickets", icon: "ticket", on: true, line: ("Staff role", "@Support")),
                demoModule("appeals", "Appeals", icon: "message-circle", on: true, line: ("Open", "2")),
            ]),
            OverviewGroup(title: "Members and engagement", cards: [
                demoModule("welcome", "Welcome", icon: "user-plus", on: true, line: ("Channel", "#welcome")),
                demoModule("leveling", "Leveling", icon: "trending-up", on: true, line: ("Top", "Mia, level 14")),
                demoModule("birthdays", "Birthdays", icon: "cake", on: true, line: ("Channel", "#general")),
                demoModule("starboard", "Starboard", icon: "star", on: true, line: ("Channel", "#starboard")),
                demoModule("polls", "Polls", icon: "bar-chart", on: true),
                demoModule("events", "Events", icon: "calendar", on: true, beta: true),
                demoModule("temp-roles", "Temporary roles", icon: "hourglass", on: true, beta: true),
                demoModule("invite-tracker", "Invite tracker", icon: "users", on: true),
                demoModule("welcome-channel", "Welcome channel", icon: "hash", on: false),
                demoModule("giveaways", "Giveaways", icon: "gift", on: false),
                demoModule("suggestions", "Suggestions", icon: "lightbulb", on: false, beta: true),
                demoModule("counting", "Counting", icon: "hash", on: false),
                demoModule("afk", "AFK", icon: "moon", on: false),
            ]),
            OverviewGroup(title: "Messages and channels", cards: [
                demoModule("autoresponder", "Autoresponder", icon: "zap", on: true, line: ("Triggers", "9")),
                OverviewCard(kind: .link, id: "messages", name: "Embed messages", icon: "message-square",
                             hasToggle: false, isEnabled: nil, status: .link),
                demoModule("custom-commands", "Custom commands", icon: "command", on: true, line: ("Commands", "3")),
                demoModule("reminders", "Reminders", icon: "bell", on: true, line: ("Active", "2")),
                demoModule("sticky", "Sticky messages", icon: "pin", on: true),
                demoModule("temp-voice", "Temporary voice", icon: "mic", on: true),
                demoModule("server-stats", "Server stats", icon: "activity", on: true),
                demoModule("insights", "Server insights", icon: "trending-up", on: true),
                demoModule("roles", "Reaction roles", icon: "smile", on: true, line: ("Sets", "2")),
                demoModule("auto-react", "Auto-react", icon: "smile", on: false, beta: true),
                demoModule("channel-cleanup", "Channel cleanup", icon: "trash-2", on: false),
                demoModule("game-stats", "Game stats", icon: "target", on: false),
                demoModule("auto-threads", "Auto threads", icon: "threads", on: false),
                demoModule("quote-board", "Quote board", icon: "quote", on: false),
            ]),
            OverviewGroup(title: "Alerts", cards: [
                demoModule("twitch-alerts", "Twitch alerts", icon: "twitch", on: true, line: ("Streamers", "3")),
                demoModule("youtube-alerts", "YouTube alerts", icon: "youtube", on: true),
                demoModule("rss", "RSS feeds", icon: "rss", on: true),
                demoModule("github", "GitHub alerts", icon: "github", on: true),
                demoModule("kick-alerts", "Kick alerts", icon: "kick", on: false),
                demoModule("free-games", "Free games", icon: "gamepad", on: false),
                demoModule("apple-connect", "App Store Connect", icon: "megaphone", on: false),
            ]),
        ])
}
#endif
