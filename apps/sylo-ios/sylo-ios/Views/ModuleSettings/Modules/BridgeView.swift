import SwiftUI
import SyloKit

/// The Bridge module (Sylo 5.3): one conversation between a channel here and a channel on the other platform. The
/// bridged channels with their state and what this server shares, the requests that wait, asking the other server
/// for a link, and using a code it gave. Everyone who can see the server reads it; only the server owner changes
/// anything. Mirrors web-v2/src/moduleForms/Bridge.jsx.
struct BridgeView: View {
    @State private var model: BridgeModel
    @State private var unlinking: BridgeLink?
    @State private var cancelling: BridgeRequest?
    @Environment(AppSession.self) private var session
    private let server: ServerID

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: BridgeModel(server: server, session: session))
    }

    var body: some View {
        content
            .navigationTitle("Bridge")
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.load() }
            .refreshable { await model.load() }
            .confirmationDialog(
                unlinking.map { "Unlink #\($0.mine.channel)?" } ?? "Unlink?", isPresented: isUnlinking,
                titleVisibility: .visible, presenting: unlinking
            ) { link in
                Button("Unlink", role: .destructive) { Task { await model.change(link, .unlink) } }
            } message: { link in
                Text(verbatim: String(localized: "Messages stop crossing to #\(link.theirs.channel) in \(link.theirs.server). Sylo deletes both webhooks and tells both channels. Messages already posted stay where they are, and deleting an original later no longer removes its copy."))
            }
            .confirmationDialog(
                "Cancel this request?", isPresented: isCancelling, titleVisibility: .visible, presenting: cancelling
            ) { request in
                Button("Cancel Request", role: .destructive) { Task { await model.cancel(request) } }
                Button("Keep It", role: .cancel) {}
            } message: { _ in
                Text("The code stops working. You can ask again.")
            }
            .alert("Couldn't Change the Bridge", isPresented: isShowingError, presenting: model.actionError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
            .sensoryFeedback(.success, trigger: model.successCount)
    }

    @ViewBuilder
    private var content: some View {
        if let overview = model.overview {
            Form {
                intro(overview)
                if let message = model.errorMessage {
                    Section { StatusMessage(message, kind: .error) }
                }
                if let notice = model.notice {
                    Section { StatusMessage(notice, kind: .notice) }
                }
                linksSection(overview)
                if !overview.requests.isEmpty {
                    requestsSection(overview)
                }
                if !overview.isOwner {
                    Section {
                        StatusMessage(
                            String(localized: "Only the server owner can ask for a link, use a code, change what this server shares, or pause, resume and unlink a bridge. You can see the status here."),
                            kind: .notice)
                    }
                }
                askSection(overview)
                useCodeSection(overview)
            }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load the Bridge", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private func intro(_ overview: BridgeOverview) -> some View {
        let here = overview.platform.displayName
        let other = overview.otherPlatform.displayName
        Section {
            Text(verbatim: String(localized: "One conversation between a channel here on \(here) and a channel on \(other). Members on both sides write as they always do, and Sylo shows each message on the other side with the author's name and picture."))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            DisclosureGroup("How It Works") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Both servers agree. One asks for a link and gets a code that works for 15 minutes; the owner of the other server uses it and picks a channel. Sylo has to be in both servers. Either side can unlink at any time.")
                    Text("What crosses: messages, replies (as a short quote), files up to 8 MB (otherwise a link), custom emoji with the same name, stickers (as a picture link), embeds, polls (as text: the vote stays where the poll is) and, if you turn it on, who joins. Edits and deletes follow for 30 days.")
                    Text("What never crosses: pings. @everyone, @here, roles and people are shown as plain text on the other side, and nothing the bridge posts notifies anyone. Sylo's own bridge messages are never relayed again, so there are no loops. Other bots are off until you turn them on. An age-restricted channel can only be bridged with another age-restricted channel. Both channels show a notice while a bridge is on.")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            if overview.platform == .discord, overview.bothPlatforms, overview.isOwner, session.has(.mirror) {
                NavigationLink {
                    MirrorView(server: server, session: session)
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Setting up a whole Fluxer server?")
                            Text("Mirror to Fluxer copies channels, roles and emoji and bridges every channel at once.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "square.on.square")
                    }
                }
            }
        }
        if !overview.bothPlatforms {
            Section {
                StatusMessage(
                    String(localized: "This Sylo is not connected to both Discord and Fluxer, so there is nothing to bridge to."),
                    kind: .error)
            }
        } else if !overview.enabled {
            Section {
                StatusMessage(
                    String(localized: "Turn the Bridge module on in the module list to ask for a link or use a code."),
                    kind: .notice)
            }
        }
    }

    @ViewBuilder
    private func linksSection(_ overview: BridgeOverview) -> some View {
        Section {
            ForEach(overview.links) { link in
                BridgeLinkRow(link: link, model: model, unlinking: $unlinking)
            }
        } header: {
            Text(verbatim: overview.linksTitle)
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if overview.links.isEmpty {
                    Text("No channel is bridged yet. Ask for a link below, or use a code from the other server.")
                }
                if let note = overview.limitNote {
                    Text(verbatim: note)
                }
            }
        }
    }

    @ViewBuilder
    private func requestsSection(_ overview: BridgeOverview) -> some View {
        Section("Waiting for the Other Server") {
            ForEach(overview.requests) { request in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "#\(request.channel)")
                    Text(verbatim: requestDetails(request))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if overview.isOwner {
                        Button("Cancel Request", systemImage: "xmark.circle", role: .destructive) { cancelling = request }
                    }
                }
                .contextMenu {
                    if overview.isOwner {
                        Button("Cancel Request", systemImage: "xmark.circle", role: .destructive) { cancelling = request }
                    }
                }
            }
        }
    }

    private func requestDetails(_ request: BridgeRequest) -> String {
        var parts: [String] = []
        if let expiry = request.expiresAt {
            parts.append(String(localized: "code valid until \(DateText.dayAndTime(expiry))"))
        }
        if !request.requestedBy.isEmpty { parts.append(request.requestedBy) }
        return parts.joined(separator: " \u{00B7} ")
    }

    @ViewBuilder
    private func askSection(_ overview: BridgeOverview) -> some View {
        let other = overview.otherPlatform.displayName
        Section {
            BridgeChannelPicker(selection: $model.askChannelID, channels: overview.freeChannels)
            ForEach(BridgeOptions.Key.allCases) { key in
                BridgeOptionToggle(key: key, isOn: $model.askOptions[key])
            }
            Button("Get a Code") { Task { await model.requestLink() } }
                .disabled(!model.canAsk)
            if let issued = model.issuedCode {
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: issued.expiresAt.map {
                        String(localized: "Give this code to the \(other) server. It works once, until \(DateText.dayAndTime($0)), and is not shown again.")
                    } ?? String(localized: "Give this code to the \(other) server. It works once and is not shown again."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text(verbatim: issued.code)
                        .font(.title3.monospaced().weight(.semibold))
                        .textSelection(.enabled)
                    CopyValueButton(title: "Copy Code", value: issued.code)
                }
                .padding(.vertical, 4)
            }
        } header: {
            Text("Ask the Other Server")
        } footer: {
            Text(verbatim: String(localized: "Pick the channel here that should be bridged. You get a one-time code to give to the owner of the \(other) server."))
        }
        .disabled(!overview.isOwner || !overview.isReady)
    }

    @ViewBuilder
    private func useCodeSection(_ overview: BridgeOverview) -> some View {
        let other = overview.otherPlatform.displayName
        Section {
            TextField("Code", text: $model.code, prompt: Text(verbatim: "XXXX-XXXX-XXXX"))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.body.monospaced())
                .onChange(of: model.code) {
                    if model.code.count > BridgeModel.codeFieldLength {
                        model.code = String(model.code.prefix(BridgeModel.codeFieldLength))
                    }
                }
            BridgeChannelPicker(selection: $model.useChannelID, channels: overview.freeChannels)
            ForEach(BridgeOptions.Key.allCases) { key in
                BridgeOptionToggle(key: key, isOn: $model.useOptions[key])
            }
            Button("Link the Channels") { Task { await model.acceptCode() } }
                .disabled(!model.canUseCode)
        } header: {
            Text("Use a Code")
        } footer: {
            Text(verbatim: String(localized: "Someone on \(other) asked for a link and gave you a code. Pick the channel here that joins it."))
        }
        .disabled(!overview.isOwner || !overview.isReady)
    }

    private var isUnlinking: Binding<Bool> {
        Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } })
    }

    private var isCancelling: Binding<Bool> {
        Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// One bridged channel: both ends and their state, why it stopped or paused, Pause or Resume and Unlink, and what
/// this server shares on it.
private struct BridgeLinkRow: View {
    let link: BridgeLink
    let model: BridgeModel
    @Binding var unlinking: BridgeLink?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: "#\(link.mine.channel) \u{2194} #\(link.theirs.channel)")
                    .font(.headline)
                Spacer(minLength: 8)
                Text(verbatim: link.statusTitle)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(statusColor)
            }
            Text(verbatim: link.details)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let problem = link.problem {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let note = link.pauseNote {
                Label(note, systemImage: "pause.circle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if link.pausedByThem {
                Text(verbatim: String(localized: "\(link.theirs.server) paused this bridge. Only they can resume it."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            DisclosureGroup("What This Server Shares") {
                ForEach(BridgeOptions.Key.allCases) { key in
                    BridgeOptionToggle(key: key, isOn: optionBinding(key))
                        .disabled(!model.isOwner || model.isWorking)
                }
                Text(verbatim: link.theirSharing)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if model.isOwner {
                HStack {
                    if link.status == .active {
                        Button("Pause", systemImage: "pause.circle") { Task { await model.change(link, .pause) } }
                    } else if link.canResume {
                        Button("Resume", systemImage: "play.circle") { Task { await model.change(link, .resume) } }
                    }
                    Spacer()
                    Button("Unlink", systemImage: "xmark.circle", role: .destructive) { unlinking = link }
                }
                .buttonStyle(.borderless)
                .disabled(model.isWorking)
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 2)
    }

    private var statusColor: Color {
        switch link.status {
        case .active: .green
        case .paused: .orange
        case .failed: .red
        case .other: .secondary
        }
    }

    private func optionBinding(_ key: BridgeOptions.Key) -> Binding<Bool> {
        Binding(get: { link.options[key] }, set: { on in Task { await model.setOption(key, to: on, on: link) } })
    }
}

/// A switch of what a side shares, with its hint.
private struct BridgeOptionToggle: View {
    let key: BridgeOptions.Key
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: key.title)
                Text(verbatim: key.hint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// The channels here that are not bridged or asked for yet.
private struct BridgeChannelPicker: View {
    @Binding var selection: String
    let channels: [BridgeChannel]

    var body: some View {
        Picker("Channel Here", selection: $selection) {
            Text("Pick a Channel").tag("")
            ForEach(channels) { channel in
                Text(verbatim: channel.label).tag(channel.id)
            }
        }
        .pickerStyle(.navigationLink)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadBridge else { return nil }
        return BridgeOverview(
            platform: .discord,
            links: [
                BridgeLink(
                    id: 1, mine: BridgeEnd(platform: .discord, server: "Sylo HQ", channel: "general"),
                    theirs: BridgeEnd(platform: .fluxer, server: "Sylo on Fluxer", channel: "general"), queued: 2),
                BridgeLink(
                    id: 2, status: .failed, problem: "The webhook in #news is gone.",
                    mine: BridgeEnd(platform: .discord, server: "Sylo HQ", channel: "news"),
                    theirs: BridgeEnd(platform: .fluxer, server: "Sylo on Fluxer", channel: "news")),
            ],
            requests: [BridgeRequest(id: 3, channel: "events", expiresAt: .now.addingTimeInterval(600), requestedBy: "Ferdi")],
            channels: [BridgeChannel(id: "10", name: "off-topic"), BridgeChannel(id: "11", name: "nsfw", ageRestricted: true)])
    }
    NavigationStack {
        BridgeView(server: "1", session: session)
    }
    .environment(session)
}
