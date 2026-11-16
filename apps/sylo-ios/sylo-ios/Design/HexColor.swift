import SwiftUI
import SyloKit

extension Color {
    /// A `#rrggbb` colour (the form the server sends and takes for a server's accent); nil for anything else.
    init?(hex: String) {
        guard let rgb = AccentColour.components(hex) else { return nil }
        self.init(.sRGB, red: Double(rgb.red) / 255, green: Double(rgb.green) / 255, blue: Double(rgb.blue) / 255)
    }
}
