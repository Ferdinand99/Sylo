import Foundation
import Testing
@testable import SyloKit

// Sylo 5.3 ships the bridge and the server mirror as Beta. The server marks a module Beta in its overview (`beta`);
// a server that does not send the field falls back to the app's list.

@Suite("Beta modules")
struct BetaTests {
    private func card(_ json: String) throws -> OverviewCard {
        try JSONDecoder().decode(OverviewCard.self, from: Data(json.utf8))
    }

    @Test("The server's flag wins when it is sent")
    func serverFlag() throws {
        #expect(try card(#"{"kind":"module","id":"economy","name":"Economy","beta":true}"#).isBeta)
        #expect(try !card(#"{"kind":"module","id":"bridge","name":"Bridge","beta":false}"#).isBeta)
        #expect(try !card(#"{"kind":"module","id":"welcome","name":"Welcome","beta":false}"#).isBeta)
    }

    @Test("Without the field, the bridge and the mirror are Beta and nothing else is")
    func fallback() throws {
        #expect(try card(#"{"kind":"module","id":"bridge","name":"Bridge"}"#).isBeta)
        #expect(try card(#"{"kind":"link","id":"mirror","name":"Mirror to Fluxer"}"#).isBeta)
        #expect(try !card(#"{"kind":"module","id":"welcome","name":"Welcome"}"#).isBeta)
        #expect(ModuleBeta.fallbackIDs == ["bridge", "mirror"])
    }

    @Test("A screen follows the overview's card when there is one, else the list")
    func screens() {
        let off = ServerOverview(
            server: OverviewServer(id: "1", name: "S"),
            groups: [OverviewGroup(title: "Messages", cards: [
                OverviewCard(kind: .module, id: "bridge", name: "Bridge", hasToggle: true, isEnabled: true, isBeta: false, status: .on),
            ])])
        #expect(!ModuleBeta.isBeta("bridge", in: off))
        #expect(ModuleBeta.isBeta("mirror", in: off))
        #expect(ModuleBeta.isBeta("bridge", in: nil))
        #expect(!ModuleBeta.isBeta("welcome", in: nil))
        #expect(ModuleBeta.note == "Beta: this module is new and may still have rough edges. Report problems in the Sylo Discord.")
    }
}
