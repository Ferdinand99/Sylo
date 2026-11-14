import SwiftUI
import SyloKit
import UniformTypeIdentifiers

// Sylo 5.2 (P6): "Start from a template" and Discord message JSON import and export, in the editors of a message with
// embeds (the message builder and the Welcome channel). Nothing here talks to the server: a template or an import only
// fills the form, which is saved the usual way. The tools show when the server announces `message-templates`, so a
// Sylo 5.1 keeps the editors as they were.

/// The Templates and Message JSON section of a message editor.
struct MessageToolsSection: View {
    /// The channel picked for the message ("" for none), to say when its embeds cannot be sent there.
    let channelID: String
    @Binding var content: String
    @Binding var embeds: [EmbedItem]
    /// The link buttons of the message; nil for a page that has none (the Welcome channel).
    var links: Binding<[ComposedLinkButton]>?
    /// Whether the page fills `{server}` and the like itself (the Welcome channel does, the builder does not).
    let tokens: Bool
    let maxEmbeds: Int
    let contentLimit: Int

    @Environment(AppSession.self) private var session
    @Environment(\.dashboardAccess) private var access
    @Environment(\.serverPlatform) private var platform
    @Environment(ServerHealthModel.self) private var health: ServerHealthModel?
    @State private var pendingTemplate: MessageTemplate?
    @State private var isChoosingFile = false
    @State private var pendingImport: MessageJSON.Imported?
    @State private var importErrors: [String] = []
    @State private var isShowingErrors = false
    @State private var exported: DownloadedFile?
    @State private var exportError: String?

    var body: some View {
        Group {
            if session.has(.messageTemplates), access.canEdit {
                Section {
                    Menu {
                        ForEach(MessageTemplate.all) { template in
                            Button {
                                choose(template)
                            } label: {
                                Text(verbatim: template.name)
                                Text(verbatim: template.blurb)
                            }
                        }
                    } label: {
                        Label("Start from a Template", systemImage: "rectangle.on.rectangle.angled")
                    }
                    Button("Import Message JSON\u{2026}", systemImage: "square.and.arrow.down") { isChoosingFile = true }
                    Button("Export Message JSON", systemImage: "square.and.arrow.up") { export() }
                        .disabled(content.isEmpty && embeds.isEmpty && (links?.wrappedValue.isEmpty ?? true))
                    if let exportError {
                        StatusMessage(exportError, kind: .error)
                    }
                } header: {
                    Text("Templates and JSON")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("A template fills this message with a starting point you then change. Message JSON is the shape Discord and tools such as Discohook use: text, embeds and link buttons. Nothing is saved until you save.")
                        // What the target cannot show: the embed part (or the buttons) of a template or of imported
                        // JSON is dropped when the message is posted, and the person is told before it happens.
                        ForEach(limitNotes, id: \.self) { note in
                            Label(note, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                        }
                    }
                }
            }
        }
        .confirmationDialog(
            pendingTemplate.map { "Start from \($0.name)?" } ?? "Start from a Template?",
            isPresented: Binding(get: { pendingTemplate != nil }, set: { if !$0 { pendingTemplate = nil } }),
            titleVisibility: .visible, presenting: pendingTemplate
        ) { template in
            Button("Replace the Message", role: .destructive) { apply(template) }
        } message: { _ in
            Text("This replaces the message text and the embeds. Your link buttons stay.")
        }
        .fileImporter(isPresented: $isChoosingFile, allowedContentTypes: [.json]) { result in
            read(result)
        }
        .confirmationDialog(
            "Import This Message?",
            isPresented: Binding(get: { pendingImport != nil }, set: { if !$0 { pendingImport = nil } }),
            titleVisibility: .visible, presenting: pendingImport
        ) { imported in
            Button("Replace the Message", role: .destructive) { apply(imported) }
        } message: { imported in
            Text(verbatim: importSummary(imported))
        }
        .alert("This JSON Can't Be Imported", isPresented: $isShowingErrors) {
            Button("OK") {}
        } message: {
            Text(verbatim: importErrors.joined(separator: "\n"))
        }
        .fileQuickLook($exported) {}
    }

    // MARK: What the target cannot show

    /// Why part of this message would not arrive: a channel where Sylo cannot send embeds (it lacks Embed Links),
    /// and Fluxer, which has no buttons yet. Empty when everything can be posted.
    private var limitNotes: [String] {
        var notes: [String] = []
        if !channelID.isEmpty, health?.targets.channelWarning(channelID, embed: true) != nil,
           health?.targets.channelWarning(channelID) == nil {
            notes.append("Sylo can't send embeds in the picked channel (it is missing Embed Links), so the embed part of this message, from a template or from JSON, is dropped when it is posted. Plain text still goes out.")
        }
        if platform == .fluxer, links != nil {
            notes.append("Fluxer has no buttons yet, so link buttons from a template or from JSON are not posted there.")
        }
        return notes
    }

    // MARK: Templates

    private func choose(_ template: MessageTemplate) {
        let isEmpty = content.isEmpty && embeds.allSatisfy { $0.draft.isEmpty(EmbedItem.options) && !$0.isOpaque }
        if isEmpty { apply(template) } else { pendingTemplate = template }
    }

    private func apply(_ template: MessageTemplate) {
        let message = template.message(tokens: tokens)
        content = message.content
        embeds = Array(message.embeds.prefix(maxEmbeds))
        pendingTemplate = nil
    }

    // MARK: JSON

    private func read(_ result: Result<URL, any Error>) {
        guard case .success(let url) = result else {
            importErrors = ["The file could not be opened."]
            isShowingErrors = true
            return
        }
        let granted = url.startAccessingSecurityScopedResource()
        defer { if granted { url.stopAccessingSecurityScopedResource() } }
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 1_000_000 {
            importErrors = ["This file is too large to be a message."]
            isShowingErrors = true
            return
        }
        guard let data = try? Data(contentsOf: url) else {
            importErrors = ["The file could not be read."]
            isShowingErrors = true
            return
        }
        Task {
            let embedLimits = await session.moduleLimits().embed
            let limits = MessageJSON.Limits(embed: embedLimits, content: contentLimit, embeds: maxEmbeds)
            switch MessageJSON.parse(data, limits: limits, allowsLinks: links != nil) {
            case .imported(let imported): pendingImport = imported
            case .failed(let errors):
                importErrors = errors
                isShowingErrors = true
            }
        }
    }

    private func importSummary(_ imported: MessageJSON.Imported) -> String {
        var parts = ["The message text and the embeds are replaced by what is in the file."]
        if links != nil { parts.append("The link buttons are replaced too.") }
        if !imported.warnings.isEmpty { parts.append("Not carried over: " + imported.warnings.joined(separator: " ")) }
        return parts.joined(separator: " ")
    }

    private func apply(_ imported: MessageJSON.Imported) {
        content = imported.content
        embeds = imported.embeds
        links?.wrappedValue = imported.links
        pendingImport = nil
    }

    private func export() {
        exportError = nil
        do {
            let data = try MessageJSON.exportData(content: content, embeds: embeds, links: links?.wrappedValue ?? [])
            exported = try DownloadedFile.write(data, filename: "sylo-message.json", mimeType: "application/json")
        } catch {
            exportError = "The message could not be exported."
        }
    }
}

/// "Start from a Template" for a text field (Welcome, the alerts): the templates that have a text for this field,
/// using only the placeholders the field has. Shown once the server is known to have templates (Sylo 5.2, P6) and
/// the person may edit.
struct TextTemplateMenu: View {
    let field: TemplateTextField
    @Binding var text: String

    @Environment(AppSession.self) private var session
    @Environment(\.dashboardAccess) private var access
    @State private var pending: String?

    var body: some View {
        if access.canEdit, session.has(.messageTemplates) {
            Menu {
                ForEach(MessageTemplate.templates(for: field)) { template in
                    Button {
                        choose(template.texts[field] ?? "")
                    } label: {
                        Text(verbatim: template.name)
                        Text(verbatim: template.blurb)
                    }
                }
            } label: {
                Label("Start from a Template", systemImage: "rectangle.on.rectangle.angled")
            }
            .confirmationDialog(
                "Replace the Text?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                titleVisibility: .visible, presenting: pending
            ) { template in
                Button("Replace", role: .destructive) {
                    text = template
                    pending = nil
                }
            } message: { _ in
                Text("The text you wrote is replaced by the template. Only the template's text is used here: this field holds plain text, so the embed part of a template is dropped. Nothing is saved until you save.")
            }
            Text("A plain text field: a template's embed is left out.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func choose(_ template: String) {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { text = template } else { pending = template }
    }
}
