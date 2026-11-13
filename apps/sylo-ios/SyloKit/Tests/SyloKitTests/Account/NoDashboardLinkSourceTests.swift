import Foundation
import Testing

/// The app does everything the web dashboard does, so nothing in it may send a server admin there
/// to manage something. These tests read the source of the app and of SyloKit (the views are out of
/// reach of a runtime test) and fail on the old fallbacks coming back, and on any new way to open a
/// web page that is not listed below with its reason. To add a link, add it to the allowlist in the
/// same change and say why it is not an admin task.
@Suite("No links to the web dashboard")
struct NoDashboardLinkSourceTests {
    /// `apps/sylo-ios`, found from this file.
    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private static let roots = ["sylo-ios", "SyloKit/Sources/SyloKit", "SyloNotificationService"]

    /// Every Swift file of the app, as a path relative to `apps/sylo-ios` with its text.
    private static func sources() throws -> [(path: String, text: String)] {
        var found: [(path: String, text: String)] = []
        for root in roots {
            let directory = appRoot.appendingPathComponent(root)
            let walker = try #require(
                FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil),
                "\(directory.path) is missing, so the guard cannot read the source")
            for case let url as URL in walker where url.pathExtension == "swift" {
                let text = try String(contentsOf: url, encoding: .utf8)
                let path = url.path.replacingOccurrences(of: appRoot.path + "/", with: "")
                found.append((path, text))
            }
        }
        #expect(found.count > 100, "found only \(found.count) source files; the guard reads the wrong place")
        return found
    }

    /// The code lines of a file: comments left out, so a doc comment may still say "the dashboard".
    private static func codeLines(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).filter {
            !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//")
        }
    }

    /// The files that use `needle` in code, with how many lines each.
    private static func uses(of pattern: String, in sources: [(path: String, text: String)]) throws -> [String: Int] {
        let regex = try Regex(pattern)
        var counts: [String: Int] = [:]
        for source in sources {
            let n = codeLines(source.text).filter { $0.contains(regex) }.count
            if n > 0 { counts[source.path] = n }
        }
        return counts
    }

    @Test("The old web fallbacks are gone")
    func noFallbacks() throws {
        let sources = try Self.sources()
        for name in ["DashboardLinkSection", "dashboardURL(", "LinkCardRow", "Not in the App Yet"] {
            let hits = sources.filter { Self.codeLines($0.text).contains { $0.contains(name) } }.map(\.path)
            #expect(hits.isEmpty, "\(name) is back in \(hits)")
        }
    }

    /// String literals that send people to the web dashboard. None are left: the operator's screens
    /// (backups, restore, import, the personalizer, the stats cache and the roadmap admin) are in the app
    /// too, for operator accounts only.
    private static let allowedDashboardText: [String: Int] = [:]

    @Test("No text sends anyone to the web dashboard, except the allowlist")
    func noDashboardText() throws {
        let found = try Self.uses(of: #"(?i)\x22[^\x22\n]*(in|on|from|to|use|open) (the |its )?web dashboard[^\x22\n]*\x22"#, in: Self.sources())
        #expect(found == Self.allowedDashboardText, "web dashboard text found in \(found), allowed \(Self.allowedDashboardText)")
    }

    /// Where the app opens a web page, with how many places each. A new one must be added here.
    private static let allowedLinks: [String: Int] = [
        // The public page of an event, for people who want to look at or share what members see.
        "sylo-ios/Views/ModuleSettings/Modules/EventsSettingsView.swift": 1,
        // The public quote page (a feature the admin switches on) and a quote's Discord message.
        "sylo-ios/Views/ModuleSettings/Modules/QuoteBoardSettingsView.swift": 2,
        // A file a member attached to a ticket.
        "sylo-ios/Views/Server/Tickets/TicketThreadView.swift": 1,
        // A reference in a release note (an issue or a pull request).
        "sylo-ios/Views/Settings/ChangelogView.swift": 1,
        // "Open Dashboard" for anyone who wants it, the platform's add-to-server pages, the public
        // What's New page for a Sylo that does not send its changelog, the privacy policy, the
        // terms, and the system settings of the app.
        "sylo-ios/Views/Settings/SettingsView.swift": 6,
    ]

    @Test("The app opens web pages only where the allowlist says")
    func linksAreListed() throws {
        let found = try Self.uses(of: #"\bLink\(|\bopenURL\(|UIApplication\.shared\.open\("#, in: Self.sources())
        #expect(found == Self.allowedLinks, "web links found in \(found), allowed \(Self.allowedLinks)")
    }
}
