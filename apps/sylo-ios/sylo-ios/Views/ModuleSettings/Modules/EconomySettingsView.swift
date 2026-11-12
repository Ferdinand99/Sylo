import SwiftUI
import SyloKit

/// Economy: the currency, what members earn from chat, voice, /daily and /work, the bank and
/// payments, robbing, the web shop and leaderboard, and the staff log. A read only member lookup
/// is one row away. The shop items, changing a member's money and the reset of the whole economy
/// stay in the web dashboard. Mirrors web-v2/src/moduleForms/Economy.jsx.
struct EconomySettingsView: View {
    @State private var model: ModuleSettingsModel<EconomyPage>
    @State private var note: ModulePlatformNoteModel
    private let server: ServerID
    private let session: AppSession

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: EconomyPage.moduleID, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Economy", model: model, problem: model.draft?.currencyProblem) { $settings, page in
            ModuleIntro("A server currency. Members earn it by chatting, being in voice, /daily and /work, keep it as cash or in the bank, and can pay each other.")
            PlatformNoteSection(model: note)

            Section {
                NavigationLink {
                    EconomyMembersView(
                        server: server, session: session,
                        currencyEmoji: settings.currencyEmoji, currencyName: settings.currencyName)
                } label: {
                    Label("Member balances", systemImage: "person.2")
                }
            } footer: {
                Text("See who holds what and each member's latest transactions. Changing a balance is done in the web dashboard.")
            }

            Section {
                TextField("Name", text: $settings.currencyName)
                    .textInputAutocapitalization(.never)
                TextField("Emoji", text: $settings.currencyEmoji)
                    .textInputAutocapitalization(.never)
                NumberField(title: "Starting balance", value: $settings.startingBalance,
                            range: EconomySettings.startingBalanceRange)
            } header: {
                Text("Currency")
            } footer: {
                if let problem = settings.currencyProblem {
                    Text(verbatim: problem)
                } else {
                    Text("The name (coins, gold, credits) comes after every amount and the emoji before it. A server emoji looks like <:name:id>. The starting balance is the cash a member gets when they first show up, and after a reset.")
                }
            }

            Section {
                Toggle("Members earn money by chatting", isOn: $settings.messageEnabled)
                if settings.messageEnabled {
                    NumberField(title: "At least", value: $settings.messageMin,
                                range: EconomySettings.messageAmountRange)
                    NumberField(title: "At most", value: $settings.messageMax,
                                range: EconomySettings.messageAmountRange)
                    NumberField(title: "Cooldown", value: $settings.messageCooldownSeconds,
                                range: EconomySettings.messageCooldownRange, unit: "seconds")
                    NumberField(title: "Shortest message", value: $settings.messageMinLength,
                                range: EconomySettings.messageMinLengthRange, unit: "characters")
                }
            } header: {
                Text("Earning from chat")
            } footer: {
                Text(page.messageLengthChecked
                    ? "Each message pays a random amount between the two, at most once per cooldown. Shorter messages pay nothing. The highest amount is raised to the lowest if it is below it."
                    : "Each message pays a random amount between the two, at most once per cooldown. The shortest message length does nothing on Discord until the bot can read message text, which only the bot's owner can switch on.")
            }

            if settings.messageEnabled {
                Section {
                    MultiPicker(title: "Channels that pay nothing", selection: $settings.ignoredChannels,
                                options: page.channels, prefix: "#")
                    MultiPicker(title: "Roles that earn nothing", selection: $settings.ignoredRoles,
                                options: page.roles, prefix: "@")
                } footer: {
                    Text("Chatting in these channels, or holding these roles, earns nothing from chat.")
                }
            }

            Section {
                Toggle("Members earn money in voice", isOn: $settings.voiceEnabled)
                if settings.voiceEnabled {
                    NumberField(title: "Paid per 5 minutes", value: $settings.voiceAmount,
                                range: EconomySettings.voiceAmountRange)
                }
            } header: {
                Text("Earning from voice")
            }

            Section {
                NumberField(title: "Daily reward", value: $settings.dailyBase,
                            range: EconomySettings.dailyBaseRange)
                NumberField(title: "Bonus per day in a row", value: $settings.dailyStreakBonus,
                            range: EconomySettings.dailyStreakBonusRange)
                NumberField(title: "Work pays at least", value: $settings.workMin,
                            range: EconomySettings.workAmountRange)
                NumberField(title: "Work pays at most", value: $settings.workMax,
                            range: EconomySettings.workAmountRange)
                NumberField(title: "Work cooldown", value: $settings.workCooldownMinutes,
                            range: EconomySettings.workCooldownRange, unit: "min")
            } header: {
                Text("Daily and work")
            } footer: {
                Text("/daily can be claimed once a day. The streak bonus counts at most 7 days. /work pays a random amount between the two.")
            }

            Section {
                Toggle("The bank is on", isOn: $settings.bankEnabled)
                Toggle("Members can pay each other", isOn: $settings.payEnabled)
                if settings.payEnabled {
                    NumberField(title: "Payment tax", value: $settings.payTaxPercent,
                                range: EconomySettings.payTaxRange, unit: "%")
                }
            } header: {
                Text("Bank and payments")
            } footer: {
                Text("The tax is taken from what the sender pays, on top of the amount.")
            }

            Section {
                Toggle("Members can rob each other", isOn: $settings.robEnabled)
                if settings.robEnabled {
                    NumberField(title: "Chance to succeed", value: $settings.robChancePercent,
                                range: EconomySettings.robChanceRange, unit: "%")
                    NumberField(title: "Cooldown for the robber", value: $settings.robCooldownHours,
                                range: EconomySettings.robCooldownRange, unit: "hours")
                    NumberField(title: "Steals at least", value: $settings.robMinPercent,
                                range: EconomySettings.robPercentRange, unit: "%")
                    NumberField(title: "Steals at most", value: $settings.robMaxPercent,
                                range: EconomySettings.robPercentRange, unit: "%")
                    NumberField(title: "Fine if caught", value: $settings.robFinePercent,
                                range: EconomySettings.robFinePercentRange, unit: "%")
                    NumberField(title: "Smallest fine", value: $settings.robFineMin,
                                range: EconomySettings.robFineMinRange)
                    NumberField(title: "Victim must hold at least", value: $settings.robVictimMinCash,
                                range: EconomySettings.robVictimMinCashRange)
                    NumberField(title: "New members are safe for", value: $settings.robNewMemberHours,
                                range: EconomySettings.robNewMemberRange, unit: "hours")
                    NumberField(title: "Victim safe after a robbery", value: $settings.robProtectionMinutes,
                                range: EconomySettings.robProtectionRange, unit: "min")
                }
            } header: {
                Text("Robbing")
            } footer: {
                Text("Off by default. The amounts are a share of the victim's cash. The highest share is raised to the lowest if it is below it.")
            }

            Section {
                Toggle("Web shop page", isOn: $settings.webShop)
                ChannelPicker(title: "Channel for custom items", selection: $settings.shopChannelId,
                              channels: page.channels, noneTitle: "None")
            } header: {
                Text("Shop")
            } footer: {
                Text("Signed-in members can browse and buy on the web shop page. Custom items post a notice in the channel for staff to fulfil. Add and change the shop's items in the web dashboard.")
            }

            Section {
                Toggle("Public leaderboard page", isOn: $settings.publicLeaderboard)
                ChannelPicker(title: "Staff log channel", selection: $settings.logChannelId,
                              channels: page.channels, noneTitle: "None")
            } header: {
                Text("Leaderboard and log")
            } footer: {
                Text("Anyone with the link can see the richest members, by name and total only. Sylo posts to the log channel when staff add, remove or set money, or reset a member or the whole economy.")
            }

            DashboardLinkSection(
                server: server, module: EconomyPage.moduleID,
                footer: "Shop items, refunds, changing a member's money and resetting the economy are done in the web dashboard.")
        }
        .task { await note.load() }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        guard endpoint is Endpoints.LoadModuleSettings<EconomyPage> else { return nil }
        return EconomyPage(
            settings: EconomySettings(currencyName: "gold", currencyEmoji: "🪙", robEnabled: true, logChannelId: "c1"),
            channels: [ChannelOption(id: "c1", name: "eco-log")],
            roles: [RoleOption(id: "r1", name: "Bots")],
            messageLengthChecked: false)
    }
    NavigationStack {
        EconomySettingsView(server: "1", session: session)
    }
    .environment(session)
}
