import Foundation
import Testing

/// Screens the server's navigation stack pushes (a module's settings, a page, a ticket) read the server's
/// health model, open-appeals model, platform and dashboard access from their environment. The stack sits above
/// `ServerView`, so values set on `ServerView` after its `navigationDestination` modifiers never reach a pushed
/// screen: it showed no health notes and none of the access limits. Every destination therefore has to set the
/// values on the screen itself, through `scoped(_:)`. These tests read the source, because the stack is in the
/// app target, out of reach of a runtime test.
@Suite("Server environment source guard")
struct ServerEnvironmentSourceTests {
    /// `apps/sylo-ios`, found from this file.
    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private static func swiftFiles(under directory: URL) -> [URL] {
        guard let walker = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil) else { return [] }
        return walker.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    private static func source(_ relative: String) throws -> String {
        let url = appRoot.appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// The bodies of every `.navigationDestination(for:` closure, up to the line that closes it.
    private static func destinationBodies(_ text: String) -> [String] {
        let parts = text.components(separatedBy: ".navigationDestination(for:")
        return parts.dropFirst().map { part in
            var body: [String] = []
            for line in part.components(separatedBy: "\n").dropFirst() {
                if line.hasPrefix("        }") { break }
                body.append(line)
            }
            return body.joined(separator: "\n")
        }
    }

    @Test("Every destination of the server screen goes through scoped(_:)")
    func destinationsAreScoped() throws {
        let text = try Self.source("sylo-ios/Views/Server/ServerView.swift").replacingOccurrences(of: "\r\n", with: "\n")
        let bodies = Self.destinationBodies(text)
        #expect(bodies.count == 3, "ServerView has \(bodies.count) destinations; each must be checked here")
        for body in bodies {
            #expect(body.contains("scoped("), "a destination of ServerView is not wrapped in scoped(_:): \(body)")
        }
    }

    @Test("scoped(_:) sets all four values the pushed screens read")
    func scopedSetsEverything() throws {
        let text = try Self.source("sylo-ios/Views/Server/ServerView.swift").replacingOccurrences(of: "\r\n", with: "\n")
        let start = try #require(text.range(of: "private func scoped<Content: View>"))
        let rest = text[start.upperBound...]
        let end = try #require(rest.range(of: "\n    }\n"))
        let body = String(rest[..<end.lowerBound])
        for needle in [".environment(openAppeals)", ".environment(health)", ".environment(\\.serverPlatform, summary.platform)",
                       ".environment(\\.dashboardAccess, summary.effectiveAccess)"] {
            #expect(body.contains(needle), "scoped(_:) no longer sets \(needle)")
        }
    }

    @Test("A new value-based destination in the app has to be looked at: only these exist")
    func destinationsAreListed() {
        // `ServerSearchView` is shown in a sheet that sets the values above its own stack, so its destinations get them.
        let allowed = ["ServerSearchView.swift": 1, "ServerView.swift": 3]
        var found: [String: Int] = [:]
        for url in Self.swiftFiles(under: Self.appRoot.appendingPathComponent("sylo-ios")) {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            let count = text.components(separatedBy: ".navigationDestination(for:").count - 1
            if count > 0 { found[url.lastPathComponent] = count }
        }
        #expect(found == allowed, "navigation destinations found in \(found), allowed \(allowed)")
    }

    /// How many times `needle` appears in each Swift file of the app (files with none are left out).
    private static func counts(of needle: String) -> [String: Int] {
        var found: [String: Int] = [:]
        for url in swiftFiles(under: appRoot.appendingPathComponent("sylo-ios")) {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            let count = text.components(separatedBy: needle).count - 1
            if count > 0 { found[url.lastPathComponent] = count }
        }
        return found
    }

    @Test("Every other way a screen is pushed or presented is listed: links take the environment of where they are, so only value-based ones matter")
    func otherDestinationStyles() throws {
        // A `NavigationLink` with a destination, and a sheet, take the environment of the view that holds them, so
        // they get the server's values from `ServerView`. A value-based link, `navigationDestination(item:)` and
        // `navigationDestination(isPresented:)` resolve in the stack's context instead, so each one in the app is listed.
        // Value-based links: the server screen's own routes (`ModuleRoute`, `ServerPageRoute`, `TicketRoute`, which
        // `ServerView` wraps in `scoped`) and the search results (whose sheet sets the values above its stack).
        // `FocusedToolsView` (the focused moderator view's Tools tab) pushes `ModuleRoute` for applications and
        // suggestions, which `ServerView` handles through `scoped`.
        #expect(Self.counts(of: "NavigationLink(value:")
            == ["ServerSearchView.swift": 1, "TicketListView.swift": 2, "OverviewView.swift": 5, "FocusedToolsView.swift": 2])
        // The one `isPresented` destination is Settings' Health page, which reads none of the server's values.
        #expect(Self.counts(of: ".navigationDestination(isPresented:") == ["SettingsView.swift": 1])
        #expect(Self.counts(of: ".navigationDestination(item:").isEmpty, "a navigationDestination(item:) needs the server's environment")
        #expect(Self.counts(of: ".fullScreenCover(").isEmpty)

        // The types the value-based links push are the ones the stack has a destination for.
        let pattern = try NSRegularExpression(pattern: #"NavigationLink\(value: (\w+)"#)
        var types = Set<String>()
        for url in Self.swiftFiles(under: Self.appRoot.appendingPathComponent("sylo-ios")) {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                if let range = Range(match.range(at: 1), in: text) { types.insert(String(text[range])) }
            }
        }
        #expect(types == ["ModuleRoute", "ServerPageRoute", "TicketRoute", "item"])
    }

    @Test("Settings' Health page reads none of the server's values")
    func healthPageReadsNone() throws {
        let text = try Self.source("sylo-ios/Views/Settings/HealthView.swift")
        for needle in ["ServerHealthModel", "OpenAppealsModel", "dashboardAccess", "serverPlatform"] {
            #expect(!text.contains(needle), "HealthView now reads \(needle): Settings has to give it the server's environment")
        }
    }
}
