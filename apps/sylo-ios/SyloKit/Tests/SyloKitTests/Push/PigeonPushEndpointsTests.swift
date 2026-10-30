import Foundation
import Testing
@testable import SyloKit

@Suite("Pigeon push endpoints")
struct PigeonPushEndpointsTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test("Registering with a Pigeon handle sends the handle and the environment, and no token")
    func registerHandle() throws {
        let e = Endpoints.RegisterPush(pigeonHandle: "hrh_abc", environment: .development)
        #expect(e.path == "/api/mobile/push")
        #expect(e.method == .post)
        #expect(e.requiresAuth)
        #expect(e.pigeonHandle == "hrh_abc")
        #expect(e.deviceToken == nil)
        #expect(e.relayToken == nil)
        let body = try #require(e.body)
        let json = try JSONDecoder().decode([String: String].self, from: JSONEncoder().encode(body))
        #expect(json == ["pigeonHandle": "hrh_abc", "environment": "development"])

        // The older two never send a handle.
        #expect(Endpoints.RegisterPush(deviceToken: "ab", environment: .production).pigeonHandle == nil)
        #expect(Endpoints.RegisterPush(relayToken: "r", environment: .production).pigeonHandle == nil)
    }

    @Test("The text of a notification is fetched below its encoded ref, signed in")
    func eventPath() {
        let e = Endpoints.PushEvent(ref: "AbC_-123456789012345")
        #expect(e.path == "/api/mobile/push/events/AbC_-123456789012345")
        #expect(e.method == .get)
        #expect(e.body == nil)
        #expect(e.requiresAuth)
        // Whatever a ref holds, it stays one path segment.
        #expect(Endpoints.PushEvent(ref: "a/b").path == "/api/mobile/push/events/a%2Fb")
    }

    @Test("A ticket's text decodes with where a tap goes")
    func decodesTicket() throws {
        let content = try decode(
            PushEventContent.self,
            #"""
            {"title": "Support", "subtitle": "New ticket", "body": "alice: Hi", "threadId": "1:12", "kind": "ticket",
             "data": {"kind": "ticket", "guildId": "1", "ticketId": 12}}
            """#)
        #expect(
            content
                == PushEventContent(
                    title: "Support", subtitle: "New ticket", body: "alice: Hi", threadId: "1:12",
                    link: .ticket(guildID: "1", ticketID: 12)))
    }

    @Test("A dev-log text decodes, and an unknown level reads as an error")
    func decodesDevLog() throws {
        let warning = try decode(
            PushEventContent.self,
            #"{"title": "T", "body": "B", "threadId": "devlog", "kind": "devlog", "data": {"kind": "devlog", "level": "warn"}}"#)
        #expect(warning.link == .devLog(.warning))
        let odd = try decode(
            PushEventContent.self, #"{"title": "T", "body": "B", "data": {"kind": "devlog", "level": "loud"}}"#)
        #expect(odd.link == .devLog(.error))
    }

    @Test("A ticket id spelled as a string reads, and incomplete or unknown data opens nothing")
    func lenientData() throws {
        let spelled = try decode(
            PushEventContent.self, #"{"title": "T", "body": "B", "data": {"kind": "ticket", "guildId": "fluxer:1", "ticketId": "7"}}"#)
        #expect(spelled.link == .ticket(guildID: "fluxer:1", ticketID: 7))

        for data in [
            #"{"kind": "ticket", "guildId": "1"}"#, #"{"kind": "ticket", "ticketId": 3}"#,
            #"{"kind": "ticket", "guildId": "", "ticketId": 3}"#, #"{"kind": "ticket", "guildId": "1", "ticketId": 0}"#,
            #"{"kind": "appeal", "guildId": "1", "ticketId": 3}"#, #"{}"#, #"5"#,
        ] {
            let content = try decode(PushEventContent.self, #"{"title": "T", "body": "B", "data": \#(data)}"#)
            #expect(content.link == nil, "\(data)")
            #expect(content.title == "T")
        }
        // Without `data` the top-level kind decides, and says nothing about where to go.
        #expect(try decode(PushEventContent.self, #"{"title": "T", "body": "B", "kind": "ticket"}"#).link == nil)
    }

    @Test("A text needs a title; the rest may be missing")
    func titleRequired() throws {
        #expect(throws: (any Error).self) { try decode(PushEventContent.self, #"{"body": "B"}"#) }
        let bare = try decode(PushEventContent.self, #"{"title": "T"}"#)
        #expect(bare == PushEventContent(title: "T", body: ""))
    }

    @Test("Where a tap goes is spelled the way the app's notification handling reads it")
    func linkUserInfo() throws {
        let server = try ServerURL("https://sylo.example.com/sub")
        let ticket = NotificationLink.ticket(guildID: "fluxer:1", ticketID: 12).userInfo(server: server)
        #expect(ticket["kind"] as? String == "ticket")
        #expect(ticket["server"] as? String == "https://sylo.example.com/sub")
        #expect(ticket["guildId"] as? String == "fluxer:1")
        #expect(ticket["ticketId"] as? Int == 12)
        #expect(
            TicketNotification(userInfo: ["sylo": ticket])
                == TicketNotification(server: server, guildID: "fluxer:1", ticketID: 12))

        let devLog = NotificationLink.devLog(.error).userInfo(server: server)
        #expect(DevLogNotification(userInfo: ["sylo": devLog]) == DevLogNotification(server: server, level: .error))
    }

    @Test("Server info names its Pigeon, and ignores one it can't read")
    func infoPigeon() throws {
        let info = try decode(
            ServerInfo.self,
            #"{"name": "Sylo", "features": ["push-pigeon"], "pigeon": "https://pigeon.hedgerow.tools"}"#)
        #expect(info.pigeon == URL(string: "https://pigeon.hedgerow.tools"))
        #expect(info.supports(.pushPigeon))
        #expect(!info.supports(.push))
        #expect(try decode(ServerInfo.self, #"{"name": "Sylo"}"#).pigeon == nil)
        #expect(try decode(ServerInfo.self, #"{"name": "Sylo", "pigeon": 5}"#).pigeon == nil)
        #expect(try decode(ServerInfo.self, #"{"name": "Sylo", "pigeon": ""}"#).pigeon == nil)
        #expect(try decode(ServerInfo.self, #"{"name": "Sylo", "pigeon": null}"#).pigeon == nil)
        #expect(ServerInfo().pigeon == nil)
        #expect(ServerFeature.pushPigeon.rawValue == "push-pigeon")
    }

    @Test("A server that sends through both says both")
    func infoBoth() throws {
        let info = try decode(
            ServerInfo.self,
            #"{"name": "Sylo", "features": ["push", "push-pigeon"], "pushRelay": "https://app.sylobot.com", "pigeon": "https://pigeon.hedgerow.tools"}"#)
        #expect(info.supports(.push) && info.supports(.pushPigeon))
        #expect(info.pushRelay == URL(string: "https://app.sylobot.com"))
        #expect(info.pigeon == URL(string: "https://pigeon.hedgerow.tools"))
    }
}

#if canImport(Security)
import Security

@Suite("Keychain access group")
struct KeychainAccessGroupTests {
    @Test("Without a group the item query names none, and with one it names it")
    func query() {
        let plain = KeychainTokenStore(service: "svc").itemQuery(for: "https://sylo.example.com")
        #expect(plain[kSecAttrAccessGroup as String] == nil)
        #expect(plain[kSecAttrService as String] as? String == "svc")
        #expect(plain[kSecAttrAccount as String] as? String == "https://sylo.example.com")
        #expect(plain[kSecAttrSynchronizable as String] as? Bool == false)

        let shared = KeychainTokenStore(service: "svc", accessGroup: "TEAM.net.opland.sylo")
            .itemQuery(for: "https://sylo.example.com")
        #expect(shared[kSecAttrAccessGroup as String] as? String == "TEAM.net.opland.sylo")
        #expect(shared[kSecAttrService as String] as? String == "svc")
    }

    @Test("The Pigeon registration item has its own service, and the app and its extension share the token service")
    func services() {
        #expect(KeychainPigeonStore().service == "net.opland.sylo.pigeon")
        #expect(SyloAppStorage.keychainService == "net.opland.sylo")
        #expect(KeychainPigeonStore().service != SyloAppStorage.keychainService)
        let query = KeychainPigeonStore(accessGroup: "TEAM.net.opland.sylo").itemQuery()
        #expect(query[kSecAttrAccessGroup as String] as? String == "TEAM.net.opland.sylo")
        #expect(query[kSecAttrSynchronizable as String] as? Bool == false)
        #expect(SyloAppStorage.appGroup == "group.net.opland.sylo")
    }

    @Test("The manage key's group is the app's second group, found from the default one")
    func pigeonGroup() {
        #expect(
            SyloAppStorage.pigeonKeychainGroup(fromDefaultGroup: "76M3G78HV8.net.opland.sylo")
                == "76M3G78HV8.net.opland.sylo.pigeon")
        // Anything that isn't the default group of this app gives none, so nothing is guessed.
        #expect(SyloAppStorage.pigeonKeychainGroup(fromDefaultGroup: "net.opland.sylo") == nil)
        #expect(SyloAppStorage.pigeonKeychainGroup(fromDefaultGroup: ".net.opland.sylo") == nil)
        #expect(SyloAppStorage.pigeonKeychainGroup(fromDefaultGroup: "76M3G78HV8.net.opland.sylo.pigeon") == nil)
        #expect(SyloAppStorage.pigeonKeychainGroup(fromDefaultGroup: "76M3G78HV8.other.app") == nil)
        #expect(SyloAppStorage.pigeonKeychainGroup(fromDefaultGroup: "") == nil)
    }
}
#endif
