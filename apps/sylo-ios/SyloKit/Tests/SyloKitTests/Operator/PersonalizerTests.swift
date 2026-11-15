import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private struct AnyBody: Encodable {
    let value: any Encodable
    func encode(to encoder: any Encoder) throws { try value.encode(to: encoder) }
}

/// The JSON object an endpoint sends, nil when it sends no body.
private func sentJSON(_ endpoint: some APIEndpoint) throws -> [String: Any]? {
    guard let body = endpoint.body else { return nil }
    return try JSONSerialization.jsonObject(with: JSONEncoder().encode(AnyBody(value: body))) as? [String: Any]
}

@Suite("Personalizer decoding")
struct PersonalizerDecodingTests {
    @Test("The bot reads with its pictures; a bot that is not connected is nil")
    func bot() throws {
        let answer = try decode(
            BotIdentityAnswer.self,
            #"{"bot":{"tag":"Sylo#9455","username":"Sylo","id":"42","avatar":"https://cdn.example/a.png","banner":null}}"#)
        #expect(answer.bot?.tag == "Sylo#9455")
        #expect(answer.bot?.username == "Sylo")
        #expect(answer.bot?.avatarURL == URL(string: "https://cdn.example/a.png"))
        #expect(answer.bot?.bannerURL == nil)
        #expect(try decode(BotIdentityAnswer.self, #"{"bot":null}"#).bot == nil)
        #expect(try decode(BotIdentityAnswer.self, "{}").bot == nil)
    }

    @Test("The presence and its choices read; missing lists fall back to the server's own")
    func presence() throws {
        let options = try decode(
            PresenceOptions.self,
            #"{"presence":{"status":"dnd","type":"Watching","text":"{servers} servers"},"types":["Playing","Watching"],"statuses":["online","dnd"],"announcementSeverities":["info","critical"]}"#)
        #expect(options.presence == PresenceSettings(status: "dnd", type: "Watching", text: "{servers} servers"))
        #expect(options.types == ["Playing", "Watching"])
        #expect(options.statuses == ["online", "dnd"])
        #expect(options.announcementSeverities == ["info", "critical"])

        let bare = try decode(PresenceOptions.self, #"{"presence":{"text":"hi"},"types":[]}"#)
        #expect(bare.presence == PresenceSettings(status: "online", type: "Listening", text: "hi"))
        #expect(bare.types == PresenceSettings.defaultTypes)
        #expect(bare.statuses == PresenceSettings.defaultStatuses)
        #expect(bare.announcementSeverities == PresenceSettings.defaultSeverities)
    }

    @Test("The identity answer says what changed and what failed")
    func identityResult() throws {
        let result = try decode(IdentityResult.self, #"{"done":["username"],"failed":["avatar (must be an https image URL)"]}"#)
        #expect(result.done == ["username"])
        #expect(result.failed == ["avatar (must be an https image URL)"])
        #expect(try decode(IdentityResult.self, "{}") == IdentityResult())
    }
}

@Suite("Personalizer wire")
struct PersonalizerWireTests {
    @Test("Reading goes to the personalizer routes")
    func reads() {
        #expect(Endpoints.Personalizer().path == "/api/v2/personalizer")
        #expect(Endpoints.Personalizer().method == .get)
        #expect(Endpoints.PersonalizerPresence().path == "/api/v2/personalizer/presence")
    }

    @Test("The identity is posted with the dashboard's four keys, trimmed")
    func identity() throws {
        let endpoint = Endpoints.SavePersonalizerIdentity(change: IdentityDraft(
            username: "  Sylo  ", avatarURL: " https://cdn.example/a.png ", bannerURL: "", resetAvatar: false))
        #expect(endpoint.path == "/api/v2/personalizer/identity")
        #expect(endpoint.method == .post)
        let json = try #require(try sentJSON(endpoint))
        #expect(Set(json.keys) == ["username", "avatarUrl", "bannerUrl", "resetAvatar"])
        #expect(json["username"] as? String == "Sylo")
        #expect(json["avatarUrl"] as? String == "https://cdn.example/a.png")
        #expect(json["bannerUrl"] as? String == "")
        #expect(json["resetAvatar"] as? Bool == false)
    }

    @Test("The presence is posted as status, type and text")
    func presence() throws {
        let endpoint = Endpoints.SavePersonalizerPresence(presence: PresenceSettings(status: "idle", type: "Playing", text: "chess"))
        #expect(endpoint.path == "/api/v2/personalizer/presence")
        #expect(endpoint.method == .post)
        let json = try #require(try sentJSON(endpoint))
        #expect(Set(json.keys) == ["status", "type", "text"])
        #expect(json["status"] as? String == "idle")
        #expect(json["type"] as? String == "Playing")
        #expect(json["text"] as? String == "chess")
    }

    @Test("The announcement is posted as title, body and severity; clearing sends no body")
    func announcement() throws {
        let publish = Endpoints.SavePersonalizerAnnouncement(
            draft: AnnouncementDraft(title: "Maintenance", body: "Tonight", severity: "warning"))
        #expect(publish.path == "/api/v2/personalizer/announcement")
        #expect(publish.method == .post)
        let json = try #require(try sentJSON(publish))
        #expect(Set(json.keys) == ["title", "body", "severity"])
        #expect(json["severity"] as? String == "warning")

        let clear = Endpoints.ClearPersonalizerAnnouncement()
        #expect(clear.path == "/api/v2/personalizer/announcement/clear")
        #expect(clear.method == .post)
        #expect(try sentJSON(clear) == nil)
    }
}

@MainActor
@Suite("Personalizer model")
struct PersonalizerModelTests {
    nonisolated static let bot = BotIdentity(tag: "Sylo#9455", username: "Sylo", id: "42")
    nonisolated static let live = Announcement(
        title: "Incident", body: "Looking into it", severity: .critical, createdAt: Date(timeIntervalSince1970: 5))

    nonisolated static func clients(
        announcement: Announcement? = nil, identity: IdentityResult = IdentityResult(done: ["username"]),
        savedAnnouncement: Announcement? = live
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.Personalizer: return BotIdentityAnswer(bot: bot)
            case is Endpoints.PersonalizerPresence:
                return PresenceOptions(presence: PresenceSettings(status: "online", type: "Listening", text: "/stats"))
            case is Endpoints.CurrentAnnouncement: return AnnouncementAnswer(announcement: announcement)
            case is Endpoints.SavePersonalizerIdentity: return identity
            case let save as Endpoints.SavePersonalizerPresence: return PresenceAnswer(presence: save.presence)
            case is Endpoints.SavePersonalizerAnnouncement: return AnnouncementAnswer(announcement: savedAnnouncement)
            case is Endpoints.ClearPersonalizerAnnouncement: return AnnouncementAnswer(announcement: nil)
            default: throw NetworkError.notFound
            }
        }
    }

    @Test("Loading fills the three forms from the server, and nothing is unsaved")
    func loads() async {
        let model = PersonalizerModel(session: makeSignedInSession(clients: Self.clients(announcement: Self.live)))
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.bot?.tag == "Sylo#9455")
        #expect(model.identity.username == "Sylo")
        #expect(model.presence.text == "/stats")
        #expect(model.announcement == AnnouncementDraft(title: "Incident", body: "Looking into it", severity: "critical"))
        #expect(model.liveAnnouncement?.title == "Incident")
        #expect(!model.isIdentityDirty && !model.isPresenceDirty && !model.isAnnouncementDirty)
    }

    @Test("Editing a form makes it unsaved, and saving it makes it saved again")
    func dirtyTracking() async {
        let model = PersonalizerModel(session: makeSignedInSession(clients: Self.clients()))
        await model.load()
        model.presence.text = "hello"
        #expect(model.isPresenceDirty)
        #expect(!model.isIdentityDirty)
        await model.savePresence()
        #expect(!model.isPresenceDirty)
        #expect(model.notice == "Presence updated.")
    }

    @Test("Saving the identity reports what changed, and sends the form as typed")
    func identitySaved() async {
        let clients = Self.clients()
        let model = PersonalizerModel(session: makeSignedInSession(clients: clients))
        await model.load()
        model.identity.username = "Sylo Two"
        await model.saveIdentity()
        #expect(model.notice == "Updated username.")
        #expect(model.actionError == nil)
        #expect(!model.isIdentityDirty)
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.SavePersonalizerIdentity }.first
        #expect(sent?.change.username == "Sylo Two")
    }

    @Test("A refused avatar is shown, and the form stays unsaved")
    func identityFailed() async {
        let result = IdentityResult(done: ["username"], failed: ["avatar (must be an https image URL)"])
        let model = PersonalizerModel(session: makeSignedInSession(clients: Self.clients(identity: result)))
        await model.load()
        model.identity.avatarURL = "http://nope"
        await model.saveIdentity()
        #expect(model.notice == "Updated username.")
        #expect(model.actionError == "Failed: avatar (must be an https image URL).")
        #expect(model.isIdentityDirty)
    }

    @Test("Nothing new says so")
    func nothingToChange() async {
        let model = PersonalizerModel(session: makeSignedInSession(clients: Self.clients(identity: IdentityResult())))
        await model.load()
        await model.saveIdentity()
        #expect(model.notice == "Nothing to change.")
    }

    @Test("The announcement needs a title to publish; the dashboard's blank-title clear is the Clear button here")
    func publishNeedsTitle() async {
        let clients = Self.clients()
        let model = PersonalizerModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.canPublish)
        await model.publishAnnouncement()
        #expect(model.actionError != nil)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SavePersonalizerAnnouncement })
    }

    @Test("Publishing shows the live announcement")
    func publishes() async {
        let model = PersonalizerModel(session: makeSignedInSession(clients: Self.clients()))
        await model.load()
        model.announcement = AnnouncementDraft(title: "Incident", body: "Looking into it", severity: "critical")
        #expect(model.canPublish)
        #expect(model.isAnnouncementDirty)
        await model.publishAnnouncement()
        #expect(model.liveAnnouncement?.title == "Incident")
        #expect(model.notice == "Announcement published.")
        #expect(!model.isAnnouncementDirty)
    }

    @Test("Clearing the announcement needs the typed word, and sends nothing without it")
    func clearNeedsTypedWord() async {
        let clients = Self.clients(announcement: Self.live)
        let model = PersonalizerModel(session: makeSignedInSession(clients: clients))
        await model.load()
        for wrong in ["", "clear", "CLEAR ", "yes"] {
            await model.clearAnnouncement(typed: wrong)
            #expect(model.liveAnnouncement != nil)
        }
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ClearPersonalizerAnnouncement })
        #expect(model.actionError == "Type CLEAR to clear the announcement.")

        await model.clearAnnouncement(typed: "CLEAR")
        #expect(model.liveAnnouncement == nil)
        #expect(model.announcement == AnnouncementDraft())
        #expect(clients.calls.filter { $0.endpoint is Endpoints.ClearPersonalizerAnnouncement }.count == 1)
    }

    @Test("A person who is not an operator gets the refusal, and no form")
    func refused() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.CurrentAnnouncement { return AnnouncementAnswer(announcement: nil) }
            throw NetworkError.forbidden(message: "Restricted to Sylo's operators.")
        }
        let model = PersonalizerModel(session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.isRefused)
        #expect(!model.hasLoaded)
        #expect(model.bot == nil)
        #expect(model.errorMessage == OperatorOnly.refusal)
        await model.savePresence()
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.SavePersonalizerPresence })
    }

    @Test("A load that finishes after the sign-in changed fills nothing")
    func lateLoad() async {
        let gate = TestGate()
        let session = makeGatedAnswerSession(gate: gate) { endpoint in
            switch endpoint {
            case is Endpoints.Personalizer: return BotIdentityAnswer(bot: Self.bot)
            case is Endpoints.PersonalizerPresence: return PresenceOptions()
            case is Endpoints.CurrentAnnouncement: return AnnouncementAnswer(announcement: nil)
            case is Endpoints.SignOut: return EmptyResponse()
            default: throw NetworkError.notFound
            }
        }
        let model = PersonalizerModel(session: session)
        let loading = Task { await model.load() }
        await waitForArrival(gate)
        let signingOut = Task { await session.signOut() }
        try? await Task.sleep(for: .milliseconds(50))
        gate.open()
        await loading.value
        await signingOut.value
        #expect(!model.hasLoaded)
        #expect(model.bot == nil)
    }
}
