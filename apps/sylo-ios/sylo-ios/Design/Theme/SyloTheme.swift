import SwiftUI

/// Spacing, corner radii and type for the Sylo look. Everything scales with Dynamic Type where it
/// holds text; the numbers are for the layout around it.
enum SyloSpacing {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    /// The gap between bento tiles.
    static let tileGap: CGFloat = 10
    /// The side margin of a screen.
    static let screen: CGFloat = 16
}

enum SyloRadius {
    /// Bento tiles and cards.
    static let tile: CGFloat = 22
    /// Rows inside a card, bubbles.
    static let row: CGFloat = 16
    /// Small chips and icon wells.
    static let chip: CGFloat = 10
}

extension Font {
    /// Numbers and ids: SF Mono digits that line up, scaling with the text style.
    static func syloNumber(_ style: Font.TextStyle = .title2, weight: Font.Weight = .semibold) -> Font {
        .system(style, design: .monospaced, weight: weight)
    }
}

/// How the app moves. One spring family, so everything feels like the same material.
enum SyloMotion {
    /// Taps, presses and small state changes.
    static let quick: Animation = .spring(duration: 0.28, bounce: 0.18)
    /// Things that change place: tab marker, tiles settling.
    static let settle: Animation = .spring(duration: 0.42, bounce: 0.22)
    /// A tile or row arriving.
    static func arrival(index: Int) -> Animation {
        .spring(duration: 0.5, bounce: 0.2).delay(min(Double(index), 8) * 0.04)
    }
    /// The slow breathing of live things.
    static let pulse: Animation = .easeOut(duration: 1.6).repeatForever(autoreverses: false)
}
