import Foundation

// The shop's items (src/web/routes/v2Shop.js, `/modules/economy/shop/items`; the dashboard form is
// web-v2/src/components/EconomyShopAdmin.jsx). Staff add, edit, pause, reorder and delete the
// items members buy with the server's currency. Sylo 5.2 adds collectibles: an item with a
// picture, a rarity and an optional announcement, and no role.

/// What an item gives. A kind this app does not know stays as the server named it, is shown, and
/// is never edited (the server would turn an unknown kind into a custom item).
public enum ShopItemType: Hashable, Sendable, RawRepresentable {
    /// A role that ends after some hours (`temp_role`).
    case tempRole
    /// A role that stays (`role`).
    case role
    /// Something staff hand over by hand (`custom`).
    case custom
    /// A picture with a rarity and no role (`collectible`, Sylo 5.2 and later).
    case collectible
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "temp_role": self = .tempRole
        case "role": self = .role
        case "custom": self = .custom
        case "collectible": self = .collectible
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .tempRole: "temp_role"
        case .role: "role"
        case .custom: "custom"
        case .collectible: "collectible"
        case .other(let raw): raw
        }
    }

    /// The kinds the app can create and edit, in the dashboard's order.
    public static let editable: [ShopItemType] = [.tempRole, .role, .custom, .collectible]

    /// The two kinds that give a role.
    public var isRole: Bool { self == .tempRole || self == .role }
    public var isCollectible: Bool { self == .collectible }
    public var isKnown: Bool {
        if case .other = self { return false }
        return true
    }

    /// The words the dashboard uses for each kind.
    public var title: String {
        switch self {
        case .tempRole: "Temporary role"
        case .role: "Permanent role"
        case .custom: "Custom item"
        case .collectible: "Collectible"
        case .other(let raw): raw
        }
    }

    /// A longer line for the kind picker.
    public var summary: String {
        switch self {
        case .tempRole: "A role that ends after some hours"
        case .role: "A role that stays"
        case .custom: "Staff fulfil it by hand"
        case .collectible: "A picture, no role"
        case .other: "A kind this app does not know"
        }
    }
}

extension ShopItemType: Decodable {
    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One of the collectible rarity tiers. The tiers are fixed on the server (`RARITIES`); the answer
/// of the item list names them as `rarities`, and the app has the same five for a server that does
/// not say.
public struct ShopRarity: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let label: String

    public var id: String { key }

    public init(key: String, label: String) {
        self.key = key
        self.label = label
    }

    private enum CodingKeys: String, CodingKey { case key, label }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let key = try c.decode(String.self, forKey: .key)
        self.init(key: key, label: try c.decode(forKey: .label, or: Self.fallbackLabel(key)))
    }

    /// Lowest first, as the server lists them.
    public static let standard: [ShopRarity] = [
        ShopRarity(key: "common", label: "Common"),
        ShopRarity(key: "uncommon", label: "Uncommon"),
        ShopRarity(key: "rare", label: "Rare"),
        ShopRarity(key: "epic", label: "Epic"),
        ShopRarity(key: "legendary", label: "Legendary"),
    ]

    /// The label for a rarity key: the server's, else the standard one, else the key itself
    /// capitalised (a tier a newer server adds).
    public static func label(for key: String, in tiers: [ShopRarity] = []) -> String {
        if let match = tiers.first(where: { $0.key == key }) { return match.label }
        if let match = standard.first(where: { $0.key == key }) { return match.label }
        return fallbackLabel(key)
    }

    private static func fallbackLabel(_ key: String) -> String {
        key.isEmpty ? key : key.prefix(1).uppercased() + key.dropFirst()
    }
}

/// One shop item as staff see it: its fields, how much is left, and what it has sold.
public struct ShopItem: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let name: String
    public let description: String
    public let emoji: String
    public let type: ShopItemType
    /// The role a role item gives; nil for the other kinds.
    public let roleId: String?
    /// How long a temporary role lasts; nil for the other kinds.
    public let durationHours: Int?
    public let price: Int
    /// nil is unlimited.
    public let stock: Int?
    public let sold: Int
    /// What is left of a limited stock; nil is unlimited.
    public let left: Int?
    public let requiredRoles: [String]
    /// nil is no limit.
    public let perMemberLimit: Int?
    public let enabled: Bool
    public let sortOrder: Int
    /// A rarity key (`common` … `legendary`); nil for none. Collectibles only, Sylo 5.2 and later.
    public let rarity: String?
    /// Whether a purchase is announced in the collectible channel.
    public let announce: Bool
    /// Where the picture is served on the server (`/c/<id>.webp`, public); nil without one.
    public let imagePath: String?
    public let purchases: Int
    /// What the item has earned in all.
    public let revenue: Int
    /// Fields of the item the app does not model (a newer server's), kept and sent back on save: the server
    /// builds the whole item from what it is sent, so a field left out would be reset to its default.
    public let extras: [String: JSONValue]

    /// A collectible without a picture is hidden from members and cannot be bought.
    public var needsPicture: Bool { type.isCollectible && imagePath == nil }

    public init(id: Int, name: String = "", description: String = "", emoji: String = "", type: ShopItemType = .custom,
                roleId: String? = nil, durationHours: Int? = nil, price: Int = 1, stock: Int? = nil, sold: Int = 0,
                left: Int? = nil, requiredRoles: [String] = [], perMemberLimit: Int? = nil, enabled: Bool = true,
                sortOrder: Int = 0, rarity: String? = nil, announce: Bool = false, imagePath: String? = nil,
                purchases: Int = 0, revenue: Int = 0, extras: [String: JSONValue] = [:]) {
        self.id = id
        self.name = name
        self.description = description
        self.emoji = emoji
        self.type = type
        self.roleId = roleId
        self.durationHours = durationHours
        self.price = price
        self.stock = stock
        self.sold = sold
        self.left = left
        self.requiredRoles = requiredRoles
        self.perMemberLimit = perMemberLimit
        self.enabled = enabled
        self.sortOrder = sortOrder
        self.rarity = rarity
        self.announce = announce
        self.imagePath = imagePath
        self.purchases = purchases
        self.revenue = revenue
        self.extras = extras
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, name, description, emoji, type, roleId, durationHours, price, stock, sold, left, requiredRoles
        case perMemberLimit, enabled, sortOrder, rarity, announce, imagePath, purchases, revenue
    }
    /// Every field the item view of the server has, so what is left over is what the app does not know.
    static let knownKeys = Set(CodingKeys.allCases.map(\.rawValue))

    // The id names an item, and equal items have equal ids; `extras` (a `JSONValue`) is not hashable.
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func nonEmpty(_ key: CodingKeys) throws -> String? {
            let text = try c.decodeIfPresent(String.self, forKey: key)
            return text?.isEmpty == false ? text : nil
        }
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            name: try c.decode(forKey: .name, or: ""),
            description: try c.decodeIfPresent(String.self, forKey: .description) ?? "",
            emoji: try c.decodeIfPresent(String.self, forKey: .emoji) ?? "",
            type: try c.decode(forKey: .type, or: .custom),
            roleId: try nonEmpty(.roleId),
            durationHours: try c.decodeIfPresent(Int.self, forKey: .durationHours),
            price: try c.decode(forKey: .price, or: 1),
            stock: try c.decodeIfPresent(Int.self, forKey: .stock),
            sold: try c.decode(forKey: .sold, or: 0),
            left: try c.decodeIfPresent(Int.self, forKey: .left),
            requiredRoles: try c.decode(forKey: .requiredRoles, or: []),
            perMemberLimit: try c.decodeIfPresent(Int.self, forKey: .perMemberLimit),
            enabled: try c.decode(forKey: .enabled, or: true),
            sortOrder: try c.decode(forKey: .sortOrder, or: 0),
            rarity: try nonEmpty(.rarity),
            announce: try c.decode(forKey: .announce, or: false),
            imagePath: try nonEmpty(.imagePath),
            purchases: try c.decode(forKey: .purchases, or: 0),
            revenue: try c.decode(forKey: .revenue, or: 0),
            extras: try Passthrough.read(decoder, excluding: Self.knownKeys))
    }
}

/// `GET .../economy/shop/items`: the items in shop order, the roles an item can give and, on
/// Sylo 5.2, the rarity tiers.
public struct ShopItemList: Decodable, Sendable, Equatable {
    public let items: [ShopItem]
    public let roles: [RoleOption]
    /// The most items the server keeps.
    public let maxItems: Int?
    /// nil on a server before Sylo 5.2, which has no collectibles.
    public let rarities: [ShopRarity]?

    /// Whether the server has collectibles, as far as this answer shows: only a 5.2 answer names
    /// the `rarities`, and only a 5.2 server has a collectible or an item with a rarity.
    public var showsCollectibles: Bool {
        rarities != nil || items.contains { $0.type.isCollectible || $0.rarity != nil }
    }

    public init(items: [ShopItem] = [], roles: [RoleOption] = [], maxItems: Int? = nil, rarities: [ShopRarity]? = nil) {
        self.items = items
        self.roles = roles
        self.maxItems = maxItems
        self.rarities = rarities
    }

    private enum CodingKeys: String, CodingKey { case items, roles, maxItems, rarities }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            items: try c.decodeLossyArray(of: ShopItem.self, forKey: .items),
            roles: try c.decodeLossyArray(of: RoleOption.self, forKey: .roles),
            maxItems: try c.decodeIfPresent(Int.self, forKey: .maxItems),
            rarities: try c.decodeLossyArrayIfPresent(of: ShopRarity.self, forKey: .rarities))
    }
}

/// The answer of every change to the items: the items as they are now, with the new item's id after
/// a create and how many members still hold the item after a delete.
public struct ShopItemsAnswer: Decodable, Sendable, Equatable {
    public let items: [ShopItem]
    public let id: Int?
    public let held: Int?

    public init(items: [ShopItem] = [], id: Int? = nil, held: Int? = nil) {
        self.items = items
        self.id = id
        self.held = held
    }

    private enum CodingKeys: String, CodingKey { case items, id, held }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            items: try c.decodeLossyArray(of: ShopItem.self, forKey: .items),
            id: try c.decodeIfPresent(Int.self, forKey: .id),
            held: try c.decodeIfPresent(Int.self, forKey: .held))
    }
}

/// The limits the server clamps an item to (`LIMITS` in economyConfig.js). Staying inside them
/// here means the server never has to change what was typed.
public enum ShopItemLimits {
    public static let nameLength = 60
    public static let descriptionLength = 300
    public static let emojiLength = 64
    public static let price = 1...1_000_000_000
    public static let stock = 0...1_000_000
    public static let durationHours = 1...8760
    public static let perMemberLimit = 1...1000
    public static let requiredRoles = 10
}

/// An item being created or edited: what the form holds, and the body the server is sent.
public struct ShopItemDraft: Sendable, Equatable {
    /// nil for a new item.
    public var id: Int?
    public var name = ""
    public var description = ""
    public var emoji = ""
    public var type: ShopItemType = .custom
    public var roleId = ""
    public var durationHours = 24
    public var price = 100
    /// nil is unlimited.
    public var stock: Int?
    /// nil is no limit.
    public var perMemberLimit: Int?
    public var requiredRoles: [String] = []
    public var enabled = true
    /// A rarity key; "" is none.
    public var rarity = ""
    public var announce = false
    /// The picture the item has now (for showing); a new one goes up separately.
    public var imagePath: String?
    /// Fields of the item the app does not model, sent back unchanged.
    public var extras: [String: JSONValue] = [:]

    public init() {}

    public init(item: ShopItem) {
        id = item.id
        name = item.name
        description = item.description
        emoji = item.emoji
        type = item.type
        roleId = item.roleId ?? ""
        durationHours = item.durationHours ?? 24
        price = item.price
        stock = item.stock
        perMemberLimit = item.perMemberLimit
        requiredRoles = item.requiredRoles
        enabled = item.enabled
        rarity = item.rarity ?? ""
        announce = item.announce
        imagePath = item.imagePath
        extras = item.extras
    }

    /// What is wrong with the item, in the server's words, or nil. The same checks as the server's
    /// `itemProblem`, plus the one kind the app cannot edit.
    public var problem: String? {
        if !type.isKnown { return "This kind of item is newer than this version of the app, so it cannot be edited here. Update the app." }
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Give the item a name." }
        if type.isRole, roleId.isEmpty { return "Pick the role this item gives." }
        return nil
    }

    /// The body of the create and update calls. Every value is clamped to the server's limits.
    /// - Parameter supportsCollectibles: Whether the server has collectibles. Only then do the
    ///   `rarity` and `announce` keys go out, so an older server never gets a key it does not know.
    public func body(supportsCollectibles: Bool) -> ShopItemBody {
        func clamp(_ value: Int, _ range: ClosedRange<Int>) -> Int { min(max(value, range.lowerBound), range.upperBound) }
        let collectible = type.isCollectible
        return ShopItemBody(
            name: UTF16Limit.truncated(name.trimmingCharacters(in: .whitespacesAndNewlines), to: ShopItemLimits.nameLength),
            description: UTF16Limit.truncated(description, to: ShopItemLimits.descriptionLength),
            emoji: UTF16Limit.truncated(emoji, to: ShopItemLimits.emojiLength),
            type: type.rawValue,
            roleId: type.isRole ? roleId : "",
            durationHours: clamp(durationHours, ShopItemLimits.durationHours),
            price: clamp(price, ShopItemLimits.price),
            stock: stock.map { clamp($0, ShopItemLimits.stock) },
            perMemberLimit: perMemberLimit.map { clamp($0, ShopItemLimits.perMemberLimit) },
            requiredRoles: Array(requiredRoles.prefix(ShopItemLimits.requiredRoles)),
            enabled: enabled,
            rarity: supportsCollectibles ? (collectible ? rarity : "") : nil,
            announce: supportsCollectibles ? (collectible && announce) : nil,
            extras: extras)
    }
}

/// The JSON of an item, as the dashboard sends it. `stock` and `perMemberLimit` are written as
/// `null` for unlimited; `rarity` and `announce` are left out for a server without collectibles.
public struct ShopItemBody: Encodable, Sendable, Equatable {
    public let name: String
    public let description: String
    public let emoji: String
    public let type: String
    public let roleId: String
    public let durationHours: Int
    public let price: Int
    public let stock: Int?
    public let perMemberLimit: Int?
    public let requiredRoles: [String]
    public let enabled: Bool
    public let rarity: String?
    public let announce: Bool?
    /// Fields the app does not model, written first so a field it does model always wins.
    public let extras: [String: JSONValue]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case name, description, emoji, type, roleId, durationHours, price, stock, perMemberLimit, requiredRoles, enabled
        case rarity, announce
    }

    public init(name: String, description: String, emoji: String, type: String, roleId: String, durationHours: Int,
                price: Int, stock: Int?, perMemberLimit: Int?, requiredRoles: [String], enabled: Bool,
                rarity: String?, announce: Bool?, extras: [String: JSONValue] = [:]) {
        self.name = name
        self.description = description
        self.emoji = emoji
        self.type = type
        self.roleId = roleId
        self.durationHours = durationHours
        self.price = price
        self.stock = stock
        self.perMemberLimit = perMemberLimit
        self.requiredRoles = requiredRoles
        self.enabled = enabled
        self.rarity = rarity
        self.announce = announce
        self.extras = extras
    }

    public func encode(to encoder: any Encoder) throws {
        var extra = encoder.container(keyedBy: PassthroughKey.self)
        // An output-only key (`sold`, `imagePath` ...) never reaches here: it is a ShopItem key, not an extra.
        try Passthrough.write(extras, excluding: Set(CodingKeys.allCases.map(\.rawValue)), to: &extra)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(description, forKey: .description)
        try c.encode(emoji, forKey: .emoji)
        try c.encode(type, forKey: .type)
        try c.encode(roleId, forKey: .roleId)
        try c.encode(durationHours, forKey: .durationHours)
        try c.encode(price, forKey: .price)
        if let stock { try c.encode(stock, forKey: .stock) } else { try c.encodeNil(forKey: .stock) }
        if let perMemberLimit {
            try c.encode(perMemberLimit, forKey: .perMemberLimit)
        } else {
            try c.encodeNil(forKey: .perMemberLimit)
        }
        try c.encode(requiredRoles, forKey: .requiredRoles)
        try c.encode(enabled, forKey: .enabled)
        try c.encodeIfPresent(rarity, forKey: .rarity)
        try c.encodeIfPresent(announce, forKey: .announce)
    }
}

/// Cuts text to the server's limits, which count UTF-16 units (JavaScript's `slice`), between characters so
/// a surrogate pair or an emoji is never split.
public enum UTF16Limit {
    /// The longest start of `text` that is at most `limit` UTF-16 units.
    public static func truncated(_ text: String, to limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var units = 0
        var result = ""
        for character in text {
            units += character.utf16.count
            if units > limit { break }
            result.append(character)
        }
        return result
    }
}
