import Foundation

// The difference between two saved settings, for the change history: "Show changes" under an audit entry.
// A port of web-v2/src/configDiff.js: changed fields only, lists as added and removed, lists of objects
// matched by `id`, readable labels where one is known and the raw key otherwise. Pure functions.

public enum ConfigDiff {
    /// What the server stores in place of a secret.
    public static let mask = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}"
    /// How many rows a diff shows before it says "and n more".
    public static let maxRows = 60
    private static let maxText = 200

    /// One line of the diff.
    public struct Row: Sendable, Equatable, Identifiable {
        public enum Kind: Sendable, Equatable {
            case changed(before: JSONValue, after: JSONValue)
            case added(JSONValue)
            case removed(JSONValue)
            /// A list of plain values: what was added and what was removed.
            case list(added: [JSONValue], removed: [JSONValue])
            /// Something changed that the history does not show (a secret).
            case hidden
        }

        public let index: Int
        public let path: [String]
        public let kind: Kind

        public var id: Int { index }

        /// The path as one line: readable names joined with " > ".
        public var pathText: String { ConfigDiff.pathText(path) }
    }

    /// A row on its way to being numbered.
    private struct Found {
        let path: [String]
        let kind: Row.Kind
    }

    /// Readable names for settings. A setting not listed shows its own key.
    private static let labels: [String: String] = [
        "enabled": "Enabled", "channel": "Channel", "channelId": "Channel", "channels": "Channels",
        "roleId": "Role", "roles": "Roles", "message": "Message", "messages": "Messages", "title": "Title",
        "name": "Name", "description": "Description", "content": "Message text", "color": "Colour",
        "logChannel": "Log channel", "logChannelId": "Log channel", "logMode": "Log mode",
        "reviewChannelId": "Review channel", "notifyChannel": "Notification channel",
        "joinLogChannelId": "Join log channel", "promptText": "Prompt text",
        "cooldownSeconds": "Cooldown (seconds)", "cooldownDays": "Cooldown (days)",
        "graceHours": "Grace period (hours)", "timeoutMinutes": "Timeout (minutes)",
        "kickAfterMinutes": "Kick after (minutes)", "refreshMinutes": "Refresh every (minutes)",
        "staffRoles": "Staff roles", "exemptRoles": "Exempt roles", "exemptChannels": "Exempt channels",
        "ignoreChannels": "Ignored channels", "ignoreRoles": "Ignored roles", "greeting": "Greeting",
        "closeMessage": "Close message", "verifiedRoleId": "Verified role", "mode": "Mode", "rules": "Rules",
        "rewards": "Rewards", "boards": "Boards", "feeds": "Feeds", "alerts": "Alerts", "hubs": "Hubs",
        "stickies": "Sticky messages", "responders": "Responders", "questions": "Questions", "events": "Events",
        "trigger": "Welcome trigger", "triggerRoleIds": "Trigger roles", "joinEnabled": "Welcome on join",
        "joinChannel": "Welcome channel", "joinMessage": "Welcome message", "leaveEnabled": "Goodbye message",
        "leaveChannel": "Goodbye channel", "leaveMessage": "Goodbye text", "dmEnabled": "Welcome by DM",
        "dmMessage": "DM text", "useEmbed": "Use an embed", "card": "Welcome card",
        "cardBackground": "Card background", "autoroleEnabled": "Give auto-roles",
        "dmOnPunish": "Tell members by DM", "warnThresholds": "Warning thresholds",
        "infractionRetentionDays": "Keep cases (days)", "publicPage": "Public page",
        "publicLeaderboard": "Public leaderboard", "modlogChannelId": "Mod-log channel",
        "embedColor": "Embed colour", "botMasterRoleIds": "Bot master roles", "commandPrefix": "Command prefix",
    ]

    /// The readable name of a setting: the known label, or the key itself.
    public static func label(for key: String) -> String { labels[key] ?? key }

    public static func pathText(_ path: [String]) -> String {
        path.map(label(for:)).joined(separator: " \u{203A} ")
    }

    // MARK: Diffing

    private static func isScalar(_ value: JSONValue) -> Bool {
        switch value {
        case .array, .object: false
        case .null, .bool, .int, .double, .string: true
        }
    }

    private static func itemIDText(_ value: JSONValue?) -> String? {
        switch value {
        case .string(let text)? where !text.isEmpty: text
        case .int(let number)?: String(number)
        case .double(let number)?: formatNumber(number)
        default: nil
        }
    }

    /// How an item of a list is called in a path: its name, or "item 3".
    private static func itemName(_ item: JSONValue?, _ index: Int) -> String {
        if case .object(let fields)? = item {
            for key in ["name", "title", "label", "trigger", "id"] {
                if case .string(let text)? = fields[key], !text.isEmpty { return String(text.prefix(40)) }
                if case .int(let number)? = fields[key] { return String(number) }
                if case .double(let number)? = fields[key] { return formatNumber(number) }
            }
        }
        return "item \(index + 1)"
    }

    private static func hasIDs(_ list: [JSONValue]) -> Bool {
        guard !list.isEmpty else { return false }
        return list.allSatisfy { item in
            if case .object(let fields) = item { return itemIDText(fields["id"]) != nil }
            return false
        }
    }

    private static func idKey(_ item: JSONValue) -> String {
        if case .object(let fields) = item { return itemIDText(fields["id"]) ?? "" }
        return ""
    }

    private static func walk(_ path: [String], _ before: JSONValue?, _ after: JSONValue?, _ out: inout [Found]) {
        switch (before, after) {
        case (nil, nil):
            return
        case (nil, let added?):
            out.append(Found(path: path, kind: .added(added)))
            return
        case (let removed?, nil):
            out.append(Found(path: path, kind: .removed(removed)))
            return
        case (let b?, let a?):
            if b == a { return }
            walkBoth(path, b, a, &out)
        }
    }

    private static func walkBoth(_ path: [String], _ b: JSONValue, _ a: JSONValue, _ out: inout [Found]) {
        if case .array(let oldList) = b, case .array(let newList) = a {
            if (oldList + newList).allSatisfy(isScalar) {
                let removed = oldList.filter { !newList.contains($0) }
                let added = newList.filter { !oldList.contains($0) }
                if removed.isEmpty, added.isEmpty {
                    out.append(Found(path: path, kind: .changed(before: b, after: a))) // the same items in another order
                } else {
                    out.append(Found(path: path, kind: .list(added: added, removed: removed)))
                }
                return
            }
            if hasIDs(oldList), hasIDs(newList) {
                var was: [String: JSONValue] = [:]
                for item in oldList { was[idKey(item)] = item }
                var now = Set<String>()
                for item in newList { now.insert(idKey(item)) }
                for (index, item) in newList.enumerated() {
                    let at = path + [itemName(item, index)]
                    if let old = was[idKey(item)] {
                        walk(at, old, item, &out)
                    } else {
                        out.append(Found(path: at, kind: .added(item)))
                    }
                }
                for (index, item) in oldList.enumerated() where !now.contains(idKey(item)) {
                    out.append(Found(path: path + [itemName(item, index)], kind: .removed(item)))
                }
                return
            }
            // Items without an id: the ones the same on both sides are not shown, so one item removed at
            // the top does not turn every later item into a change. What is left is paired by place.
            var removed = oldList
            var added: [JSONValue] = []
            for item in newList {
                if let at = removed.firstIndex(of: item) {
                    removed.remove(at: at)
                } else {
                    added.append(item)
                }
            }
            for index in 0..<max(added.count, removed.count) {
                let item = index < added.count ? added[index] : removed[index]
                walk(path + [itemName(item, index)],
                     index < removed.count ? removed[index] : nil,
                     index < added.count ? added[index] : nil, &out)
            }
            return
        }
        if case .object(let oldFields) = b, case .object(let newFields) = a {
            let keys = Set(oldFields.keys).union(newFields.keys).sorted()
            for key in keys { walk(path + [key], oldFields[key], newFields[key], &out) }
            return
        }
        out.append(Found(path: path, kind: .changed(before: b, after: a)))
    }

    /// The rows that differ between the two sides of a stored change (only the settings that changed, a
    /// missing key meaning "did not exist"). `more` is how many rows were left out (over `limit`; a nil
    /// limit leaves none out).
    public static func rows(
        before: [String: JSONValue], after: [String: JSONValue], limit: Int? = maxRows
    ) -> (rows: [Row], more: Int) {
        var all: [Found] = []
        for key in Set(before.keys).union(after.keys).sorted() {
            var found: [Found] = []
            walk([key], before[key], after[key], &found)
            if found.isEmpty {
                all.append(Found(path: [key], kind: .hidden))
            } else {
                all += found
            }
        }
        let cap = limit ?? all.count
        let shown = all.prefix(cap).enumerated().map { Row(index: $0.offset, path: $0.element.path, kind: $0.element.kind) }
        return (shown, max(0, all.count - cap))
    }

    // MARK: Values as text

    private static func formatNumber(_ number: Double) -> String {
        if number.isFinite, number == number.rounded(), abs(number) < 1e15 { return String(Int(number)) }
        return String(number)
    }

    /// A value as text. `names` maps channel and role ids to "#general" or "@Moderators". A missing value
    /// reads "(not set)".
    ///
    /// With `full`, nothing is cut: a long text, a long list and a whole item are shown in full, and an item
    /// reads as one "Setting: value" line per field, with the ids in it named like the top-level ones. The
    /// import review uses it, because a person has to judge everything that would be written. The history
    /// keeps the short form.
    public static func format(_ value: JSONValue?, names: [String: String] = [:], full: Bool = false) -> String {
        guard let value else { return "(not set)" }
        switch value {
        case .null: return "(empty)"
        case .bool(let flag): return flag ? "On" : "Off"
        case .int(let number): return String(number)
        case .double(let number): return formatNumber(number)
        case .string(let text):
            if text.isEmpty { return "(empty)" }
            if text == mask { return "\(mask) (hidden)" }
            if let name = names[text] { return name }
            if full { return text }
            return text.count > maxText ? String(text.prefix(maxText)) + "\u{2026}" : text
        case .array(let list):
            if list.isEmpty { return "(empty list)" }
            if full {
                if list.allSatisfy(isScalar) { return list.map { format($0, names: names, full: true) }.joined(separator: ", ") }
                return lines(of: value, names: names, depth: 0).joined(separator: "\n")
            }
            let shown = list.prefix(6).map { format($0, names: names) }
            return list.count > 6 ? "\(shown.joined(separator: ", ")) and \(list.count - 6) more" : shown.joined(separator: ", ")
        case .object:
            if full {
                let fields = lines(of: value, names: names, depth: 0)
                return fields.isEmpty ? "(empty)" : fields.joined(separator: "\n")
            }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let text = (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
            return text.count > maxText ? String(text.prefix(maxText)) + "\u{2026}" : text
        }
    }

    /// An item or a list of items as readable lines: "Role: @Moderators", nested items indented.
    private static func lines(of value: JSONValue, names: [String: String], depth: Int) -> [String] {
        let pad = String(repeating: "  ", count: depth)
        switch value {
        case .object(let fields):
            var out: [String] = []
            for key in fields.keys.sorted() {
                guard let field = fields[key] else { continue }
                let name = label(for: key)
                switch field {
                case .object(let inner) where !inner.isEmpty:
                    out.append("\(pad)\(name):")
                    out += lines(of: field, names: names, depth: depth + 1)
                case .array(let list) where !list.isEmpty && !list.allSatisfy(isScalar):
                    out.append("\(pad)\(name):")
                    out += lines(of: field, names: names, depth: depth + 1)
                default:
                    out.append("\(pad)\(name): \(format(field, names: names, full: true))")
                }
            }
            return out
        case .array(let list):
            var out: [String] = []
            for item in list {
                if isScalar(item) {
                    out.append("\(pad)\u{2022} \(format(item, names: names, full: true))")
                } else {
                    let inner = lines(of: item, names: names, depth: depth + 1)
                    out.append("\(pad)\u{2022}")
                    out += inner
                }
            }
            return out
        default:
            return ["\(pad)\(format(value, names: names, full: true))"]
        }
    }

    /// The text of a list of values (the added or the removed of a ``Row/Kind/list`` row).
    public static func format(list: [JSONValue], names: [String: String] = [:], full: Bool = false) -> String {
        format(.array(list), names: names, full: full)
    }
}
