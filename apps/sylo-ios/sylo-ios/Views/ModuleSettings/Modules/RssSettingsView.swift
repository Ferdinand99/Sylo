import SwiftUI
import SyloKit

/// RSS alerts: the feeds to follow (a feed URL, or a Reddit, Mastodon or Bluesky handle), where
/// new items go, who to ping and the message template. Mirrors
/// web-v2/src/moduleForms/RssAlerts.jsx.
struct RssSettingsView: View {
    @State private var model: ModuleSettingsModel<RssPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("RSS Alerts", model: model) { $settings, page in
            Section {
                Text("Sylo checks each feed every few minutes and posts new items to the chosen channel. Use a raw RSS or Atom URL, or a Reddit, Mastodon or Bluesky handle and Sylo finds its feed. The first check only remembers the current items; new ones after that are posted. Template placeholders: {title} {link} {author} {feed}.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // One section per feed, so each control gets its own row.
            ForEach($settings.feeds) { $feed in
                Section {
                    Picker("Source", selection: $feed.type) {
                        ForEach(RssFeedType.allCases, id: \.self) { type in
                            Text(type.title).tag(type)
                        }
                    }
                    TextField(feed.type.refTitle, text: $feed.ref, prompt: Text(verbatim: feed.type.refPrompt))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(feed.type == .url ? .URL : .default)
                    ChannelPicker(title: "Post in", selection: $feed.channelId, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    RolePicker(title: "Ping role", selection: $feed.roleId, roles: page.roles)
                    TextArea(title: "Message template", text: $feed.template,
                             limit: RssSettings.maxTemplateLength, lines: 2...6)
                    Button("Remove Feed", role: .destructive) {
                        settings.feeds.removeAll { $0.id == feed.id }
                    }
                } header: {
                    Text("Feed")
                } footer: {
                    if !page.defaultTemplate.isEmpty {
                        Text("An empty template uses the default: \(page.defaultTemplate)")
                    }
                }
            }
            Section {
                if settings.feeds.count < RssSettings.maxFeeds {
                    Button("Add Feed", systemImage: "plus") {
                        settings.feeds.append(RssSettings.Feed())
                    }
                }
            } footer: {
                Text("Up to \(RssSettings.maxFeeds) feeds. A feed Sylo can't read, or one without a channel, is dropped when you save.")
            }
        }
    }
}

private extension RssFeedType {
    var title: LocalizedStringKey {
        switch self {
        case .url: "RSS / Atom URL"
        case .reddit: "Reddit"
        case .mastodon: "Mastodon"
        case .bluesky: "Bluesky"
        }
    }

    /// The label of the reference field for this source.
    var refTitle: LocalizedStringKey {
        switch self {
        case .url: "Feed URL"
        case .reddit: "Subreddit or user"
        case .mastodon, .bluesky: "Handle"
        }
    }

    /// An example reference, shown in the empty field.
    var refPrompt: String {
        switch self {
        case .url: "https://example.com/feed.xml"
        case .reddit: "r/programming or u/spez"
        case .mastodon: "@user@mastodon.social"
        case .bluesky: "name.bsky.social"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<RssPage> else { return nil }
        return RssPage(
            settings: RssSettings(feeds: [
                RssSettings.Feed(feedId: "a1b2c3d4", type: .reddit, ref: "r/swift", channelId: "c1"),
                RssSettings.Feed(feedId: "e5f6a7b8", ref: "https://example.com/feed.xml", channelId: "c2",
                                 roleId: "r1"),
            ]),
            channels: [ChannelOption(id: "c1", name: "news"), ChannelOption(id: "c2", name: "blog")],
            roles: [RoleOption(id: "r1", name: "Readers")],
            defaultTemplate: "📰 **{title}**\n{link}")
    }
    NavigationStack {
        RssSettingsView(server: "1", session: session)
    }
    .environment(session)
}
