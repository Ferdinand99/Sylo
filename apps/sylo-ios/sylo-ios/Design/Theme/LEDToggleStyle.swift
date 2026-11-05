import SwiftUI

/// The Sylo switch: a slim track with an LED for a knob. Off, the LED is dark; on, it lights
/// cyan with a halo and the track takes a cyan wash. Same behaviour as the system switch, and
/// VoiceOver reads it as one ("Logging, switch, on"). A selection haptic on every change.
///
/// - Forms: `Toggle("Delete the message", isOn: $x)` gets the label on the left and the switch on
///   the right; the style is set once on the form (``syloFormStyle()``).
/// - Tiles: `LEDToggleStyle(compactLabel: name)` draws the switch alone, smaller, for a tile's
///   corner; the label is only spoken.
struct LEDToggleStyle: ToggleStyle {
    var compactLabel: String?

    func makeBody(configuration: Configuration) -> some View {
        LEDToggleBody(configuration: configuration, compactLabel: compactLabel)
    }
}

private struct LEDToggleBody: View {
    let configuration: ToggleStyleConfiguration
    let compactLabel: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    private var isCompact: Bool { compactLabel != nil }
    private var trackSize: CGSize {
        isCompact ? CGSize(width: 40, height: 24) : CGSize(width: 52, height: 30)
    }
    private var knob: CGFloat { isCompact ? 14 : 20 }

    var body: some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            if compactLabel != nil {
                led
                    // 44 pt to hit, even though the track is smaller.
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            } else {
                HStack(spacing: SyloSpacing.m) {
                    configuration.label
                        .foregroundStyle(Color.primary)
                    Spacer(minLength: SyloSpacing.s)
                    led
                }
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: configuration.isOn)
        .opacity(isEnabled ? 1 : 0.5)
        // One element, a real switch to VoiceOver and Switch Control.
        .accessibilityRepresentation {
            if let compactLabel {
                Toggle(compactLabel, isOn: configuration.$isOn).toggleStyle(.switch)
            } else {
                Toggle(isOn: configuration.$isOn) { configuration.label }.toggleStyle(.switch)
            }
        }
    }

    private var led: some View {
        let isOn = configuration.isOn
        return ZStack(alignment: isOn ? .trailing : .leading) {
            Capsule()
                .fill(isOn ? Color.syloCyan.opacity(0.22) : Color.syloCard2)
            Capsule()
                .strokeBorder(isOn ? Color.syloCyan.opacity(0.8) : Color.syloLineStrong, lineWidth: 1)
            Circle()
                .fill(isOn ? Color.syloCyan : Color.syloMuted.opacity(0.5))
                .frame(width: knob, height: knob)
                .shadow(color: isOn ? Color.syloGlow.opacity(0.9) : .clear, radius: 6)
                .padding(.horizontal, (trackSize.height - knob) / 2)
        }
        .frame(width: trackSize.width, height: trackSize.height)
        .animation(reduceMotion ? nil : SyloMotion.quick, value: isOn)
    }
}

extension ToggleStyle where Self == LEDToggleStyle {
    static var led: LEDToggleStyle { LEDToggleStyle() }
    static func led(compactLabel: String) -> LEDToggleStyle { LEDToggleStyle(compactLabel: compactLabel) }
}

/// An LED that only shows a state (no control): on, off, or blocked.
struct LEDIndicator: View {
    enum Level { case on, off, blocked }
    let state: Level
    var size: CGFloat = 9

    var body: some View {
        switch state {
        case .on:
            LiveDot(size: size, pulses: false)
        case .off:
            LiveDot(size: size, isLive: false)
        case .blocked:
            Circle().fill(Color.syloWarn).frame(width: size, height: size).accessibilityHidden(true)
        }
    }
}
