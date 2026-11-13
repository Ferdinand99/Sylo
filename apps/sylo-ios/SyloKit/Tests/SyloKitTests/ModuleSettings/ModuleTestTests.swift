import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Module test message")
struct ModuleTestTests {
    @Test("a sent test names the channel it went to")
    func sent() throws {
        let result = try decode(ModuleTestResult.self, #"{"ok":true,"channelName":"welcome"}"#)
        #expect(result.isSent)
        #expect(result.channelName == "welcome")
        #expect(result.failure == nil)
        #expect(result.message == "Test sent to #welcome.")
    }

    @Test("a sent test without a channel name still says it was sent")
    func sentWithoutName() throws {
        let result = try decode(ModuleTestResult.self, #"{"ok":true}"#)
        #expect(result.message == "Test sent.")
    }

    @Test("no channel set asks for one")
    func noChannel() throws {
        let result = try decode(ModuleTestResult.self, #"{"ok":false,"reason":"no-channel"}"#)
        #expect(!result.isSent)
        #expect(result.failure == .noChannel)
        #expect(result.message == "Set a channel for this module first.")
    }

    @Test("a failed send tells the person to check the bot's access")
    func sendFailed() throws {
        let result = try decode(ModuleTestResult.self, #"{"ok":false,"reason":"send-failed"}"#)
        #expect(result.failure == .sendFailed)
        #expect(result.message.contains("access to that channel"))
    }

    @Test("a reason this app does not know, or none, is still a failure with words")
    func unknownReason() throws {
        let newer = try decode(ModuleTestResult.self, #"{"ok":false,"reason":"rate-limited"}"#)
        #expect(!newer.isSent)
        #expect(newer.failure == .other)
        #expect(!newer.message.isEmpty)
        let bare = try decode(ModuleTestResult.self, "{}")
        #expect(!bare.isSent)
        #expect(bare.failure == .other)
    }

    @Test("the modules with a test message are the server's list")
    func testable() {
        #expect(ModuleTestable.ids == ["welcome", "birthdays", "logging", "twitch-alerts", "youtube-alerts",
                                       "starboard", "free-games"])
        #expect(ModuleTestable.isTestable("welcome"))
        #expect(!ModuleTestable.isTestable("afk"))
    }

    @Test("the line by the button says what is posted and where")
    func postsTo() {
        #expect(ModuleTestText.postsTo(sample: "a sample alert", channelName: "streams")
            == "Posts a sample alert to #streams.")
        #expect(ModuleTestText.postsTo(sample: "a sample alert", channelName: nil)
            == "Posts a sample alert to the channel set above.")
        #expect(ModuleTestText.postsTo(sample: "", channelName: "  ") == "Posts a sample message to the channel set above.")
        #expect(ModuleTestText.postsTo(sample: "a sample alert", channelName: "streams", note: "the first streamer in the list")
            == "Posts a sample alert to #streams (the first streamer in the list).")
    }

    @Test("the path is the module's test route")
    func path() {
        let endpoint = Endpoints.SendModuleTest(server: "fluxer:9", module: "free-games")
        #expect(endpoint.path == "/api/v2/guilds/fluxer%3A9/modules/free-games/test")
        #expect(endpoint.method == .post)
        #expect(endpoint.body == nil)
    }
}

@MainActor
@Suite("Module test model")
struct ModuleTestModelTests {
    private func make(_ answer: @escaping @Sendable (any APIEndpoint) throws -> Any) -> ModuleTestModel {
        let clients = StubClients { try answer($0) }
        return ModuleTestModel(server: "1", module: "welcome", session: makeSignedInSession(clients: clients))
    }

    @Test("a sent test becomes a notice")
    func sends() async {
        let model = make { endpoint in
            #expect((endpoint as? Endpoints.SendModuleTest)?.module == "welcome")
            return ModuleTestResult(isSent: true, channelName: "welcome")
        }
        await model.send()
        #expect(model.outcome == .sent("Test sent to #welcome."))
        #expect(model.outcome?.isSent == true)
        #expect(!model.isSending)
    }

    @Test("a test that did not go through shows why, as a failure")
    func failsWithReason() async {
        let model = make { _ in ModuleTestResult(isSent: false, failure: .noChannel) }
        await model.send()
        #expect(model.outcome == .failed("Set a channel for this module first."))
        #expect(model.outcome?.isSent == false)
    }

    @Test("a failed call shows the server's words")
    func failedCall() async {
        let model = make { _ in throw NetworkError.badRequest(message: "This module has no test message.") }
        await model.send()
        #expect(model.outcome == .failed("This module has no test message."))
    }

    @Test("a new send clears the old outcome, and the outcome can be cleared")
    func clears() async {
        let model = make { _ in ModuleTestResult(isSent: true, channelName: "welcome") }
        await model.send()
        model.clearOutcome()
        #expect(model.outcome == nil)
    }
}

@MainActor
@Suite("Saved settings warning")
struct SavedWarningTests {
    @Test("a save answer reads the server's warning, trimmed")
    func decodesWarning() throws {
        let saved = try decode(SavedModuleSettings<WelcomeSettings>.self, """
            {"config":{"trigger":"role","triggerRoleIds":[]},"warning":" No usable role is picked, so no welcome is sent until you pick one. "}
            """)
        #expect(saved.warning == "No usable role is picked, so no welcome is sent until you pick one.")
        #expect(saved.settings.trigger == .role)
    }

    @Test("no warning, an empty one or one of another shape is no warning, and the save still reads")
    func noWarning() throws {
        #expect(try decode(SavedModuleSettings<WelcomeSettings>.self, #"{"config":{}}"#).warning == nil)
        #expect(try decode(SavedModuleSettings<WelcomeSettings>.self, #"{"config":{},"warning":""}"#).warning == nil)
        let odd = try decode(SavedModuleSettings<WelcomeSettings>.self, #"{"config":{},"warning":{"a":1}}"#)
        #expect(odd.warning == nil)
    }

    @Test("the model keeps the warning of the last save and clears it at the next one")
    func modelKeepsWarning() async {
        let page = WelcomePage(settings: WelcomeSettings(trigger: .role, triggerRoleIds: []))
        let warning = LockedBox<String?>("No usable role is picked, so no welcome is sent until you pick one.")
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LoadModuleSettings<WelcomePage> { return page }
            if let saving = endpoint as? Endpoints.SaveModuleSettings<WelcomePage> {
                return SavedModuleSettings(settings: saving.settings, warning: warning.value)
            }
            throw NetworkError.notFound
        }
        let model = ModuleSettingsModel<WelcomePage>(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        model.draft?.joinMessage = "Hi"
        #expect(await model.save())
        #expect(model.saveWarning == "No usable role is picked, so no welcome is sent until you pick one.")

        warning.value = nil
        model.draft?.joinMessage = "Hello"
        #expect(await model.save())
        #expect(model.saveWarning == nil)
    }

    @Test("a failed save leaves no warning")
    func failedSave() async {
        let page = WelcomePage(settings: WelcomeSettings())
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LoadModuleSettings<WelcomePage> { return page }
            throw NetworkError.badRequest(message: "nope")
        }
        let model = ModuleSettingsModel<WelcomePage>(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        model.draft?.joinMessage = "Hi"
        #expect(!(await model.save()))
        #expect(model.saveWarning == nil)
    }
}

/// A value the test changes between calls; the stub handler reads it from another context.
private final class LockedBox<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
