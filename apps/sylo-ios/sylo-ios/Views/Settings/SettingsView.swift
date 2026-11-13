import AuthenticationServices
import SwiftUI
import SyloKit
import UIKit

/// Account (with its connected platforms), notifications, signed-in devices, the Sylo server (with
/// its command list, roadmap and Health for its operators), adding Sylo to a server, the policies,
/// Sign Out, and deleting the account.
struct SettingsView: View {
    let server: ServerURL
    /// The servers the person manages, for a notification switch each.
    let servers: ServersModel

    @Environment(AppSession.self) private var session
    @Environment(PushCoordinator.self) private var push
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var account: AccountModel
    @State private var addToServer: AddToServerModel
    @State private var isConfirmingSignOut = false
    @State private var isConfirmingDelete = false
    @State private var isShowingHealth = false
    @State private var platformToDisconnect: PlatformConnection?

    init(server: ServerURL, session: AppSession, servers: ServersModel) {
        self.server = server
        self.servers = servers
        _account = State(initialValue: AccountModel(session: session))
        _addToServer = State(initialValue: AddToServerModel(session: session))
    }

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                NotificationsSection(push: push, servers: servers.servers)
                DevicesSection(account: account)
                serverSection
                addToServerSection
                // Only for an operator, and not there at all for anyone else. The account is read
                // again whenever the sign-in changes (another account, a new token).
                if !account.operatorFeatures.isEmpty {
                    operatorSection
                }
                aboutSection
                Section {
                    Button("Sign Out", role: .destructive) {
                        isConfirmingSignOut = true
                    }
                }
                Section {
                    Button(role: .destructive) {
                        isConfirmingDelete = true
                    } label: {
                        if account.isDeleting {
                            HStack {
                                Text("Deleting Account…")
                                Spacer()
                                ProgressView()
                            }
                        } else {
                            Text("Delete Account")
                        }
                    }
                    .disabled(account.isDeleting)
                } footer: {
                    Text("Deletes your Sylo account on \(server.displayName). Your servers and their settings stay as they are.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task(id: session.generation) { await account.load() }
            .task { await push.settings.load() }
            .task { await addToServer.load() }
            .navigationDestination(isPresented: $isShowingHealth) {
                OperatorGate(account: account) { HealthView(session: session) }
            }
            // A tapped dev-log notification opens Settings (MainView) and then Health here.
            .onChange(of: push.pendingDevLog, initial: true) {
                guard push.pendingDevLog else { return }
                push.pendingDevLog = false
                isShowingHealth = true
            }
            .refreshable {
                await account.load()
                await push.settings.load()
            }
            .confirmationDialog(
                "Sign out of \(server.displayName)?", isPresented: $isConfirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign Out", role: .destructive) {
                    dismiss()
                    Task { await session.signOut() }
                }
            } message: {
                Text("You'll need to sign in again to manage your servers on this device.")
            }
            .alert("Delete your Sylo account?", isPresented: $isConfirmingDelete) {
                Button("Delete Account", role: .destructive) {
                    Task {
                        await account.deleteAccount()
                        if account.deleteError == nil { dismiss() }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes your sign-in, your linked Discord and Fluxer accounts, your devices and your preferences on \(server.displayName). It can't be undone.")
            }
            .alert("Couldn't Delete Account", isPresented: isShowingDeleteError, presenting: account.deleteError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
            .alert("Couldn't Revoke Device", isPresented: isShowingRevokeError, presenting: account.revokeError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
            .confirmationDialog(
                "Disconnect \(platformToDisconnect?.label ?? "")?", isPresented: isConfirmingDisconnect,
                titleVisibility: .visible, presenting: platformToDisconnect
            ) { connection in
                Button("Disconnect \(connection.label)", role: .destructive) {
                    // On success the server has signed every device out, this one too; the app
                    // goes back to sign-in by itself.
                    Task {
                        if await account.disconnect(connection) { dismiss() }
                    }
                }
            } message: { connection in
                Text("This signs you out of Sylo on every device, and you can't manage the servers you reach only through \(connection.label) anymore. You can connect it again later.")
            }
            .alert("Couldn't Change Account", isPresented: isShowingPlatformError, presenting: account.platformError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        Section {
            if let name = session.account?.name {
                LabeledContent("Signed in as", value: name)
            }
            ForEach(account.connectedPlatforms) { connection in
                platformRow(connection)
            }
            // Only on a Sylo that can start a connect for the app.
            ForEach(account.unconnectedPlatforms) { connection in
                if account.connectablePlatforms(serverInfo: serverInfo).contains(connection) {
                    Button {
                        Task { await connect(connection) }
                    } label: {
                        HStack {
                            Label("Connect \(connection.label)", systemImage: "link.badge.plus")
                            if account.changingPlatform == connection.platform {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(account.changingPlatform != nil)
                } else {
                    // This Sylo cannot add it from the app (or its login is off): just say so.
                    LabeledContent(connection.label, value: "Not connected")
                }
            }
            if let message = account.errorMessage {
                StatusMessage(message, kind: .error)
            } else if session.account == nil, account.account == nil {
                ProgressView()
            }
        } header: {
            Text("Account")
        } footer: {
            if account.connectedPlatforms.contains(where: \.canDisconnect) {
                Text("Swipe a connected platform to disconnect it. You can't disconnect your only sign-in.")
            }
        }
    }

    /// The Sylo's info: this launch's, or the one the notification settings fetched.
    private var serverInfo: ServerInfo? { session.serverInfo ?? push.settings.serverInfo }

    private func platformRow(_ connection: PlatformConnection) -> some View {
        LabeledContent(connection.label) {
            if account.changingPlatform == connection.platform {
                ProgressView()
            } else {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(connection.username ?? "Connected")
                    if connection.serverCount > 0 {
                        Text("Manages ^[\(connection.serverCount) server](inflect: true)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .swipeActions {
            if connection.canDisconnect {
                Button("Disconnect", role: .destructive) { platformToDisconnect = connection }
            }
        }
        .contextMenu {
            if connection.canDisconnect {
                Button("Disconnect", systemImage: "link.badge.minus", role: .destructive) {
                    platformToDisconnect = connection
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Opens the server's connect page in the system sign-in sheet; it ends on `sylo://connected`.
    private func connect(_ connection: PlatformConnection) async {
        let web = webAuthenticationSession
        let connected = await account.connect(connection) { url in
            do {
                // Shared with Safari, like sign-in: someone signed in to the platform there skips that step.
                if #available(iOS 17.4, *) {
                    return try await web.authenticate(
                        using: url,
                        callback: .customScheme(ConnectCallback.callbackScheme),
                        preferredBrowserSession: .shared,
                        additionalHeaderFields: [:])
                } else {
                    return try await web.authenticate(
                        using: url,
                        callbackURLScheme: ConnectCallback.callbackScheme,
                        preferredBrowserSession: .shared)
                }
            } catch let error as ASWebAuthenticationSessionError {
                // Closing the sheet is not a failure; anything else says what went wrong.
                if error.code == .canceledLogin { throw ConnectError.cancelled }
                throw ConnectError.sheetFailed(error.localizedDescription)
            }
        }
        // A new platform brings its servers.
        if connected { await servers.load() }
    }

    private var serverSection: some View {
        Section("Sylo server") {
            LabeledContent("Address", value: server.displayName)
            // After a relaunch the session has no server info yet; the notification settings
            // load it on open, so fall back to theirs.
            if let version = session.serverInfo?.version ?? push.settings.serverInfo?.version {
                LabeledContent("Version", value: version)
            }
            NavigationLink {
                CommandListView(session: session)
            } label: {
                Label("Command List", systemImage: "slash.circle")
            }
            NavigationLink {
                RoadmapView(session: session)
            } label: {
                Label("Roadmap", systemImage: "map")
            }
            Link(destination: server.baseURL) {
                Label("Open Dashboard", systemImage: "safari")
            }
        }
    }

    /// The links to add Sylo to a server: each is the platform's own page, opened in the browser.
    /// Nothing while the server has none to offer (an older Sylo, or no bot set up).
    @ViewBuilder
    private var addToServerSection: some View {
        if !addToServer.invites.isEmpty {
            Section {
                ForEach(addToServer.invites) { invite in
                    Link(destination: invite.url) {
                        Label("Add Sylo to a \(invite.label) Server", systemImage: "plus.app")
                    }
                }
            } header: {
                Text("Add Sylo to a server")
            } footer: {
                Text("Opens the platform's own page in your browser, where you pick the server. When you are back, pull down on the server list to see it.")
            }
        }
    }

    /// Only for the people who run this Sylo (its operators), never for someone who only manages
    /// a server: the server refuses Health to anyone else too.
    private var operatorSection: some View {
        Section {
            ForEach(account.operatorFeatures) { feature in
                NavigationLink {
                    OperatorGate(account: account) { operatorScreen(feature) }
                } label: {
                    Label(Self.title(feature), systemImage: Self.symbol(feature))
                }
            }
        } header: {
            Text("Operator")
        } footer: {
            Text("You run this Sylo. These screens change things for every server on it, and the server checks that you are an operator on every call.")
        }
    }

    @ViewBuilder
    private func operatorScreen(_ feature: OperatorFeature) -> some View {
        switch feature {
        case .health: HealthView(session: session)
        case .personalizer: PersonalizerView(session: session)
        case .statsCache: StatsCacheView(session: session)
        case .roadmapAdmin: RoadmapAdminView(session: session)
        }
    }

    private static func title(_ feature: OperatorFeature) -> LocalizedStringKey {
        switch feature {
        case .health: "Health"
        case .personalizer: "Bot Personalizer"
        case .statsCache: "Stats Cache"
        case .roadmapAdmin: "Roadmap Admin"
        }
    }

    private static func symbol(_ feature: OperatorFeature) -> String {
        switch feature {
        case .health: "stethoscope"
        case .personalizer: "paintbrush"
        case .statsCache: "chart.bar.doc.horizontal"
        case .roadmapAdmin: "map"
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("App version") {
                HStack(spacing: 8) {
                    PublicBetaBadge()
                    Text(verbatim: Self.appVersion)
                }
            }
            // In the app when this Sylo server sends its changelog (its info is fetched with the
            // notification settings when the session has none); older servers open the V2
            // dashboard's What's new page in the browser.
            if push.settings.serverInfo?.supports(.changelog) == true {
                NavigationLink {
                    ChangelogView(session: session)
                } label: {
                    Label("What's New", systemImage: "sparkles")
                }
            } else {
                Link(destination: server.url(for: "v2/changelog")) {
                    Label("What's New", systemImage: "sparkles")
                }
            }
            Link(destination: Self.privacyPolicy) {
                Label("Privacy Policy", systemImage: "hand.raised")
            }
            Link(destination: Self.terms) {
                Label("Terms of Service", systemImage: "doc.text")
            }
        }
    }

    private var isShowingRevokeError: Binding<Bool> {
        Binding(
            get: { account.revokeError != nil },
            set: { if !$0 { account.revokeError = nil } })
    }

    private var isConfirmingDisconnect: Binding<Bool> {
        Binding(
            get: { platformToDisconnect != nil },
            set: { if !$0 { platformToDisconnect = nil } })
    }

    private var isShowingPlatformError: Binding<Bool> {
        Binding(
            get: { account.platformError != nil },
            set: { if !$0 { account.platformError = nil } })
    }

    private var isShowingDeleteError: Binding<Bool> {
        Binding(
            get: { account.deleteError != nil },
            set: { if !$0 { account.deleteError = nil } })
    }

    /// This build's version and build number, such as "1.0 (5)".
    private static let appVersion: String = {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        guard let build = info?["CFBundleVersion"] as? String else { return version }
        return "\(version) (\(build))"
    }()

    private static let privacyPolicy = URL(string: "https://github.com/Ferdinand99/Sylo/blob/main/docs/privacy-policy.md")!
    private static let terms = URL(string: "https://github.com/Ferdinand99/Sylo/blob/main/docs/terms-of-service.md")!
}

/// "Public beta", as on sylobot.com: a hairline capsule with a small accent dot. The text stays
/// secondary so it reads on every row background; the accent is only in the dot.
private struct PublicBetaBadge: View {
    @ScaledMetric(relativeTo: .caption) private var dot = 6.0

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(.tint)
                .frame(width: dot, height: dot)
            Text("Public beta")
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .overlay(Capsule().strokeBorder(.separator))
        .accessibilityElement(children: .combine)
    }
}

/// Ticket notifications: whether this Sylo server can send them, the permission, on or off, and a
/// switch per server (off mutes that server on the Sylo server).
private struct NotificationsSection: View {
    let push: PushCoordinator
    let servers: [ServerSummary]

    private var settings: NotificationSettingsModel { push.settings }

    var body: some View {
        Section {
            if !settings.hasLoadedAvailability {
                if let message = settings.errorMessage {
                    StatusMessage(message, kind: .error)
                } else {
                    ProgressView()
                }
            } else if !settings.isAvailable {
                Label("Not available on this Sylo server", systemImage: "bell.slash")
            } else {
                switch push.authorization {
                case .notDetermined:
                    Button("Turn On Notifications") {
                        Task { await push.requestAuthorization() }
                    }
                case .denied:
                    Label("Turned off in Settings", systemImage: "bell.slash")
                    Link(destination: Self.appSettings) {
                        Label("Open Settings", systemImage: "gear")
                    }
                case .authorized:
                    Toggle("Ticket Notifications", isOn: isEnabled)
                    if settings.isEnabled, let devLog = settings.devLog {
                        // Operators only: the server sends the setting to no one else.
                        Picker("Dev Log", selection: devLogLevel(devLog)) {
                            Text("Off").tag(DevLogNotificationLevel.off)
                            Text("Errors").tag(DevLogNotificationLevel.errors)
                            Text("Errors and Warnings").tag(DevLogNotificationLevel.warnings)
                        }
                    }
                    if settings.isEnabled {
                        ForEach(servers) { server in
                            Toggle(isOn: isNotified(server.id)) {
                                Label {
                                    Text(verbatim: server.name)
                                } icon: {
                                    ServerIcon(url: server.iconURL, name: server.name)
                                }
                            }
                            .disabled(settings.isPending(server.id))
                        }
                    }
                }
                if let message = settings.errorMessage {
                    StatusMessage(message, kind: .error)
                }
            }
        } header: {
            Text("Notifications")
        } footer: {
            footer
        }
    }

    @ViewBuilder
    private var footer: some View {
        if let reason = settings.unavailableReason {
            Text(reason)
        } else if settings.hasLoadedAvailability, !settings.isAvailable {
            Text("This Sylo server can't send notifications. It may need an update, or notifications are turned off on it.")
        } else if settings.isAvailable, push.authorization == .denied {
            Text("To get ticket notifications, allow notifications for Sylo in the Settings app.")
        } else if settings.isAvailable, push.authorization == .authorized, settings.isEnabled {
            Text(
                settings.devLog == nil
                    ? "New tickets and member messages. Turn a server off to stop its notifications on this device."
                    : "New tickets and member messages, and Sylo's own errors (Dev Log, for operators). Turn a server off to stop its ticket notifications on this device.")
        }
    }

    private var isEnabled: Binding<Bool> {
        Binding(
            get: { settings.isEnabled },
            set: { isOn in Task { await push.setEnabled(isOn) } })
    }

    private func devLogLevel(_ current: DevLogNotificationLevel) -> Binding<DevLogNotificationLevel> {
        Binding(
            get: { settings.devLog ?? current },
            set: { level in Task { await settings.setDevLog(level) } })
    }

    /// On means not muted.
    private func isNotified(_ server: ServerID) -> Binding<Bool> {
        Binding(
            get: { !settings.isMuted(server) },
            set: { settings.setMuted(server, !$0) })
    }

    // A constant the system defines; it always forms a URL.
    private static let appSettings = URL(string: UIApplication.openSettingsURLString)!
}

/// Every device signed in to this account with the Sylo app. Any device but this one can be
/// revoked (swipe, or the context menu); this one signs out with Sign Out.
private struct DevicesSection: View {
    let account: AccountModel

    var body: some View {
        Section {
            ForEach(account.devices) { device in
                DeviceRow(device: device, isRevoking: account.isRevoking(device.id))
                    .swipeActions {
                        if !device.isCurrent {
                            Button("Revoke", role: .destructive) { account.revoke(device) }
                        }
                    }
                    .contextMenu {
                        if !device.isCurrent {
                            Button("Revoke", systemImage: "xmark.circle", role: .destructive) {
                                account.revoke(device)
                            }
                        }
                    }
            }
        } header: {
            Text("Signed-in devices")
        } footer: {
            Text("Revoke a device to sign it out of Sylo. To sign out on this device, use Sign Out.")
        }
    }
}

private struct DeviceRow: View {
    let device: SignedInDevice
    let isRevoking: Bool

    var body: some View {
        HStack {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(device.name)
                        if device.isCurrent {
                            Text("This device")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .foregroundStyle(.tint)
                                .background(.tint.opacity(0.15), in: Capsule())
                        }
                    }
                    Text("Last used \(device.lastUsedAt, format: .relative(presentation: .named))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: device.isCurrent ? "iphone.gen3" : "iphone")
                    .foregroundStyle(.tint)
            }
            if isRevoking {
                Spacer()
                ProgressView()
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    let servers = ServersModel(session: session)
    SettingsView(server: .hosted, session: session, servers: servers)
        .environment(session)
        .environment(PushCoordinator(session: session, authorization: .authorized))
        .task { await servers.load() }
}
