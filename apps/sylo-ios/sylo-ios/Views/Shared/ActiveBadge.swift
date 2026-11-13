import SwiftUI

/// "Active" or "Paused" next to the name of a schedule, a reminder or a watch.
struct ActiveBadge: View {
    let isActive: Bool

    var body: some View {
        Group {
            if isActive {
                Text("Active")
            } else {
                Text("Paused")
            }
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background((isActive ? Color.green : Color.secondary).opacity(0.2), in: Capsule())
    }
}
