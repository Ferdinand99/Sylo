import SwiftUI

/// A server's icon, or its initials while the icon loads or when it has none.
struct ServerIcon: View {
    let url: URL?
    let name: String
    @ScaledMetric private var size: CGFloat

    init(url: URL?, name: String, size: CGFloat = 28) {
        self.url = url
        self.name = name
        _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
    }

    var body: some View {
        AsyncImage(url: url) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
        .accessibilityHidden(true)
    }

    private var initials: some View {
        ZStack {
            Rectangle().fill(.tint.opacity(0.15))
            Text(Self.initials(of: name))
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(.tint)
        }
    }

    /// "Sylo Test Server" → "ST".
    static func initials(of name: String) -> String {
        let letters = name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap(\.first)
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }
}

#Preview {
    HStack(spacing: 16) {
        ServerIcon(url: nil, name: "Sylo Test Server")
        ServerIcon(url: nil, name: "gaming", size: 56)
    }
    .padding()
}
