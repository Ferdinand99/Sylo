import Foundation
import Testing
@testable import SyloKit

/// The operator screens are for operator accounts only: the app asks the account page who is signed in,
/// shows the Operator section only to an operator, and forgets what it knew when the sign-in changes. The
/// server checks every operator call itself; this is the part of the app that decides what to show.
@MainActor
@Suite("Operator gating")
struct OperatorGatingTests {
    nonisolated static func account(isOperator: Bool) -> AccountInfo {
        AccountInfo(isOperator: isOperator, platforms: [AccountModelTests.discord], devices: [AccountModelTests.phone])
    }

    /// Answers the account page as an operator or not, depending on `isOperator`, and sign-in and
    /// sign-out like a server.
    nonisolated static func clients(_ isOperator: LockedFlag) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.Account: return account(isOperator: isOperator.value)
            case is Endpoints.SignOut: return EmptyResponse()
            case is Endpoints.ExchangeCode:
                return TokenGrant(
                    token: "sylo_second", expiresAt: Date().addingTimeInterval(86_400),
                    account: SignedInAccount(name: "second", platforms: [.discord]))
            default: throw NetworkError.notFound
            }
        }
    }

    @Test("An operator is offered every operator screen")
    func operatorSeesAll() async {
        let isOperator = LockedFlag()
        isOperator.value = true
        let model = AccountModel(session: makeSignedInSession(clients: Self.clients(isOperator)))
        await model.load()
        #expect(model.isOperator)
        #expect(model.operatorFeatures == OperatorFeature.allCases)
        #expect(OperatorFeature.allCases == [.health, .personalizer, .statsCache, .roadmapAdmin])
    }

    @Test("Anyone else is offered none: the section is not there at all")
    func nonOperatorSeesNone() async {
        let isOperator = LockedFlag()
        let model = AccountModel(session: makeSignedInSession(clients: Self.clients(isOperator)))
        await model.load()
        #expect(model.account != nil)
        #expect(!model.isOperator)
        #expect(model.operatorFeatures.isEmpty)
    }

    @Test("Before the account is read nobody is an operator")
    func unknownIsNoOperator() {
        let isOperator = LockedFlag()
        isOperator.value = true
        let model = AccountModel(session: makeSignedInSession(clients: Self.clients(isOperator)))
        #expect(!model.isOperator)
        #expect(model.operatorFeatures.isEmpty)
    }

    @Test("A server that does not say is not an operator")
    func missingFlag() async throws {
        let json = #"{"platforms":[],"devices":[]}"#
        let info = try JSONDecoder().decode(AccountInfo.self, from: Data(json.utf8))
        let model = AccountModel(session: makeSignedInSession(clients: StubClients { _ in info }))
        await model.load()
        #expect(!model.isOperator)
    }

    @Test("Signing out hides the operator screens at once, before anything is read again")
    func signOutHides() async {
        let isOperator = LockedFlag()
        isOperator.value = true
        let session = makeSignedInSession(clients: Self.clients(isOperator))
        let model = AccountModel(session: session)
        await model.load()
        #expect(model.isOperator)
        await session.signOut()
        #expect(!model.isOperator)
        #expect(model.operatorFeatures.isEmpty)
    }

    @Test("Another account on the same device is not trusted with what the first one was told")
    func accountSwitch() async throws {
        let isOperator = LockedFlag()
        isOperator.value = true
        let session = makeSignedInSession(clients: Self.clients(isOperator))
        let model = AccountModel(session: session)
        await model.load()
        #expect(model.operatorFeatures.count == 4)

        // The operator signs out, and a person who is not one signs in on the same device.
        await session.signOut()
        isOperator.value = false
        await session.signIn(with: nil) { try AppSessionTests.allow($0) }
        let server = try ServerURL("https://sylo.example.com")
        #expect(session.phase == .signedIn(server))

        // The old account page is still in the model, but it belongs to the earlier sign-in.
        #expect(model.account?.isOperator == true)
        #expect(!model.isOperator)
        #expect(model.operatorFeatures.isEmpty)

        // Read again, it says what the new account is.
        await model.load()
        #expect(!model.isOperator)
        #expect(model.operatorFeatures.isEmpty)
    }

    @Test("And an operator signing in after a non-operator is believed only after the account is read")
    func switchToOperator() async {
        let isOperator = LockedFlag()
        let session = makeSignedInSession(clients: Self.clients(isOperator))
        let model = AccountModel(session: session)
        await model.load()
        #expect(!model.isOperator)

        await session.signOut()
        isOperator.value = true
        await session.signIn(with: nil) { try AppSessionTests.allow($0) }
        #expect(!model.isOperator)
        await model.load()
        #expect(model.isOperator)
        #expect(model.operatorFeatures.count == 4)
    }

    @Test("An answer that arrives after the sign-in changed is not kept")
    func lateAnswerDropped() async {
        let gate = TestGate()
        let session = makeGatedAnswerSession(gate: gate) { endpoint in
            switch endpoint {
            case is Endpoints.Account: return Self.account(isOperator: true)
            case is Endpoints.SignOut: return EmptyResponse()
            default: throw NetworkError.notFound
            }
        }
        let model = AccountModel(session: session)
        let loading = Task { await model.load() }
        await waitForArrival(gate)
        let signingOut = Task { await session.signOut() }
        try? await Task.sleep(for: .milliseconds(50))
        gate.open()
        await loading.value
        await signingOut.value
        #expect(model.account == nil)
        #expect(!model.isOperator)
    }

    @Test("Only a 403 counts as the server saying this is not for the account")
    func refusalDetection() {
        #expect(OperatorOnly.isRefusal(.forbidden))
        #expect(OperatorOnly.isRefusal(.forbidden(message: "Restricted to Sylo's operators.")))
        #expect(!OperatorOnly.isRefusal(.notFound))
        #expect(!OperatorOnly.isRefusal(.offline))
        #expect(!OperatorOnly.isRefusal(.unauthorized))
    }
}
