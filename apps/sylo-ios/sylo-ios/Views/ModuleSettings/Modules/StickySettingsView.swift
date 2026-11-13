import SwiftUI
import SyloKit

/// Sticky messages: one message per channel (text, an embed, or both) that Sylo re-posts at the
/// bottom. Mirrors web-v2/src/moduleForms/Sticky.jsx; the embed is edited in the shared embed editor
/// on its own screen, with its live preview.
struct StickySettingsView: View {
    @State private var model: ModuleSettingsModel<StickyPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Sticky Messages", model: model) { $settings, page in
            ModuleIntro("Each channel can have one sticky message: text, an embed, or both. It is re-posted at the bottom whenever someone else writes in that channel.")

            // One section per sticky, so each control gets its own row.
            ForEach($settings.stickies) { $sticky in
                Section {
                    ChannelPicker(title: "Channel", selection: $sticky.channelId, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    UTF16TextArea(title: "Message", text: $sticky.content,
                             limit: StickySettings.Sticky.maxContentLength, lines: 2...8)
                    if sticky.embed != nil {
                        NavigationLink {
                            EmbedEditorView(draft: Binding(
                                get: { sticky.embed ?? EmbedDraft() },
                                set: { sticky.embed = $0 }), options: EmbedItem.options)
                        } label: {
                            LabeledContent("Embed") {
                                Text(verbatim: sticky.embed?.title ?? "")
                            }
                        }
                        Button("Remove Embed", role: .destructive) {
                            sticky.embed = nil
                        }
                    } else {
                        Button("Add Embed", systemImage: "plus") {
                            sticky.embed = EmbedDraft()
                        }
                    }
                    Toggle("Also bump for other apps", isOn: $sticky.repostOnBots)
                    NumberField(title: "Seconds between reposts", value: $sticky.cooldownSeconds,
                                range: StickySettings.Sticky.cooldownRange, unit: "s")
                    Button("Remove Sticky Message", role: .destructive) {
                        settings.stickies.removeAll { $0.id == sticky.id }
                    }
                } header: {
                    StickyHeader(channelId: sticky.channelId, channels: page.channels)
                }
            }

            Section {
                Button("Add Sticky Message", systemImage: "plus") {
                    settings.stickies.append(StickySettings.Sticky())
                }
            } footer: {
                if settings.stickies.isEmpty {
                    Text("No sticky messages yet. Add one for a channel.")
                } else {
                    Text("Bumping for other apps also counts webhooks and Sylo's own alerts. 0 seconds between reposts means the default of 4 seconds. A sticky message without a channel, or with neither a message nor an embed, isn't kept.")
                }
            }
        }
    }
}

/// "#rules", or "Sticky message" before a channel is chosen.
private struct StickyHeader: View {
    let channelId: String
    let channels: [ChannelOption]

    var body: some View {
        if let channel = channels.first(where: { $0.id == channelId }) {
            Text(verbatim: "#\(channel.name)")
        } else {
            Text("Sticky message")
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<StickyPage> else { return nil }
        return StickyPage(
            settings: StickySettings(stickies: [
                StickySettings.Sticky(channelId: "c1", content: "Please read the pinned rules before posting."),
                StickySettings.Sticky(
                    channelId: "c2",
                    embed: EmbedDraft(title: "Welcome", description: "Be nice to each other.",
                                       fields: [EmbedDraft.Field(name: "Rule 1", value: "No spam")]),
                    cooldownSeconds: 30),
            ]),
            channels: [ChannelOption(id: "c1", name: "general"), ChannelOption(id: "c2", name: "rules")])
    }
    NavigationStack {
        StickySettingsView(server: "1", session: session)
    }
    .environment(session)
}
