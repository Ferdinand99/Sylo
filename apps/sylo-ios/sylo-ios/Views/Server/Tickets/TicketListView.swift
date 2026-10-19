import SwiftUI
import SyloKit

/// The Tickets tab: conversations with members, laid out like Messages. Open ones first, newest
/// activity on top, unread ones marked with a dot.
struct TicketListView: View {
    let model: TicketsModel

    @Environment(PushCoordinator.self) private var push
    @AppStorage("ticketNotificationCardDismissed") private var isNotificationCardDismissed = false

    var body: some View {
        content
            // Runs while the tab is on screen: comes back from a conversation fresh, and picks up
            // new tickets now and then.
            .task {
                while !Task.isCancelled {
                    await model.load()
                    try? await Task.sleep(for: .seconds(30))
                }
            }
            .task { await push.settings.loadAvailability() }
    }

    /// Asks here, where notifications make sense, rather than at launch: once, until answered or
    /// put off with Not Now.
    private var showsNotificationCard: Bool {
        !isNotificationCardDismissed && push.authorization == .notDetermined && push.settings.isAvailable
    }

    @ViewBuilder
    private var content: some View {
        if let list = model.list {
            List {
                if showsNotificationCard {
                    Section {
                        NotificationCard {
                            Task { await push.requestAuthorization() }
                        } notNow: {
                            isNotificationCardDismissed = true
                        }
                    }
                }
                if let message = model.errorMessage {
                    Section {
                        StatusMessage(message, kind: .error)
                    }
                }
                if !list.open.isEmpty {
                    Section("Open") {
                        ForEach(list.open) { ticket in
                            NavigationLink(value: TicketRoute(id: ticket.id, user: ticket.user)) {
                                TicketRow(ticket: ticket)
                            }
                        }
                    }
                }
                if !list.closed.isEmpty {
                    Section("Closed") {
                        ForEach(list.closed) { ticket in
                            NavigationLink(value: TicketRoute(id: ticket.id, user: ticket.user)) {
                                TicketRow(ticket: ticket)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if list.open.isEmpty, list.closed.isEmpty {
                    ContentUnavailableView(
                        "No Tickets", systemImage: "bubble.left.and.bubble.right",
                        description: Text("With the Tickets module on, members open a ticket by sending Sylo a direct message. New tickets show up here for you to answer."))
                        .allowsHitTesting(false)
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load Tickets", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }
}

/// The one-time offer to turn on ticket notifications.
private struct NotificationCard: View {
    let turnOn: () -> Void
    let notNow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Get notified about new tickets")
                        .font(.headline)
                    Text("Sylo can tell you when a member opens a ticket or writes in one, so you can answer right away.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } icon: {
                Image(systemName: "bell.badge")
                    .foregroundStyle(.tint)
            }
            HStack(spacing: 12) {
                Button("Turn On", action: turnOn)
                    .primaryActionStyle()
                Button("Not Now", action: notNow)
                    .secondaryActionStyle()
            }
        }
        .padding(.vertical, 6)
    }
}

/// One conversation: the member, the last message, when, and an unread dot.
private struct TicketRow: View {
    let ticket: TicketSummary
    @ScaledMetric(relativeTo: .body) private var avatarSize = 44
    @ScaledMetric(relativeTo: .body) private var dotSize = 9

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(ticket.isUnread ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear))
                .frame(width: dotSize, height: dotSize)
            ZStack {
                Circle().fill(.tint.opacity(0.15))
                Text(verbatim: ServerIcon.initials(of: ticket.user))
                    .font(.system(size: avatarSize * 0.38, weight: .semibold, design: .rounded))
                    .foregroundStyle(.tint)
            }
            .frame(width: avatarSize, height: avatarSize)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(verbatim: ticket.user)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(verbatim: when)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text(verbatim: preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(ticket.isUnread ? Text("Unread") : Text(verbatim: ""))
    }

    private var when: String {
        ticket.lastAt.map { MessageTime.listLabel(for: $0) } ?? ticket.ago
    }

    private var preview: String {
        let text = ticket.preview.isEmpty ? String(localized: "Attachment") : ticket.preview
        return ticket.previewKind == .staff ? String(localized: "Staff: \(text)") : text
    }
}

/// Times the way Messages words them.
enum MessageTime {
    /// "14:05" today, "Yesterday", the weekday this week, else a short date.
    static func listLabel(for date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) {
            return String(localized: "Yesterday")
        }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(date: .numeric, time: .omitted)
    }

    /// The label above a group of messages: "Today 14:05", "Yesterday 09:12", "Monday 18:30", or a date and time.
    static func separatorLabel(for date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return String(localized: "Today \(time)") }
        if calendar.isDateInYesterday(date) { return String(localized: "Yesterday \(time)") }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return "\(date.formatted(.dateTime.weekday(.wide))) \(time)"
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.Tickets else { return nil }
        return PreviewData.tickets
    }
    NavigationStack {
        TicketListView(model: TicketsModel(server: "1", session: session))
            .navigationTitle("Tickets")
    }
    .environment(session)
    .environment(PushCoordinator(session: session))
}
