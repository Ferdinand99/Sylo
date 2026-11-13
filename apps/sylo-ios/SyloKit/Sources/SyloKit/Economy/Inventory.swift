import Foundation
import Observation

// A member's inventory (src/web/routes/v2Shop.js: `/modules/economy/members/:userId/inventory` and its
// grant, revoke, refund and fulfil actions; the dashboard panel is web-v2/src/components/EconomyInventory.jsx).
// Staff see what a member owns and can give an item for free, take one away, refund a purchase, and
// mark a custom item as handed over. Every action goes through the same server code as the shop's
// commands and is in the member's ledger.

/// Where an inventory entry stands.
public enum InventoryStatus: Hashable, Sendable, RawRepresentable {
    /// A role is on its way to the member.
    case pending
    case active
    case revoked
    case refunded
    case expired
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "pending": self = .pending
        case "active": self = .active
        case "revoked": self = .revoked
        case "refunded": self = .refunded
        case "expired": self = .expired
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .pending: "pending"
        case .active: "active"
        case .revoked: "revoked"
        case .refunded: "refunded"
        case .expired: "expired"
        case .other(let raw): raw
        }
    }

    /// The words the dashboard uses.
    public var title: String {
        switch self {
        case .pending: "Being set up"
        case .active: "Active"
        case .revoked: "Revoked"
        case .refunded: "Refunded"
        case .expired: "Expired"
        case .other(let raw): raw
        }
    }

    /// An entry the member still holds: it can be revoked or refunded.
    public var isLive: Bool { self == .active || self == .pending }
}

extension InventoryStatus: Decodable {
    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One entry of a member's inventory, or of the shop's activity: a copy of an item a member owns.
public struct InventoryRow: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let userId: String
    /// Who owns it; nil when the server could not name them.
    public let member: EconomyPerson?
    public let itemId: Int
    /// The item's name when it was bought, kept even after the item is deleted.
    public let itemName: String
    public let itemType: ShopItemType
    /// The item was deleted from the shop after this copy was bought.
    public let itemRemoved: Bool
    public let roleId: String?
    /// The picture this copy shows (`/c/<id>.webp`); nil for other kinds, or once the copy is refunded
    /// or revoked.
    public let imagePath: String?
    /// A rarity key; nil for none. Collectibles only. A tier the app does not know stays as sent.
    public let rarity: String?
    public let pricePaid: Int
    /// `purchase` or `grant`.
    public let source: String
    public let status: InventoryStatus
    /// When a temporary role ends, in milliseconds since 1970.
    public let expiresAt: Double?
    /// When staff marked a custom item as handed over, in milliseconds since 1970.
    public let fulfilledAt: Double?
    public let fulfilledBy: EconomyPerson?
    /// What staff wrote when they gave or fulfilled it.
    public let note: String
    /// In milliseconds since 1970.
    public let createdAt: Double?

    public var expiresDate: Date? { expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    public var createdDate: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    public var isGrant: Bool { source == "grant" }
    public var isLive: Bool { status.isLive }
    /// A role or a collectible that can be taken away; no money moves.
    public var canRevoke: Bool { isLive }
    /// A purchase that cost something and is still held can be refunded (money back, item revoked).
    public var canRefund: Bool { isLive && source == "purchase" && pricePaid > 0 }
    /// A custom item that waits for staff, or was handed over and can be reopened.
    public var canFulfil: Bool { itemType == .custom && status == .active }
    public var isFulfilled: Bool { fulfilledAt != nil }

    public init(id: Int, userId: String = "", member: EconomyPerson? = nil, itemId: Int = 0, itemName: String = "",
                itemType: ShopItemType = .custom, itemRemoved: Bool = false, roleId: String? = nil,
                imagePath: String? = nil, rarity: String? = nil, pricePaid: Int = 0, source: String = "purchase",
                status: InventoryStatus = .active, expiresAt: Double? = nil, fulfilledAt: Double? = nil,
                fulfilledBy: EconomyPerson? = nil, note: String = "", createdAt: Double? = nil) {
        self.id = id
        self.userId = userId
        self.member = member
        self.itemId = itemId
        self.itemName = itemName
        self.itemType = itemType
        self.itemRemoved = itemRemoved
        self.roleId = roleId
        self.imagePath = imagePath
        self.rarity = rarity
        self.pricePaid = pricePaid
        self.source = source
        self.status = status
        self.expiresAt = expiresAt
        self.fulfilledAt = fulfilledAt
        self.fulfilledBy = fulfilledBy
        self.note = note
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, userId, member, itemId, itemName, itemType, itemRemoved, roleId, imagePath, rarity, pricePaid
        case source, status, expiresAt, fulfilledAt, fulfilledBy, note, createdAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func nonEmpty(_ key: CodingKeys) throws -> String? {
            let text = try c.decodeIfPresent(String.self, forKey: key)
            return text?.isEmpty == false ? text : nil
        }
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            userId: try c.decode(forKey: .userId, or: ""),
            member: try c.decodeIfPresent(EconomyPerson.self, forKey: .member),
            itemId: try c.decode(forKey: .itemId, or: 0),
            itemName: try c.decode(forKey: .itemName, or: ""),
            itemType: try c.decode(forKey: .itemType, or: .custom),
            itemRemoved: try c.decode(forKey: .itemRemoved, or: false),
            roleId: try nonEmpty(.roleId),
            imagePath: try nonEmpty(.imagePath),
            rarity: try nonEmpty(.rarity),
            pricePaid: try c.decode(forKey: .pricePaid, or: 0),
            source: try c.decode(forKey: .source, or: "purchase"),
            status: try c.decode(forKey: .status, or: .active),
            expiresAt: try c.decodeIfPresent(Double.self, forKey: .expiresAt),
            fulfilledAt: try c.decodeIfPresent(Double.self, forKey: .fulfilledAt),
            fulfilledBy: try c.decodeIfPresent(EconomyPerson.self, forKey: .fulfilledBy),
            note: try c.decodeIfPresent(String.self, forKey: .note) ?? "",
            createdAt: try c.decodeIfPresent(Double.self, forKey: .createdAt))
    }
}

/// The answer of the inventory calls: the member's inventory as it is now, and for a refund or a
/// revoke how it ended.
public struct InventoryAnswer: Decodable, Sendable, Equatable {
    public let inventory: [InventoryRow]
    /// For a refund or revoke: whether money went back to the member.
    public let refunded: Bool?
    /// Something that went wrong around it (a role that could not be taken off); the change stands.
    public let warning: String?

    public init(inventory: [InventoryRow] = [], refunded: Bool? = nil, warning: String? = nil) {
        self.inventory = inventory
        self.refunded = refunded
        self.warning = warning
    }

    private enum CodingKeys: String, CodingKey { case inventory, refunded, warning }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let warning = try c.decodeIfPresent(String.self, forKey: .warning)
        self.init(
            inventory: try c.decodeLossyArray(of: InventoryRow.self, forKey: .inventory),
            refunded: try c.decodeIfPresent(Bool.self, forKey: .refunded),
            warning: warning?.isEmpty == false ? warning : nil)
    }
}

/// Which way an entry is ended.
public enum InventoryEnding: String, Sendable {
    case revoke
    case refund
}

extension Endpoints {
    private static func inventoryPath(_ server: ServerID, _ userID: String, _ rest: String = "") -> String {
        "/api/v2/guilds/\(server.pathComponent)/modules/economy/members/\(userID.encodedPathSegment)/inventory" + rest
    }

    /// `GET .../economy/members/:userId/inventory`: up to the latest 100 entries.
    public struct LoadMemberInventory: APIEndpoint {
        public typealias Response = InventoryAnswer
        public let server: ServerID
        public let userID: String

        public init(server: ServerID, userID: String) {
            self.server = server
            self.userID = userID
        }

        public var path: String { Endpoints.inventoryPath(server, userID) }
    }

    /// `POST .../inventory/grant`: gives a member an item for free, with a reason kept in the ledger.
    public struct GrantShopItem: APIEndpoint {
        public typealias Response = InventoryAnswer
        public let server: ServerID
        public let userID: String
        public let itemID: Int
        public let reason: String

        public init(server: ServerID, userID: String, itemID: Int, reason: String = "") {
            self.server = server
            self.userID = userID
            self.itemID = itemID
            self.reason = reason
        }

        public var path: String { Endpoints.inventoryPath(server, userID, "/grant") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(itemId: itemID, reason: reason) }

        private struct Body: Encodable, Sendable {
            let itemId: Int
            let reason: String
        }
    }

    /// `POST .../inventory/:row/revoke` or `/refund`: takes the item away; a refund also gives the
    /// price back.
    public struct EndInventoryRow: APIEndpoint {
        public typealias Response = InventoryAnswer
        public let server: ServerID
        public let userID: String
        public let rowID: Int
        public let ending: InventoryEnding
        public let reason: String

        public init(server: ServerID, userID: String, rowID: Int, ending: InventoryEnding, reason: String = "") {
            self.server = server
            self.userID = userID
            self.rowID = rowID
            self.ending = ending
            self.reason = reason
        }

        public var path: String { Endpoints.inventoryPath(server, userID, "/\(rowID)/\(ending.rawValue)") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(reason: reason) }

        private struct Body: Encodable, Sendable { let reason: String }
    }

    /// `POST .../inventory/:row/fulfil`: marks a custom item as handed over, or reopens it.
    public struct FulfilInventoryRow: APIEndpoint {
        public typealias Response = InventoryAnswer
        public let server: ServerID
        public let userID: String
        public let rowID: Int
        public let fulfilled: Bool
        public let note: String

        public init(server: ServerID, userID: String, rowID: Int, fulfilled: Bool, note: String = "") {
            self.server = server
            self.userID = userID
            self.rowID = rowID
            self.fulfilled = fulfilled
            self.note = note
        }

        public var path: String { Endpoints.inventoryPath(server, userID, "/\(rowID)/fulfil") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(fulfilled: fulfilled, note: note) }

        private struct Body: Encodable, Sendable {
            let fulfilled: Bool
            let note: String
        }
    }
}

/// One member's inventory and the staff actions on it.
@MainActor
@Observable
public final class MemberInventoryModel {
    /// The longest reason or note the server keeps, in characters.
    public static let maxReasonLength = 200

    public let server: ServerID
    public let userID: String
    public private(set) var rows: [InventoryRow] = []
    /// The shop's items, for the one to give; empty when they could not be loaded.
    public private(set) var items: [ShopItem] = []
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    public private(set) var isWorking = false
    /// Why the inventory could not be loaded.
    public var errorMessage: String?
    /// Why an action did not go through.
    public var actionError: String?
    /// What the last action did, in words, including what the server warned about.
    public private(set) var notice: String?
    /// Goes up with every action that went through, for a haptic.
    public private(set) var changeCount = 0

    private let session: AppSession

    public init(server: ServerID, userID: String, session: AppSession) {
        self.server = server
        self.userID = userID
        self.session = session
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            rows = try await session.send(Endpoints.LoadMemberInventory(server: server, userID: userID)).inventory
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
        // The items to give are optional: without them the grant row is hidden.
        if let list = try? await session.send(Endpoints.LoadShopItems(server: server)) { items = list.items }
    }

    /// Gives the member an item for free.
    @discardableResult
    public func grant(_ item: ShopItem, reason: String) async -> Bool {
        await perform(
            Endpoints.GrantShopItem(server: server, userID: userID, itemID: item.id, reason: Self.clean(reason)),
            done: "\(item.name) was given.")
    }

    /// Takes an entry away (no money moves) or refunds it (the price goes back to the member).
    @discardableResult
    public func end(_ row: InventoryRow, as ending: InventoryEnding, reason: String) async -> Bool {
        await perform(
            Endpoints.EndInventoryRow(
                server: server, userID: userID, rowID: row.id, ending: ending, reason: Self.clean(reason)),
            done: nil
        ) { answer in
            switch ending {
            case .revoke:
                "\(row.itemName) was taken away. No money moved."
            case .refund:
                answer.refunded == false
                    ? "\(row.itemName) was taken away, but nothing was refunded."
                    : "\(row.itemName) was refunded and taken away."
            }
        }
    }

    /// Marks a custom item as handed over (with a note), or reopens it.
    @discardableResult
    public func setFulfilled(_ row: InventoryRow, _ fulfilled: Bool, note: String) async -> Bool {
        await perform(
            Endpoints.FulfilInventoryRow(
                server: server, userID: userID, rowID: row.id, fulfilled: fulfilled, note: Self.clean(note)),
            done: fulfilled ? "Marked as fulfilled." : "Reopened.")
    }

    /// A reason or note as the server keeps it: trimmed and cut to its limit.
    static func clean(_ text: String) -> String {
        String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxReasonLength))
    }

    private func perform<E: APIEndpoint>(
        _ endpoint: E, done: String?, words: ((InventoryAnswer) -> String)? = nil
    ) async -> Bool where E.Response == InventoryAnswer {
        guard !isWorking else { return false }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        notice = nil
        do {
            let answer = try await session.send(endpoint)
            rows = answer.inventory
            var message = words?(answer) ?? done ?? ""
            if let warning = answer.warning { message += (message.isEmpty ? "" : " ") + warning }
            notice = message.isEmpty ? nil : message
            changeCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
    }
}
