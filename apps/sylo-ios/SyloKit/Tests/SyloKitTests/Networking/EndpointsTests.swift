import Foundation
import Testing
@testable import SyloKit

@Suite("Endpoints")
struct EndpointsTests {
    private func json(_ endpoint: some APIEndpoint) throws -> [String: String] {
        let body = try #require(endpoint.body)
        let data = try JSONEncoder().encode(body)
        return try JSONDecoder().decode([String: String].self, from: data)
    }

    @Test("Server info is public")
    func serverInfo() {
        let e = Endpoints.ServerInfo()
        #expect(e.path == "/api/mobile/info")
        #expect(e.method == .get)
        #expect(!e.requiresAuth)
        #expect(e.body == nil)
        #expect(e.query.isEmpty)
    }

    @Test("Code exchange posts code, verifier and device name without auth")
    func exchangeCode() throws {
        let e = Endpoints.ExchangeCode(code: "abc", verifier: "v".padding(toLength: 43, withPad: "v", startingAt: 0), deviceName: "iPhone — Sylo app")
        #expect(e.path == "/api/mobile/token")
        #expect(e.method == .post)
        #expect(!e.requiresAuth)
        let body = try json(e)
        #expect(body == ["code": "abc", "verifier": String(repeating: "v", count: 43), "deviceName": "iPhone — Sylo app"])
    }

    @Test("Code exchange leaves out a missing device name")
    func exchangeCodeNoName() throws {
        let body = try json(Endpoints.ExchangeCode(code: "abc", verifier: "xyz", deviceName: nil))
        #expect(body == ["code": "abc", "verifier": "xyz"])
    }

    @Test("Signed-in endpoints, with ids encoded into the path")
    func signedIn() throws {
        let fluxer: ServerID = "fluxer:223456789012345678"
        #expect(Endpoints.Servers().path == "/api/v2/guilds")
        #expect(Endpoints.Overview(server: fluxer).path == "/api/v2/guilds/fluxer%3A223456789012345678/overview")
        #expect(Endpoints.Overview(server: "123").path == "/api/v2/guilds/123/overview")
        #expect(Endpoints.Account().path == "/api/v2/account")
        #expect(Endpoints.RevokeDevice(id: "6f1c2a8e-0b7d").path == "/api/v2/account/devices/6f1c2a8e-0b7d/revoke")
        #expect(Endpoints.RevokeDevice(id: "../x").path == "/api/v2/account/devices/..%2Fx/revoke")

        let set = Endpoints.SetModule(server: fluxer, module: "auto-react", enabled: false)
        #expect(set.path == "/api/v2/guilds/fluxer%3A223456789012345678/modules/auto-react")
        #expect(set.method == .post)
        let body = try #require(set.body)
        let decoded = try JSONDecoder().decode([String: Bool].self, from: JSONEncoder().encode(body))
        #expect(decoded == ["enabled": false])

        let signOut = Endpoints.SignOut()
        #expect(signOut.path == "/api/mobile/token")
        #expect(signOut.method == .delete)

        let all: [any APIEndpoint] = [
            Endpoints.Servers(), Endpoints.Overview(server: fluxer), set, Endpoints.Account(),
            Endpoints.RevokeDevice(id: "x"), signOut,
        ]
        for endpoint in all { #expect(endpoint.requiresAuth, "\(endpoint.path)") }
        #expect(Endpoints.RevokeDevice(id: "x").method == .post)
        let delete = Endpoints.DeleteAccount()
        #expect(delete.path == "/api/v2/account/delete")
        #expect(delete.method == .post)
        #expect(delete.requiresAuth)
        let deleteBody = try #require(delete.body)
        let sent = try JSONDecoder().decode([String: Bool].self, from: JSONEncoder().encode(deleteBody))
        #expect(sent == ["confirm": true])
        #expect(Endpoints.RevokeDevice(id: "x").body == nil)
    }
}
