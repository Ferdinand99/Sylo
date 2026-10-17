import SwiftUI
import SyloKit

/// Sticky messages: one message per channel (text, an embed, or both) that Sylo re-posts at the
/// bottom. Mirrors web-v2/src/moduleForms/Sticky.jsx; the embed is edited on its own screen
/// (without the web editor's live preview).
struct StickySettingsView: View {
    @State private var model: ModuleSettingsModel<StickyPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Sticky Messages", model: model) { $settings, page in
            Section {
                Text("Each channel can have one sticky message: text, an embed, or both. It is re-posted at the bottom whenever someone else writes in that channel.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // One section per sticky, so each control gets its own row.
            ForEach($settings.stickies) { $sticky in
                Section {
                    ChannelPicker(title: "Channel", selection: $sticky.channelId, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    TextArea(title: "Message", text: $sticky.content,
                             limit: StickySettings.Sticky.maxContentLength, lines: 2...8)
                    if sticky.embed != nil {
                        NavigationLink {
                            StickyEmbedEditor(embed: Binding(
                                get: { sticky.embed ?? StickyEmbed() },
                                set: { sticky.embed = $0 }))
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
                            sticky.embed = StickyEmbed()
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

/// Edits one sticky's embed on its own screen. Changes go straight into the settings draft; Save
/// is on the screen before this one.
private struct StickyEmbedEditor: View {
    @Binding var embed: StickyEmbed

    var body: some View {
        Form {
            Section {
                TextField("Title", text: $embed.title)
                TextArea(title: "Description", text: $embed.description,
                         limit: StickyEmbed.maxDescriptionLength, lines: 3...10)
                ColorPicker("Colour", selection: colour, supportsOpacity: false)
            }

            Section("Author") {
                TextField("Name", text: $embed.authorName)
                StickyURLField(title: "Icon URL", text: $embed.authorIcon)
            }

            Section {
                StickyURLField(title: "Image URL", text: $embed.image)
                StickyURLField(title: "Thumbnail URL", text: $embed.thumbnail)
            } header: {
                Text("Images")
            } footer: {
                Text("Links must start with http:// or https://.")
            }

            Section("Footer") {
                TextField("Text", text: $embed.footerText)
                StickyURLField(title: "Icon URL", text: $embed.footerIcon)
            }

            ForEach($embed.fields) { $field in
                Section("Field") {
                    TextField("Name", text: $field.name)
                    TextArea(title: "Value", text: $field.value,
                             limit: StickyEmbed.Field.maxValueLength, lines: 2...6)
                    Toggle("Inline", isOn: $field.inline)
                    Button("Remove Field", role: .destructive) {
                        embed.fields.removeAll { $0.id == field.id }
                    }
                }
            }
            Section {
                if embed.fields.count < StickyEmbed.maxFields {
                    Button("Add Field", systemImage: "plus") {
                        embed.fields.append(StickyEmbed.Field())
                    }
                }
            } footer: {
                Text("A field needs both a name and a value.")
            }
        }
        .navigationTitle("Embed")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var colour: Binding<Color> {
        Binding(
            get: {
                let rgb = embed.rgb
                return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
            },
            set: { newValue in
                let resolved = newValue.resolve(in: EnvironmentValues())
                embed.setRGB(red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue))
            })
    }
}

/// A text field for a link.
private struct StickyURLField: View {
    let title: LocalizedStringKey
    @Binding var text: String

    var body: some View {
        TextField(title, text: $text)
            .keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
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
                    embed: StickyEmbed(title: "Welcome", description: "Be nice to each other.",
                                       fields: [StickyEmbed.Field(name: "Rule 1", value: "No spam")]),
                    cooldownSeconds: 30),
            ]),
            channels: [ChannelOption(id: "c1", name: "general"), ChannelOption(id: "c2", name: "rules")])
    }
    NavigationStack {
        StickySettingsView(server: "1", session: session)
    }
    .environment(session)
}
