import SwiftUI
import SyloKit

/// Quote board: the public quote page, who may save a quote and the staff roles, and the quotes
/// themselves: search them by text or author, or delete one. Mirrors web-v2/src/moduleForms/QuoteBoard.jsx.
struct QuoteBoardSettingsView: View {
    @State private var model: ModuleSettingsModel<QuoteBoardPage>
    @State private var note: ModulePlatformNoteModel
    @State private var list: QuoteListModel
    @State private var search = ""
    @State private var deleting: QuoteSummary?

    @Environment(AppSession.self) private var session

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: QuoteBoardPage.moduleID, session: session))
        _list = State(initialValue: QuoteListModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Quote Board", model: model) { $settings, page in
            ModuleIntro("Members save memorable messages as quotes and bring them back later. Only the text, the author's name and the date are kept. Files are counted, never copied.")
            PlatformNoteSection(model: note)

            Section {
                Toggle("Public quote page", isOn: $settings.publicPage)
                if model.saved?.publicPage == true, let url = publicURL(page) {
                    Link(destination: url) {
                        Label("Open the public page", systemImage: "safari")
                    }
                }
            } footer: {
                Text("Anyone with the link can read the latest quotes, without signing in: the text, the author's display name and the date. No IDs and no jump links. Quotes from channels that @everyone cannot read are never shown there.")
            }

            Section {
                Picker("Who may save quotes", selection: $settings.saveMode) {
                    Text("Everyone").tag(QuoteSaveMode.everyone)
                    Text("Staff and the roles below").tag(QuoteSaveMode.roles)
                }
                if settings.saveMode == .roles {
                    MultiPicker(title: "Roles that may save", selection: $settings.saveRoles,
                                options: page.roles, prefix: "@")
                }
            }

            Section {
                MultiPicker(title: "Staff roles", selection: $settings.staffRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("May remove any quote. Manage Messages, Manage Server and Administrator always may.")
            }

            quotesSection(page)
        }
        .task { await note.load() }
        // The page comes with the newest quotes; take them over whenever the page is loaded.
        .onChange(of: model.page?.quotes, initial: true) {
            if let page = model.page { Task { await list.adopt(page) } }
        }
        // Wait for the typing to pause, and skip a search that is already on screen.
        .task(id: search) {
            if QuoteSearch.normalised(search) == list.search { return }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await list.load(search: search)
        }
        .confirmationDialog(
            "Delete This Quote?", isPresented: isConfirmingDelete, titleVisibility: .visible, presenting: deleting
        ) { quote in
            Button("Delete", role: .destructive) { Task { await list.delete(quote) } }
            Button("Cancel", role: .cancel) {}
        } message: { quote in
            Text("Quote #\(quote.number) is deleted and its number will not be used again. The original message stays.")
        }
        .alert("Couldn't Delete Quote", isPresented: isShowingActionError, presenting: list.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: list.deleteCount)
    }

    /// The search field and the quotes.
    @ViewBuilder
    private func quotesSection(_ page: QuoteBoardPage) -> some View {
        let quotes = list.hasLoaded ? list.quotes : page.quotes
        let total = list.hasLoaded ? list.total : page.total
        Section {
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                TextField("Search text or author", text: $search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                if !search.isEmpty {
                    Button("Clear Search", systemImage: "xmark.circle.fill") { search = "" }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                        .buttonStyle(.borderless)
                }
            }
        }

        Section {
            if quotes.isEmpty {
                Text(list.isLoading ? "Loading…" : "Nothing here yet.").foregroundStyle(.secondary)
            }
            ForEach(quotes) { quote in
                QuoteLine(quote: quote)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = quote }
                    }
                    .contextMenu {
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = quote }
                    }
            }
        } header: {
            Text(list.search.isEmpty ? "Quotes (\(total))" : "Quotes (\(quotes.count) of \(total))")
        } footer: {
            if let message = list.errorMessage {
                StatusMessage(message, kind: .error)
            }
        }
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { list.actionError != nil }, set: { if !$0 { list.actionError = nil } })
    }

    private func publicURL(_ page: QuoteBoardPage) -> URL? {
        guard let path = page.publicPath, let base = session.server else { return nil }
        return base.url(for: path)
    }
}

private struct QuoteLine: View {
    let quote: QuoteSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "#\(quote.number) · " + (quote.author.isEmpty ? String(localized: "Unknown") : quote.author))
                .font(.headline)
            if !quote.text.isEmpty {
                Text(verbatim: quote.text)
                    .lineLimit(4)
            }
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let url = quote.url {
                Link("Open message", destination: url)
                    .font(.footnote)
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// "Thu 24 Sep · #general · 📎 2 · not on the public page".
    private var details: String {
        var parts: [String] = []
        if let date = quote.messageDate { parts.append(DateText.day(date)) }
        if let channel = quote.channel { parts.append("#\(channel)") }
        if quote.attachments > 0 { parts.append("📎 \(quote.attachments)") }
        if !quote.publicSource { parts.append("not on the public page") }
        return parts.joined(separator: " · ")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        guard endpoint is Endpoints.LoadModuleSettings<QuoteBoardPage> else { return nil }
        return QuoteBoardPage(
            settings: QuoteBoardSettings(publicPage: true, saveMode: .roles, saveRoles: ["r1"]),
            roles: [RoleOption(id: "r1", name: "Moderators")],
            publicPath: "/quotes/1",
            total: 1,
            quotes: [QuoteSummary(number: 7, author: "Alex", text: "I meant to do that.", channel: "general",
                                  messageAt: 1_794_000_000_000)])
    }
    NavigationStack {
        QuoteBoardSettingsView(server: "1", session: session)
    }
    .environment(session)
}
