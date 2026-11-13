import Foundation
import Testing
@testable import SyloKit

@Suite("Embed draft")
struct EmbedDraftTests {
    private static func object(_ spec: EmbedSpec) throws -> [String: Any] {
        let data = try JSONEncoder().encode(spec)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func keys(_ spec: EmbedSpec) throws -> Set<String> {
        Set(try object(spec).keys)
    }

    private static let sample = EmbedDraft(
        content: "Hello {user}", color: "#57f287", authorName: "Sylo", authorIcon: "https://example.com/a.png",
        title: "Welcome", description: "Read the rules.", image: "https://example.com/i.png",
        thumbnail: "https://example.com/t.png", footerText: "Be nice", footerIcon: "https://example.com/f.png",
        timestamp: true,
        fields: [EmbedDraft.Field(name: "Rule 1", value: "No spam", inline: true), EmbedDraft.Field(name: "Rule 2", value: "Be kind")])

    // MARK: Key sets, as EmbedEditor.jsx serialises them

    @Test("The default options send the web editor's default keys")
    func defaultKeys() throws {
        #expect(try Self.keys(Self.sample.spec()) == [
            "kind", "color", "title", "image", "authorName", "authorIcon", "description", "thumbnail",
            "footerText", "footerIcon", "fields",
        ])
    }

    @Test("Every option on adds the message text and the timestamp")
    func allKeys() throws {
        let options = EmbedOptions(content: true, timestamp: true)
        #expect(try Self.keys(Self.sample.spec(options)) == [
            "kind", "color", "title", "image", "content", "authorName", "authorIcon", "description", "thumbnail",
            "footerText", "footerIcon", "timestamp", "fields",
        ])
    }

    @Test("Every option off leaves the always-sent keys and the footer")
    func minimalKeys() throws {
        let options = EmbedOptions(
            content: false, author: false, description: false, fields: false, thumbnail: false,
            footerIcon: false, timestamp: false)
        #expect(try Self.keys(Self.sample.spec(options)) == ["kind", "color", "title", "image", "footerText"])
    }

    @Test("Each option switches only its own keys", arguments: [
        ("content", EmbedOptions(content: true), Set(["content"])),
        ("author", EmbedOptions(author: false), Set(["authorName", "authorIcon"])),
        ("description", EmbedOptions(description: false), Set(["description"])),
        ("fields", EmbedOptions(fields: false), Set(["fields"])),
        ("thumbnail", EmbedOptions(thumbnail: false), Set(["thumbnail"])),
        ("footerIcon", EmbedOptions(footerIcon: false), Set(["footerIcon"])),
        ("timestamp", EmbedOptions(timestamp: true), Set(["timestamp"])),
    ])
    func optionKeys(name: String, options: EmbedOptions, difference: Set<String>) throws {
        let base = try Self.keys(Self.sample.spec())
        let changed = try Self.keys(Self.sample.spec(options))
        #expect(base.symmetricDifference(changed) == difference)
    }

    @Test("A module that stores the footer as `footer` gets that key and not footerText")
    func footerKey() throws {
        let json = try Self.object(Self.sample.spec(EmbedOptions(footerKey: .footer)))
        #expect(json["footer"] as? String == "Be nice")
        #expect(json["footerText"] == nil)
    }

    @Test("The values are sent as typed")
    func values() throws {
        let json = try Self.object(Self.sample.spec(EmbedOptions(content: true, timestamp: true)))
        #expect(json["kind"] as? String == "embed")
        #expect(json["color"] as? String == "#57f287")
        #expect(json["content"] as? String == "Hello {user}")
        #expect(json["title"] as? String == "Welcome")
        #expect(json["description"] as? String == "Read the rules.")
        #expect(json["authorName"] as? String == "Sylo")
        #expect(json["image"] as? String == "https://example.com/i.png")
        #expect(json["timestamp"] as? Bool == true)
        let fields = try #require(json["fields"] as? [[String: Any]])
        #expect(fields.count == 2)
        #expect(Set(fields[0].keys) == ["name", "value", "inline"])
        #expect(fields[0]["inline"] as? Bool == true)
        #expect(fields[1]["inline"] as? Bool == false)
    }

    @Test("Fields with neither a name nor a value are not sent; one with only a name is")
    func fieldFilter() throws {
        var draft = EmbedDraft()
        draft.fields = [
            EmbedDraft.Field(), EmbedDraft.Field(name: "Only name"), EmbedDraft.Field(value: "Only value"),
        ]
        let fields = try #require(try Self.object(draft.spec())["fields"] as? [[String: Any]])
        #expect(fields.map { $0["name"] as? String } == ["Only name", ""])
        #expect(fields.map { $0["value"] as? String } == ["", "Only value"])
    }

    // MARK: Colour

    @Test("An empty or unreadable colour is sent as the default one")
    func defaultColour() throws {
        for color in ["", "red", "#12345", "#12345g", "5865f2", "#5865f2ff"] {
            let json = try Self.object(EmbedDraft(color: color).spec())
            #expect(json["color"] as? String == "#5865f2", "colour \(color)")
        }
        let own = try Self.object(EmbedDraft(color: "").spec(EmbedOptions(defaultColor: "#ed4245")))
        #expect(own["color"] as? String == "#ed4245")
        // A default that is itself unreadable never reaches the server.
        let broken = try Self.object(EmbedDraft(color: "").spec(EmbedOptions(defaultColor: "nope")))
        #expect(broken["color"] as? String == "#5865f2")
        #expect(try Self.object(EmbedDraft(color: "#ABCDEF").spec())["color"] as? String == "#ABCDEF")
    }

    @Test("The colour as components and back")
    func rgbRoundTrip() {
        var draft = EmbedDraft(color: "#ff8000")
        let rgb = draft.rgb()
        #expect(rgb.red == 1)
        #expect(abs(rgb.green - 128.0 / 255) < 0.0001)
        #expect(rgb.blue == 0)

        draft.setRGB(red: 0, green: 0.5, blue: 1)
        #expect(draft.color == "#0080ff")
        draft.setRGB(red: -1, green: 2, blue: 0)
        #expect(draft.color == "#00ff00")
        draft.setRGB(red: 0, green: 0, blue: 0.02)
        #expect(draft.color == "#000005")

        let unset = EmbedDraft(color: "").rgb()
        #expect(unset.red == Double(0x58) / 255)
    }

    // MARK: Decoding a stored embed

    @Test("A stored embed from the server is read, and what is missing is empty")
    func decodes() throws {
        let json = #"""
        {"kind":"embed","color":"#ed4245","title":"T","description":"D","image":"https://e.com/i.png",
         "thumbnail":"","authorName":"A","authorIcon":"","footerText":"F","footerIcon":"","timestamp":true,
         "fields":[{"name":"n","value":"v","inline":true},{"name":"only"}],"unknownKey":[1,2]}
        """#
        let draft = try JSONDecoder().decode(EmbedDraft.self, from: Data(json.utf8))
        #expect(draft.color == "#ed4245")
        #expect(draft.title == "T")
        #expect(draft.footerText == "F")
        #expect(draft.timestamp)
        #expect(draft.content == "")
        #expect(draft.fields == [EmbedDraft.Field(name: "n", value: "v", inline: true), EmbedDraft.Field(name: "only")])

        let empty = try JSONDecoder().decode(EmbedDraft.self, from: Data("{}".utf8))
        #expect(empty == EmbedDraft())
    }

    @Test("A footer stored as `footer` is read like the web editor does")
    func decodesFooterKey() throws {
        let one = try JSONDecoder().decode(EmbedDraft.self, from: Data(#"{"footer":"Old footer"}"#.utf8))
        #expect(one.footerText == "Old footer")
        let both = try JSONDecoder().decode(EmbedDraft.self, from: Data(#"{"footerText":"New","footer":"Old"}"#.utf8))
        #expect(both.footerText == "New")
    }

    @Test("An entry in the fields that cannot be read is dropped, not fatal")
    func lossyFields() throws {
        let draft = try JSONDecoder().decode(
            EmbedDraft.self, from: Data(#"{"fields":[{"name":"ok","value":"v"},"junk",{"name":5}]}"#.utf8))
        #expect(draft.fields.map(\.name) == ["ok"])
    }

    @Test("What is sent reads back the same, for every option set", arguments: [
        EmbedOptions(), EmbedOptions(content: true, timestamp: true), EmbedOptions(footerKey: .footer),
        EmbedOptions(author: false, description: false, thumbnail: false, footerIcon: false),
    ])
    func roundTrip(options: EmbedOptions) throws {
        let data = try JSONEncoder().encode(Self.sample.spec(options))
        let back = try JSONDecoder().decode(EmbedDraft.self, from: data)

        // Only what the options send comes back; the rest is empty, and everything else is equal.
        var expected = EmbedDraft(color: Self.sample.color, title: Self.sample.title, image: Self.sample.image)
        expected.footerText = Self.sample.footerText
        if options.content { expected.content = Self.sample.content }
        if options.author { expected.authorName = Self.sample.authorName; expected.authorIcon = Self.sample.authorIcon }
        if options.description { expected.description = Self.sample.description }
        if options.thumbnail { expected.thumbnail = Self.sample.thumbnail }
        if options.footerIcon { expected.footerIcon = Self.sample.footerIcon }
        if options.timestamp { expected.timestamp = Self.sample.timestamp }
        if options.fields { expected.fields = Self.sample.fields }
        #expect(back == expected)
    }

    @Test("A stored sticky embed opens in the editor and saves with the same keys")
    func stickyEmbedKeysMatch() throws {
        let sticky = StickyEmbed(
            title: "Rules", description: "Be nice", color: "#5865f2", image: "https://e.com/i.png",
            thumbnail: "https://e.com/t.png", authorName: "Mods", authorIcon: "https://e.com/a.png",
            footerText: "Thanks", footerIcon: "https://e.com/f.png",
            fields: [StickyEmbed.Field(name: "1", value: "x")])
        let stickyJSON = try JSONEncoder().encode(sticky)
        let stickyObject = try #require(try JSONSerialization.jsonObject(with: stickyJSON) as? [String: Any])
        let stickyKeys = Set(stickyObject.keys)

        let draft = try JSONDecoder().decode(EmbedDraft.self, from: stickyJSON)
        #expect(draft.title == "Rules")
        #expect(draft.fields.count == 1)
        #expect(try Self.keys(draft.spec()) == stickyKeys)
    }

    // MARK: Emptiness

    @Test("An embed with nothing in it is empty, whatever the colour")
    func emptiness() {
        #expect(EmbedDraft().isEmpty())
        #expect(EmbedDraft(color: "#ff0000").isEmpty())
        #expect(!EmbedDraft(title: "x").isEmpty())
        #expect(!EmbedDraft(fields: [EmbedDraft.Field(value: "v")]).isEmpty())
        // Text a hidden option would not send does not count.
        #expect(EmbedDraft(content: "x").isEmpty())
        #expect(!EmbedDraft(content: "x").isEmpty(EmbedOptions(content: true)))
        #expect(EmbedDraft(description: "x").isEmpty(EmbedOptions(description: false)))
        #expect(EmbedDraft(fields: [EmbedDraft.Field(name: "n")]).isEmpty(EmbedOptions(fields: false)))
    }
}
