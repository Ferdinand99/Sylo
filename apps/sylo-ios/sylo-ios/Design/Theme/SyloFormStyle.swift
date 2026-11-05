import SwiftUI

// Settings screens stay system forms (they hold pickers, text fields and steppers that should
// behave like iOS), dressed as Sylo: the screen background, a card colour behind every section's
// rows, hairline separators and the LED switch.

extension View {
    /// Dresses a `Form` or `List` as Sylo: background, LED switches, hairline separators.
    /// Pair with ``syloSectionCards()`` on the form's content.
    func syloFormStyle() -> some View {
        toggleStyle(LEDToggleStyle())
            .listRowSeparatorTint(Color.syloLine)
            .syloScreen()
    }

    /// Draws the rows of every section in this content on the card colour, so each section reads
    /// as a card. Apply to the content inside the `Form`.
    func syloSectionCards() -> some View {
        listRowBackground(Color.syloCard)
    }
}
