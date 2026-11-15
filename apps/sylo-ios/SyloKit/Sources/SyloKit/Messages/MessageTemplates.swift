import Foundation

// The built-in gallery of message templates (Sylo 5.2, P6; web-v2/src/messageTemplates.js): starting points for
// the message builder, the Welcome channel message and the text fields of Welcome and the alerts. Nothing here
// is sent to the server: picking one only fills the form, which is saved the usual way.
//
// A template has one embed message (used by the builder and the Welcome channel) and, where it makes sense, a
// short text for a field that holds plain text. The text uses the {placeholders} of the field it goes into.

/// A text field a template can fill.
public enum TemplateTextField: String, Sendable, CaseIterable {
    case welcome, welcomeDm, stream, youtubeVideo, youtubeLive, rss
}

public struct MessageTemplate: Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    /// One line for the gallery.
    public let blurb: String
    public let embeds: [EmbedDraft]
    public let texts: [TemplateTextField: String]

    /// The message as a fresh copy to put in a form. `tokens` says whether the page fills `{server}` in (the
    /// Welcome channel does, the embed message builder does not): without it the words are written out, so
    /// the message never shows a placeholder as it is.
    public func message(tokens: Bool) -> (content: String, embeds: [EmbedItem]) {
        func swap(_ text: String) -> String { tokens ? text : text.replacingOccurrences(of: "{server}", with: "our server") }
        let items = embeds.map { draft -> EmbedItem in
            var copy = draft
            copy.title = swap(copy.title)
            copy.description = swap(copy.description)
            copy.footerText = swap(copy.footerText)
            copy.fields = copy.fields.map { EmbedDraft.Field(name: swap($0.name), value: swap($0.value), inline: $0.inline) }
            return EmbedItem(copy)
        }
        return ("", items)
    }

    public static func == (lhs: MessageTemplate, rhs: MessageTemplate) -> Bool {
        lhs.id == rhs.id && lhs.name == rhs.name && lhs.blurb == rhs.blurb && lhs.texts == rhs.texts
            && lhs.embeds == rhs.embeds
    }
}

extension MessageTemplate {
    private static func embed(
        color: String = "#5865f2", title: String = "", description: String = "", footer: String = "",
        fields: [EmbedDraft.Field] = []
    ) -> EmbedDraft {
        EmbedDraft(color: color, title: title, description: description, footerText: footer, fields: fields)
    }

    /// Rules, Welcome card, Announcement, Stream live, Giveaway, Event.
    public static let all: [MessageTemplate] = [
        MessageTemplate(
            id: "rules", name: "Rules", blurb: "A numbered list of server rules.",
            embeds: [embed(
                title: "\u{1F4DC} Server rules",
                description: "**1.** Be kind and respectful. No harassment, hate or personal attacks.\n"
                    + "**2.** Keep each topic in the right channel.\n"
                    + "**3.** No spam, self-promotion or unrequested advertising.\n"
                    + "**4.** No NSFW or illegal content.\n"
                    + "**5.** Follow the moderators and the platform\u{2019}s terms of service.",
                footer: "Breaking the rules can lead to a warning, a timeout or a ban.")],
            texts: [
                .welcome: "Welcome to {server}, {user}! Before you post, please read the server rules.",
                .welcomeDm: "Hi {user.name}, welcome to {server}! Please read the rules: be kind, keep topics in the right channel and no spam.",
            ]),
        MessageTemplate(
            id: "welcome-card", name: "Welcome card", blurb: "A friendly welcome with where to start.",
            embeds: [embed(
                color: "#38c8f0", title: "\u{1F44B} Welcome to {server}!",
                description: "Glad you are here. Say hi, introduce yourself and have a look around.",
                footer: "Enjoy your stay in {server}",
                fields: [EmbedDraft.Field(name: "Start here", value: "Read the rules and pick your roles.", inline: true),
                         EmbedDraft.Field(name: "Need help?", value: "Ask any moderator.", inline: true)])],
            texts: [
                .welcome: "Welcome to {server}, {user}! You are member number {memberCount}. Say hi and make yourself at home.",
                .welcomeDm: "Hi {user.name}, welcome to {server}! If you need anything, just ask a moderator.",
            ]),
        MessageTemplate(
            id: "announcement", name: "Announcement", blurb: "News with what, when and who it affects.",
            embeds: [embed(
                color: "#f59e0b", title: "\u{1F4E3} Announcement",
                description: "Write your news here. Keep it short: what changed, who it affects and what to do.",
                footer: "Posted by the team",
                fields: [EmbedDraft.Field(name: "What", value: "What is new or different.", inline: true),
                         EmbedDraft.Field(name: "When", value: "The date or \u{201C}from now on\u{201D}.", inline: true)])],
            texts: [
                .youtubeVideo: "\u{1F4E3} New video from **{name}**: **{title}**\n{url}",
                .rss: "\u{1F4E3} **{title}**\n{link}",
            ]),
        MessageTemplate(
            id: "stream-live", name: "Stream live", blurb: "Tell everyone you are streaming.",
            embeds: [embed(
                color: "#9146ff", title: "\u{1F534} Going live!",
                description: "Come hang out and say hi in chat.\nhttps://twitch.tv/yourname",
                fields: [EmbedDraft.Field(name: "Playing", value: "Game name", inline: true),
                         EmbedDraft.Field(name: "Starts", value: "Now", inline: true)])],
            texts: [
                .stream: "\u{1F534} **{name}** is live: **{title}**\nPlaying {game} \u{00B7} {viewers} watching\n{url}",
                .youtubeLive: "\u{1F534} **{name}** is live: **{title}**\n{url}",
            ]),
        MessageTemplate(
            id: "giveaway", name: "Giveaway", blurb: "Prize, end time and how to enter.",
            embeds: [embed(
                color: "#ec4899", title: "\u{1F389} Giveaway: Prize name",
                description: "React with \u{1F389} to enter!\n\n**Ends:** date and time\n**Winners:** 1\n**Hosted by:** your name",
                footer: "Good luck!")],
            texts: [:]),
        MessageTemplate(
            id: "event", name: "Event", blurb: "An event with when, where and who.",
            embeds: [embed(
                color: "#10b981", title: "\u{1F4C5} Event: Name",
                description: "What the event is and who it is for.",
                footer: "Reply here if you can join.",
                fields: [EmbedDraft.Field(name: "When", value: "Date and time", inline: true),
                         EmbedDraft.Field(name: "Where", value: "A voice channel or a link", inline: true),
                         EmbedDraft.Field(name: "Who", value: "Everyone is welcome", inline: true)])],
            texts: [:]),
    ]

    /// The templates that have a text for this field (Welcome, the alerts).
    public static func templates(for field: TemplateTextField) -> [MessageTemplate] {
        all.filter { $0.texts[field] != nil }
    }
}
