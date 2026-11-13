import SwiftUI
import SyloKit

/// Server logging: the log channel and which events go to it. Mirrors
/// web-v2/src/moduleForms/Logging.jsx.
struct LoggingSettingsView: View {
    @State private var model: ModuleSettingsModel<LoggingPage>
    @State private var test: ModuleTestModel

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _test = State(initialValue: ModuleTestModel(server: server, module: "logging", session: session))
    }

    var body: some View {
        ModuleSettingsForm("Server Logging", model: model) { $settings, page in
            Section {
                ChannelPicker(title: "Log channel", selection: $settings.channel, channels: page.channels)
            } footer: {
                Text("Posts member, message, role and channel events to this channel as they happen.")
            }

            Section("Events to log") {
                ForEach(page.logEvents) { event in
                    Toggle(isOn: Binding(
                        get: { settings.isLogging(event.key) },
                        set: { settings.setLogging(event.key, $0) }
                    )) {
                        Text(verbatim: event.label)
                    }
                }
            }

            SendTestButton(model: test, hasUnsavedChanges: model.hasChanges,
                           sample: "a sample log message",
                           channelName: page.channels.first { $0.id == settings.channel }?.name)
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<LoggingPage> else { return nil }
        return LoggingPage(
            settings: LoggingSettings(channel: "c1", events: ["memberJoin": true, "messageDelete": true]),
            channels: [ChannelOption(id: "c1", name: "mod-log"), ChannelOption(id: "c2", name: "general")],
            logEvents: [
                LoggingEvent(key: "memberJoin", label: "Member joined"),
                LoggingEvent(key: "memberLeave", label: "Member left"),
                LoggingEvent(key: "messageDelete", label: "Message deleted"),
                LoggingEvent(key: "messageEdit", label: "Message edited"),
            ])
    }
    NavigationStack {
        LoggingSettingsView(server: "1", session: session)
    }
    .environment(session)
}
