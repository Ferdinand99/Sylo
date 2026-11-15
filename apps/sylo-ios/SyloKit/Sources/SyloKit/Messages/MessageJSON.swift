import Foundation

// Raw JSON of a message, in the shape Discord (and tools such as Discohook) use for a message: content, embeds
// and, for link buttons, components. A port of web-v2/src/embedJson.js (Sylo 5.2, P6). The message builder and the
// Welcome channel export what is on the screen and import JSON from a file. Import never trusts the JSON: it is
// checked against the limits of one message, and anything it cannot carry over is named in `warnings`.
// Nothing here talks to the server; the result fills the form, which is saved the usual way.

public enum MessageJSON {
    /// What Discord itself allows in one message, for what the server's embed limits do not list.
    public enum Discord {
        public static let content = 2000
        public static let embeds = 10
        public static let totalChars = 6000
        public static let rows = 5
        public static let buttonsPerRow = 5
        public static let buttonLabel = 80
    }

    /// The limits to check an import against.
    public struct Limits: Sendable, Equatable {
        public var embed: EmbedLimits
        public var content: Int
        public var embeds: Int

        public init(embed: EmbedLimits = .standard, content: Int? = nil, embeds: Int = Discord.embeds) {
            self.embed = embed
            self.content = content ?? embed.content
            self.embeds = embeds
        }
    }

    public enum Outcome: Sendable, Equatable {
        case imported(Imported)
        case failed([String])
    }

    public struct Imported: Sendable, Equatable {
        public var content: String
        public var embeds: [EmbedItem]
        public var links: [ComposedLinkButton]
        /// What the JSON had that was not carried over.
        public var warnings: [String]
    }

    private static let maxErrors = 8

    // MARK: Export

    private static func colorValue(_ hex: String) -> Int {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        if digits.count == 6, let value = Int(digits, radix: 16) { return value }
        return 0x5865f2
    }

    private static func emojiJSON(_ emoji: String) -> JSONValue? {
        let text = emoji.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        // `<:name:id>` or `<a:name:id>`
        if text.hasPrefix("<"), text.hasSuffix(">") {
            let parts = text.dropFirst().dropLast().split(separator: ":", omittingEmptySubsequences: false)
            if parts.count == 3, parts[0] == "" || parts[0] == "a", !parts[2].isEmpty, parts[2].allSatisfy(\.isNumber) {
                return .object(["name": .string(String(parts[1])), "id": .string(String(parts[2])),
                                "animated": .bool(parts[0] == "a")])
            }
        }
        return .object(["name": .string(text)])
    }

    /// The message as Discord message JSON: content, embeds and link buttons. Role buttons and menus are left
    /// out (they only work through Sylo); a banner becomes an embed with just an image and a caption.
    public static func export(content: String, embeds: [EmbedItem], links: [ComposedLinkButton]) -> JSONValue {
        var out: [String: JSONValue] = [:]
        if !content.isEmpty { out["content"] = .string(content) }
        var list: [JSONValue] = []
        for item in embeds where !item.isOpaque {
            let e = item.draft
            var j: [String: JSONValue] = [:]
            if !e.title.isEmpty { j["title"] = .string(e.title) }
            if !e.description.isEmpty { j["description"] = .string(e.description) }
            j["color"] = .int(colorValue(e.color))
            if !e.authorName.isEmpty {
                var author: [String: JSONValue] = ["name": .string(e.authorName)]
                if !e.authorIcon.isEmpty { author["icon_url"] = .string(e.authorIcon) }
                j["author"] = .object(author)
            }
            if !e.thumbnail.isEmpty { j["thumbnail"] = .object(["url": .string(e.thumbnail)]) }
            if !e.image.isEmpty { j["image"] = .object(["url": .string(e.image)]) }
            if !e.footerText.isEmpty {
                var footer: [String: JSONValue] = ["text": .string(e.footerText)]
                if !e.footerIcon.isEmpty { footer["icon_url"] = .string(e.footerIcon) }
                j["footer"] = .object(footer)
            }
            let fields = e.fields.filter { !$0.name.isEmpty && !$0.value.isEmpty }
            if !fields.isEmpty {
                j["fields"] = .array(fields.map {
                    .object(["name": .string($0.name), "value": .string($0.value), "inline": .bool($0.inline)])
                })
            }
            list.append(.object(j))
        }
        if !list.isEmpty { out["embeds"] = .array(list) }
        let buttons: [JSONValue] = links.filter(\.isComplete).map { link in
            var button: [String: JSONValue] = ["type": .int(2), "style": .int(5), "url": .string(link.url.trimmingCharacters(in: .whitespaces))]
            let label = link.label.trimmingCharacters(in: .whitespaces)
            if !label.isEmpty { button["label"] = .string(label) }
            if let emoji = emojiJSON(link.emoji) { button["emoji"] = emoji }
            return .object(button)
        }
        if !buttons.isEmpty { out["components"] = .array([.object(["type": .int(1), "components": .array(buttons)])]) }
        return .object(out)
    }

    /// The export as pretty, stable JSON text.
    public static func exportData(content: String, embeds: [EmbedItem], links: [ComposedLinkButton]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(export(content: content, embeds: embeds, links: links))
    }

    // MARK: Import

    private static func isObject(_ value: JSONValue?) -> [String: JSONValue]? {
        if case .object(let fields)? = value { return fields }
        return nil
    }

    private static func text(_ value: JSONValue?) -> String {
        if case .string(let s)? = value { return s }
        return ""
    }

    /// The message part of whatever was loaded: a message, a Discohook backup or export, a list of embeds or one embed.
    private static func messageObject(of json: JSONValue, _ warnings: inout [String]) -> [String: JSONValue]? {
        if case .array = json { return ["embeds": json] }
        guard case .object(let object) = json else { return nil }
        var wrapped: [JSONValue]?
        if case .array(let backups)? = object["backups"] {
            if let first = isObject(backups.first), case .array(let messages)? = first["messages"] { wrapped = messages }
        } else if case .array(let messages)? = object["messages"] {
            wrapped = messages
        }
        if let wrapped, !wrapped.isEmpty {
            if wrapped.count > 1 { warnings.append("The file holds \(wrapped.count) messages; only the first was imported.") }
            if let data = isObject(isObject(wrapped[0])?["data"]) { return data }
            return isObject(wrapped[0])
        }
        if let data = isObject(object["data"]), data["content"] != nil || data["embeds"] != nil { return data }
        if object["content"] == nil, object["embeds"] == nil, object["components"] == nil {
            // A single embed on its own.
            if ["title", "description", "fields", "author", "footer", "image"].contains(where: { object[$0] != nil }) {
                return ["embeds": .array([json])]
            }
        }
        return object
    }

    private static func color(_ value: JSONValue?) -> String {
        switch value {
        case .int(let n)? where n >= 0 && n <= 0xffffff:
            let hex = String(n, radix: 16)
            return "#" + String(repeating: "0", count: 6 - hex.count) + hex
        case .double(let d)? where d >= 0 && d <= 16_777_215 && d == d.rounded():
            let hex = String(Int(d), radix: 16)
            return "#" + String(repeating: "0", count: 6 - hex.count) + hex
        case .string(let s)?:
            let digits = s.hasPrefix("#") ? String(s.dropFirst()) : ""
            if digits.count == 6, Int(digits, radix: 16) != nil { return s.lowercased() }
            return EmbedOptions.defaultColorHex
        default:
            return EmbedOptions.defaultColorHex
        }
    }

    private static func emojiText(_ value: JSONValue?) -> String {
        if case .string(let s)? = value { return s }
        guard let object = isObject(value) else { return "" }
        let name = text(object["name"])
        if case .string(let id)? = object["id"], !id.isEmpty {
            let animated: Bool
            if case .bool(let flag)? = object["animated"] { animated = flag } else { animated = false }
            return "<\(animated ? "a" : ""):\(name.isEmpty ? "emoji" : name):\(id)>"
        }
        return name
    }

    private static func isWebURL(_ value: String) -> Bool {
        let lower = value.lowercased()
        return (lower.hasPrefix("http://") || lower.hasPrefix("https://")) && !value.contains(where: \.isWhitespace) && value.count > 8
    }

    /// Message JSON as a message for the form, checked against `limits`. `links: false` for a page that has no
    /// buttons (the Welcome channel): the link buttons are then listed as not carried over.
    public static func parse(_ json: JSONValue, limits: Limits = Limits(), allowsLinks: Bool = true) -> Outcome {
        var warnings: [String] = []
        var errors: [String] = []
        func fail(_ message: String) {
            if errors.count < maxErrors { errors.append(message) }
        }
        guard let message = messageObject(of: json, &warnings) else {
            return .failed(["This is not a message. Expected an object with \"content\" and/or \"embeds\"."])
        }

        var content = ""
        switch message["content"] {
        case nil, .null?: break
        case .string(let s)?:
            content = s
            if s.utf16.count > limits.content {
                fail("The message text is \(s.utf16.count) characters; the limit is \(limits.content).")
            }
        default: fail("\"content\" must be text.")
        }

        var rawEmbeds: [JSONValue] = []
        switch message["embeds"] {
        case nil, .null?: break
        case .array(let list)?:
            rawEmbeds = list
            if list.count > limits.embeds { fail("The message has \(list.count) embeds; the limit is \(limits.embeds).") }
        default: fail("\"embeds\" must be a list.")
        }

        var embeds: [EmbedItem] = []
        var total = 0
        var sawTimestamp = false
        var sawTitleURL = false
        func url(_ value: JSONValue?, _ where_: String) -> String {
            let v = text(value).trimmingCharacters(in: .whitespacesAndNewlines)
            if v.isEmpty { return "" }
            if isWebURL(v) { return v }
            warnings.append("\(where_): \"\(v.prefix(40))\" is not a web address (https://\u{2026}) and was left out.")
            return ""
        }
        for (index, raw) in rawEmbeds.prefix(limits.embeds).enumerated() {
            let at = "Embed \(index + 1)"
            guard let object = isObject(raw) else {
                fail("\(at) must be an object.")
                continue
            }
            let title = text(object["title"])
            let description = text(object["description"])
            let authorName = text(isObject(object["author"])?["name"])
            let footerText = text(isObject(object["footer"])?["text"])
            if title.utf16.count > limits.embed.title { fail("\(at): the title is \(title.utf16.count) characters; the limit is \(limits.embed.title).") }
            if description.utf16.count > limits.embed.description {
                fail("\(at): the description is \(description.utf16.count) characters; the limit is \(limits.embed.description).")
            }
            if authorName.utf16.count > limits.embed.authorName {
                fail("\(at): the author name is \(authorName.utf16.count) characters; the limit is \(limits.embed.authorName).")
            }
            if footerText.utf16.count > limits.embed.footerText {
                fail("\(at): the footer is \(footerText.utf16.count) characters; the limit is \(limits.embed.footerText).")
            }
            var rawFields: [JSONValue] = []
            switch object["fields"] {
            case nil, .null?: break
            case .array(let list)?:
                rawFields = list
                if list.count > limits.embed.maxFields {
                    fail("\(at) has \(list.count) fields; the limit is \(limits.embed.maxFields).")
                }
            default:
                fail("\(at): \"fields\" must be a list.")
                continue
            }
            var fields: [EmbedDraft.Field] = []
            for (j, field) in rawFields.prefix(limits.embed.maxFields).enumerated() {
                let fat = "\(at), field \(j + 1)"
                guard let f = isObject(field) else {
                    fail("\(fat) must be an object.")
                    continue
                }
                let name = text(f["name"])
                let value = text(f["value"])
                if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    fail("\(fat) needs both a name and a value.")
                    continue
                }
                if name.utf16.count > limits.embed.fieldName { fail("\(fat): the name is \(name.utf16.count) characters; the limit is \(limits.embed.fieldName).") }
                if value.utf16.count > limits.embed.fieldValue { fail("\(fat): the value is \(value.utf16.count) characters; the limit is \(limits.embed.fieldValue).") }
                total += name.utf16.count + value.utf16.count
                var inline = false
                if case .bool(let flag)? = f["inline"] { inline = flag }
                fields.append(EmbedDraft.Field(name: name, value: value, inline: inline))
            }
            total += title.utf16.count + description.utf16.count + authorName.utf16.count + footerText.utf16.count
            if let stamp = object["timestamp"], stamp != .null { sawTimestamp = true }
            if let link = object["url"], link != .null { sawTitleURL = true }
            let author = isObject(object["author"])
            let footer = isObject(object["footer"])
            embeds.append(EmbedItem(EmbedDraft(
                color: color(object["color"]), authorName: authorName,
                authorIcon: url(author?["icon_url"], "\(at), author icon"),
                title: title, description: description,
                image: url(isObject(object["image"])?["url"], "\(at), image"),
                thumbnail: url(isObject(object["thumbnail"])?["url"], "\(at), thumbnail"),
                footerText: footerText, footerIcon: url(footer?["icon_url"], "\(at), footer icon"), fields: fields)))
        }
        if total > Discord.totalChars {
            fail("The embeds hold \(total) characters in all; Discord allows \(Discord.totalChars) in one message.")
        }
        if sawTimestamp { warnings.append("Timestamps are not imported.") }
        if message["username"] != nil || message["avatar_url"] != nil {
            warnings.append("The custom name and avatar (a webhook feature) are not imported.")
        }
        if case .array(let files)? = message["attachments"], !files.isEmpty { warnings.append("Attached files are not imported.") }
        else if case .array(let files)? = message["files"], !files.isEmpty { warnings.append("Attached files are not imported.") }
        if let thread = message["thread_name"], thread != .null, thread != .string("") {
            warnings.append("The thread name (a forum post feature) is not imported.")
        }
        if let flags = message["flags"], flags != .null, flags != .int(0) { warnings.append("The message flags are not imported.") }
        if sawTitleURL { warnings.append("Links on embed titles are not imported.") }

        // Link buttons only: the rest need Sylo to answer them.
        var links: [ComposedLinkButton] = []
        var skipped = 0
        var linkSkipped = 0
        var rows = 0
        switch message["components"] {
        case nil, .null?: break
        case .array(let rowList)?:
            for row in rowList {
                var buttons: [ComposedLinkButton] = []
                if case .array(let components)? = isObject(row)?["components"] {
                    for component in components {
                        let c = isObject(component)
                        if case .int(2)? = c?["type"], case .int(5)? = c?["style"], isWebURL(text(c?["url"])) {
                            let label = text(c?["label"])
                            if label.utf16.count > Discord.buttonLabel {
                                fail("A button label is \(label.utf16.count) characters; the limit is \(Discord.buttonLabel).")
                            }
                            if buttons.count < Discord.buttonsPerRow {
                                buttons.append(ComposedLinkButton(label: label, emoji: emojiText(c?["emoji"]), url: text(c?["url"])))
                            }
                        } else {
                            skipped += 1
                        }
                    }
                }
                if !allowsLinks {
                    linkSkipped += buttons.count
                } else if !buttons.isEmpty, rows < Discord.rows {
                    // The app keeps one row of link buttons, like the dashboard's builder shows.
                    if links.isEmpty { links = buttons } else { linkSkipped += buttons.count }
                    rows += 1
                }
            }
        default:
            fail("\"components\" must be a list.")
        }
        if linkSkipped > 0 {
            warnings.append(allowsLinks
                ? "\(linkSkipped) link \(linkSkipped == 1 ? "button was" : "buttons were") not imported: a message here keeps one row of link buttons."
                : "\(linkSkipped) link \(linkSkipped == 1 ? "button was" : "buttons were") not imported: this page has no buttons.")
        }
        if skipped > 0 {
            warnings.append("\(skipped) \(skipped == 1 ? "button or menu" : "buttons and menus") that need a bot to answer \(skipped == 1 ? "was" : "were") skipped. Only link buttons are imported.")
        }

        if errors.isEmpty, content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, embeds.isEmpty, links.isEmpty {
            fail("This JSON has no message text, embeds or link buttons.")
        }
        if !errors.isEmpty { return .failed(errors) }
        return .imported(Imported(content: content, embeds: embeds, links: links, warnings: warnings))
    }

    /// Message JSON from the bytes of a file or pasted text. Text that is not JSON is a plain error.
    public static func parse(_ data: Data, limits: Limits = Limits(), allowsLinks: Bool = true) -> Outcome {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            return .failed(["This is not valid JSON."])
        }
        return parse(json, limits: limits, allowsLinks: allowsLinks)
    }
}
