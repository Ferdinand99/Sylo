import Testing
@testable import SyloKit

@Suite("Module icons as SF Symbols")
struct ModuleSymbolTests {
    // Every icon name the server sends (src/web/lib/moduleIcons.js, MODULE_ICONS).
    static let serverIcons = [
        "shield", "file-text", "filter", "target", "shield-check", "gavel", "ticket", "users", "cake",
        "megaphone", "smile", "hash", "trending-up", "star", "pin", "command", "user-plus", "bar-chart",
        "message-circle", "zap", "moon", "activity", "mic", "gamepad", "bell", "gift", "twitch",
        "youtube", "kick", "rss", "trash-2", "github", "gear", "message-square",
    ]

    @Test("each icon the server uses has its own symbol", arguments: serverIcons)
    func known(icon: String) {
        #expect(ModuleSymbol.name(forIcon: icon) != ModuleSymbol.fallback)
    }

    @Test("an unknown or missing icon falls back to a neutral symbol")
    func unknown() {
        #expect(ModuleSymbol.name(forIcon: "something-new") == ModuleSymbol.fallback)
        #expect(ModuleSymbol.name(forIcon: nil) == ModuleSymbol.fallback)
    }

    @Test("a few spot checks")
    func spotChecks() {
        #expect(ModuleSymbol.name(forIcon: "shield") == "shield")
        #expect(ModuleSymbol.name(forIcon: "ticket") == "ticket")
        #expect(ModuleSymbol.name(forIcon: "gear") == "gearshape")
    }
}
