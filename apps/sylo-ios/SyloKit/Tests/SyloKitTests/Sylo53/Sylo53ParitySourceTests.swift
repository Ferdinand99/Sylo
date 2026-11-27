import Foundation
import Testing

/// The Sylo 5.3 screens are views, out of reach of a runtime test. These tests read the app's source and fail when a
/// way in goes missing: the Bridge module's screen, Mirror to Fluxer behind its feature string, the refresh of the
/// server list on a pull, and the notes that keep their line breaks.
@Suite("Sylo 5.3 parity: the screens are wired")
struct Sylo53ParitySourceTests {
    /// `apps/sylo-ios`, found from this file.
    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private static func source(_ path: String) throws -> String {
        let url = appRoot.appendingPathComponent(path)
        #expect(FileManager.default.fileExists(atPath: url.path), "\(path) is missing")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// The code lines of a file, comments left out.
    private static func code(_ path: String) throws -> String {
        try source(path).split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    @Test("The Bridge module has a screen")
    func bridgeScreen() throws {
        let screens = try Self.code("sylo-ios/Views/ModuleSettings/ModuleScreens.swift")
        #expect(screens.contains(#""bridge""#))
        #expect(screens.contains(#"case "bridge": BridgeView(server: server, session: session)"#))
    }

    @Test("Mirror to Fluxer opens from the server tools, only on a server that announces it")
    func mirrorEntry() throws {
        let tools = try Self.code("sylo-ios/Views/Server/ServerToolsSection.swift")
        #expect(tools.contains("if session.has(.mirror)"))
        #expect(tools.contains("MirrorView(server: server, session: session)"))
        let bridge = try Self.code("sylo-ios/Views/ModuleSettings/Modules/BridgeView.swift")
        #expect(bridge.contains("session.has(.mirror)"))
    }

    @Test("Pulling the server list (and the iPad Refresh button) asks the server to look again")
    func refresh() throws {
        let main = try Self.code("sylo-ios/Views/Servers/MainView.swift")
        #expect(main.contains(".refreshable { await servers.refresh() }"))
        #expect(main.contains("Task { await servers.refresh() }"))
    }

    @Test("Appeal notes and application reasons are typed in a field of several lines")
    func multilineNotes() throws {
        for path in [
            "sylo-ios/Views/Server/Appeals/AppealsReviewView.swift",
            "sylo-ios/Views/ModuleSettings/Modules/ApplicationSubmissionsView.swift",
        ] {
            let text = try Self.code(path)
            #expect(text.contains(".multilineReasonPrompt("), "\(path) asks for the note in a one-line alert")
            #expect(!text.contains(".reasonPrompt("), "\(path) still has a one-line reason alert")
        }
        let prompt = try Self.code("sylo-ios/Views/Shared/ReasonPrompt.swift")
        #expect(prompt.contains("LimitedTextField(title: reasonLabel, text: $reason, limit: limit, lines: 3...10)"))
    }

    @Test("The shop list shows an item's description in full, with its line breaks")
    func shopDescription() throws {
        let shop = try Self.code("sylo-ios/Views/ModuleSettings/Modules/Shop/ShopItemsView.swift")
        #expect(shop.contains("Text(verbatim: item.description)"))
        let editor = try Self.code("sylo-ios/Views/ModuleSettings/Modules/Shop/ShopItemEditorView.swift")
        #expect(editor.contains("limit: ShopItemLimits.descriptionLength, lines:"))
    }
}
