import SwiftUI
import UIKit

// The Sylo palette, from the Bento website: near-black blue surfaces, hairline cyan borders and
// one brand colour, the cyan of the logo. Every token has a dark and a light variant (light is its
// own palette on the same cyan axis, not an inverted dark one). Colours resolve per trait
// collection, so they follow the system appearance without any view having to check it.

nonisolated private func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> UIColor {
    UIColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha)
}

extension Color {
    /// A colour that is `dark` in dark appearance and `light` in light appearance.
    fileprivate init(dark: UIColor, light: UIColor) {
        self.init(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }

    // MARK: Surfaces

    /// The screen background (#070b0f in dark).
    static let syloBackground = Color(dark: rgb(0x070B0F), light: rgb(0xEAF2F6))
    /// A step above the background, for bars and wells (#0c1319 in dark).
    static let syloBackground2 = Color(dark: rgb(0x0C1319), light: rgb(0xDFEAF0))
    /// Cards and tiles (#101820 in dark).
    static let syloCard = Color(dark: rgb(0x101820), light: rgb(0xFFFFFF))
    /// A card on a card, hover and pressed states (#14202a in dark).
    static let syloCard2 = Color(dark: rgb(0x14202A), light: rgb(0xF1F7FA))

    // MARK: Lines

    /// The hairline around cards: cyan at 11 % in dark.
    static let syloLine = Color(dark: rgb(0x8CCDE6, alpha: 0.11), light: rgb(0x0E6F91, alpha: 0.16))
    /// The stronger hairline, for selected and live things, and for Increase Contrast.
    static let syloLineStrong = Color(dark: rgb(0x8CCDE6, alpha: 0.22), light: rgb(0x0E6F91, alpha: 0.30))

    // MARK: Text

    /// Primary text (#edf5f9 in dark).
    static let syloText = Color(dark: rgb(0xEDF5F9), light: rgb(0x0A1A22))
    /// Secondary text. 7.5:1 on a dark card, 6.1:1 on a light one.
    static let syloMuted = Color(dark: rgb(0x9DB0BB), light: rgb(0x4A6270))

    // MARK: Brand

    /// The brand colour as text or an icon on a surface: cy-300 in dark, a deep cyan in light.
    static let syloBrand = Color(dark: rgb(0x6FD9F6), light: rgb(0x076787))
    /// The brand colour as a fill (switch on, bubbles, the tab marker): cy-400 in dark.
    static let syloCyan = Color(dark: rgb(0x38C8F0), light: rgb(0x0E6F91))
    /// Text and icons on `syloCyan`: dark on the light cyan (9:1), white on the deep one (5.9:1).
    static let syloOnCyan = Color(dark: rgb(0x03212B), light: rgb(0xFFFFFF))
    /// The glow of live things: always the logo cyan.
    static let syloGlow = Color(uiColor: rgb(0x38C8F0))

    // MARK: Status

    static let syloOK = Color(dark: rgb(0x30D158), light: rgb(0x1A8A3A))
    static let syloWarn = Color(dark: rgb(0xFFD60A), light: rgb(0x8A5E00))
    static let syloBad = Color(dark: rgb(0xFF453A), light: rgb(0xC92A20))

    // MARK: Platforms

    /// Discord's own blurple, for its badge.
    static let syloDiscord = Color(dark: rgb(0x8C96FF), light: rgb(0x4752C4))
    /// A violet that sets Fluxer apart from Discord and from the cyan.
    static let syloFluxer = Color(dark: rgb(0xC58BFF), light: rgb(0x7A38C8))
}
