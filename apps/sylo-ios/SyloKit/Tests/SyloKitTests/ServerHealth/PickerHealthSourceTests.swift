import Foundation
import Testing

/// The health note under a role or channel picker is opt-in: the web puts it (`PickerHealth`) only where a module
/// gives or takes away a role or posts in a channel. A picker for who may use the dashboard, a staff role, an ignore
/// list or a ping role must not say "move Sylo's role above it". The views are out of reach of a runtime test, so
/// this reads their source and fails when one of those pickers is switched on, or when a picker that should warn
/// loses its switch.
@Suite("Health notes on pickers")
struct PickerHealthSourceTests {
    /// `apps/sylo-ios`, found from this file.
    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    /// Every `ChannelPicker(`, `RolePicker(` and `MultiPicker(` call in the views: its title and its whole text.
    private static func pickerCalls() throws -> [(title: String, text: String, path: String)] {
        let directory = appRoot.appendingPathComponent("sylo-ios/Views")
        let walker = try #require(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil))
        var calls: [(title: String, text: String, path: String)] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let source = try String(contentsOf: url, encoding: .utf8)
            if url.lastPathComponent == "SettingsControls.swift" { continue }
            for name in ["ChannelPicker(", "RolePicker(", "MultiPicker("] {
                var searchFrom = source.startIndex
                while let found = source.range(of: name, range: searchFrom..<source.endIndex) {
                    searchFrom = found.upperBound
                    // The character before must not make this the end of another name (`struct ChannelPicker(`).
                    var depth = 1
                    var index = found.upperBound
                    while index < source.endIndex, depth > 0 {
                        let c = source[index]
                        if c == "(" { depth += 1 } else if c == ")" { depth -= 1 }
                        index = source.index(after: index)
                    }
                    let text = String(source[found.lowerBound..<index])
                    guard let titleStart = text.range(of: "title: \""),
                          let titleEnd = text.range(of: "\"", range: titleStart.upperBound..<text.endIndex) else { continue }
                    calls.append((String(text[titleStart.upperBound..<titleEnd.lowerBound]), text, url.lastPathComponent))
                }
            }
        }
        return calls
    }

    /// Pickers the module does not give, take away or post in. None may carry `health: true`.
    private static let silent: Set<String> = [
        // Who may use the dashboard
        "Edit", "Inbox", "View", "Bot master roles",
        // Staff, moderator and exempt roles and channels
        "Staff roles", "Moderator roles", "Roles that may decide", "Immunity roles", "Exempt roles", "Exempt channels",
        // Ignore and no-XP lists
        "Ignore channels", "Ignore roles", "Ignored roles", "Channels that pay nothing", "Roles that earn nothing",
        // Who may do something
        "Required roles", "Restricted roles", "Roles that may save", "Only these roles", "Only in these channels",
        "Only for these roles",
        // Pinged roles
        "Ping role", "Ping for a new application",
    ]

    @Test("The views have the pickers this test knows about")
    func found() throws {
        let titles = Set(try Self.pickerCalls().map(\.title))
        #expect(titles.count > 40)
        for title in ["Staff roles", "Edit", "Inbox", "View", "Ignore roles", "Verified role", "Log channel"] {
            #expect(titles.contains(title), "no picker titled \(title) was found")
        }
    }

    @Test("No picker for access, staff, ignore lists or ping roles shows a health note")
    func silentPickers() throws {
        for call in try Self.pickerCalls() where Self.silent.contains(call.title) {
            #expect(!call.text.contains("health: true"), "\(call.path): \"\(call.title)\" must not show a health note")
        }
    }

    @Test("The pickers the web warns under do")
    func warningPickers() throws {
        let calls = try Self.pickerCalls()
        let expected = [
            "Verified role", "Verify channel", "Birthday role", "Counting channel", "Penalty role", "Mod-log channel",
            "Suggestions channel", "Review channel", "Announcement channel", "Notification channel",
        ]
        for title in expected {
            let matching = calls.filter { $0.title == title }
            #expect(!matching.isEmpty, "no picker titled \(title)")
            for call in matching {
                #expect(call.text.contains("health: true"), "\(call.path): \"\(title)\" should show a health note")
            }
        }
    }
}
