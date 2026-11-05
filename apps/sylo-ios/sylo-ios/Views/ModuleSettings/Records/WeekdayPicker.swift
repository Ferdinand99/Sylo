import SwiftUI
import SyloKit

/// The days of the week as toggle chips, for a schedule. Each chip says whether it is on in
/// words for VoiceOver, and shows a checkmark besides the colour.
struct WeekdayPicker: View {
    let weekdays: [WeekdayOption]
    @Binding var selection: Set<Int>

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 60), spacing: SyloSpacing.s)], spacing: SyloSpacing.s) {
            ForEach(weekdays) { day in
                let isOn = selection.contains(day.number)
                Button {
                    if isOn { selection.remove(day.number) } else { selection.insert(day.number) }
                } label: {
                    HStack(spacing: 4) {
                        if isOn {
                            Image(systemName: "checkmark")
                                .font(.caption2.weight(.bold))
                        }
                        Text(verbatim: day.name)
                            .font(.footnote.weight(.medium))
                    }
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .foregroundStyle(isOn ? Color.syloOnCyan : Color.syloText)
                    .background(isOn ? Color.syloCyan : Color.syloCard2, in: Capsule())
                    .overlay { Capsule().strokeBorder(isOn ? Color.clear : Color.syloLineStrong, lineWidth: 1) }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isOn ? .isSelected : [])
            }
        }
        .padding(.vertical, SyloSpacing.xs)
    }
}
