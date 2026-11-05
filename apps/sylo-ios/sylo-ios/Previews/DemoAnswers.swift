#if DEBUG
import SyloKit

extension PreviewData {
    /// What the demo session answers beyond the shared preview answers: the ticket inbox, a ticket,
    /// the server's general settings and one module's settings page (Honeypot).
    static let demoAnswer: PreviewClient.Answer = { endpoint in
        if endpoint is Endpoints.Tickets { return tickets }
        if endpoint is Endpoints.Ticket { return ticketThread }
        if endpoint is Endpoints.LoadGuildSettings {
            return GuildSettingsPage(
                settings: GuildSettings(modlogChannelId: "c1", botMasterRoleIds: ["r2"], embedColorHex: "#38c8f0"),
                channels: [ChannelOption(id: "c1", name: "mod-log"), ChannelOption(id: "c2", name: "general")],
                roles: [RoleOption(id: "r1", name: "Admins"), RoleOption(id: "r2", name: "Moderators")])
        }
        if endpoint is Endpoints.LoadModuleSettings<HoneypotPage> {
            return HoneypotPage(
                settings: HoneypotSettings(
                    exemptRoles: ["r1"],
                    channels: [HoneypotSettings.ChannelTrap(channelId: "c1", action: .timeout, triggerCount: 3)],
                    messages: [HoneypotSettings.MessageTrap(channelId: "c2", bait: "Free nitro, react here")]),
                channels: [ChannelOption(id: "c1", name: "trap"), ChannelOption(id: "c2", name: "general")],
                roles: [RoleOption(id: "r1", name: "Moderators")])
        }
        return nil
    }
}
#endif
