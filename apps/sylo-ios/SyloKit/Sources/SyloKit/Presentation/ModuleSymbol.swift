// The server names a module's icon with a web icon name (src/web/lib/moduleIcons.js, Lucide-style
// names such as "shield" or "trending-up"). The app shows SF Symbols instead, so it looks like the
// rest of iOS and scales with Dynamic Type; this table is the translation.

/// SF Symbol names for the icons modules use on the Sylo server.
public enum ModuleSymbol {
    /// Shown for an icon this build does not know yet (a module newer than the app).
    public static let fallback = "square.grid.2x2"

    /// The SF Symbol for a server icon name, or ``fallback``.
    public static func name(forIcon icon: String?) -> String {
        guard let icon else { return fallback }
        return table[icon] ?? fallback
    }

    private static let table: [String: String] = [
        "shield": "shield",
        "file-text": "doc.text",
        "filter": "line.3.horizontal.decrease.circle",
        "target": "scope",
        "shield-check": "checkmark.shield",
        "gavel": "hammer",
        "ticket": "ticket",
        "users": "person.2",
        "cake": "birthday.cake",
        "megaphone": "megaphone",
        "smile": "face.smiling",
        "hash": "number",
        "trending-up": "chart.line.uptrend.xyaxis",
        "star": "star",
        "pin": "pin",
        "command": "command",
        "user-plus": "person.badge.plus",
        "bar-chart": "chart.bar",
        "message-circle": "bubble.left",
        "zap": "bolt",
        "moon": "moon",
        "activity": "waveform.path.ecg",
        "mic": "mic",
        "gamepad": "gamecontroller",
        "bell": "bell",
        "gift": "gift",
        "calendar": "calendar",
        "lightbulb": "lightbulb",
        "twitch": "play.tv",
        "youtube": "play.rectangle",
        "kick": "play.circle",
        "rss": "dot.radiowaves.up.forward",
        "trash-2": "trash",
        "github": "chevron.left.forwardslash.chevron.right",
        "gear": "gearshape",
        "message-square": "text.bubble",
    ]
}
