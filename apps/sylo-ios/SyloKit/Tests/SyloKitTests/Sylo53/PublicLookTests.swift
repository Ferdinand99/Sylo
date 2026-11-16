import Foundation
import Testing
@testable import SyloKit

// The server's look on its public pages (Sylo 5.3, `public-page-look`): what the server answers, what the app posts,
// and the accent colour rules it mirrors for the preview. A server without the feature has none of these routes.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// The JSON a request body encodes to.
private func bodyJSON(_ body: (any Encodable & Sendable)?) throws -> [String: Any] {
    struct Box: Encodable {
        let value: any Encodable
        func encode(to encoder: any Encoder) throws { try value.encode(to: encoder) }
    }
    let value = try #require(body)
    let data = try JSONEncoder().encode(Box(value: value))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// `GET .../public-page-look` of a Discord server that chose its own picture and a colour that reads in one theme.
let publicLookJSON = #"""
{
  "platform": "discord", "accent": "#5865f2", "background": "upload",
  "backgrounds": ["none", "upload", "discord-splash"],
  "upload": {"bytes": 123456, "url": "/look/900000000000000201.0123456789abcdef.webp", "updatedAt": 1763640000000},
  "splash": {"available": true, "copied": {"url": "/look/900000000000000201.fedcba9876543210.webp", "checkedAt": 1763640000000, "updatedAt": 1763640000000}},
  "limits": {"maxBytes": 2097152, "types": ["PNG", "JPEG", "WebP"], "maxSide": 1920},
  "sylo": {"accent": {"dark": "#38c8f0", "light": "#076787"}},
  "effective": {
    "accent": {"dark": "#5865f2", "light": "#5865f2"},
    "accentText": {"dark": "#737ef4", "light": "#5865f2"},
    "contrast": {"dark": {"ratio": 3.92, "ok": true}, "light": {"ratio": 4.61, "ok": true}},
    "fallback": [], "note": null,
    "backgroundUrl": "/look/900000000000000201.0123456789abcdef.webp",
    "css": "/look/900000000000000201.aaaaaaaaaaaaaaaa.css"
  }
}
"""#

@Suite("Public pages: decoding")
struct PublicLookDecodingTests {
    @Test("A full answer reads: choice, picture, invite background, limits and what it comes to")
    func full() throws {
        let look = try decode(PublicPageLook.self, publicLookJSON)
        #expect(look.accent == "#5865f2")
        #expect(look.background == .upload)
        #expect(look.platform == .discord)
        #expect(look.backgrounds == [.noBackground, .upload, .discordSplash])
        #expect(look.upload?.bytes == 123_456)
        #expect(look.upload?.url == "/look/900000000000000201.0123456789abcdef.webp")
        #expect(look.splash.isAvailable)
        #expect(look.splash.copiedURL == "/look/900000000000000201.fedcba9876543210.webp")
        #expect(look.limits.maxBytes == 2_097_152)
        #expect(look.limits.maxSide == 1920)
        #expect(look.effective.accent?.dark == "#5865f2")
        #expect(look.effective.accentText?.dark == "#737ef4")
        #expect(look.effective.fallback.isEmpty)
        #expect(look.effective.note == nil)
        #expect(look.effective.backgroundURL == "/look/900000000000000201.0123456789abcdef.webp")
        #expect(look.syloAccent?.light == "#076787")
        #expect(look.imagePath(for: .upload) == look.upload?.url)
        #expect(look.imagePath(for: .discordSplash) == look.splash.copiedURL)
        #expect(look.imagePath(for: .noBackground) == nil)
    }

    @Test("An empty answer, null parts and wrong types still read, with the defaults")
    func lenient() throws {
        let empty = try decode(PublicPageLook.self, "{}")
        #expect(empty.accent == "")
        #expect(empty.background == .noBackground)
        #expect(empty.backgrounds == PublicPageLook.knownBackgrounds)
        #expect(empty.upload == nil)
        #expect(!empty.splash.isAvailable)
        #expect(empty.effective.note == nil)
        #expect(empty.limits.maxBytes == 2 * 1024 * 1024)

        let odd = try decode(
            PublicPageLook.self,
            #"{"accent":7,"background":"hologram","backgrounds":[],"upload":{"bytes":"x"},"splash":null,"effective":[1],"limits":"big","platform":null,"unknownKey":true}"#)
        #expect(odd.accent == "")
        #expect(odd.background == .other("hologram"))
        #expect(odd.backgrounds == PublicPageLook.knownBackgrounds)
        #expect(odd.upload == nil)
        #expect(odd.effective.fallback.isEmpty)
        // A value the app does not know is never offered, but it is not lost either.
        #expect(odd.offeredBackgrounds(chosen: odd.background).allSatisfy { $0 != .other("hologram") })
        #expect(odd.imagePath(for: .other("hologram")) == nil)
    }

    @Test("The server's note and fallback themes read when the colour is too faint")
    func fallback() throws {
        let look = try decode(
            PublicPageLook.self,
            ##"{"accent":"#ffff00","background":"none","effective":{"accent":{"dark":"#ffff00","light":"#076787"},"fallback":["light"],"note":"This colour is too hard to read on the card in the light theme, so public pages use Sylo's own colour there. Pick a darker or lighter shade."}}"##)
        #expect(look.effective.fallback == ["light"])
        #expect(look.effective.note?.hasPrefix("This colour is too hard to read") == true)
        #expect(look.effective.accent?.light == "#076787")
    }

    @Test("Fluxer without an invite background is offered an upload or none only")
    func offered() throws {
        let fluxer = try decode(
            PublicPageLook.self,
            #"{"platform":"fluxer","accent":"","background":"none","backgrounds":["none","upload","discord-splash"],"splash":{"available":false,"copied":null}}"#)
        #expect(fluxer.offeredBackgrounds(chosen: .noBackground) == [.noBackground, .upload])
        // A server that already chose the invite background keeps seeing it.
        #expect(fluxer.offeredBackgrounds(chosen: .discordSplash) == [.noBackground, .upload, .discordSplash])
        let discord = try decode(PublicPageLook.self, publicLookJSON)
        #expect(discord.offeredBackgrounds(chosen: .upload) == [.noBackground, .upload, .discordSplash])
        // The server lists what it takes; the app offers no more.
        let narrow = try decode(PublicPageLook.self, #"{"backgrounds":["none","upload"],"splash":{"available":true}}"#)
        #expect(narrow.offeredBackgrounds(chosen: .noBackground) == [.noBackground, .upload])
    }

    @Test("The values the app posts for a background")
    func backgroundValues() {
        #expect(PublicPageBackground.noBackground.rawValue == "none")
        #expect(PublicPageBackground.upload.rawValue == "upload")
        #expect(PublicPageBackground.discordSplash.rawValue == "discord-splash")
        #expect(PublicPageBackground(rawValue: "discord-splash") == .discordSplash)
        #expect(ServerFeature.publicPageLook.rawValue == "public-page-look")
    }
}

@Suite("Public pages: the accent colour")
struct AccentColourTests {
    @Test("A colour is #rgb or #rrggbb, with or without the #; empty is none; anything else is not a colour")
    func normalise() {
        #expect(AccentColour.normalise("#5865F2") == "#5865f2")
        #expect(AccentColour.normalise("5865f2") == "#5865f2")
        #expect(AccentColour.normalise("  #abc ") == "#aabbcc")
        #expect(AccentColour.normalise("fff") == "#ffffff")
        #expect(AccentColour.normalise("") == "")
        #expect(AccentColour.normalise("   ") == "")
        for bad in ["#12", "#12345", "#1234567", "#gggggg", "red", "#5865f2ff", "rgb(1,2,3)", "#58 65f2"] {
            #expect(AccentColour.normalise(bad) == nil, "\(bad)")
        }
    }

    @Test("A picker's colour becomes #rrggbb")
    func hex() {
        #expect(AccentColour.hex(red: 0.345, green: 0.396, blue: 0.949) == "#5865f2")
        #expect(AccentColour.hex(red: 0, green: 0, blue: 0) == "#000000")
        #expect(AccentColour.hex(red: 1, green: 1, blue: 1) == "#ffffff")
        #expect(AccentColour.hex(red: 0, green: 0, blue: 0.02) == "#000005")
        #expect(AccentColour.hex(red: -1, green: 2, blue: 0.5) == "#00ff80")
        #expect(AccentColour.components("#5865f2")?.red == 0x58)
        #expect(AccentColour.components("5865f2") == nil)
    }

    @Test("Contrast against the card is the server's rule: 3:1 or Sylo's own colour is used")
    func contrast() {
        // Mid-tones such as Discord's blurple read in both themes.
        #expect(AccentColour.fallbackThemes("#5865f2").isEmpty)
        #expect(AccentColour.fallbackNote("#5865f2") == nil)
        #expect(abs(AccentColour.ratio(of: "#5865f2", dark: true) - 3.92) < 0.011)
        #expect(abs(AccentColour.ratio(of: "#5865f2", dark: false) - 4.61) < 0.011)
        // Yellow vanishes on a white card, black on a dark one.
        #expect(AccentColour.fallbackThemes("#ffff00") == ["light"])
        #expect(AccentColour.fallbackThemes("#000000") == ["dark"])
        #expect(AccentColour.fallbackThemes("#ffffff") == ["light"])
        #expect(AccentColour.fallbackThemes("") == [])
        #expect(AccentColour.fallbackNote("#ffff00")?.contains("the light theme") == true)
        #expect(AccentColour.fallbackNote("#ffff00")?.hasSuffix("Pick a darker or lighter shade.") == true)
    }

    @Test("The colour really used is the chosen one where it reads, else Sylo's own")
    func effective() {
        #expect(AccentColour.effective("#5865f2", dark: true) == "#5865f2")
        #expect(AccentColour.effective("#ffff00", dark: false) == AccentColour.syloAccent.light)
        #expect(AccentColour.effective("#ffff00", dark: true) == "#ffff00")
        #expect(AccentColour.effective("", dark: true) == AccentColour.syloAccent.dark)
        #expect(AccentColour.effective("not a colour", dark: false) == AccentColour.syloAccent.light)
    }

    @Test("The text on a button is black or white, whichever reads better")
    func onAccent() {
        #expect(AccentColour.onAccent("#5865f2") == "#ffffff")
        #expect(AccentColour.onAccent("#ffff00") == "#000000")
        #expect(AccentColour.onAccent("#000000") == "#ffffff")
    }
}

@Suite("Public pages: the calls")
struct PublicLookCallTests {
    @Test("The routes are the server's, one per call")
    func routes() throws {
        #expect(Endpoints.LoadPublicLook(server: "1").path == "/api/v2/guilds/1/public-page-look")
        #expect(Endpoints.LoadPublicLook(server: "1").method == .get)
        let save = Endpoints.SavePublicLook(server: "fluxer:7", choice: PublicPageLookChoice(accent: "#5865f2", background: .upload))
        #expect(save.path == "/api/v2/guilds/fluxer%3A7/public-page-look")
        #expect(save.method == .post)
        #expect(Endpoints.DeletePublicLookImage(server: "1").path == "/api/v2/guilds/1/public-page-look/image/delete")
        #expect(Endpoints.DeletePublicLookImage(server: "1").method == .post)
        #expect(Endpoints.RefreshPublicLookSplash(server: "1").path == "/api/v2/guilds/1/public-page-look/splash/refresh")
        #expect(Endpoints.RefreshPublicLookSplash(server: "1").method == .post)
        let picture = PreparedPicture(data: Data([1, 2, 3]), mimeType: "image/jpeg", filename: "picture.jpg", width: 1, height: 1)
        let upload = Endpoints.UploadPublicLookImage(server: "1", picture: picture, boundary: "B")
        #expect(upload.path == "/api/v2/guilds/1/public-page-look/image")
        #expect(upload.method == .post)
        #expect(upload.body == nil)
        let raw = try #require(upload.rawBody)
        #expect(raw.contentType == "multipart/form-data; boundary=B")
        let text = String(decoding: raw.data, as: UTF8.self)
        #expect(text.contains(#"name="file"; filename="picture.jpg""#))
        #expect(text.contains("Content-Type: image/jpeg"))
    }

    @Test("A save posts both keys: the colour and the background")
    func saveBody() throws {
        let save = Endpoints.SavePublicLook(server: "1", choice: PublicPageLookChoice(accent: "#5865f2", background: .discordSplash))
        let json = try bodyJSON(save.body)
        #expect(Set(json.keys) == ["accent", "background"])
        #expect(json["accent"] as? String == "#5865f2")
        #expect(json["background"] as? String == "discord-splash")
        let none = try bodyJSON(Endpoints.SavePublicLook(server: "1", choice: PublicPageLookChoice(accent: "", background: .noBackground)).body)
        #expect(none["accent"] as? String == "")
        #expect(none["background"] as? String == "none")
    }
}

@MainActor
@Suite("Public pages: the model")
struct PublicLookModelTests {
    nonisolated static func look(
        accent: String = "#5865f2", background: PublicPageBackground = .upload, hasUpload: Bool = true,
        note: String? = nil
    ) -> PublicPageLook {
        PublicPageLook(
            accent: accent, background: background, platform: .discord,
            upload: hasUpload ? PublicPageLook.Upload(bytes: 10, url: "/look/1.aaaaaaaaaaaaaaaa.webp") : nil,
            splash: PublicPageLook.Splash(isAvailable: true, copiedURL: nil),
            effective: PublicPageLook.Effective(note: note))
    }

    private func makeModel(_ clients: StubClients) -> PublicLookModel {
        PublicLookModel(server: "1", session: makeSignedInSession(clients: clients))
    }

    private static let picture = PreparedPicture(
        data: Data([1, 2, 3]), mimeType: "image/jpeg", filename: "picture.jpg", width: 10, height: 10)

    @Test("Loading shows the saved choice, and an unchanged page has nothing to save")
    func loads() async {
        let model = makeModel(StubClients { _ in Self.look() })
        await model.load()
        #expect(model.accentText == "#5865f2")
        #expect(model.background == .upload)
        #expect(!model.hasChanges)
        #expect(!model.canSave)
        #expect(model.previewImagePath == "/look/1.aaaaaaaaaaaaaaaa.webp")
    }

    @Test("A typed colour is a change; one that is not a colour cannot be saved")
    func typing() async {
        let model = makeModel(StubClients { _ in Self.look() })
        await model.load()
        model.accentText = "#ff0000"
        #expect(model.hasChanges)
        #expect(model.canSave)
        model.accentText = "#ff00"
        #expect(!model.accentIsValid)
        #expect(!model.hasChanges)
        #expect(!model.canSave)
        model.accentText = "F00"
        #expect(model.accent == "#ff0000")
        model.discardChanges()
        #expect(model.accentText == "#5865f2")
        #expect(!model.hasChanges)
    }

    @Test("The note is the server's for the saved colour and worked out here for a typed one")
    func note() async {
        let model = makeModel(StubClients { _ in Self.look(accent: "#ffff00", note: "The server's sentence.") })
        await model.load()
        #expect(model.accentNote == "The server's sentence.")
        model.accentText = "#ffffff"
        #expect(model.accentNote?.contains("the light theme") == true)
        model.accentText = "#5865f2"
        #expect(model.accentNote == nil)
        model.accentText = "nope"
        #expect(model.accentNote == nil)
    }

    @Test("Saving posts the colour and the background, then shows what the server answers")
    func saves() async {
        let clients = StubClients { endpoint in
            if let save = endpoint as? Endpoints.SavePublicLook {
                return Self.look(accent: save.choice.accent, background: save.choice.background)
            }
            return Self.look()
        }
        let model = makeModel(clients)
        await model.load()
        model.accentText = "00F"
        model.background = .noBackground
        #expect(await model.save())
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.SavePublicLook }
        #expect(sent.count == 1)
        #expect(sent.first?.choice.accent == "#0000ff")
        #expect(sent.first?.choice.background == .noBackground)
        #expect(model.look?.accent == "#0000ff")
        #expect(!model.hasChanges)
        #expect(model.saveCount == 1)
    }

    @Test("Nothing is sent when nothing changed or the colour is not one")
    func noSave() async {
        let clients = StubClients { _ in Self.look() }
        let model = makeModel(clients)
        await model.load()
        #expect(await model.save() == false)
        model.accentText = "xyz"
        #expect(await model.save() == false)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SavePublicLook })
    }

    @Test("A save the server refuses shows its words and keeps the changes")
    func refusedSave() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SavePublicLook {
                throw NetworkError.badRequest(message: "This server has no invite background. Set one in the server settings, or choose another.")
            }
            return Self.look()
        }
        let model = makeModel(clients)
        await model.load()
        model.background = .discordSplash
        #expect(await model.save() == false)
        #expect(model.actionError == "This server has no invite background. Set one in the server settings, or choose another.")
        #expect(model.hasChanges)
    }

    @Test("An uploaded picture is chosen at once and saved with the rest")
    func uploads() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.UploadPublicLookImage {
                return Self.look(accent: "#5865f2", background: .noBackground, hasUpload: true)
            }
            return Self.look(background: .noBackground, hasUpload: false)
        }
        let model = makeModel(clients)
        await model.load()
        #expect(model.look?.upload == nil)
        #expect(await model.upload(Self.picture))
        #expect(model.look?.upload != nil)
        #expect(model.background == .upload)
        #expect(model.hasChanges)
        #expect(clients.calls.contains { $0.endpoint is Endpoints.UploadPublicLookImage })
        // The upload alone does not save the choice.
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SavePublicLook })
    }

    @Test("A picture the server refuses shows why, and the choice stays")
    func refusedUpload() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.UploadPublicLookImage { throw NetworkError.tooLarge }
            return Self.look(background: .noBackground, hasUpload: false)
        }
        let model = makeModel(clients)
        await model.load()
        #expect(await model.upload(Self.picture) == false)
        #expect(model.actionError?.contains("larger than the server takes") == true)
        #expect(model.background == .noBackground)
        #expect(!model.hasChanges)
    }

    @Test("Removing the picture takes a not yet saved choice of it back")
    func removes() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeletePublicLookImage { return Self.look(background: .noBackground, hasUpload: false) }
            return Self.look(background: .noBackground, hasUpload: true)
        }
        let model = makeModel(clients)
        await model.load()
        model.background = .upload
        #expect(model.hasChanges)
        #expect(await model.removePicture())
        #expect(model.look?.upload == nil)
        #expect(model.background == .noBackground)
        #expect(!model.hasChanges)
    }

    @Test("The invite background is checked on request, and a missing copy is said to wait for the save")
    func splash() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RefreshPublicLookSplash {
                return PublicPageLook(
                    background: .discordSplash, splash: PublicPageLook.Splash(isAvailable: true, copiedURL: "/look/1.bbbbbbbbbbbbbbbb.webp"))
            }
            return PublicPageLook(background: .noBackground, splash: PublicPageLook.Splash(isAvailable: true, copiedURL: nil))
        }
        let model = makeModel(clients)
        await model.load()
        model.background = .discordSplash
        #expect(model.waitsForSplash)
        #expect(await model.refreshSplash())
        #expect(!model.waitsForSplash)
        #expect(model.previewImagePath == "/look/1.bbbbbbbbbbbbbbbb.webp")
    }

    @Test("A person below Edit gets the server's refusal in words")
    func forbidden() async {
        let model = makeModel(StubClients { _ in throw NetworkError.forbidden })
        await model.load()
        #expect(model.look == nil)
        #expect(model.errorMessage?.contains("Edit access") == true)
    }
}
