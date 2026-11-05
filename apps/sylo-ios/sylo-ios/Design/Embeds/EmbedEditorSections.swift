import SwiftUI
import SyloKit

/// The sections that edit one embed inside a `Form`: title, text, colour, author, pictures, footer
/// and fields. The same fields as the dashboard's embed editor (web-v2/src/components/EmbedCard.jsx),
/// as form rows; the live preview is a separate view (``EmbedEditorScreen``).
struct EmbedEditorSections: View {
    @Binding var embed: EmbedSpec
    /// Offers "Show the time in the footer" (reminders and custom commands have it, embed messages do not).
    var showsTimestamp = false
    /// Values to offer as insert chips under the title and text, such as `{user}`.
    var placeholders: [String] = []

    var body: some View {
        Section {
            TextField("Title", text: $embed.title)
                .onChange(of: embed.title) {
                    if embed.title.count > EmbedSpec.maxTitleLength {
                        embed.title = String(embed.title.prefix(EmbedSpec.maxTitleLength))
                    }
                }
            TextArea(
                title: "Description", text: $embed.description, limit: EmbedSpec.maxDescriptionLength, lines: 3...10)
            if !placeholders.isEmpty {
                PlaceholderChips(tokens: placeholders, text: $embed.description)
            }
            EmbedColorRow(embed: $embed)
        } header: {
            Text("Embed")
        } footer: {
            Text("The description supports **bold**, *italic* and [links](https://sylobot.com).")
        }

        Section("Author") {
            TextField("Name", text: $embed.authorName)
                .onChange(of: embed.authorName) {
                    if embed.authorName.count > EmbedSpec.maxAuthorNameLength {
                        embed.authorName = String(embed.authorName.prefix(EmbedSpec.maxAuthorNameLength))
                    }
                }
            WebLinkField(title: "Icon link", text: $embed.authorIcon)
        }

        Section {
            WebLinkField(title: "Image link", text: $embed.image)
            WebLinkField(title: "Thumbnail link", text: $embed.thumbnail)
        } header: {
            Text("Pictures")
        } footer: {
            Text("Links must start with http:// or https://.")
        }

        Section("Footer") {
            TextField("Text", text: $embed.footerText)
                .onChange(of: embed.footerText) {
                    if embed.footerText.count > EmbedSpec.maxFooterLength {
                        embed.footerText = String(embed.footerText.prefix(EmbedSpec.maxFooterLength))
                    }
                }
            WebLinkField(title: "Icon link", text: $embed.footerIcon)
            if showsTimestamp {
                Toggle("Show the time in the footer", isOn: $embed.timestamp)
            }
        }

        ForEach($embed.fields) { $field in
            Section("Field") {
                TextField("Name", text: $field.name)
                    .onChange(of: field.name) {
                        if field.name.count > EmbedSpec.Field.maxNameLength {
                            field.name = String(field.name.prefix(EmbedSpec.Field.maxNameLength))
                        }
                    }
                TextArea(title: "Value", text: $field.value, limit: EmbedSpec.Field.maxValueLength, lines: 2...6)
                Toggle("Show next to other fields", isOn: $field.inline)
                Button("Remove Field", role: .destructive) {
                    embed.fields.removeAll { $0.id == field.id }
                }
            }
        }
        Section {
            if embed.fields.count < EmbedSpec.maxFields {
                Button("Add Field", systemImage: "plus") {
                    embed.fields.append(EmbedSpec.Field())
                }
            }
        } footer: {
            Text("A field needs both a name and a value, or it is left out. Up to \(EmbedSpec.maxFields) fields.")
        }
    }
}

/// The embed's colour: the dashboard's preset swatches and a full colour picker.
struct EmbedColorRow: View {
    @Binding var embed: EmbedSpec

    @ScaledMetric(relativeTo: .body) private var swatch: CGFloat = 30

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.s) {
            ColorPicker("Colour", selection: colour, supportsOpacity: false)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: SyloSpacing.s) {
                    ForEach(EmbedSpec.colorPresets, id: \.self) { preset in
                        Button {
                            embed.color = preset
                        } label: {
                            Circle()
                                .fill(Self.swiftUIColor(preset))
                                .frame(width: swatch, height: swatch)
                                .overlay {
                                    Circle().strokeBorder(Color.syloLineStrong, lineWidth: 1)
                                }
                                .overlay {
                                    if embed.color.lowercased() == preset {
                                        Image(systemName: "checkmark")
                                            .font(.footnote.weight(.bold))
                                            .foregroundStyle(.white)
                                            .shadow(radius: 1)
                                    }
                                }
                                // Room to hit, without a bigger swatch.
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("Colour \(preset)"))
                        .accessibilityAddTraits(embed.color.lowercased() == preset ? .isSelected : [])
                    }
                }
            }
        }
    }

    private var colour: Binding<Color> {
        Binding(
            get: { Self.swiftUIColor(embed.color.isEmpty ? EmbedSpec.defaultColor : embed.color) },
            set: { newValue in
                let resolved = newValue.resolve(in: EnvironmentValues())
                embed.setRGB(red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue))
            })
    }

    static func swiftUIColor(_ hex: String) -> Color {
        let rgb = EmbedSpec(color: hex).rgb
        return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
    }
}

/// A text field for a link to a picture or a page.
struct WebLinkField: View {
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

/// "Insert" chips under a template field: tap a placeholder such as `{user}` to add it to the text.
/// The text is added at the end (iOS has no caret position to give a plain text field).
struct PlaceholderChips: View {
    let tokens: [String]
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.xs) {
            Text("Insert")
                .font(.caption)
                .foregroundStyle(Color.syloMuted)
            FlowLayout(spacing: SyloSpacing.s) {
                ForEach(tokens, id: \.self) { token in
                    Button {
                        text += token
                    } label: {
                        Text(verbatim: token)
                            .font(.footnote.monospaced())
                            .padding(.horizontal, SyloSpacing.m)
                            .padding(.vertical, SyloSpacing.s)
                            .frame(minHeight: 36)
                            .background(Color.syloCyan.opacity(0.14), in: Capsule())
                            .overlay { Capsule().strokeBorder(Color.syloCyan.opacity(0.35), lineWidth: 1) }
                            .foregroundStyle(Color.syloBrand)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Insert \(token)"))
                }
            }
        }
    }
}

/// An embed's own screen: the live preview of it on top, then every field to edit.
struct EmbedEditorScreen: View {
    let title: LocalizedStringKey
    @Binding var embed: EmbedSpec
    var showsTimestamp = false
    var placeholders: [String] = []
    var isFluxer = false

    var body: some View {
        Form {
            Group {
                Section {
                    MessagePreview(embeds: [embed], isFluxer: isFluxer)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                } header: {
                    Text("Preview")
                }
                EmbedEditorSections(embed: $embed, showsTimestamp: showsTimestamp, placeholders: placeholders)
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
