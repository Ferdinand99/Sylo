import SwiftUI
import SyloKit

/// Welcome Channel: the channel, the message text and its embeds and banners (each edited on its
/// own screen). Mirrors web-v2/src/moduleForms/WelcomeChannel.jsx; saving here is the web page's
/// Save Draft. Publishing, removing the published message and creating the channel stay on the web.
struct WelcomeChannelSettingsView: View {
    @State private var model: ModuleSettingsModel<WelcomeChannelPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Welcome Channel", model: model) { $settings, page in
            Section {
                Text("Build one rich message for a dedicated read-only channel. Saving keeps it as a draft; publish it to the channel from the web dashboard.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                ChannelPicker(title: "Channel", selection: $settings.channelId, channels: page.channels,
                              noneTitle: "Choose a channel")
            } footer: {
                if settings.isPublished {
                    Text("Published. Publish again from the web dashboard to update the message in the channel.")
                } else {
                    Text("Not published yet.")
                }
            }

            Section {
                TextArea(title: "Message text", text: $settings.content,
                         limit: WelcomeChannelSettings.maxContentLength, lines: 2...6)
            } header: {
                Text("Message text")
            } footer: {
                Text("Optional, shown above the embeds. Placeholders: {server}, {memberCount}.")
            }

            ForEach($settings.embeds) { $embed in
                Section {
                    NavigationLink {
                        WelcomeChannelEmbedEditor(embed: $embed)
                    } label: {
                        WelcomeChannelEmbedSummary(embed: embed)
                    }
                    if let index = settings.embeds.firstIndex(where: { $0.id == embed.id }) {
                        if index > 0 {
                            Button("Move Up", systemImage: "arrow.up") {
                                settings.embeds.swapAt(index, index - 1)
                            }
                        }
                        if index < settings.embeds.count - 1 {
                            Button("Move Down", systemImage: "arrow.down") {
                                settings.embeds.swapAt(index, index + 1)
                            }
                        }
                    }
                    Button("Remove Element", role: .destructive) {
                        settings.embeds.removeAll { $0.id == embed.id }
                    }
                } header: {
                    if embed.kind == .banner {
                        Text("Banner")
                    } else {
                        Text("Embed")
                    }
                }
            }
            Section {
                if settings.embeds.count < WelcomeChannelSettings.maxEmbeds {
                    if page.presets.isEmpty {
                        Button("Add Embed", systemImage: "plus") {
                            settings.embeds.append(WelcomeChannelSettings.Embed())
                        }
                    } else {
                        Menu {
                            ForEach(page.presets) { preset in
                                Button {
                                    settings.embeds.append(preset.makeEmbed())
                                } label: {
                                    Text(verbatim: preset.label)
                                }
                            }
                        } label: {
                            Label("Add Element", systemImage: "plus")
                        }
                    }
                }
            } footer: {
                Text("Up to 10 embeds and banners.")
            }
        }
    }
}

/// An element's title (or kind) over the start of its text.
private struct WelcomeChannelEmbedSummary: View {
    let embed: WelcomeChannelSettings.Embed

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !embed.title.isEmpty {
                Text(verbatim: embed.title)
            } else if embed.kind == .banner {
                if embed.image.isEmpty {
                    Text("Banner without an image")
                } else {
                    Text("Banner")
                }
            } else {
                Text("Untitled embed")
            }
            if !embed.description.isEmpty {
                Text(verbatim: embed.description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

/// One embed or banner, on its own screen.
private struct WelcomeChannelEmbedEditor: View {
    @Binding var embed: WelcomeChannelSettings.Embed

    var body: some View {
        Form {
            if embed.kind == .banner {
                Section {
                    WelcomeChannelURLField(title: "Image URL", text: $embed.image)
                    TextArea(title: "Caption", text: $embed.description,
                             limit: WelcomeChannelSettings.Embed.maxDescriptionLength, lines: 1...4)
                } footer: {
                    Text("A big image with an optional caption.")
                }
            } else {
                Section {
                    WelcomeChannelColorField(color: $embed.color)
                }

                Section("Author") {
                    WelcomeChannelLimitedField(title: "Author name", text: $embed.authorName,
                                               limit: WelcomeChannelSettings.Embed.maxAuthorLength)
                    WelcomeChannelURLField(title: "Author icon URL", text: $embed.authorIcon)
                }

                Section {
                    WelcomeChannelLimitedField(title: "Title", text: $embed.title,
                                               limit: WelcomeChannelSettings.Embed.maxTitleLength)
                    TextArea(title: "Description", text: $embed.description,
                             limit: WelcomeChannelSettings.Embed.maxDescriptionLength, lines: 3...10)
                } header: {
                    Text("Text")
                } footer: {
                    Text(verbatim: "{server} {memberCount}")
                }

                Section("Images") {
                    WelcomeChannelURLField(title: "Image URL", text: $embed.image)
                    WelcomeChannelURLField(title: "Thumbnail URL", text: $embed.thumbnail)
                }

                Section("Footer") {
                    WelcomeChannelLimitedField(title: "Footer text", text: $embed.footerText,
                                               limit: WelcomeChannelSettings.Embed.maxFooterLength)
                    WelcomeChannelURLField(title: "Footer icon URL", text: $embed.footerIcon)
                }

                ForEach($embed.fields) { $field in
                    Section("Field") {
                        WelcomeChannelLimitedField(title: "Name", text: $field.name,
                                                   limit: WelcomeChannelSettings.Field.maxNameLength)
                        TextArea(title: "Value", text: $field.value,
                                 limit: WelcomeChannelSettings.Field.maxValueLength, lines: 1...6)
                        Toggle("Inline", isOn: $field.inline)
                        Button("Remove Field", role: .destructive) {
                            embed.fields.removeAll { $0.id == field.id }
                        }
                    }
                }
                Section {
                    if embed.fields.count < WelcomeChannelSettings.Embed.maxFields {
                        Button("Add Field", systemImage: "plus") {
                            embed.fields.append(WelcomeChannelSettings.Field())
                        }
                    }
                } footer: {
                    Text("A field needs both a name and a value to be shown.")
                }
            }
        }
        .navigationTitle(embed.kind == .banner ? Text("Banner") : Text("Embed"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// One line of text, cut off at `limit` characters.
private struct WelcomeChannelLimitedField: View {
    let title: LocalizedStringKey
    @Binding var text: String
    let limit: Int

    var body: some View {
        TextField(title, text: $text)
            .onChange(of: text) {
                if text.count > limit { text = String(text.prefix(limit)) }
            }
    }
}

/// An image URL (`https://…`). The server drops anything that isn't one.
private struct WelcomeChannelURLField: View {
    let title: LocalizedStringKey
    @Binding var text: String

    var body: some View {
        TextField(title, text: $text, prompt: Text(verbatim: "https://"))
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }
}

/// The embed's side colour as `#rrggbb`, with a swatch.
private struct WelcomeChannelColorField: View {
    @Binding var color: String

    var body: some View {
        LabeledContent("Color") {
            HStack(spacing: 8) {
                TextField("Color", text: $color, prompt: Text(verbatim: WelcomeChannelSettings.Embed.defaultColor))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .multilineTextAlignment(.trailing)
                    .fixedSize()
                Circle()
                    .fill(swatch)
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
            }
        }
    }

    private var swatch: Color {
        guard WelcomeChannelSettings.Embed.isValidColor(color),
              let value = UInt32(color.dropFirst(), radix: 16) else { return Color.secondary.opacity(0.3) }
        return Color(red: Double((value >> 16) & 0xFF) / 255,
                     green: Double((value >> 8) & 0xFF) / 255,
                     blue: Double(value & 0xFF) / 255)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<WelcomeChannelPage> else { return nil }
        return WelcomeChannelPage(
            settings: WelcomeChannelSettings(
                channelId: "c1",
                content: "Welcome to {server}!",
                embeds: [
                    WelcomeChannelSettings.Embed(title: "Server rules", description: "Be respectful to everyone.",
                                                 fields: [WelcomeChannelSettings.Field(name: "1", value: "No spam")]),
                    WelcomeChannelSettings.Embed(kind: .banner, image: "https://example.com/banner.png"),
                ]),
            channels: [ChannelOption(id: "c1", name: "welcome")],
            presets: [
                WelcomeChannelPreset(id: "welcome-embed", label: "Welcome embed",
                                     defaults: WelcomeChannelSettings.Embed(title: "Welcome to {server}!")),
                WelcomeChannelPreset(id: "welcome-banner", label: "Welcome banner",
                                     defaults: WelcomeChannelSettings.Embed(kind: .banner)),
            ])
    }
    NavigationStack {
        WelcomeChannelSettingsView(server: "1", session: session)
    }
    .environment(session)
}
