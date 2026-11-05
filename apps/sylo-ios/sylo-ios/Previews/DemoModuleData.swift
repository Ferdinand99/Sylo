#if DEBUG
import Foundation
import SyloKit

nonisolated extension PreviewData {
    private static func demoDecode<T: Decodable>(_ json: String) -> T {
        // Sample data spelled out below; a typo here is a programming error in the previews.
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    /// The saved embed messages of the demo server.
    static let composedList: ComposedMessageList = demoDecode(#"""
    {"items": [
      {"id": 7, "name": "Server rules", "channel": "rules", "published": true, "when": "3h ago"},
      {"id": 8, "name": "Giveaway announcement", "channel": "announcements", "published": false, "when": "2d ago"},
      {"id": 9, "name": "Weekly events", "channel": "events", "published": true, "when": "6d ago"}
    ]}
    """#)

    /// One published message with two embeds, fields and a link button.
    static let composedPage: ComposedMessagePage = demoDecode(#"""
    {"isNew": false,
     "rec": {"id": 7, "name": "Server rules", "channelId": "222222222222222222", "messageId": "999999999999999999",
             "spec": {"content": "Welcome! Please read the rules before you chat.",
                      "embeds": [
                        {"kind": "embed", "color": "#38c8f0", "title": "Be kind", "description": "Treat everyone with **respect**. No harassment, hate speech or spam.\nQuestions? Ask a *moderator*.",
                         "authorName": "Sylo Test Server", "authorIcon": "", "image": "", "thumbnail": "",
                         "footerText": "Last updated today", "footerIcon": "", "timestamp": false,
                         "fields": [{"name": "Reports", "value": "Open a ticket", "inline": true},
                                    {"name": "Appeals", "value": "Use the appeals form", "inline": true},
                                    {"name": "Mods", "value": "@Moderators", "inline": true}]},
                        {"kind": "embed", "color": "#ed4245", "title": "Consequences", "description": "Breaking a rule can get you muted, kicked or banned.",
                         "authorName": "", "authorIcon": "", "image": "", "thumbnail": "", "footerText": "", "footerIcon": "", "fields": []}],
                      "rows": [{"type": "buttons", "buttons": [{"style": "link", "label": "Full rules", "emoji": "📜", "url": "https://sylobot.com"}]}]}},
     "channels": [{"id": "222222222222222222", "name": "rules"}, {"id": "333333333333333333", "name": "announcements"}],
     "roles": []}
    """#)

    static let composedNew: ComposedMessagePage = demoDecode(#"""
    {"isNew": true, "rec": {"id": "", "name": "", "channelId": "", "messageId": null,
                            "spec": {"content": "", "embeds": [], "rows": []}},
     "channels": [{"id": "333333333333333333", "name": "announcements"}], "roles": []}
    """#)

    /// Three custom commands, the first with a reply, a role and a message to a channel.
    static let customCommands: CustomCommandsPage = demoDecode(#"""
    {"commands": [
       {"id": "1", "name": "rules", "description": "Show the server rules",
        "actions": [{"type": "reply", "private": true, "messages": [{"content": "Read #rules, {user}.", "embed": null}]},
                    {"type": "send", "channelId": "222222222222222222", "messages": [{"content": "{username} looked at the rules", "embed": null}]}],
        "allowedRoles": [], "allowedChannels": [], "cooldownSeconds": 30, "reserved": false},
       {"id": "2", "name": "verify", "description": "Get the Member role",
        "actions": [{"type": "add-role", "roleId": "333333333333333333"}],
        "allowedRoles": [], "allowedChannels": ["222222222222222222"], "cooldownSeconds": 0, "reserved": false},
       {"id": "3", "name": "ping", "description": "",
        "actions": [{"type": "reply", "private": false, "messages": [{"content": "pong", "embed": null}]}],
        "allowedRoles": [], "allowedChannels": [], "cooldownSeconds": 0, "reserved": true}],
     "channels": [{"id": "222222222222222222", "name": "log"}],
     "roles": [{"id": "333333333333333333", "name": "Member"}],
     "placeholders": ["{user}", "{username}", "{server}", "{channel}", "{args}"]}
    """#)

    /// Thirty days of activity.
    static let insights: InsightsPage = {
        let series = (0..<30).map { day -> InsightsPoint in
            let wave = Int(60 * (1 + sin(Double(day) / 3)))
            return InsightsPoint(
                label: "day-\(day)", messages: 120 + wave * 3 + (day % 7 == 5 ? 160 : 0), joins: 2 + (day % 5),
                leaves: day % 4, activeMembers: 20 + wave / 3, voiceMinutes: 40 + wave * 2 + (day % 9) * 20,
                voicePeak: 2 + day % 4)
        }
        return InsightsPage(
            range: 30, isHourly: false, series: series,
            totals: InsightsTotals(
                messages: series.reduce(0) { $0 + $1.messages }, joins: series.reduce(0) { $0 + $1.joins },
                leaves: series.reduce(0) { $0 + $1.leaves },
                net: series.reduce(0) { $0 + $1.joins - $1.leaves }, peakActive: 52,
                voiceMinutes: series.reduce(0) { $0 + $1.voiceMinutes }, voicePeak: 5),
            topChannels: [
                InsightsChannel(name: "general", amount: 4_210), InsightsChannel(name: "memes", amount: 2_980),
                InsightsChannel(name: "gaming", amount: 1_760),
            ],
            topVoice: [InsightsChannel(name: "Lounge", amount: 1_240), InsightsChannel(name: "Game night", amount: 640)])
    }()
}
#endif
