import Foundation
import Testing
@testable import SyloKit

@MainActor
@Suite("Account model")
struct AccountModelTests {
    nonisolated static let start = Date(timeIntervalSince1970: 1_700_000_000)
    nonisolated static let laptop = SignedInDevice(
        id: "d-laptop", name: "Laptop", createdAt: start, lastUsedAt: start.addingTimeInterval(100))
    nonisolated static let phone = SignedInDevice(
        id: "d-phone", name: "iPhone", createdAt: start, lastUsedAt: start.addingTimeInterval(50), isCurrent: true)
    nonisolated static let tablet = SignedInDevice(
        id: "d-tablet", name: "iPad", createdAt: start, lastUsedAt: start.addingTimeInterval(300))
    nonisolated static let discord = PlatformConnection(
        platform: .discord, isConnected: true, username: "ferdi", serverCount: 3, canDisconnect: true)
    nonisolated static let fluxer = PlatformConnection(
        platform: .fluxer, isConnected: false, connectPath: "/auth/fluxer")
    nonisolated static let account = AccountInfo(
        platforms: [fluxer, discord], devices: [laptop, phone, tablet])

    /// Answers the account, and revokes with `revoke` (default: the server agrees).
    static func clients(
        revoke: @escaping @Sendable (Endpoints.RevokeDevice) throws -> OKResponse = { _ in OKResponse() }
    ) -> StubClients {
        StubClients { endpoint in
            if let revokeDevice = endpoint as? Endpoints.RevokeDevice { return try revoke(revokeDevice) }
            return Self.account
        }
    }

    func loadedModel(_ clients: StubClients) async -> AccountModel {
        let model = AccountModel(session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    func revokeCalls(_ clients: StubClients) -> [Endpoints.RevokeDevice] {
        clients.calls.compactMap { $0.endpoint as? Endpoints.RevokeDevice }
    }

    @Test("loading shows the account")
    func loads() async {
        let model = await loadedModel(Self.clients())
        #expect(model.account == Self.account)
        #expect(model.errorMessage == nil)
        #expect(!model.isLoading)
    }

    @Test("this device comes first, then the others by most recent use")
    func deviceOrder() async {
        let model = await loadedModel(Self.clients())
        #expect(model.devices.map(\.id) == ["d-phone", "d-tablet", "d-laptop"])
    }

    @Test("only connected platforms are listed")
    func connectedPlatforms() async {
        let model = await loadedModel(Self.clients())
        #expect(model.connectedPlatforms == [Self.discord])
    }

    @Test("a failed load explains and keeps the account already shown")
    func failedLoad() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        clients.setHandler { _ in throw NetworkError.offline }
        await model.load()
        #expect(model.account == Self.account)
        #expect(model.errorMessage == NetworkError.offline.userMessage)

        clients.setHandler { _ in Self.account }
        await model.load()
        #expect(model.errorMessage == nil)
    }

    @Test("a cancelled load stays quiet")
    func cancelledLoad() async {
        let model = AccountModel(session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.cancelled }))
        await model.load()
        #expect(model.account == nil)
        #expect(model.errorMessage == nil)
    }

    @Test("revoking removes the device at once and sends its id")
    func revokes() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        let task = try #require(model.revoke(Self.laptop))
        #expect(!model.devices.contains { $0.id == "d-laptop" })
        #expect(model.isRevoking("d-laptop"))
        await task.value
        #expect(!model.isRevoking("d-laptop"))
        #expect(model.account?.devices.map(\.id) == ["d-phone", "d-tablet"])
        #expect(revokeCalls(clients).map(\.id) == ["d-laptop"])
        #expect(model.revokeError == nil)
    }

    @Test("a failed revoke puts the device back where it was and explains")
    func failedRevoke() async {
        let model = await loadedModel(Self.clients { _ in throw NetworkError.offline })
        await model.revoke(Self.laptop)?.value
        #expect(model.account == Self.account)
        #expect(model.revokeError == NetworkError.offline.userMessage)
        #expect(!model.isRevoking("d-laptop"))
    }

    @Test("a device that is already gone counts as revoked")
    func alreadyGone() async {
        let model = await loadedModel(Self.clients { _ in throw NetworkError.notFound })
        await model.revoke(Self.tablet)?.value
        #expect(model.account?.devices.map(\.id) == ["d-laptop", "d-phone"])
        #expect(model.revokeError == nil)
    }

    @Test("a cancelled revoke puts the device back without an error")
    func cancelledRevoke() async {
        let model = await loadedModel(Self.clients { _ in throw NetworkError.cancelled })
        await model.revoke(Self.laptop)?.value
        #expect(model.account == Self.account)
        #expect(model.revokeError == nil)
    }

    @Test("this device, an unknown one, or one already being revoked is not sent")
    func ignoresRevoke() async {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        #expect(model.revoke(Self.phone) == nil)
        let unknown = SignedInDevice(id: "d-gone", name: "Old", createdAt: Self.start, lastUsedAt: Self.start)
        #expect(model.revoke(unknown) == nil)
        let first = model.revoke(Self.laptop)
        #expect(first != nil)
        #expect(model.revoke(Self.laptop) == nil)
        await first?.value
        #expect(revokeCalls(clients).map(\.id) == ["d-laptop"])
        #expect(model.account?.devices.contains { $0.id == "d-phone" } == true)
    }

    @Test("starting a new revoke clears the last revoke error")
    func clearsRevokeError() async {
        let clients = Self.clients { _ in throw NetworkError.offline }
        let model = await loadedModel(clients)
        await model.revoke(Self.laptop)?.value
        #expect(model.revokeError != nil)
        let task = model.revoke(Self.laptop)
        #expect(model.revokeError == nil)
        await task?.value
    }
}
