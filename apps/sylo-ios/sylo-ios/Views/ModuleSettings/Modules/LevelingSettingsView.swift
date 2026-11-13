import SwiftUI
import SyloKit

/// Leveling: level-up announcements, XP cooldown and rate, role rewards, voice XP, XP multipliers,
/// and no-XP roles and channels, then the tools to set one member's XP or wipe everyone's. Mirrors
/// web-v2/src/moduleForms/Leveling.jsx (the leaderboard has its own screen).
struct LevelingSettingsView: View {
    @State private var model: ModuleSettingsModel<LevelingPage>
    @State private var actions: MemberActionModel
    @State private var xpMember: MemberChoice?
    @State private var xpText = ""
    @State private var isConfirmingReset = false
    /// Whether the last notice came from the wipe (it is shown under that button, not the XP form).
    @State private var noticeIsWipe = false
    private let server: ServerID
    private let session: AppSession

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _actions = State(initialValue: MemberActionModel(server: server, session: session))
    }

    /// What was typed as the XP, nil when it is not a whole number.
    private var typedXP: Int? { Int(xpText.trimmingCharacters(in: .whitespacesAndNewlines)) }

    private func setXP() {
        guard let member = xpMember, let xp = typedXP else { return }
        noticeIsWipe = false
        Task {
            if await actions.setXP(member: member, xp: xp) {
                xpMember = nil
                xpText = ""
            }
        }
    }

    var body: some View {
        ModuleSettingsForm("Leveling", model: model) { $settings, page in
            ModuleIntro("Members earn 15–25 XP per message (once per cooldown), plus optional voice XP, scaled by the XP rate and any multipliers below. The public web leaderboard is switched on the Leaderboard page.")

            Section {
                Picker("Announcement", selection: $settings.announce) {
                    ForEach(LevelingAnnounceMode.allCases, id: \.self) { mode in
                        Text(mode.levelingTitle).tag(mode)
                    }
                }
                if settings.announce == .channel {
                    ChannelPicker(title: "Channel", selection: $settings.announceChannel, channels: page.channels,
                                  noneTitle: "Where they levelled up")
                }
                if settings.announce != .off {
                    TextArea(title: "Level-up message", text: $settings.announceMessage,
                             limit: LevelingSettings.maxMessageLength, lines: 2...6)
                }
            } header: {
                Text("Leveling up")
            } footer: {
                if settings.announce != .off {
                    Text(verbatim: "{player} {level} {username} {server}")
                }
            }

            Section {
                NumberField(title: "XP cooldown", value: $settings.cooldownSeconds,
                            range: LevelingSettings.cooldownRange, unit: "sec")
                Picker("XP rate", selection: $settings.xpRate) {
                    ForEach(page.xpRates, id: \.self) { rate in
                        Text(verbatim: "\(rate.formatted())×").tag(rate)
                    }
                }
            } header: {
                Text("XP")
            }

            Section {
                Toggle("Give XP for Time in Voice", isOn: $settings.voiceXpEnabled)
                if settings.voiceXpEnabled {
                    NumberField(title: "XP per voice minute", value: $settings.voiceXpPerMin,
                                range: LevelingSettings.voiceXpRange, unit: "XP")
                    Toggle("Only When Active", isOn: $settings.voiceAfkExcluded)
                }
            } header: {
                Text("Voice XP")
            } footer: {
                if settings.voiceXpEnabled {
                    Text("Active means 2 or more non-bot members, not deafened, and not in the AFK channel. XP per minute is before the rate and multipliers.")
                }
            }

            Section {
                Toggle("Stack Reward Roles", isOn: $settings.stackRewards)
                Toggle("Remove Rewards on XP Loss", isOn: $settings.removeRewardsOnXpLoss)
            } header: {
                Text("Role rewards")
            } footer: {
                Text("Stacked, a member keeps every reward role they reached; otherwise only the highest. A reward role can also be taken away when a member drops below its level.")
            }

            ForEach($settings.rewards) { $reward in
                Section {
                    NumberField(title: "Level", value: $reward.level, range: LevelingSettings.Reward.levelRange)
                    RolePicker(title: "Role", selection: $reward.roleId, roles: page.roles, noneTitle: "Choose a role")
                    Button("Remove Reward", role: .destructive) {
                        settings.rewards.removeAll { $0.id == reward.id }
                    }
                } header: {
                    Text(verbatim: "Level \(reward.level) reward")
                }
            }
            Section {
                if settings.rewards.count < LevelingSettings.maxRewards {
                    Button("Add Role Reward", systemImage: "plus") {
                        settings.rewards.append(LevelingSettings.Reward())
                    }
                }
            } footer: {
                Text("Rewards without a role are dropped when you save.")
            }

            ForEach($settings.multipliers) { $multiplier in
                Section {
                    Picker("Applies to", selection: $multiplier.levelingType) {
                        ForEach(LevelingMultiplierType.allCases, id: \.self) { type in
                            Text(type.levelingTitle).tag(type)
                        }
                    }
                    if multiplier.type == .role {
                        RolePicker(title: "Role", selection: $multiplier.targetId, roles: page.roles,
                                   noneTitle: "Choose a role")
                    } else {
                        ChannelPicker(title: "Channel", selection: $multiplier.targetId, channels: page.channels,
                                      noneTitle: "Choose a channel")
                    }
                    LevelingFactorField(value: $multiplier.factor)
                    Button("Remove Multiplier", role: .destructive) {
                        settings.multipliers.removeAll { $0.id == multiplier.id }
                    }
                } header: {
                    Text("XP multiplier")
                }
            }
            Section {
                if settings.multipliers.count < LevelingSettings.maxMultipliers {
                    Button("Add Multiplier", systemImage: "plus") {
                        settings.multipliers.append(LevelingSettings.Multiplier())
                    }
                }
            } footer: {
                Text("The highest matching role factor is multiplied by the channel factor; both default to 1×, and the result is capped at 10×.")
            }

            Section {
                Picker("Mode", selection: $settings.noXpRolesMode) {
                    Text("All Except These").tag(LevelingListMode.allow)
                    Text("None Except These").tag(LevelingListMode.deny)
                }
                MultiPicker(title: "Roles", selection: $settings.noXpRoles, options: page.roles, prefix: "@")
            } header: {
                Text("Roles that gain XP")
            } footer: {
                if settings.noXpRolesMode == .allow {
                    Text("All roles gain XP, except the ones chosen.")
                } else {
                    Text("No roles gain XP, except the ones chosen.")
                }
            }

            Section {
                Picker("Mode", selection: $settings.noXpChannelsMode) {
                    Text("All Except These").tag(LevelingListMode.allow)
                    Text("None Except These").tag(LevelingListMode.deny)
                }
                MultiPicker(title: "Channels", selection: $settings.noXpChannels, options: page.channels, prefix: "#")
            } header: {
                Text("Channels that give XP")
            } footer: {
                if settings.noXpChannelsMode == .allow {
                    Text("All channels give XP, except the ones chosen.")
                } else {
                    Text("No channels give XP, except the ones chosen.")
                }
            }

            Section {
                MemberPicker("Member", server: server, session: session, selection: $xpMember)
                LabeledContent("New XP total") {
                    TextField("XP", text: $xpText)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                }
                Button("Update XP") { setXP() }
                    .disabled(xpMember == nil || typedXP == nil || actions.isWorking)
                if let notice = actions.notice, !noticeIsWipe {
                    StatusMessage(notice, kind: .notice)
                }
            } header: {
                Text("Set XP for a member")
            } footer: {
                Text("Replaces the member's XP total. Their level and reward roles follow.")
            }

            Section {
                Button("Reset All Leveling Data…", role: .destructive) { isConfirmingReset = true }
                    .disabled(actions.isWorking)
                if let notice = actions.notice, noticeIsWipe {
                    StatusMessage(notice, kind: .notice)
                }
            } footer: {
                Text("Wipes every member's XP, level and message count on this server. This can't be undone.")
            }
        }
        .typedConfirmation(
            "Wipe All Leveling Data?",
            message: "Every member's XP, level and message count on this server is deleted. This can't be undone.",
            word: MemberActionLimits.resetXPWord, isPresented: $isConfirmingReset,
            confirmTitle: "Wipe All Leveling Data"
        ) {
            noticeIsWipe = true
            Task { _ = await actions.resetAllXP() }
        }
        .alert("Couldn't Update XP", isPresented: isShowingActionError, presenting: actions.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: actions.doneCount)
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { actions.errorMessage != nil }, set: { if !$0 { actions.errorMessage = nil } })
    }
}

private extension LevelingSettings.Multiplier {
    /// The multiplier's type; choosing another one clears the role or channel, as on the web.
    var levelingType: LevelingMultiplierType {
        get { type }
        set {
            guard newValue != type else { return }
            type = newValue
            targetId = ""
        }
    }
}

/// A multiplier factor (0.1× to 5×), typed in; pulled back into the range when the field is left.
private struct LevelingFactorField: View {
    @Binding var value: Double

    @FocusState private var isFocused: Bool

    var body: some View {
        LabeledContent("Factor") {
            HStack(spacing: 4) {
                TextField("Factor", value: $value, format: .number.precision(.fractionLength(0...2)))
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .focused($isFocused)
                    .fixedSize()
                Text(verbatim: "×").foregroundStyle(.secondary)
            }
        }
        .onChange(of: isFocused) {
            if !isFocused {
                let range = LevelingSettings.Multiplier.factorRange
                value = min(max(value, range.lowerBound), range.upperBound)
            }
        }
    }
}

private extension LevelingAnnounceMode {
    var levelingTitle: LocalizedStringKey {
        switch self {
        case .channel: "In a Channel"
        case .reply: "Reply to Their Message"
        case .dm: "Direct Message"
        case .off: "No Announcement"
        }
    }
}

private extension LevelingMultiplierType {
    var levelingTitle: LocalizedStringKey {
        switch self {
        case .role: "Role"
        case .channel: "Channel"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<LevelingPage> else { return nil }
        return LevelingPage(
            settings: LevelingSettings(
                xpRate: 1.5,
                noXpChannels: ["c2"],
                voiceXpEnabled: true,
                multipliers: [LevelingSettings.Multiplier(type: .role, targetId: "r2", factor: 1.5)],
                rewards: [LevelingSettings.Reward(level: 10, roleId: "r1")]),
            channels: [ChannelOption(id: "c1", name: "level-ups"), ChannelOption(id: "c2", name: "bot-commands")],
            roles: [RoleOption(id: "r1", name: "Regular"), RoleOption(id: "r2", name: "Booster")])
    }
    NavigationStack {
        LevelingSettingsView(server: "1", session: session)
    }
    .environment(session)
}
