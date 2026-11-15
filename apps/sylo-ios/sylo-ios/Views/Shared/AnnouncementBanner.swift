import SwiftUI
import SyloKit

/// The notice the operator of this Sylo shows everyone who is signed in (an incident,
/// maintenance). Dismissible, except a critical one. Takes no room while there is none.
///
/// Loads its own notice, so a screen only has to place it: `.safeAreaInset(edge: .top)`.
struct AnnouncementBanner: View {
    @State private var model: AnnouncementModel
    @Environment(\.scenePhase) private var scenePhase

    init(server: ServerURL, session: AppSession) {
        _model = State(initialValue: AnnouncementModel(
            session: session, store: UserDefaultsDismissedAnnouncement(server: server)))
    }

    var body: some View {
        // A zero-height base keeps the view alive, so its task runs while there is no notice.
        ZStack(alignment: .top) {
            Color.clear.frame(height: 0)
            if let announcement = model.visible {
                banner(announcement)
                    .padding(.horizontal)
                    .padding(.vertical, 8)
            }
        }
        .task { await model.load() }
        .onChange(of: scenePhase) {
            if scenePhase == .active { Task { await model.load() } }
        }
    }

    private func banner(_ announcement: Announcement) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: Self.symbol(announcement.severity))
                .foregroundStyle(Self.color(announcement.severity))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: announcement.title)
                    .font(.subheadline.weight(.semibold))
                if !announcement.body.isEmpty {
                    Text(verbatim: announcement.body)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if announcement.isDismissible {
                Button {
                    withAnimation { model.dismiss() }
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .frame(minWidth: 28, minHeight: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(12)
        .background(Self.color(announcement.severity).opacity(0.14), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Self.color(announcement.severity).opacity(0.35)))
        .accessibilityElement(children: .contain)
    }

    private static func symbol(_ severity: AnnouncementSeverity) -> String {
        switch severity {
        case .critical: "exclamationmark.octagon.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .info, .other: "info.circle.fill"
        }
    }

    private static func color(_ severity: AnnouncementSeverity) -> Color {
        switch severity {
        case .critical: .red
        case .warning: .orange
        case .info, .other: .accentColor
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.CurrentAnnouncement else { return nil }
        return AnnouncementAnswer(announcement: Announcement(
            title: "Planned maintenance", body: "Sylo restarts tonight at 22:00 UTC.", severity: .warning,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)))
    }
    List { Text("Servers") }
        .safeAreaInset(edge: .top) { AnnouncementBanner(server: .hosted, session: session) }
}
