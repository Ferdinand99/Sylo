import SwiftUI
import SyloKit

/// A module on the board: its icon, name, a line of its setup and an LED switch in the corner.
/// Tap opens the module's settings (when the app has them); press and hold switches the module,
/// with a haptic. The LED is a real switch for VoiceOver, 44 pt to hit, so nothing depends on
/// the long press.
struct ModuleTile: View {
    let card: OverviewCard
    let isPending: Bool
    let hasScreen: Bool
    let open: () -> Void
    let setEnabled: @MainActor (Bool) -> Void

    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 112
    @State private var holdCount = 0
    @ScaledMetric(relativeTo: .body) private var scaledIconWell: CGFloat = 36
    private var iconWell: CGFloat { min(scaledIconWell, 54) }

    private var isOn: Bool { card.isEnabled ?? false }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            tileBody
                .syloPressable(tap: { if hasScreen { open() } }, hold: toggleByHold)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(hasScreen ? .isButton : [])
                .accessibilityHint(hasScreen ? Text("Opens the settings") : Text(verbatim: ""))
                .accessibilityAction(named: Text(isOn ? "Switch off" : "Switch on")) { toggleByHold() }
                .sensoryFeedback(.impact(flexibility: .solid, intensity: 0.8), trigger: holdCount)
            Toggle(isOn: Binding(get: { isOn }, set: setEnabled)) {
                Text(verbatim: card.name)
            }
            .toggleStyle(LEDToggleStyle(compactLabel: card.name))
            .disabled(isPending)
            // The 44 pt target sits in the tile corner.
            .padding(.top, 2)
            .padding(.trailing, 6)
        }
    }

    private var tileBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            icon
            Text(verbatim: card.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.syloText)
                .multilineTextAlignment(.leading)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if card.isBeta {
                SyloPill("Beta")
            }
            if let line = card.lines.first {
                Text(verbatim: "\(line.label): \(line.value)")
                    .font(.caption)
                    .foregroundStyle(Color.syloMuted)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            if card.status == .blocked {
                Label(blockedReason, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Color.syloWarn)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(SyloSpacing.m)
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
        .syloCard(radius: SyloRadius.row + 4)
        // An off module sits back a little; the lit ones read first.
        .opacity(isOn ? 1 : 0.82)
    }

    private var icon: some View {
        Image(systemName: ModuleSymbol.name(forIcon: card.icon))
            .font(.system(size: iconWell * 0.46, weight: .semibold))
            .foregroundStyle(isOn ? Color.syloBrand : Color.syloMuted)
            .frame(width: iconWell, height: iconWell)
            .background(
                (isOn ? Color.syloCyan.opacity(0.14) : Color.syloLine),
                in: RoundedRectangle(cornerRadius: SyloRadius.chip, style: .continuous))
            .accessibilityHidden(true)
    }

    private func toggleByHold() {
        guard !isPending else { return }
        holdCount += 1
        setEnabled(!isOn)
    }

    /// Why the module can't run, in Discord's own words for the intent.
    private var blockedReason: String {
        let names = card.missingIntents.map { Self.intentNames[$0] ?? $0 }
        guard !names.isEmpty else { return String(localized: "Can't run on this server right now.") }
        let list = ListFormatter.localizedString(byJoining: names)
        return String(localized: "Needs the \(list) intent. Turn it on for the bot in the Discord Developer Portal.")
    }

    private static let intentNames = [
        "GuildMembers": "Server Members",
        "GuildPresences": "Presence",
        "MessageContent": "Message Content",
    ]
}

/// A card without a switch: opens its page in the web dashboard.
struct LinkTile: View {
    let card: OverviewCard
    let url: URL

    @ScaledMetric(relativeTo: .body) private var scaledIconWell: CGFloat = 36
    private var iconWell: CGFloat { min(scaledIconWell, 54) }

    var body: some View {
        Link(destination: url) {
            HStack(spacing: SyloSpacing.m) {
                Image(systemName: ModuleSymbol.name(forIcon: card.icon))
                    .font(.system(size: iconWell * 0.46, weight: .semibold))
                    .foregroundStyle(Color.syloBrand)
                    .frame(width: iconWell, height: iconWell)
                    .background(
                        Color.syloCyan.opacity(0.14),
                        in: RoundedRectangle(cornerRadius: SyloRadius.chip, style: .continuous))
                Text(verbatim: card.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.syloText)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.forward")
                    .font(.footnote)
                    .foregroundStyle(Color.syloMuted)
            }
            .padding(SyloSpacing.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .syloCard(radius: SyloRadius.row + 4)
        }
        .buttonStyle(.syloPress)
        .accessibilityHint("Opens in the web dashboard")
    }
}

/// A card without a switch that opens a screen in the app (Embed messages).
struct InAppLinkTile: View {
    let card: OverviewCard
    let open: () -> Void

    @ScaledMetric(relativeTo: .body) private var scaledIconWell: CGFloat = 36
    private var iconWell: CGFloat { min(scaledIconWell, 54) }

    var body: some View {
        Button(action: open) {
            HStack(spacing: SyloSpacing.m) {
                Image(systemName: ModuleSymbol.name(forIcon: card.icon))
                    .font(.system(size: iconWell * 0.46, weight: .semibold))
                    .foregroundStyle(Color.syloBrand)
                    .frame(width: iconWell, height: iconWell)
                    .background(
                        Color.syloCyan.opacity(0.14),
                        in: RoundedRectangle(cornerRadius: SyloRadius.chip, style: .continuous))
                    .accessibilityHidden(true)
                Text(verbatim: card.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.syloText)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.syloMuted)
                    .accessibilityHidden(true)
            }
            .padding(SyloSpacing.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .syloCard(radius: SyloRadius.row + 4)
        }
        .buttonStyle(.syloPress)
        .accessibilityHint("Opens the screen")
    }
}
