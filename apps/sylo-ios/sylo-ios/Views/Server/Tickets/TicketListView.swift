import SwiftUI
import SyloKit

/// The Tickets tab: conversations with members as cards. Open ones first, newest activity on top,
/// unread ones lit with a glowing dot. Swipe an open ticket to close it.
struct TicketListView: View {
    let model: TicketsModel
    /// Opens a conversation (pushes it on the server's navigation stack).
    let open: (TicketRoute) -> Void

    @Environment(PushCoordinator.self) private var push
    @AppStorage("ticketNotificationCardDismissed") private var isNotificationCardDismissed = false
    @State private var ticketToClose: TicketSummary?

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
            .confirmationDialog(
                "Close this ticket?", isPresented: isConfirmingClose, titleVisibility: .visible,
                presenting: ticketToClose
            ) { ticket in
                Button("Close Ticket", role: .destructive) {
                    Task { await model.close(ticket.id) }
                }
            } message: { ticket in
                Text("\(ticket.user) is told the ticket is closed.")
            }
            .alert("Couldn't Close Ticket", isPresented: isShowingActionError, presenting: model.actionError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
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
                        .cardRow()
                    }
                }
                if let message = model.errorMessage {
                    Section {
                        StatusMessage(message, kind: .error)
                            .padding(SyloSpacing.m)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .syloCard(radius: SyloRadius.row)
                            .cardRow()
                    }
                }
                if !list.open.isEmpty {
                    Section {
                        ForEach(list.open) { ticket in
                            Button {
                                open(TicketRoute(id: ticket.id, user: ticket.user))
                            } label: {
                                TicketRow(ticket: ticket, isClosed: false)
                            }
                            .buttonStyle(.syloPress)
                            .cardRow()
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button {
                                    ticketToClose = ticket
                                } label: {
                                    Label("Close", systemImage: "checkmark.circle")
                                }
                                .tint(Color.syloCyan)
                            }
                            .accessibilityAction(named: Text("Close ticket")) { ticketToClose = ticket }
                        }
                    } header: {
                        SectionHeading(title: "Open", count: list.open.count)
                    }
                }
                if !list.closed.isEmpty {
                    Section {
                        ForEach(list.closed) { ticket in
                            Button {
                                open(TicketRoute(id: ticket.id, user: ticket.user))
                            } label: {
                                TicketRow(ticket: ticket, isClosed: true)
                            }
                            .buttonStyle(.syloPress)
                            .cardRow()
                        }
                    } header: {
                        SectionHeading(title: "Closed", count: list.closed.count)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .syloScreen()
            .tabBarClearance()
            .overlay {
                if list.open.isEmpty, list.closed.isEmpty {
                    EmptyState(
                        "No Tickets", systemImage: "bubble.left.and.bubble.right",
                        message: Text("With the Tickets module on, members open a ticket by sending Sylo a direct message. New tickets show up here for you to answer."))
                        .allowsHitTesting(false)
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            EmptyState(
                "Couldn't Load Tickets", systemImage: "exclamationmark.triangle", message: Text(message),
                isError: true, actionTitle: "Try Again") {
                    Task { await model.load() }
                }
        } else {
            SyloLoadingView()
        }
    }

    private var isConfirmingClose: Binding<Bool> {
        Binding(get: { ticketToClose != nil }, set: { if !$0 { ticketToClose = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

extension View {
    /// A list row that is a free-standing card: no row background, no separator, a gap above and below.
    fileprivate func cardRow() -> some View {
        listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: SyloSpacing.xs, bottom: 4, trailing: SyloSpacing.xs))
    }
}

/// "Open · 3" above a group of tickets.
private struct SectionHeading: View {
    let title: LocalizedStringKey
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Color.syloText)
            Text(verbatim: "\(count)")
                .font(.syloNumber(.footnote, weight: .medium))
                .foregroundStyle(Color.syloMuted)
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The one-time offer to turn on ticket notifications.
private struct NotificationCard: View {
    let turnOn: () -> Void
    let notNow: () -> Void

    private var turnOnButton: some View {
        Button("Turn On", action: turnOn).primaryActionStyle()
    }

    private var notNowButton: some View {
        Button("Not Now", action: notNow).secondaryActionStyle()
    }

    var body: some View {
        SectionCard(title: "Get notified about new tickets", systemImage: "bell.badge") {
            Text("Sylo can tell you when a member opens a ticket or writes in one, so you can answer right away.")
                .font(.subheadline)
                .foregroundStyle(Color.syloMuted)
                .fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: SyloSpacing.m) { turnOnButton; notNowButton }
                VStack(spacing: SyloSpacing.s) { turnOnButton; notNowButton }
            }
        }
    }
}

/// One conversation: the member, the last message, when, and a glowing dot while it is unread.
private struct TicketRow: View {
    let ticket: TicketSummary
    let isClosed: Bool

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var scaledAvatarSize: CGFloat = 44
    private var avatarSize: CGFloat { min(scaledAvatarSize, 64) }

    var body: some View {
        HStack(alignment: .top, spacing: SyloSpacing.m) {
            avatar
            VStack(alignment: .leading, spacing: 3) {
                header
                Text(verbatim: preview)
                    .font(.subheadline)
                    .foregroundStyle(Color.syloMuted)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(verbatim: "#\(ticket.id)")
                    .font(.syloNumber(.caption2, weight: .regular))
                    .foregroundStyle(Color.syloMuted.opacity(0.8))
            }
        }
        .padding(SyloSpacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .syloCard(radius: SyloRadius.row + 4, isLive: ticket.isUnread, showsGlow: false)
        .opacity(isClosed ? 0.72 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityValue(ticket.isUnread ? Text("Unread") : Text(verbatim: ""))
    }

    private var avatar: some View {
        ZStack {
            Circle().fill(Color.syloCyan.opacity(ticket.isUnread ? 0.2 : 0.12))
            Circle().strokeBorder(Color.syloCyan.opacity(ticket.isUnread ? 0.6 : 0.25), lineWidth: 1)
            Text(verbatim: ServerIcon.initials(of: ticket.user))
                .font(.system(size: avatarSize * 0.36, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.syloBrand)
        }
        .frame(width: avatarSize, height: avatarSize)
        .overlay(alignment: .topTrailing) {
            if ticket.isUnread {
                LiveDot(size: 10)
                    .padding(1.5)
                    .background(Color.syloCard, in: Circle())
                    .offset(x: 2, y: -2)
            }
        }
        .accessibilityHidden(true)
    }

    private var header: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: SyloSpacing.s))
        return layout {
            Text(verbatim: ticket.user)
                .font(.headline)
                .foregroundStyle(Color.syloText)
                .lineLimit(1)
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: SyloSpacing.s) }
            Text(verbatim: when)
                .font(.syloNumber(.caption, weight: .regular))
                .foregroundStyle(ticket.isUnread ? Color.syloBrand : Color.syloMuted)
        }
    }

    private var when: String {
        ticket.lastAt.map { MessageTime.listLabel(for: $0) } ?? ticket.ago
    }

    private var preview: String {
        let text = ticket.preview.isEmpty ? String(localized: "Attachment") : ticket.preview
        return ticket.previewKind == .staff ? String(localized: "Staff: \(text)") : text
    }
}
