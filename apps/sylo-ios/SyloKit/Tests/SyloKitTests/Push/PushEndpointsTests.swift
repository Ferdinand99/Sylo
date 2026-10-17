import Foundation
import Testing
@testable import SyloKit

@Suite("Push endpoints")
struct PushEndpointsTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test("Registering posts the token and the environment")
    func register() throws {
        let e = Endpoints.RegisterPush(deviceToken: "0a1b2c", environment: .development)
        #expect(e.path == "/api/mobile/push")
        #expect(e.method == .post)
        let body = try #require(e.body)
        let json = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
        #expect(json == ["deviceToken": "0a1b2c", "environment": "development"])

        let production = try #require(Endpoints.RegisterPush(deviceToken: "ff", environment: .production).body)
        let decoded = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(production))
        #expect(decoded["environment"] == "production")
    }

    @Test("Through a relay, the instance gets the relay token instead of the device token")
    func registerRelayToken() throws {
        let e = Endpoints.RegisterPush(relayToken: "r-123", environment: .production)
        #expect(e.path == "/api/mobile/push")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        #expect(e.relayToken == "r-123")
        #expect(e.deviceToken == nil)
        let body = try #require(e.body)
        let json = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
        #expect(json == ["relayToken": "r-123", "environment": "production"])

        let direct = Endpoints.RegisterPush(deviceToken: "ab", environment: .production)
        #expect(direct.deviceToken == "ab")
        #expect(direct.relayToken == nil)
    }

    @Test("The relay registration posts the device, its environment and the Sylo server, without a token")
    func relayRegister() throws {
        let e = Endpoints.RegisterWithRelay(
            deviceToken: "0a1b", environment: .development, instance: try ServerURL("https://sylo.example.com/sub"))
        #expect(e.path == "/api/push-relay/v1/register")
        #expect(e.method == .post)
        #expect(!e.requiresAuth)
        let body = try #require(e.body)
        let json = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
        #expect(json == [
            "deviceToken": "0a1b", "environment": "development", "instance": "https://sylo.example.com/sub",
        ])
        #expect(try decode(PushRelayRegistration.self, #"{"relayToken": "r-1"}"#).relayToken == "r-1")
        #expect(throws: (any Error).self) { try decode(PushRelayRegistration.self, "{}") }
    }

    @Test("Only the official relay is trusted, however its address is spelled")
    func officialRelay() throws {
        #expect(PushRelay.official == .hosted)
        #expect(PushRelay.isOfficial(try #require(URL(string: "https://app.sylobot.com"))))
        #expect(PushRelay.isOfficial(try #require(URL(string: "https://APP.sylobot.com/"))))
        #expect(PushRelay.isOfficial(try #require(URL(string: "https://app.sylobot.com:443"))))
        #expect(!PushRelay.isOfficial(try #require(URL(string: "http://app.sylobot.com"))))
        #expect(!PushRelay.isOfficial(try #require(URL(string: "https://app.sylobot.com/relay"))))
        #expect(!PushRelay.isOfficial(try #require(URL(string: "https://relay.example.com"))))
        #expect(!PushRelay.isOfficial(try #require(URL(string: "https://app.sylobot.com.evil.example"))))
    }

    @Test("Server info names its relay when it has one, and ignores one it can't read")
    func infoRelay() throws {
        let relayed = try decode(
            ServerInfo.self, #"{"name": "Sylo", "features": ["push"], "pushRelay": "https://app.sylobot.com"}"#)
        #expect(relayed.pushRelay == URL(string: "https://app.sylobot.com"))
        #expect(try decode(ServerInfo.self, #"{"name": "Sylo", "features": ["push"]}"#).pushRelay == nil)
        #expect(try decode(ServerInfo.self, #"{"name": "Sylo", "pushRelay": 5}"#).pushRelay == nil)
        #expect(try decode(ServerInfo.self, #"{"name": "Sylo", "pushRelay": ""}"#).pushRelay == nil)
        #expect(try decode(ServerInfo.self, #"{"name": "Sylo", "pushRelay": null}"#).pushRelay == nil)
        #expect(ServerInfo().pushRelay == nil)
    }

    @Test("Turning off is a DELETE without a body; the settings are a GET")
    func unregisterAndRead() {
        let off = Endpoints.UnregisterPush()
        #expect(off.path == "/api/mobile/push")
        #expect(off.method == .delete)
        #expect(off.body == nil)

        let read = Endpoints.PushSettings()
        #expect(read.path == "/api/mobile/push")
        #expect(read.method == .get)
        #expect(read.body == nil)
    }

    @Test("Muting a server puts muted below its encoded id")
    func mute() throws {
        let e = Endpoints.MutePushForServer(server: "fluxer:1", muted: true)
        #expect(e.path == "/api/mobile/push/servers/fluxer%3A1")
        #expect(e.method == .put)
        let body = try #require(e.body)
        let json = try JSONDecoder().decode([String: Bool].self, from: JSONEncoder().encode(body))
        #expect(json == ["muted": true])
        #expect(Endpoints.MutePushForServer(server: "123", muted: false).path == "/api/mobile/push/servers/123")
    }

    @Test("Every push call is signed in")
    func signedIn() {
        let all: [any APIEndpoint] = [
            Endpoints.RegisterPush(deviceToken: "00", environment: .production), Endpoints.UnregisterPush(),
            Endpoints.PushSettings(), Endpoints.MutePushForServer(server: "1", muted: true),
        ]
        for endpoint in all { #expect(endpoint.requiresAuth, "\(endpoint.path)") }
    }

    @Test("The settings decode, and missing fields mean off and nothing muted")
    func decodesSettings() throws {
        let settings = try decode(PushSettingsInfo.self, #"{"enabled": true, "mutedServers": ["1", "fluxer:2"]}"#)
        #expect(settings.isEnabled)
        #expect(settings.mutedServers == ["1", "fluxer:2"])

        let empty = try decode(PushSettingsInfo.self, "{}")
        #expect(!empty.isEnabled)
        #expect(empty.mutedServers.isEmpty)
    }

    @Test("A mute answer decodes the muted servers")
    func decodesMuteResult() throws {
        #expect(try decode(PushMuteResult.self, #"{"mutedServers": ["1"]}"#).mutedServers == ["1"])
        #expect(try decode(PushMuteResult.self, "{}").mutedServers.isEmpty)
    }

    @Test("Servers say whether they can push")
    func feature() throws {
        #expect(ServerFeature.push.rawValue == "push")
        let info = try decode(ServerInfo.self, #"{"name": "Sylo", "features": ["app-login", "push"]}"#)
        #expect(info.supports(.push))
        #expect(!ServerInfo().supports(.push))
    }

    @Test("A device token is spelled in lowercase hex, two digits a byte")
    func hexToken() {
        #expect(PushToken.hex(Data([0x00, 0x0a, 0xab, 0xff, 0x10])) == "000aabff10")
        #expect(PushToken.hex(Data()) == "")
        let token = Data((0..<32).map { UInt8($0 * 8 % 256) })
        #expect(PushToken.hex(token).count == 64)
        #expect(PushToken.hex(token) == PushToken.hex(token).lowercased())
    }
}
