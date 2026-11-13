import SwiftUI
import SyloKit

/// Welcome Channel: the channel, the message text and its embeds and banners (each edited on its
/// own screen, with a live preview). Mirrors web-v2/src/moduleForms/WelcomeChannel.jsx. Save keeps a
/// draft, Publish posts it to the channel (or updates the posted message), Remove Published Message
/// takes it down again, and Create Read-Only #welcome makes the channel.
struct WelcomeChannelSettingsView: View {
    @State private var model: ModuleSettingsModel<WelcomeChannelPage>
    @State private var publisher: WelcomeChannelPublisher
    @State private var isConfirmingRemove = false
    @State private var isConfirmingClear = false
    @State private var isConfirmingCreate = false

    /// What the server fills in on the message text and in the embeds.
    private static let variables = [
        EmbedVariable(token: "{server}", label: "Server name"),
        EmbedVariable(token: "{memberCount}", label: "Member count"),
    ]

    init(server: ServerID, session: AppSession) {
        let model = ModuleSettingsModel<WelcomeChannelPage>(server: server, session: session)
        _model = State(initialValue: model)
        _publisher = State(initialValue: WelcomeChannelPublisher(model: model, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Welcome Channel", model: model) { $settings, page in
            ModuleIntro("Build one rich message for a dedicated read-only channel. Save keeps it as a draft. Publish posts it to the channel, or updates it if it is already posted.")

            Section {
                ChannelPicker(title: "Channel", selection: $settings.channelId, channels: page.channels,
                              noneTitle: "Choose a channel")
                Button("Create Read-Only #welcome", systemImage: "plus.bubble") {
                    isConfirmingCreate = true
                }
                .disabled(publisher.isBusy)
            } footer: {
                if publisher.isPublished {
                    if publisher.serverMovesMessages {
                        Text("Published in the channel. Publish again to update the message there. Another channel applies when you publish: the message is posted there and the old one is deleted.")
                    } else {
                        Text("Published in the channel. Publish again to update the message there. If you pick another channel, the new one gets a new message and the old one stays where it is, so remove the published message first if you do not want it.")
                    }
                } else {
                    Text("Not published yet.")
                }
            }

            Section {
                UTF16TextArea(title: "Message text", text: $settings.content,
                         limit: WelcomeChannelSettings.maxContentLength, lines: 2...6)
            } header: {
                Text("Message text")
            } footer: {
                Text("Optional, shown above the embeds. Placeholders: {server}, {memberCount}.")
            }

            Section("Preview") {
                MessagePreviewCard(content: settings.content, embeds: settings.embeds)
            }

            EmbedElementSections(items: $settings.embeds, limit: WelcomeChannelSettings.maxEmbeds) { item in
                if item.wrappedValue.isBanner {
                    WelcomeBannerEditor(draft: item.draft)
                } else {
                    EmbedEditorView(
                        draft: item.draft, options: EmbedItem.options, variables: Self.variables)
                }
            }
            Section {
                if settings.embeds.count < WelcomeChannelSettings.maxEmbeds {
                    if page.presets.isEmpty {
                        Button("Add Embed", systemImage: "plus") {
                            settings.embeds.append(EmbedItem())
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
                if settings.embeds.isEmpty {
                    Text("No elements yet. An embed is a card with a title, text and fields; a banner is a large picture. A message holds up to \(WelcomeChannelSettings.maxEmbeds).")
                } else {
                    Text("Up to \(WelcomeChannelSettings.maxEmbeds) embeds and banners.")
                }
            }

            Section {
                if publisher.isBusy {
                    HStack {
                        Text("Working\u{2026}")
                        Spacer()
                        ProgressView()
                    }
                } else {
                    Button {
                        Task { await publisher.publish() }
                    } label: {
                        Label(publisher.isPublished ? "Update Published Message" : "Publish to Channel",
                              systemImage: "paperplane")
                    }
                    .disabled(settings.channelId.isEmpty)
                    if publisher.isPublished {
                        Button("Remove Published Message", systemImage: "trash", role: .destructive) {
                            isConfirmingRemove = true
                        }
                    }
                }
            } footer: {
                actionFooter(channelChosen: !settings.channelId.isEmpty)
            }

            if !settings.content.isEmpty || !settings.embeds.isEmpty {
                Section {
                    Button("Clear Message", role: .destructive) {
                        isConfirmingClear = true
                    }
                } footer: {
                    Text("Clears the editor. Nothing changes in the channel until you save or publish.")
                }
            }
        }
        .confirmationDialog(
            "Remove the published message?", isPresented: $isConfirmingRemove, titleVisibility: .visible
        ) {
            Button("Remove Message", role: .destructive) { Task { await publisher.unpublish() } }
        } message: {
            Text("The message is deleted from the channel. Your draft stays here, so you can publish it again.")
        }
        .confirmationDialog(
            "Create a read-only #welcome channel?", isPresented: $isConfirmingCreate, titleVisibility: .visible
        ) {
            Button("Create Channel") { Task { await publisher.createChannel() } }
        } message: {
            Text("Members can read it but not write in it. It is picked as this message's channel.")
        }
        .confirmationDialog(
            "Clear the whole message?", isPresented: $isConfirmingClear, titleVisibility: .visible
        ) {
            Button("Clear Message", role: .destructive) {
                model.draft?.content = ""
                model.draft?.embeds = []
            }
        } message: {
            Text("Removes every element and the message text from the editor.")
        }
        .alert(failureTitle, isPresented: isShowingError, presenting: publisher.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: publisher.successCount)
        .task { await publisher.loadFeatures() }
    }

    @ViewBuilder
    private func actionFooter(channelChosen: Bool) -> some View {
        if let notice = publisher.notice {
            switch notice {
            case .published: Text("Published to the channel.")
            case .updated: Text("Published message updated.")
            case .removed: Text("Published message removed.")
            case .channelCreated: Text("Created #welcome.")
            }
        } else if !channelChosen {
            Text("Choose a channel to publish to.")
        } else {
            Text("Publishing also saves your changes.")
        }
    }

    private var failureTitle: LocalizedStringKey {
        switch publisher.failedStep {
        case .remove: "Couldn't Remove Message"
        case .createChannel: "Couldn't Create Channel"
        default: "Couldn't Publish"
        }
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { publisher.errorMessage != nil }, set: { if !$0 { publisher.errorMessage = nil } })
    }
}

/// A banner: a big picture with an optional caption, and nothing else.
private struct WelcomeBannerEditor: View {
    @Binding var draft: EmbedDraft

    var body: some View {
        Form {
            Section("Preview") {
                VStack(alignment: .leading, spacing: 8) {
                    BotMessageHeader()
                    EmbedPreviewCard(draft: draft)
                }
                .padding(.vertical, 4)
            }
            Section {
                LinkTextField(title: "Image URL", text: $draft.image)
                UTF16TextArea(title: "Caption", text: $draft.description,
                         limit: EmbedLimits.standard.description, lines: 1...4)
            } footer: {
                Text("A big picture with an optional caption. Links must start with http:// or https://.")
            }
        }
        .navigationTitle("Banner")
        .navigationBarTitleDisplayMode(.inline)
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
                    EmbedItem(EmbedDraft(
                        color: "#5865f2", title: "Server rules", description: "Be respectful to everyone.",
                        fields: [EmbedDraft.Field(name: "1", value: "No spam")])),
                    EmbedItem(EmbedDraft(image: "https://example.com/banner.png", kind: "banner")),
                ]),
            channels: [ChannelOption(id: "c1", name: "welcome")],
            presets: [
                WelcomeChannelPreset(id: "welcome-embed", label: "Welcome embed",
                                     defaults: EmbedDraft(title: "Welcome to {server}!")),
                WelcomeChannelPreset(id: "welcome-banner", label: "Welcome banner",
                                     defaults: EmbedDraft(kind: "banner")),
            ])
    }
    NavigationStack {
        WelcomeChannelSettingsView(server: "1", session: session)
    }
    .environment(session)
}
