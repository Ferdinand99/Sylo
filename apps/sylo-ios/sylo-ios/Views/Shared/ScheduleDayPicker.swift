import SwiftUI
import SyloKit

/// The days of the week a schedule runs on: one chip per day (Sun to Sat), with a checkmark on the
/// picked ones so the state never depends on colour alone, and two shortcuts. The numbers are the
/// server's (0 is Sunday).
struct ScheduleDayPicker: View {
    @Binding var selection: Set<Int>
    let weekdays: [ScheduleWeekday]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: 8)], spacing: 8) {
                ForEach(weekdays) { day in
                    chip(for: day)
                }
            }
            HStack(spacing: 16) {
                Button("Every Day") { selection = ScheduleDays.all }
                Button("Weekdays") { selection = [1, 2, 3, 4, 5] }
            }
            .font(.footnote)
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    private func chip(for day: ScheduleWeekday) -> some View {
        let isPicked = selection.contains(day.number)
        return Button {
            if isPicked {
                selection.remove(day.number)
            } else {
                selection.insert(day.number)
            }
        } label: {
            HStack(spacing: 4) {
                if isPicked {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.bold))
                }
                Text(verbatim: day.label)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(isPicked ? Color.accentColor : Color.secondary)
        .accessibilityAddTraits(isPicked ? .isSelected : [])
    }
}

#Preview {
    @Previewable @State var days: Set<Int> = [1, 3]
    Form {
        Section("Day of the week") {
            ScheduleDayPicker(selection: $days, weekdays: ScheduleWeekday.standard)
        }
    }
}
