import SwiftUI
import SyloKit

/// Quote board: the public quote page, who may save a quote and the staff roles, with the latest
/// quotes listed read only. Searching and deleting quotes has its own screen. Mirrors
/// web-v2/src/moduleForms/QuoteBoard.jsx.
struct QuoteBoardSettingsView: View {
    @State private var model: ModuleSettingsModel<QuoteBoardPage>
    @State private var note: ModulePlatformNoteModel
    private let server: ServerID

    @Environment(AppSession.self) private var session

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: QuoteBoardPage.moduleID, session: session))
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

            Section {
                NavigationLink {
                    QuotesManageView(server: server, session: session)
                } label: {
                    LabeledContent {
                        Text("\(page.total)")
                    } label: {
                        Label("Quotes", systemImage: "quote.bubble")
                    }
                }
            } footer: {
                Text("Search the saved quotes and delete one.")
            }
        }
        .task { await note.load() }
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
