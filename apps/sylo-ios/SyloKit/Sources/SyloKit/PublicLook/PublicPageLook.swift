import Foundation
import Observation

// The server's look on its public member pages (Sylo 5.3, `public-page-look` in `GET /api/mobile/info`;
// src/web/routes/v2PublicLook.js, Server settings -> Public pages). The pages members open without the dashboard
// (the application form and the web shop, the ban appeal, the quote page and the leaderboards) can take the
// server's accent colour and a background, and nothing else: the layout, the type, the light and dark themes and the
// "Powered by Sylo" link stay Sylo's, and the dashboard and the app are never restyled. Edit level only, the read
// too. A server that does not announce `public-page-look` has none of these routes, so the app shows nothing.

extension ServerFeature {
    /// `GET` and `POST /api/v2/guilds/:id/public-page-look`, the background upload and the invite-background check.
    public static let publicPageLook = ServerFeature(rawValue: "public-page-look")
}

/// What a server may choose for the background of its public pages.
public enum PublicPageBackground: Hashable, Sendable, RawRepresentable, Codable {
    case noBackground
    /// A picture the server uploaded.
    case upload
    /// A copy of the server's invite background (Discord and Fluxer both have one, and a server may not have set it).
    case discordSplash
    /// A value a newer Sylo adds. The app does not offer it, and reads it as it is sent.
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "none": self = .noBackground
        case "upload": self = .upload
        case "discord-splash": self = .discordSplash
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .noBackground: "none"
        case .upload: "upload"
        case .discordSplash: "discord-splash"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// A value for each of Sylo's two themes.
public struct ThemePair<Value: Decodable & Sendable & Equatable>: Decodable, Sendable, Equatable {
    public let dark: Value
    public let light: Value

    public init(dark: Value, light: Value) {
        self.dark = dark
        self.light = light
    }
}

/// `GET /api/v2/guilds/:id/public-page-look`, and the answer of every other call here.
public struct PublicPageLook: Decodable, Sendable, Equatable {
    public struct Upload: Decodable, Sendable, Equatable {
        public let bytes: Int
        /// A path on the Sylo server (`/look/<server>.<hash>.webp`); the app loads it through the session.
        public let url: String

        public init(bytes: Int, url: String) {
            self.bytes = bytes
            self.url = url
        }

        private enum CodingKeys: String, CodingKey { case bytes, url }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            bytes = (try? c.decodeIfPresent(Int.self, forKey: .bytes)) ?? 0
            url = try c.decode(String.self, forKey: .url)
        }
    }

    public struct Splash: Decodable, Sendable, Equatable {
        /// The server has an invite background on its platform.
        public let isAvailable: Bool
        /// The path of Sylo's own copy, nil until it was downloaded.
        public let copiedURL: String?

        public init(isAvailable: Bool = false, copiedURL: String? = nil) {
            self.isAvailable = isAvailable
            self.copiedURL = copiedURL
        }

        private enum CodingKeys: String, CodingKey { case available, copied }
        private struct Copy: Decodable { let url: String? }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            isAvailable = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? false
            let copy = (try? c.decodeIfPresent(Copy.self, forKey: .copied)) ?? nil
            copiedURL = copy?.url
        }
    }

    /// What the choice comes to on the pages.
    public struct Effective: Decodable, Sendable, Equatable {
        /// The accent used for fills and borders, per theme.
        public let accent: ThemePair<String>?
        /// The colour used for text, per theme.
        public let accentText: ThemePair<String>?
        /// The themes where the accent is too hard to read and Sylo's own colour is used instead.
        public let fallback: [String]
        /// The sentence to show when ``fallback`` is not empty.
        public let note: String?
        /// The path of the picture of the chosen background.
        public let backgroundURL: String?

        public init(
            accent: ThemePair<String>? = nil, accentText: ThemePair<String>? = nil, fallback: [String] = [],
            note: String? = nil, backgroundURL: String? = nil
        ) {
            self.accent = accent
            self.accentText = accentText
            self.fallback = fallback
            self.note = note
            self.backgroundURL = backgroundURL
        }

        private enum CodingKeys: String, CodingKey { case accent, accentText, fallback, note, backgroundUrl }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            accent = (try? c.decodeIfPresent(ThemePair<String>.self, forKey: .accent)) ?? nil
            accentText = (try? c.decodeIfPresent(ThemePair<String>.self, forKey: .accentText)) ?? nil
            fallback = (try? c.decodeIfPresent([String].self, forKey: .fallback)) ?? []
            note = (try? c.decodeIfPresent(String.self, forKey: .note)) ?? nil
            backgroundURL = (try? c.decodeIfPresent(String.self, forKey: .backgroundUrl)) ?? nil
        }
    }

    /// What the server holds an upload to.
    public struct Limits: Decodable, Sendable, Equatable {
        public let maxBytes: Int
        public let maxSide: Int

        public init(maxBytes: Int = 2 * 1024 * 1024, maxSide: Int = 1920) {
            self.maxBytes = maxBytes
            self.maxSide = maxSide
        }

        private enum CodingKeys: String, CodingKey { case maxBytes, maxSide }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            maxBytes = (try? c.decodeIfPresent(Int.self, forKey: .maxBytes)) ?? 2 * 1024 * 1024
            maxSide = (try? c.decodeIfPresent(Int.self, forKey: .maxSide)) ?? 1920
        }
    }

    /// The saved accent as `#rrggbb`, or empty for Sylo's own.
    public let accent: String
    public let background: PublicPageBackground
    /// The values the server takes for ``background``; the three known ones when it did not say.
    public let backgrounds: [PublicPageBackground]
    public let platform: Platform?
    public let upload: Upload?
    public let splash: Splash
    public let effective: Effective
    /// Sylo's own accent per theme, for the preview when there is no accent of the server's.
    public let syloAccent: ThemePair<String>?
    public let limits: Limits

    public init(
        accent: String = "", background: PublicPageBackground = .noBackground,
        backgrounds: [PublicPageBackground] = PublicPageLook.knownBackgrounds, platform: Platform? = nil,
        upload: Upload? = nil, splash: Splash = Splash(), effective: Effective = Effective(),
        syloAccent: ThemePair<String>? = nil, limits: Limits = Limits()
    ) {
        self.accent = accent
        self.background = background
        self.backgrounds = backgrounds
        self.platform = platform
        self.upload = upload
        self.splash = splash
        self.effective = effective
        self.syloAccent = syloAccent
        self.limits = limits
    }

    public static let knownBackgrounds: [PublicPageBackground] = [.noBackground, .upload, .discordSplash]

    private enum CodingKeys: String, CodingKey {
        case accent, background, backgrounds, platform, upload, splash, effective, sylo, limits
    }

    private struct SyloBlock: Decodable { let accent: ThemePair<String>? }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accent = (try? c.decodeIfPresent(String.self, forKey: .accent)) ?? ""
        background = (try? c.decodeIfPresent(PublicPageBackground.self, forKey: .background)) ?? .noBackground
        let listed = (try? c.decodeIfPresent([PublicPageBackground].self, forKey: .backgrounds)) ?? nil
        backgrounds = listed.flatMap { $0.isEmpty ? nil : $0 } ?? Self.knownBackgrounds
        platform = (try? c.decodeIfPresent(Platform.self, forKey: .platform)) ?? nil
        upload = (try? c.decodeIfPresent(Upload.self, forKey: .upload)) ?? nil
        splash = (try? c.decodeIfPresent(Splash.self, forKey: .splash)) ?? Splash()
        effective = (try? c.decodeIfPresent(Effective.self, forKey: .effective)) ?? Effective()
        syloAccent = ((try? c.decodeIfPresent(SyloBlock.self, forKey: .sylo)) ?? nil)?.accent
        limits = (try? c.decodeIfPresent(Limits.self, forKey: .limits)) ?? Limits()
    }

    /// The picture a background choice shows, as a path on the server; nil for none or a picture not there yet.
    public func imagePath(for background: PublicPageBackground) -> String? {
        switch background {
        case .upload: upload?.url
        case .discordSplash: splash.copiedURL
        case .noBackground, .other: nil
        }
    }

    /// The backgrounds the picker offers: what the server takes, and only the invite background when this server has
    /// one (or has chosen it already, so the choice never silently vanishes). A value the app does not know is not
    /// offered.
    public func offeredBackgrounds(chosen: PublicPageBackground) -> [PublicPageBackground] {
        backgrounds.filter { value in
            switch value {
            case .noBackground, .upload: true
            case .discordSplash: splash.isAvailable || chosen == .discordSplash
            case .other: false
            }
        }
    }
}

/// What `POST .../public-page-look` takes. Both keys, as the dashboard sends them.
public struct PublicPageLookChoice: Encodable, Sendable, Equatable {
    /// `#rrggbb`, or empty for Sylo's own colour.
    public let accent: String
    public let background: PublicPageBackground

    public init(accent: String, background: PublicPageBackground) {
        self.accent = accent
        self.background = background
    }
}

// MARK: - The accent colour

/// The accent colour rules of the server (src/lib/publicLook.js), for a preview before saving: what is a colour,
/// whether it reads on the card in each theme, and the sentence when it does not. The server decides on save; this
/// only shows the same answer sooner.
public enum AccentColour {
    /// The card the form sits on, per theme (`--bg-surface` of the public pages).
    public static let card = ThemePair(dark: "#161618", light: "#ffffff")
    /// Sylo's own accent per theme.
    public static let syloAccent = ThemePair(dark: "#38c8f0", light: "#076787")
    /// The page colour behind the card, per theme.
    public static let page = ThemePair(dark: "#0b0b0d", light: "#f5f5f7")
    /// The least contrast an accent needs against the card to be used at all (WCAG for interface elements).
    public static let minimumContrast = 3.0
    /// The least contrast of accent text (WCAG AA).
    public static let minimumTextContrast = 4.5

    /// The colour as `#rrggbb` in lower case, empty for none, or nil when it is not a colour. Accepts `#rgb`,
    /// `#rrggbb` and the same without the `#`.
    public static func normalise(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        var digits = Substring(trimmed)
        if digits.hasPrefix("#") { digits = digits.dropFirst() }
        guard digits.count == 3 || digits.count == 6, digits.allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
            return nil
        }
        var hex = digits.lowercased()
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        return "#" + hex
    }

    /// A colour picker's red, green and blue (0 to 1, clamped) as `#rrggbb`.
    public static func hex(red: Double, green: Double, blue: Double) -> String {
        func byte(_ value: Double) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
        let packed = (byte(red) << 16) | (byte(green) << 8) | byte(blue)
        let digits = String(packed, radix: 16)
        return "#" + String(repeating: "0", count: 6 - digits.count) + digits
    }

    /// The red, green and blue of a `#rrggbb` colour, 0 to 255; nil when it is not one.
    public static func components(_ hex: String) -> (red: Int, green: Int, blue: Int)? {
        guard hex.count == 7, hex.hasPrefix("#"), let value = Int(hex.dropFirst(), radix: 16) else { return nil }
        return ((value >> 16) & 255, (value >> 8) & 255, value & 255)
    }

    /// The relative luminance of a `#rrggbb` colour (WCAG 2).
    public static func luminance(_ hex: String) -> Double {
        guard let rgb = components(hex) else { return 0 }
        func channel(_ value: Int) -> Double {
            let v = Double(value) / 255
            return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(rgb.red) + 0.7152 * channel(rgb.green) + 0.0722 * channel(rgb.blue)
    }

    /// The contrast ratio of two `#rrggbb` colours, 1 to 21.
    public static func contrast(_ a: String, _ b: String) -> Double {
        let first = luminance(a)
        let second = luminance(b)
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }

    /// The ratio of an accent to the card in a theme, rounded to two places as the server does.
    public static func ratio(of accent: String, dark: Bool) -> Double {
        let value = contrast(accent, dark ? card.dark : card.light)
        return (value * 100).rounded() / 100
    }

    /// The themes where the accent is too hard to read on the card, so Sylo's own colour is used (`dark`, `light`).
    /// Empty for no accent.
    public static func fallbackThemes(_ accent: String) -> [String] {
        guard !accent.isEmpty, components(accent) != nil else { return [] }
        var themes: [String] = []
        // The raw ratio decides, as on the server; the rounded one is only for showing.
        if contrast(accent, card.dark) < minimumContrast { themes.append("dark") }
        if contrast(accent, card.light) < minimumContrast { themes.append("light") }
        return themes
    }

    /// The sentence that says Sylo's accent is used, or nil when the colour is fine everywhere.
    public static func fallbackNote(_ accent: String) -> String? {
        let themes = fallbackThemes(accent)
        guard !themes.isEmpty else { return nil }
        let place = themes.count == 2 ? "both the light and the dark theme" : "the \(themes[0]) theme"
        return "This colour is too hard to read on the card in \(place), so public pages use Sylo's own colour there. Pick a darker or lighter shade."
    }

    /// The colour of the text on a button of this accent: black or white, whichever reads better.
    public static func onAccent(_ accent: String) -> String {
        contrast(accent, "#ffffff") >= contrast(accent, "#000000") ? "#ffffff" : "#000000"
    }

    /// The accent really used for fills in a theme: the chosen one where it is readable, else Sylo's own.
    public static func effective(_ accent: String, dark: Bool) -> String {
        let fallback = dark ? syloAccent.dark : syloAccent.light
        guard !accent.isEmpty, components(accent) != nil else { return fallback }
        return contrast(accent, dark ? card.dark : card.light) >= minimumContrast ? accent : fallback
    }

    /// The colour `t` (0 to 1) of the way from `a` to `b`, both `#rrggbb`.
    public static func mix(_ a: String, _ b: String, _ t: Double) -> String {
        guard let x = components(a), let y = components(b) else { return a }
        func channel(_ from: Int, _ to: Int) -> Int {
            let value = min(255, max(0, Double(from) + (Double(to) - Double(from)) * t))
            // Like JavaScript's Math.round: halves go up.
            return Int((value + 0.5).rounded(.down))
        }
        let packed = (channel(x.red, y.red) << 16) | (channel(x.green, y.green) << 8) | channel(x.blue, y.blue)
        let digits = String(packed, radix: 16)
        return "#" + String(repeating: "0", count: 6 - digits.count) + digits
    }

    /// The accent as a text colour in a theme (links, labels): the accent itself when it reaches 4.5:1 against the
    /// card, the page and both tinted with the accent, else the same hue mixed toward white (dark theme) or black
    /// (light theme) in small steps until it does. The same steps as the server (`accentText`).
    public static func accentText(_ accent: String, dark: Bool) -> String {
        guard components(accent) != nil else { return accent }
        let card = dark ? Self.card.dark : Self.card.light
        let page = dark ? Self.page.dark : Self.page.light
        let backs = [card, page, mix(card, accent, 0.14), mix(page, accent, 0.14)]
        func reads(_ colour: String) -> Bool { backs.allSatisfy { contrast(colour, $0) >= minimumTextContrast } }
        if reads(accent) { return accent }
        let target = dark ? "#ffffff" : "#000000"
        var t = 0.02
        while t < 1 {
            let candidate = mix(accent, target, t)
            if reads(candidate) { return candidate }
            t += 0.02
        }
        return target
    }

    /// The text colour really used in a theme: ``accentText(_:dark:)`` where the accent is used, else Sylo's own.
    public static func effectiveText(_ accent: String, dark: Bool) -> String {
        let fallback = dark ? syloAccent.dark : syloAccent.light
        guard !accent.isEmpty, components(accent) != nil else { return fallback }
        let fits = contrast(accent, dark ? card.dark : card.light) >= minimumContrast
        return fits ? accentText(accent, dark: dark) : fallback
    }
}

// MARK: - Calls

extension Endpoints {
    static func publicLookPath(_ server: ServerID, _ tail: String = "") -> String {
        "/api/v2/guilds/\(server.pathComponent)/public-page-look\(tail)"
    }

    /// `GET .../public-page-look`: the choice and what it comes to. Edit level.
    public struct LoadPublicLook: APIEndpoint {
        public typealias Response = PublicPageLook
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.publicLookPath(server) }
    }

    /// `POST .../public-page-look` with `{accent, background}`; answers like the `GET`. 400 for a colour that is not
    /// `#rgb` or `#rrggbb`, for `upload` with no picture and for `discord-splash` when the server has none; 502
    /// when the invite background could not be downloaded.
    public struct SavePublicLook: APIEndpoint {
        public typealias Response = PublicPageLook
        public let server: ServerID
        public let choice: PublicPageLookChoice
        public init(server: ServerID, choice: PublicPageLookChoice) {
            self.server = server
            self.choice = choice
        }
        public var path: String { Endpoints.publicLookPath(server) }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { choice }
    }

    /// `POST .../public-page-look/image`: a multipart upload (the field `file`: PNG, JPEG or WebP, at most 2 MB, at
    /// most 16 megapixels). It does not change the choice: save `"background": "upload"` after it. Never retried.
    public struct UploadPublicLookImage: APIEndpoint {
        public typealias Response = PublicPageLook
        public let server: ServerID
        public let form: MultipartForm

        public init(server: ServerID, picture: PreparedPicture, boundary: String? = nil) {
            self.server = server
            var form = boundary.map { MultipartForm(boundary: $0) } ?? MultipartForm()
            form.addFile(name: "file", filename: picture.filename, mimeType: picture.mimeType, data: picture.data)
            self.form = form
        }

        public var path: String { Endpoints.publicLookPath(server, "/image") }
        public var method: HTTPMethod { .post }
        public var rawBody: RawBody? { form.rawBody }
    }

    /// `POST .../public-page-look/image/delete`: deletes the uploaded picture (a choice of `upload` falls back to
    /// `none` on the server).
    public struct DeletePublicLookImage: APIEndpoint {
        public typealias Response = PublicPageLook
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.publicLookPath(server, "/image/delete") }
        public var method: HTTPMethod { .post }
    }

    /// `POST .../public-page-look/splash/refresh`: checks the invite background against the platform now. Six a
    /// minute.
    public struct RefreshPublicLookSplash: APIEndpoint {
        public typealias Response = PublicPageLook
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.publicLookPath(server, "/splash/refresh") }
        public var method: HTTPMethod { .post }
    }
}

// MARK: - The model

/// The Public pages screen: what is saved, what the person has changed, and the calls that save it.
@MainActor
@Observable
public final class PublicLookModel {
    public let server: ServerID
    public private(set) var look: PublicPageLook?
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    /// A picture upload, a removal or an invite-background check is on its way.
    public private(set) var isWorking = false
    /// Why the screen could not be loaded.
    public var errorMessage: String?
    /// Why the last save, upload or removal did not go through.
    public var actionError: String?
    /// Bumped after every save, for the success feedback.
    public private(set) var saveCount = 0

    /// What was typed in the colour field, nil while it shows the saved colour.
    private var accentDraft: String?
    private var backgroundDraft: PublicPageBackground?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    // MARK: Draft

    /// The text of the colour field.
    public var accentText: String {
        get { accentDraft ?? look?.accent ?? "" }
        set { accentDraft = newValue }
    }

    /// The chosen background.
    public var background: PublicPageBackground {
        get { backgroundDraft ?? look?.background ?? .noBackground }
        set { backgroundDraft = newValue }
    }

    /// The colour as `#rrggbb` (empty for Sylo's own), or nil while the field does not hold a colour.
    public var accent: String? { AccentColour.normalise(accentText) }

    public var accentIsValid: Bool { accent != nil }

    /// The sentence about the colour: the server's while the colour is the saved one, else the same rule worked
    /// out here. Nil when the colour is fine in both themes.
    public var accentNote: String? {
        guard let accent else { return nil }
        if accent == look?.accent { return look?.effective.note }
        return AccentColour.fallbackNote(accent)
    }

    /// The picture the chosen background shows, as a path on the server.
    public var previewImagePath: String? { look?.imagePath(for: background) }

    /// Whether the invite background was chosen but Sylo has no copy yet (it is downloaded when saved).
    public var waitsForSplash: Bool { background == .discordSplash && look?.splash.copiedURL == nil }

    public var hasChanges: Bool {
        guard let look, let accent else { return false }
        return accent != look.accent || background != look.background
    }

    public var canSave: Bool { hasChanges && !isSaving && !isWorking }

    /// The backgrounds to offer.
    public var offeredBackgrounds: [PublicPageBackground] {
        look?.offeredBackgrounds(chosen: background) ?? PublicPageLook.knownBackgrounds
    }

    public func discardChanges() {
        accentDraft = nil
        backgroundDraft = nil
    }

    // MARK: Calls

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        let generation = session.generation
        do {
            let loaded = try await session.send(Endpoints.LoadPublicLook(server: server))
            guard session.generation == generation else { return }
            look = loaded
            errorMessage = nil
        } catch {
            guard session.generation == generation else { return }
            if let text = describe(error) { errorMessage = text }
        }
    }

    /// Saves the colour and the background. Nothing is sent while the colour is not one.
    @discardableResult
    public func save() async -> Bool {
        guard canSave, let accent else { return false }
        isSaving = true
        defer { isSaving = false }
        actionError = nil
        let generation = session.generation
        do {
            let saved = try await session.send(
                Endpoints.SavePublicLook(server: server, choice: PublicPageLookChoice(accent: accent, background: background)))
            guard session.generation == generation else { return false }
            look = saved
            discardChanges()
            saveCount += 1
            return true
        } catch {
            guard session.generation == generation else { return false }
            actionError = describe(error)
            return false
        }
    }

    /// Uploads the picture as the server's own background, and chooses it (still to be saved).
    @discardableResult
    public func upload(_ picture: PreparedPicture) async -> Bool {
        guard !isWorking, !isSaving else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        let generation = session.generation
        do {
            let answer = try await session.upload(Endpoints.UploadPublicLookImage(server: server, picture: picture))
            guard session.generation == generation else { return false }
            look = answer
            backgroundDraft = .upload
            return true
        } catch {
            guard session.generation == generation else { return false }
            actionError = describe(error)
            return false
        }
    }

    /// Deletes the uploaded picture. A choice of it that was not saved yet goes back to none.
    @discardableResult
    public func removePicture() async -> Bool {
        guard !isWorking, !isSaving else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        let generation = session.generation
        do {
            let answer = try await session.send(Endpoints.DeletePublicLookImage(server: server))
            guard session.generation == generation else { return false }
            look = answer
            // A picture that is gone cannot stay chosen; whatever else was changed stays.
            if background == .upload { backgroundDraft = nil }
            return true
        } catch {
            guard session.generation == generation else { return false }
            actionError = describe(error)
            return false
        }
    }

    /// Checks the invite background against the platform now.
    @discardableResult
    public func refreshSplash() async -> Bool {
        guard !isWorking, !isSaving else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        let generation = session.generation
        do {
            let answer = try await session.send(Endpoints.RefreshPublicLookSplash(server: server))
            guard session.generation == generation else { return false }
            look = answer
            return true
        } catch {
            guard session.generation == generation else { return false }
            actionError = describe(error)
            return false
        }
    }

    /// The sentence for a failure; nil for a cancelled call or a sign-out (which the session handles).
    private func describe(_ error: any Error) -> String? {
        let error = NetworkError(error)
        switch error {
        case .cancelled, .unauthorized: return nil
        case .tooLarge: return "The picture is larger than the server takes (\(look?.limits.maxBytes ?? 2 * 1024 * 1024) bytes). Choose a smaller one."
        case .forbidden: return "Only people with Edit access can change how the public pages look."
        default: return error.userMessage
        }
    }
}
