import Foundation
import Testing
@testable import SyloKit

@Suite("Push device state")
struct PushDeviceStateTests {
    private let server = try! ServerURL("https://sylo.example.com")
    private let other = try! ServerURL("https://other.example.com")
    private let token = Data([0xAB, 0x01])

    @Test("A token is registered once per server and token")
    func registersOnce() {
        var state = PushDeviceState()
        #expect(state.needsDeviceToken)
        #expect(!state.hasRegistered(at: server))

        state.received(deviceToken: token)
        #expect(!state.needsDeviceToken)
        #expect(!state.hasRegistered(at: server))

        state.registered(at: server, token: token)
        #expect(state.hasRegistered(at: server))
        #expect(!state.hasRegistered(at: other))

        // iOS hands out another token: it is registered again.
        state.received(deviceToken: Data([0xCD]))
        #expect(!state.hasRegistered(at: server))
    }

    @Test("A new sign-in registers again with the token it has")
    func newSignIn() {
        var state = PushDeviceState(deviceToken: token)
        state.registered(at: server, token: token)
        state.forgetRegistration()
        #expect(!state.hasRegistered(at: server))
        #expect(state.deviceToken == token)
    }

    @Test("Signing out forgets the token and what was registered, so nothing stays in use on the device")
    func signedOut() {
        var state = PushDeviceState(deviceToken: token)
        state.registered(at: server, token: token)
        state.signedOut()
        #expect(state.deviceToken == nil)
        #expect(state.needsDeviceToken)
        #expect(!state.hasRegistered(at: server))
        #expect(state == PushDeviceState())
    }

    @Test("After a sign-out a later sign-in registers cleanly, even at the same server with the same token")
    func signInAfterSignOut() {
        var state = PushDeviceState(deviceToken: token)
        state.registered(at: server, token: token)
        state.signedOut()

        // The next sign-in asks iOS for a token, which may well be the same one.
        state.forgetRegistration()
        #expect(state.needsDeviceToken)
        state.received(deviceToken: token)
        #expect(!state.hasRegistered(at: server))
        state.registered(at: server, token: token)
        #expect(state.hasRegistered(at: server))
    }

    @Test("A registration that finishes after the token changed does not count for the new token")
    func staleRegistration() {
        var state = PushDeviceState(deviceToken: token)
        let newer = Data([0xEE])
        state.received(deviceToken: newer)
        state.registered(at: server, token: token)
        #expect(!state.hasRegistered(at: server))
    }
}

@MainActor
@Suite("Signing out and notifications")
struct SignOutNotificationsTests {
    private let server = try! ServerURL("https://sylo.example.com")

    private func clients(info: ServerInfo, signOut: @escaping @Sendable () throws -> Void = {}) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return info
            case is Endpoints.UnregisterPush: return EmptyResponse()
            case is Endpoints.SignOut:
                try signOut()
                return EmptyResponse()
            default: throw NetworkError.notFound
            }
        }
    }

    @Test("Signing out of a server that pushes takes the notifications down first, then revokes the token")
    func unregistersFirst() async throws {
        let stub = clients(info: ServerInfo(features: [.appLogin, .push]))
        let session = makeSignedInSession(clients: stub)
        _ = await session.serverFeatures()
        await session.signOut()
        let sent = stub.calls.map { call -> String in
            switch call.endpoint {
            case is Endpoints.UnregisterPush: "unregister"
            case is Endpoints.SignOut: "signout"
            default: "other"
            }
        }
        #expect(sent == ["other", "unregister", "signout"])
        #expect(stub.calls.last?.token == "sylo_live")
        #expect(session.phase == .signIn(server))
    }

    @Test("A server through Pigeon is told too")
    func pigeonServerToo() async throws {
        let stub = clients(info: ServerInfo(features: [.appLogin, .pushPigeon]))
        let session = makeSignedInSession(clients: stub)
        _ = await session.serverFeatures()
        await session.signOut()
        #expect(stub.calls.contains { $0.endpoint is Endpoints.UnregisterPush })
    }

    @Test("A server without push is not asked to take anything down")
    func noPushNoCall() async throws {
        let stub = clients(info: ServerInfo(features: [.appLogin]))
        let session = makeSignedInSession(clients: stub)
        _ = await session.serverFeatures()
        await session.signOut()
        #expect(!stub.calls.contains { $0.endpoint is Endpoints.UnregisterPush })
        #expect(stub.calls.last?.endpoint is Endpoints.SignOut)
    }

    @Test("Signing out works when the server cannot be reached: signed out here, token gone, nothing left to retry with")
    func offline() async throws {
        let stub = clients(info: ServerInfo(features: [.appLogin, .push]))
        let session = makeSignedInSession(clients: stub)
        _ = await session.serverFeatures()
        stub.setHandler { endpoint in
            if endpoint is Endpoints.ServerInfo { return ServerInfo(features: [.appLogin, .push]) }
            throw NetworkError.offline
        }
        await session.signOut()
        #expect(session.phase == .signIn(server))
        #expect(session.notice == nil)
        // Without the token the app can no longer speak for the account: no later call goes out with it.
        await #expect(throws: NetworkError.unauthorized) { try await session.send(Endpoints.PushSettings()) }
    }
}
