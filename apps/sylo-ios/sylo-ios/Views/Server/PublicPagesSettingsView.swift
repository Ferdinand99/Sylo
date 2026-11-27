import PhotosUI
import SwiftUI
import SyloKit
import UIKit

/// Server settings -> Public pages (Sylo 5.3): the server's own accent colour and background on the pages its
/// members open without the dashboard (application forms and the web shop, ban appeals, the quote page and the
/// leaderboards). Only these two things change; the layout, the type, the light and dark themes and the "Powered by
/// Sylo" link stay Sylo's, and the dashboard and this app are never restyled. Edit level only. Mirrors
/// web-v2/src/components/PublicPagesSettings.jsx.
struct PublicPagesSettingsView: View {
    @State private var model: PublicLookModel

    @Environment(\.dashboardAccess) private var access
    @Environment(\.serverPlatform) private var platform
    @Environment(\.colorScheme) private var colorScheme
    @State private var isConfirmingDiscard = false
    @State private var isAskingToRemove = false
    @State private var selection: PhotosPickerItem?
    @State private var isPreparing = false
    @State private var prepareError: String?

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: PublicLookModel(server: server, session: session))
    }

    var body: some View {
        Group {
            if let look = model.look {
                form(look)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Public Pages", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Public Pages")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(model.hasChanges)
        .tracksUnsavedChanges(model.hasChanges)
        .toolbar {
            if model.hasChanges {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { isConfirmingDiscard = true }
                        .disabled(model.isSaving)
                }
            }
            if model.look != nil {
                ToolbarItem(placement: .confirmationAction) {
                    if model.isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await model.save() } }
                            .toolbarSaveStyle()
                            .disabled(!model.canSave || !access.canEdit)
                    }
                }
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { model.discardChanges() }
        }
        .sensoryFeedback(.success, trigger: model.saveCount)
        .task { if model.look == nil { await model.load() } }
        .lockedBelow()
    }

    // MARK: - The form

    private func form(_ look: PublicPageLook) -> some View {
        Form {
            if let message = model.actionError {
                Section { StatusMessage(message, kind: .error) }
            }
            accentSection
            backgroundSection(look)
            previewSection(look)
        }
        .disabled(model.isSaving)
        .refreshable { await model.load() }
    }

    private var accentSection: some View {
        Section {
            ColorPicker("Pick the accent colour", selection: pickedColour, supportsOpacity: false)
            LabeledContent("Accent colour") {
                TextField("Accent colour", text: accentText, prompt: Text(verbatim: AccentColour.syloAccent.dark))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
                    .submitLabel(.done)
            }
            if !model.accentText.isEmpty {
                Button("Use Sylo's Colour", systemImage: "arrow.counterclockwise") {
                    model.accentText = ""
                }
            }
        } header: {
            Text("Accent colour")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if !model.accentIsValid {
                    Text("Use a colour like #5865f2.")
                        .foregroundStyle(.red)
                } else {
                    Text("Used for buttons, links and highlights. Leave it empty for Sylo's own colour.")
                }
                if let note = model.accentNote {
                    Text(verbatim: note)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    private func backgroundSection(_ look: PublicPageLook) -> some View {
        Section {
            Picker("Background", selection: backgroundBinding) {
                ForEach(model.offeredBackgrounds, id: \.self) { value in
                    Text(verbatim: title(of: value)).tag(value)
                }
            }
            .pickerStyle(.menu)
            PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
                Label(look.upload == nil ? "Upload a Picture" : "Replace Picture", systemImage: "photo.on.rectangle")
            }
            .disabled(isPreparing || model.isWorking)
            // On one row only: a modifier on the section would be applied to every row of it.
            .onChange(of: selection) { _, item in
                guard let item else { return }
                Task { await prepareAndUpload(item, maxSide: look.limits.maxSide, maxBytes: look.limits.maxBytes) }
            }
            if isPreparing || model.isWorking {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(isPreparing ? "Preparing the picture\u{2026}" : "Working\u{2026}").foregroundStyle(.secondary)
                }
            }
            if let prepareError {
                StatusMessage(prepareError, kind: .error)
            }
            if look.upload != nil {
                Button("Remove Picture", role: .destructive) { isAskingToRemove = true }
                    .disabled(model.isWorking)
                    .confirmationDialog("Remove the picture?", isPresented: $isAskingToRemove, titleVisibility: .visible) {
                        Button("Remove Picture", role: .destructive) { Task { await model.removePicture() } }
                    } message: {
                        Text("A background that uses it goes back to none.")
                    }
            }
            if model.background == .discordSplash, look.splash.isAvailable {
                Button {
                    Task { await model.refreshSplash() }
                } label: {
                    Label("Check the Invite Background Now", systemImage: "arrow.clockwise")
                }
                .disabled(model.isWorking)
            }
        } header: {
            Text("Background")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text("PNG, JPEG or WebP, at most \(Self.megabytes(look.limits.maxBytes)) MB. The app shrinks a photo to fit. Sylo stores a re-encoded copy without metadata, at most \(look.limits.maxSide) pixels wide, and serves it itself.")
                if !look.splash.isAvailable {
                    Text(verbatim: splashHint(look))
                } else if model.background == .discordSplash {
                    Text(verbatim: splashHint(look))
                }
                if model.waitsForSplash {
                    Text("The invite background is downloaded when you save.")
                }
            }
        }
    }

    private func previewSection(_ look: PublicPageLook) -> some View {
        let dark = colorScheme == .dark
        let accent = model.accent ?? look.accent
        let fill = AccentColour.effective(accent, dark: dark)
        return Section {
            PublicLookPreview(
                accent: Color(hex: fill) ?? .accentColor,
                accentText: Color(hex: AccentColour.effectiveText(accent, dark: dark)) ?? .accentColor,
                onAccent: Color(hex: AccentColour.onAccent(fill)) ?? .white,
                imagePath: model.previewImagePath, isDark: dark)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
        } header: {
            Text("Preview: the application form")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text("Shown in the \(dark ? "dark" : "light") theme. \(ratios(accent))")
                Text("Members see this on the application forms, the web shop, ban appeals, the quote page and the leaderboards. This app and the dashboard keep Sylo's own look.")
            }
        }
    }

    // MARK: - Helpers

    private var accentText: Binding<String> {
        Binding(get: { model.accentText }, set: { model.accentText = $0 })
    }

    private var backgroundBinding: Binding<PublicPageBackground> {
        Binding(get: { model.background }, set: { model.background = $0 })
    }

    /// The system colour picker, as `#rrggbb` in the text field.
    private var pickedColour: Binding<Color> {
        Binding(
            get: {
                let hex = model.accent.flatMap { $0.isEmpty ? nil : $0 }
                    ?? (colorScheme == .dark ? AccentColour.syloAccent.dark : AccentColour.syloAccent.light)
                return Color(hex: hex) ?? .accentColor
            },
            set: { newValue in
                let resolved = newValue.resolve(in: EnvironmentValues())
                model.accentText = AccentColour.hex(
                    red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue))
            })
    }

    private func title(of background: PublicPageBackground) -> String {
        switch background {
        case .noBackground: String(localized: "None")
        case .upload: String(localized: "My own picture")
        case .discordSplash:
            platform == .fluxer ? String(localized: "Invite background from Fluxer") : String(localized: "Invite background from Discord")
        case .other(let raw): raw
        }
    }

    private func splashHint(_ look: PublicPageLook) -> String {
        let name = (look.platform ?? platform) == .fluxer ? "Fluxer" : "Discord"
        if !look.splash.isAvailable {
            return String(localized: "This server has no invite background on \(name). Set one there to use it here.")
        }
        return String(localized: "Sylo keeps its own copy of the server's \(name) invite background and checks it once a day, so visitors never load it from \(name).")
    }

    /// "dark 4.6:1, light 2.1:1 (too low)", as the dashboard shows the contrast.
    private func ratios(_ accent: String) -> String {
        guard !accent.isEmpty else { return "" }
        let themes = AccentColour.fallbackThemes(accent)
        func part(_ name: String, dark: Bool) -> String {
            let ratio = AccentColour.ratio(of: accent, dark: dark)
            let low = themes.contains(name) ? " (too low)" : ""
            return "\(name) \(ratio.formatted(.number.precision(.fractionLength(0...2)))):1\(low)"
        }
        return part("dark", dark: true) + ", " + part("light", dark: false)
    }

    private static func megabytes(_ bytes: Int) -> Int { max(1, bytes / (1024 * 1024)) }

    /// Reads the photo, shrinks it to what the server takes, and uploads it as the server's own background.
    private func prepareAndUpload(_ item: PhotosPickerItem, maxSide: Int, maxBytes: Int) async {
        isPreparing = true
        prepareError = nil
        defer {
            isPreparing = false
            selection = nil
        }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw CollectiblePictureError.unreadable
            }
            // Decoding and shrinking a 12 MP photo is real work: not on the main actor.
            let target = max(1_000_000, maxBytes - 100_000)
            let picture = try await Task.detached(priority: .userInitiated) {
                try CollectiblePicture.prepare(data, maxSide: maxSide, targetBytes: target)
            }.value
            isPreparing = false
            await model.upload(picture)
        } catch is CancellationError {
            // The person left the screen.
        } catch let error as CollectiblePictureError {
            prepareError = error.message
        } catch {
            prepareError = CollectiblePictureError.unreadable.message
        }
    }
}

/// A small picture of an application form page with the chosen accent colour and background: the page, a dim
/// overlay over the picture, the semi-opaque card, one button in the accent colour, and the "Powered by Sylo" link.
private struct PublicLookPreview: View {
    let accent: Color
    /// The colour of links and labels: the accent lightened or darkened until it reads, as on the pages.
    let accentText: Color
    let onAccent: Color
    let imagePath: String?
    let isDark: Bool

    var body: some View {
        (isDark ? Color(white: 0.04) : Color(white: 0.96))
            .frame(height: 250)
            .overlay {
                if let imagePath {
                    Color.clear
                        .overlay { AuthenticatedImage(path: imagePath, contentMode: .fill) }
                        .clipped()
                        .overlay((isDark ? Color.black : Color.white).opacity(isDark ? 0.55 : 0.4))
                }
            }
            .overlay {
                VStack(spacing: 8) {
                    card
                    Text("Powered by Sylo")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Preview of an application form page with this accent colour and background")
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("YOUR SERVER")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(accentText)
            Text("Staff application")
                .font(.headline)
            (Text("Tell us a little about you. ") + Text("Read the rules first").foregroundStyle(accentText) + Text("."))
                .font(.footnote)
            Text("Why do you want to join?")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            Text("Submit application")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(onAccent)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(accent, in: RoundedRectangle(cornerRadius: 6))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((isDark ? Color(white: 0.09) : Color.white).opacity(0.92), in: RoundedRectangle(cornerRadius: 10))
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        PublicPagesSettingsView(server: "1", session: session)
    }
    .environment(session)
}
