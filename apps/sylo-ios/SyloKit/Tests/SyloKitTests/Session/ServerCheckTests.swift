import Testing
@testable import SyloKit

@Suite("Server check")
struct ServerCheckTests {
    @Test("a current Sylo with a login is ready")
    func ready() {
        #expect(ServerCheck(ServerInfo()) == .ready)
    }

    @Test("an answer that isn't from Sylo")
    func notSylo() {
        #expect(ServerCheck(ServerInfo(name: "Something else")) == .notSylo)
    }

    @Test("a Sylo in open mode, or with no login offered, has no sign-in")
    func noLogin() {
        #expect(ServerCheck(ServerInfo(isLoginEnabled: false)) == .noLogin)
        #expect(ServerCheck(ServerInfo(loginProviders: [])) == .noLogin)
    }

    @Test("an older app API, or no app login, is too old")
    func tooOld() {
        #expect(ServerCheck(ServerInfo(apiVersion: 0)) == .tooOld)
        #expect(ServerCheck(ServerInfo(apiVersion: supportedAPIVersion - 1)) == .tooOld)
        #expect(ServerCheck(ServerInfo(features: [.liveAccess])) == .tooOld)
    }

    @Test("a newer app API needs a newer app")
    func needsNewerApp() {
        #expect(ServerCheck(ServerInfo(apiVersion: supportedAPIVersion + 1)) == .needsNewerApp)
    }

    @Test("a missing info endpoint means an older Sylo; anything not Sylo-shaped means not Sylo")
    func fromErrors() {
        #expect(ServerCheck(NetworkError.notFound) == .tooOld)
        #expect(ServerCheck(NetworkError.notASyloServer) == .notSylo)
        #expect(ServerCheck(NetworkError.decoding("x")) == .notSylo)
        #expect(ServerCheck(NetworkError.offline) == .failed(.offline))
    }

    @Test("every outcome but ready explains itself")
    func messages() {
        #expect(ServerCheck.ready.userMessage == nil)
        for check in [ServerCheck.notSylo, .noLogin, .tooOld, .needsNewerApp, .failed(.unreachable)] {
            #expect(check.userMessage?.isEmpty == false)
        }
        #expect(ServerCheck.failed(.unreachable).userMessage == NetworkError.unreachable.userMessage)
    }
}
