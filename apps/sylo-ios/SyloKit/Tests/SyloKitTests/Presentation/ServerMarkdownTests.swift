import Foundation
import Testing
@testable import SyloKit

@Suite("Server Markdown links")
struct ServerMarkdownTests {
    private func links(_ source: String) -> [URL] {
        ServerMarkdown.attributed(source).runs.compactMap(\.link)
    }

    @Test("An https link stays a link")
    func httpsStays() {
        #expect(links("See [the docs](https://sylobot.com/docs) now") == [URL(string: "https://sylobot.com/docs")!])
        #expect(links("[x](HTTPS://sylobot.com)").count == 1)
    }

    @Test("Every other scheme is plain text, not a link", arguments: [
        "[call](tel:+4712345678)", "[mail](mailto:a@b.example)", "[open](sylo://auth?code=1)",
        "[x](javascript:alert(1))", "[x](http://example.com)", "[x](ftp://example.com/f)",
        "[x](file:///etc/hosts)", "[x](/relative/path)", "[x](//example.com/path)", "[x](https:///nohost)",
        "[x](https://user:pw@example.com/)", "[x](https://example.com@evil.example/)",
        "<http://example.com>", "[x](itms-apps://apps.apple.com/app/id1)", "[x](sms:123)",
    ])
    func otherSchemesDropped(source: String) {
        #expect(links(source).isEmpty)
        // The words stay.
        #expect(!String(ServerMarkdown.attributed(source).characters).isEmpty)
    }

    @Test("A bad link does not take the good ones or the formatting with it")
    func mixed() {
        let text = ServerMarkdown.attributed("**bold** [bad](tel:1) and [good](https://sylobot.com)")
        #expect(String(text.characters) == "bold bad and good")
        #expect(text.runs.compactMap(\.link) == [URL(string: "https://sylobot.com")!])
        #expect(text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }

    @Test("Text that is not Markdown shows as it is")
    func plain() {
        #expect(String(ServerMarkdown.attributed("just text").characters) == "just text")
    }

    @Test("Only https addresses with a host and no credentials are openable")
    func openable() {
        #expect(ServerMarkdown.isOpenable(URL(string: "https://github.com/Ferdinand99/Sylo/issues/1")!))
        #expect(!ServerMarkdown.isOpenable(URL(string: "http://github.com")!))
        #expect(!ServerMarkdown.isOpenable(URL(string: "tel:+1")!))
        #expect(!ServerMarkdown.isOpenable(URL(string: "/x")!))
        #expect(!ServerMarkdown.isOpenable(URL(string: "https://a@b.example")!))
        #expect(ServerMarkdown.openable(nil) == nil)
        #expect(ServerMarkdown.openable(URL(string: "javascript:void(0)")!) == nil)
    }

    @Test("Changelog addresses that are not https are dropped when read")
    func changelogAddresses() throws {
        let json = ##"""
        {"text":"t","refs":[{"label":"#1","url":"http://example.com/1"},{"label":"#2","url":"tel:5"},
                            {"label":"#3","url":"https://github.com/x/y/issues/3"}]}
        """##
        let item = try JSONDecoder().decode(ChangelogItem.self, from: Data(json.utf8))
        #expect(item.refs.map(\.url) == [nil, nil, URL(string: "https://github.com/x/y/issues/3")])
        let release = try JSONDecoder().decode(
            ChangelogRelease.self, from: Data(##"{"version":"1","url":"sylo://x","sections":[]}"##.utf8))
        #expect(release.url == nil)
    }
}
