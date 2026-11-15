import SwiftUI
import SyloKit

// Small pieces the shop screens share: a collectible's picture, its rarity, and how money reads.

/// A collectible's picture as a small square. The server serves it publicly under `/c/`; it is loaded
/// through the session like any picture the app shows. Without a path it is a placeholder.
struct CollectibleThumbnail: View {
    let path: String?
    var size: CGFloat = 44

    var body: some View {
        Group {
            if let path {
                AuthenticatedImage(path: path, contentMode: .fill)
            } else {
                Image(systemName: "photo")
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        // The row's text names the item; the picture adds nothing for VoiceOver.
        .accessibilityHidden(true)
    }
}

/// A rarity as a small coloured label. The word is always there, so the tier never depends on colour.
struct RarityBadge: View {
    let key: String
    var tiers: [ShopRarity] = []

    var body: some View {
        Text(verbatim: ShopRarity.label(for: key, in: tiers))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.15), in: Capsule())
    }

    private var color: Color {
        switch key {
        case "common": .gray
        case "uncommon": .green
        case "rare": .blue
        case "epic": .purple
        case "legendary": .orange
        default: .secondary
        }
    }
}

/// How an inventory entry reads in a list: "Active · paid 500 · until Thu 24 Sep, 19:00".
enum InventoryText {
    static func details(of row: InventoryRow, includeMember: Bool = false) -> String {
        var parts: [String] = []
        if includeMember { parts.append(row.member?.name ?? row.userId) }
        parts.append(row.status.title)
        parts.append(row.isGrant
            ? String(localized: "given for free")
            : String(localized: "paid \(row.pricePaid.formatted())"))
        if let until = row.expiresDate { parts.append(String(localized: "until \(DateText.dayAndTime(until))")) }
        if row.itemType == .custom, row.isLive {
            if row.isFulfilled {
                if let by = row.fulfilledBy {
                    parts.append(String(localized: "fulfilled by \(by.name)"))
                } else {
                    parts.append(String(localized: "fulfilled"))
                }
            } else {
                parts.append(String(localized: "waiting for staff"))
            }
        }
        if !row.note.isEmpty { parts.append(row.note) }
        if let created = row.createdDate { parts.append(DateText.relative(created)) }
        return parts.joined(separator: " · ")
    }
}
