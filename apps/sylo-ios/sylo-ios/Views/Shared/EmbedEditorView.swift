import SwiftUI
import SyloKit

/// A variable the person can drop into an embed (`{user}`, `{server}`): a short label on a button
/// and the token it inserts.
struct EmbedVariable: Hashable, Identifiable {
    let token: String
    /// Shown on the button, as is.
    let label: String

    var id: String { token }
}

/// One embed's editor, a full form screen: colour, title, description, author, images, footer and
/// fields, each part shown only when ``EmbedOptions`` asks for it, with the server's limits as
/// character counters. It edits an ``EmbedDraft``, and ``EmbedDraft/spec(_:)`` turns that into what
/// the server stores. Push it from a `NavigationLink`, like the other module screens; changes go
/// straight into the binding and are saved by the screen before it.
///
/// ```swift
/// NavigationLink("Embed") {
///     EmbedEditorView(draft: $draft, options: EmbedOptions(content: true, timestamp: true))
/// }
/// ```
///
/// A live preview at the top shows how the embed looks in Discord (``EmbedPreviewCard``). The limits come from
/// ``AppSession/moduleLimits()``, with `limits` applied on top where a module's embed is narrower.
/// Counters and cut-offs count UTF-16 units, as the server does.
struct EmbedEditorView: View {
    @Binding var draft: EmbedDraft
    var options = EmbedOptions()
    /// Tokens the person can insert at the end of the field they last edited. Empty: no insert row.
    var variables: [EmbedVariable] = []
    /// A module's own limits for the paths where its embed is narrower than the standard one (a
    /// poll's title), applied on top of the server's. nil: the server's alone.
    var limits: ModuleFieldLimits?

    @Environment(AppSession.self) private var session
    @State private var loadedLimits = EmbedLimits.standard
    @FocusState private var focus: EmbedFocus?
    @State private var lastFocus: EmbedFocus?

    private var activeLimits: EmbedLimits {
        limits.map { loadedLimits.overriding($0) } ?? loadedLimits
    }

    var body: some View {
        Form {
            Section("Preview") {
                VStack(alignment: .leading, spacing: 8) {
                    BotMessageHeader()
                    if options.content, !draft.content.isEmpty {
                        discordText(draft.content)
                            .font(.footnote)
                    }
                    EmbedPreviewCard(draft: draft, options: options)
                }
                .padding(.vertical, 4)
            }

            if options.content {
                Section {
                    EmbedTextField(
                        title: "Message text", text: $draft.content, limit: activeLimits.content, lines: 2...8,
                        target: .content, focus: $focus)
                } footer: {
                    Text("Posted above the embed.")
                }
            }

            Section {
                EmbedTextField(
                    title: "Title", text: $draft.title, limit: activeLimits.title, lines: nil,
                    target: .title, focus: $focus)
                if options.description {
                    EmbedTextField(
                        title: "Description", text: $draft.description, limit: activeLimits.description,
                        lines: 3...10, target: .description, focus: $focus)
                }
                ColorPicker("Colour", selection: colour, supportsOpacity: false)
                if draft.color != "" {
                    Button("Use Default Colour") { draft.color = "" }
                }
            }

            if options.author {
                Section("Author") {
                    EmbedTextField(
                        title: "Name", text: $draft.authorName, limit: activeLimits.authorName, lines: nil,
                        target: .authorName, focus: $focus)
                    EmbedURLField(title: "Icon URL", text: $draft.authorIcon)
                }
            }

            Section {
                EmbedURLField(title: "Image URL", text: $draft.image)
                if options.thumbnail {
                    EmbedURLField(title: "Thumbnail URL", text: $draft.thumbnail)
                }
            } header: {
                Text("Images")
            } footer: {
                Text("Links must start with http:// or https://.")
            }

            Section("Footer") {
                EmbedTextField(
                    title: "Text", text: $draft.footerText, limit: activeLimits.footerText, lines: nil,
                    target: .footer, focus: $focus)
                if options.footerIcon {
                    EmbedURLField(title: "Icon URL", text: $draft.footerIcon)
                }
                if options.timestamp {
                    Toggle("Show the current time", isOn: $draft.timestamp)
                }
            }

            if options.fields {
                fieldSections
            }

            if !variables.isEmpty {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(variables) { variable in
                                Button(variable.label) { insert(variable.token) }
                                    .buttonStyle(.bordered)
                            }
                        }
                    }
                } header: {
                    Text("Insert a Variable")
                } footer: {
                    Text("Adds it at the end of the field you edited last.")
                }
            }
        }
        .navigationTitle("Embed")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: focus) { _, new in
            if let new { lastFocus = new }
        }
        .task {
            loadedLimits = await session.moduleLimits().embed
        }
    }

    // MARK: - Fields

    @ViewBuilder
    private var fieldSections: some View {
        ForEach($draft.fields) { $field in
            Section("Field") {
                EmbedTextField(
                    title: "Name", text: $field.name, limit: activeLimits.fieldName, lines: nil,
                    target: .fieldName(field.id), focus: $focus)
                EmbedTextField(
                    title: "Value", text: $field.value, limit: activeLimits.fieldValue, lines: 2...6,
                    target: .fieldValue(field.id), focus: $focus)
                Toggle("Inline", isOn: $field.inline)
                Button("Remove Field", role: .destructive) {
                    draft.fields.removeAll { $0.id == field.id }
                }
            }
        }
        Section {
            if draft.fields.count < activeLimits.maxFields {
                Button("Add Field", systemImage: "plus") {
                    draft.fields.append(EmbedDraft.Field())
                }
            }
        } footer: {
            Text("A field with neither a name nor a value isn't kept.")
        }
    }

    // MARK: - Colour

    private var colour: Binding<Color> {
        Binding(
            get: {
                let rgb = draft.rgb(options)
                return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
            },
            set: { newValue in
                let resolved = newValue.resolve(in: EnvironmentValues())
                draft.setRGB(red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue))
            })
    }

    // MARK: - Variables

    private func insert(_ token: String) {
        let target = lastFocus ?? (options.content ? .content : .title)
        switch target {
        case .content: draft.content = appending(token, to: draft.content, limit: activeLimits.content)
        case .authorName: draft.authorName = appending(token, to: draft.authorName, limit: activeLimits.authorName)
        case .title: draft.title = appending(token, to: draft.title, limit: activeLimits.title)
        case .description: draft.description = appending(token, to: draft.description, limit: activeLimits.description)
        case .footer: draft.footerText = appending(token, to: draft.footerText, limit: activeLimits.footerText)
        case .fieldName(let id):
            if let index = draft.fields.firstIndex(where: { $0.id == id }) {
                draft.fields[index].name = appending(token, to: draft.fields[index].name, limit: activeLimits.fieldName)
            }
        case .fieldValue(let id):
            if let index = draft.fields.firstIndex(where: { $0.id == id }) {
                draft.fields[index].value = appending(
                    token, to: draft.fields[index].value, limit: activeLimits.fieldValue)
            }
        }
    }

    /// The text with the token after it (and a space between), or the text unchanged when the token
    /// does not fit.
    private func appending(_ token: String, to text: String, limit: Int) -> String {
        let joined = (text.isEmpty ? token : text + " " + token).trimmingCharacters(in: .whitespaces)
        return joined.utf16.count <= limit ? joined : text
    }
}

/// The text boxes of the editor, for remembering which one was edited last.
private enum EmbedFocus: Hashable {
    case content, authorName, title, description, footer
    case fieldName(UUID)
    case fieldValue(UUID)
}

/// A text box with a counter that appears near the limit and a hard stop at it.
private struct EmbedTextField: View {
    let title: LocalizedStringKey
    @Binding var text: String
    let limit: Int
    /// nil: one line.
    let lines: ClosedRange<Int>?
    let target: EmbedFocus
    var focus: FocusState<EmbedFocus?>.Binding

    /// The longest start of `text` that fits `limit` UTF-16 units, cut between characters.
    static func truncated(_ text: String, toUTF16 limit: Int) -> String {
        var units = 0
        var result = ""
        for character in text {
            units += character.utf16.count
            if units > limit { break }
            result.append(character)
        }
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let lines {
                TextField(title, text: $text, axis: .vertical)
                    .lineLimit(lines)
                    .focused(focus, equals: target)
            } else {
                TextField(title, text: $text)
                    .focused(focus, equals: target)
            }
            // Counted in UTF-16 units, the way the server counts and cuts.
            if text.utf16.count > limit * 3 / 4 {
                Text("\(text.utf16.count) of \(limit) characters")
                    .font(.caption)
                    .foregroundStyle(text.utf16.count > limit ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            }
        }
        .onChange(of: text) {
            if text.utf16.count > limit { text = Self.truncated(text, toUTF16: limit) }
        }
    }
}

/// A text field for a link.
private struct EmbedURLField: View {
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
    @Previewable @State var draft = EmbedDraft(
        color: "#57f287", title: "Welcome", description: "Read the rules, then say hi.",
        footerText: "Be nice", fields: [EmbedDraft.Field(name: "Rule 1", value: "No spam")])
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        EmbedEditorView(
            draft: $draft, options: EmbedOptions(content: true, timestamp: true),
            variables: [EmbedVariable(token: "{user}", label: "Member"), EmbedVariable(token: "{server}", label: "Server")])
    }
    .environment(session)
}
