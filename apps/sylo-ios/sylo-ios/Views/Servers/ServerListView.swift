import SwiftUI
import SyloKit

/// The server list: one card per server, grouped by platform, pull to refresh. Each card shows the
/// server's icon in a status ring, its platform, members, how busy it was today and, when there are
/// tickets, a badge that pulses while some are unread.
struct ServerListView: View {
    let servers: ServersModel
    let selection: ServerID?
    let open: (ServerID) -> Void
    let zoomNamespace: Namespace.ID

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: SyloSpacing.s) {
                if servers.hasLoaded, let message = servers.errorMessage {
                    StatusMessage(message, kind: .error)
                        .padding(SyloSpacing.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .syloCard(radius: SyloRadius.row)
                }
                ForEach(servers.sections) { section in
                    PlatformHeader(platform: section.platform)
                        .padding(.top, SyloSpacing.s)
                    ForEach(Array(section.servers.enumerated()), id: \.element.id) { index, server in
                        Button {
                            open(server.id)
                        } label: {
                            ServerCard(
                                server: server, busiest: busiest,
                                isSelected: horizontalSizeClass == .regular && selection == server.id)
                        }
                        .buttonStyle(.syloPress)
                        .syloZoomSource(id: server.id, in: zoomNamespace)
                        .syloArrival(index: index)
                    }
                }
            }
            .padding(.horizontal, SyloSpacing.screen)
            .padding(.bottom, SyloSpacing.xl)
        }
        .syloScreen()
        .overlay { placeholder }
        .refreshable { await servers.load() }
    }

    /// The most messages any server had today, so each card's meter is relative to the busiest.
    private var busiest: Int {
        servers.servers.compactMap(\.messagesToday).max() ?? 0
    }

    @ViewBuilder
    private var placeholder: some View {
        if servers.hasLoaded, servers.servers.isEmpty {
            EmptyState(
                "No Servers", systemImage: "server.rack",
                message: Text("You don't manage a server with Sylo on it yet. Add Sylo to a server, then pull to refresh."))
                // Let the pull to refresh reach the list underneath.
                .allowsHitTesting(false)
        } else if !servers.hasLoaded {
            if let message = servers.errorMessage {
                EmptyState(
                    "Couldn't Load Servers", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") {
                        Task { await servers.load() }
                    }
            } else {
                SyloLoadingView()
            }
        }
    }
}

/// "Discord" or "Fluxer" above its servers.
private struct PlatformHeader: View {
    let platform: Platform

    var body: some View {
        HStack(spacing: SyloSpacing.s) {
            Circle()
                .fill(platform == .fluxer ? Color.syloFluxer : Color.syloDiscord)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(platform.displayName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.syloMuted)
        }
        .padding(.horizontal, SyloSpacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One server in the list.
struct ServerCard: View {
    let server: ServerSummary
    /// The highest message count today among the person's servers; 0 when none is known.
    let busiest: Int
    var isSelected = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: SyloSpacing.m))
            : AnyLayout(HStackLayout(alignment: .center, spacing: SyloSpacing.m))
        layout {
            StatusRingIcon(server: server)
            VStack(alignment: .leading, spacing: 6) {
                Text(server.name)
                    .font(.headline)
                    .foregroundStyle(Color.syloText)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                detail
                if let messages = server.messagesToday {
                    ActivityMeter(messages: messages, busiest: busiest)
                }
            }
            if dynamicTypeSize.isAccessibilitySize {
                TicketBadge(open: server.openTickets, unread: server.unreadTickets)
            } else {
                Spacer(minLength: SyloSpacing.s)
                TicketBadge(open: server.openTickets, unread: server.unreadTickets)
            }
        }
        .padding(SyloSpacing.m + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .syloCard(radius: SyloRadius.tile, isLive: server.unreadTickets > 0, isSelected: isSelected)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Opens the server"))
    }

    /// Platform and members on one line; wraps under each other at large sizes.
    private var detail: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: SyloSpacing.s) { platformPill; members }
            VStack(alignment: .leading, spacing: SyloSpacing.xs) { platformPill; members }
        }
    }

    private var platformPill: some View {
        PlatformPill(platformName: server.platform.displayName, isFluxer: server.platform == .fluxer)
    }

    @ViewBuilder
    private var members: some View {
        if let count = server.memberCount {
            Text("^[\(count) member](inflect: true)")
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(Color.syloMuted)
        }
    }
}

/// The server's icon in a rounded ring: lit cyan with a glow while the server has something live
/// (messages today or unread tickets), a hairline otherwise.
private struct StatusRingIcon: View {
    let server: ServerSummary

    @ScaledMetric(relativeTo: .body) private var scaledIconSize: CGFloat = 44
    /// Matches ``ServerIcon``, which stops growing at 1.6 times its base size.
    private var iconSize: CGFloat { min(scaledIconSize, 44 * 1.6) }
    private let gap: CGFloat = 4

    private var isLive: Bool { (server.messagesToday ?? 0) > 0 || server.unreadTickets > 0 }

    var body: some View {
        let ring = RoundedRectangle(cornerRadius: iconSize * 0.28 + gap + 1, style: .continuous)
        ServerIcon(url: server.iconURL, name: server.name, size: 44)
            .padding(gap + 1)
            .overlay {
                ring.strokeBorder(
                    isLive
                        ? AnyShapeStyle(LinearGradient(
                            colors: [Color.syloCyan, Color.syloCyan.opacity(0.35)],
                            startPoint: .topLeading, endPoint: .bottomTrailing))
                        : AnyShapeStyle(Color.syloLineStrong),
                    lineWidth: isLive ? 1.75 : 1)
            }
            .shadow(color: isLive ? Color.syloGlow.opacity(0.35) : .clear, radius: 8)
    }
}

/// "312 messages today" with a small meter, as long as the busiest server's today.
private struct ActivityMeter: View {
    let messages: Int
    let busiest: Int

    var body: some View {
        // Side by side when there is room; stacked, with the text free to wrap, at large sizes.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: SyloSpacing.s) {
                meter
                label.lineLimit(1)
            }
            VStack(alignment: .leading, spacing: 4) {
                meter
                label
            }
        }
    }

    private var meter: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(Color.syloLine)
            Capsule()
                .fill(LinearGradient(
                    colors: [Color.syloCyan.opacity(0.5), Color.syloCyan], startPoint: .leading, endPoint: .trailing))
                .frame(width: max(Self.meterWidth * fraction, messages > 0 ? 4 : 0))
        }
        .frame(width: Self.meterWidth, height: 5)
        .accessibilityHidden(true)
    }

    private var label: some View {
        Text("^[\(messages) message](inflect: true) today")
            .font(.caption)
            .monospacedDigit()
            .foregroundStyle(Color.syloMuted)
            .multilineTextAlignment(.leading)
    }

    private static let meterWidth: CGFloat = 44

    private var fraction: CGFloat {
        busiest > 0 ? min(CGFloat(messages) / CGFloat(busiest), 1) : 0
    }
}

/// Tickets waiting on a server: the unread ones as a filled, glowing count that pulses, otherwise
/// how many are open.
private struct TicketBadge: View {
    let open: Int
    let unread: Int

    var body: some View {
        if unread > 0 {
            HStack(spacing: 4) {
                Image(systemName: "ticket.fill")
                    .font(.caption.weight(.semibold))
                Text(verbatim: "\(unread)")
                    .font(.syloNumber(.footnote, weight: .bold))
            }
            .foregroundStyle(Color.syloOnCyan)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color.syloCyan, in: Capsule())
            .syloGlow(radius: 10)
            .syloPulse()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("^[\(unread) unread ticket](inflect: true)"))
        } else if open > 0 {
            HStack(spacing: 4) {
                Image(systemName: "ticket")
                    .font(.caption)
                Text(verbatim: "\(open)")
                    .font(.syloNumber(.footnote, weight: .medium))
            }
            .foregroundStyle(Color.syloMuted)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .overlay { Capsule().strokeBorder(Color.syloLineStrong, lineWidth: 1) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("^[\(open) open ticket](inflect: true)"))
        }
    }
}
