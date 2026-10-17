import Testing
@testable import SyloKit

@Suite("Display names")
struct DisplayNameTests {
    @Test("platforms by their product names; an unknown one as the server sent it")
    func platforms() {
        #expect(Platform.discord.displayName == "Discord")
        #expect(Platform.fluxer.displayName == "Fluxer")
        #expect(Platform.other("matrix").displayName == "matrix")
    }

    @Test("the hosted server is Sylo; any other by host, port and path")
    func servers() throws {
        #expect(ServerURL.hosted.displayName == "Sylo")
        #expect(try ServerURL("https://sylo.example.com").displayName == "sylo.example.com")
        #expect(try ServerURL("https://example.com:8443/sylo/").displayName == "example.com:8443/sylo")
    }
}
