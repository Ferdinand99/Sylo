import SwiftUI
import SyloKit

/// The Overview tab of a server: a bento grid of live facts. Status and round trip time, open
/// tickets (big, and a tap away from the inbox), members, today's messages, how many modules are
/// on as a ring, and open appeals. Every number comes from the server; a tile with nothing to
/// show says what to turn on instead of making something up.
struct BentoOverviewView: View {
    let summary: ServerSummary
    let model: OverviewModel
    /// Tickets with something new, from the inbox (the overview only knows how many are open).
    let unreadTickets: Int
    let openTab: (ServerView.ServerTab) -> Void
    let openModule: (String) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var smallTile: CGFloat = 112
    @ScaledMetric(relativeTo: .body) private var wideTile: CGFloat = 128
    private let gap = SyloSpacing.tileGap

    var body: some View {
        content
            .task { if model.overview == nil { await model.load() } }
            // Back from a module's settings or another tab: the numbers may have changed.
            .onAppear {
                if model.overview != nil { Task { await model.load() } }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let overview = model.overview {
            ScrollView {
                VStack(spacing: gap) {
                    liveStatus(overview)
                        .syloArrival(index: 0)
                    if dynamicTypeSize.isAccessibilitySize {
                        tickets(overview, minHeight: 0).syloArrival(index: 1)
                        members(overview).syloArrival(index: 2)
                        activity.syloArrival(index: 3)
                        modules(overview).syloArrival(index: 4)
                        appeals(overview).syloArrival(index: 5)
                    } else {
                        HStack(alignment: .top, spacing: gap) {
                            tickets(overview, minHeight: smallTile * 2 + gap).syloArrival(index: 1)
                            VStack(spacing: gap) {
                                members(overview).syloArrival(index: 2)
                                activity.syloArrival(index: 3)
                            }
                        }
                        HStack(alignment: .top, spacing: gap) {
                            modules(overview).syloArrival(index: 4)
                            appeals(overview).syloArrival(index: 5)
                        }
                    }
                }
                .padding(.horizontal, SyloSpacing.screen)
                .padding(.top, SyloSpacing.s)
            }
            .tabBarClearance()
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            EmptyState(
                "Couldn't Load Server", systemImage: "exclamationmark.triangle", message: Text(message),
                isError: true, actionTitle: "Try Again") {
                    Task { await model.load() }
                }
        } else {
            SyloLoadingView()
        }
    }

    // MARK: - Tiles

    /// Whether the last call to the Sylo server worked, and how long it took.
    private func liveStatus(_ overview: ServerOverview) -> some View {
        let isOnline = model.errorMessage == nil
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: SyloSpacing.m))
            : AnyLayout(HStackLayout(alignment: .center, spacing: SyloSpacing.m))
        return BentoTile(title: "Live status", systemImage: "dot.radiowaves.left.and.right", isLive: isOnline) {
            layout {
                ServerIcon(url: overview.server.iconURL ?? summary.iconURL, name: summary.name, size: 48)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: SyloSpacing.s) {
                        LiveDot(color: isOnline ? .syloGlow : .syloWarn, isLive: true, pulses: isOnline)
                        Text(isOnline ? "Online" : "Can't reach Sylo")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(Color.syloText)
                    }
                    PlatformPill(platformName: summary.platform.displayName, isFluxer: summary.platform == .fluxer)
                }
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: SyloSpacing.s) }
                if let milliseconds = model.latencyMilliseconds, isOnline {
                    VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: 0) {
                        Text(verbatim: "\(milliseconds)")
                            .font(.syloNumber(.title2))
                            .foregroundStyle(Color.syloText)
                            .contentTransition(.numericText())
                        Text("ms round trip")
                            .font(.caption)
                            .foregroundStyle(Color.syloMuted)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Live status"))
        .accessibilityValue(statusSpoken(isOnline: isOnline))
    }

    private func statusSpoken(isOnline: Bool) -> Text {
        guard isOnline else { return Text("Can't reach Sylo") }
        if let milliseconds = model.latencyMilliseconds {
            return Text("Online, \(milliseconds) milliseconds round trip")
        }
        return Text("Online")
    }

    private func tickets(_ overview: ServerOverview, minHeight: CGFloat) -> some View {
        let open = overview.openTickets
        return BentoTile(title: "Open tickets", systemImage: "ticket", isLive: unreadTickets > 0, minHeight: minHeight) {
            VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                Spacer(minLength: 0)
                HeroNumber(open, scale: minHeight > 0 ? 1.9 : 1)
                Spacer(minLength: 0)
                if unreadTickets > 0 {
                    HStack(spacing: 6) {
                        LiveDot(size: 8)
                        Text("\(unreadTickets) unread")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.syloBrand)
                    }
                } else if open == 0 {
                    Label("All clear", systemImage: "checkmark.circle")
                        .font(.footnote)
                        .foregroundStyle(Color.syloMuted)
                } else {
                    Text("Waiting for staff")
                        .font(.footnote)
                        .foregroundStyle(Color.syloMuted)
                }
            }
        }
        .syloPressable { openTab(.tickets) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("Opens the tickets"))
    }

    private func members(_ overview: ServerOverview) -> some View {
        BentoTile(title: "Members", systemImage: "person.2", minHeight: smallTile) {
            VStack(alignment: .leading, spacing: 0) {
                HeroNumber(overview.server.memberCount)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var activity: some View {
        let target = canOpen("server-stats") ? "server-stats" : nil
        BentoTile(title: "Messages today", systemImage: "waveform.path.ecg", minHeight: smallTile) {
            if let messages = summary.messagesToday {
                HeroNumber(messages)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    HeroNumber(text: "–")
                    Text("Turn on Server stats")
                        .font(.caption)
                        .foregroundStyle(Color.syloMuted)
                }
            }
        }
        .syloPressable {
            if let target { openModule(target) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(target == nil ? [] : .isButton)
    }

    private func modules(_ overview: ServerOverview) -> some View {
        let cards = overview.groups.flatMap(\.cards).filter(\.hasToggle)
        let enabled = cards.count(where: { $0.isEnabled == true })
        return BentoTile(title: "Modules", systemImage: "switch.2", minHeight: wideTile) {
            ModuleRing(enabled: enabled, total: cards.count)
        }
        .syloPressable { openTab(.modules) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text("Opens the modules"))
    }

    @ViewBuilder
    private func appeals(_ overview: ServerOverview) -> some View {
        let target = canOpen("appeals") ? "appeals" : nil
        BentoTile(title: "Open appeals", systemImage: "hand.raised", isLive: overview.openAppeals > 0, minHeight: wideTile) {
            VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                HeroNumber(overview.openAppeals)
                Spacer(minLength: 0)
                Text(overview.openAppeals == 0 ? "None waiting" : "Waiting for a decision")
                    .font(.footnote)
                    .foregroundStyle(Color.syloMuted)
            }
        }
        .syloPressable {
            if let target { openModule(target) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(target == nil ? [] : .isButton)
    }

    /// Whether this server has the module and the app has a settings screen for it.
    private func canOpen(_ moduleID: String) -> Bool {
        ModuleScreens.hasScreen(moduleID) && model.card(moduleID) != nil
    }
}

/// A big number in the Sylo way: monospaced digits, scaling with Dynamic Type but never wider than
/// its tile.
private struct HeroNumber: View {
    let value: Value
    var scale: CGFloat = 1
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 40

    enum Value {
        case number(Int)
        case text(String)
    }

    init(_ value: Int, scale: CGFloat = 1) {
        self.value = .number(value)
        self.scale = scale
    }
    init(text: String) { self.value = .text(text) }

    var body: some View {
        Group {
            switch value {
            case .number(let number): Text(number, format: .number)
            case .text(let text): Text(verbatim: text)
            }
        }
        .font(.system(size: size * scale, weight: .semibold, design: .monospaced))
        .foregroundStyle(Color.syloText)
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .contentTransition(.numericText())
    }
}

/// How many modules are on, as a ring with the count in the middle.
private struct ModuleRing: View {
    let enabled: Int
    let total: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 76
    @State private var progress = 0.0

    private var fraction: Double { total > 0 ? Double(enabled) / Double(total) : 0 }

    var body: some View {
        HStack(spacing: SyloSpacing.m) {
            ZStack {
                Circle().stroke(Color.syloLineStrong, lineWidth: 8)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(
                        AngularGradient(
                            colors: [Color.syloCyan.opacity(0.45), Color.syloCyan],
                            center: .center, startAngle: .degrees(0), endAngle: .degrees(360 * max(fraction, 0.01))),
                        style: StrokeStyle(lineWidth: 8, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .shadow(color: Color.syloGlow.opacity(0.55), radius: 6)
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(verbatim: "\(enabled)")
                        .font(.system(size: size * 0.27, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.syloText)
                    Text(verbatim: "/\(total)")
                        .font(.system(size: size * 0.17, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.syloMuted)
                }
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .padding(.horizontal, 10)
            }
            .frame(width: size, height: size)
            Text("modules on")
                .font(.caption)
                .foregroundStyle(Color.syloMuted)
                .lineLimit(2)
        }
        .onAppear {
            if reduceMotion {
                progress = fraction
            } else {
                withAnimation(.spring(duration: 0.9, bounce: 0.15).delay(0.25)) { progress = fraction }
            }
        }
        .onChange(of: fraction) {
            withAnimation(reduceMotion ? nil : SyloMotion.settle) { progress = fraction }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Modules on"))
        .accessibilityValue(Text("\(enabled) of \(total)"))
    }
}
