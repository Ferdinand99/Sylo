import SwiftUI
import SyloKit

/// Account, signed-in devices, the Sylo server, the policies, and Sign Out.
struct SettingsView: View {
    let server: ServerURL

    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var account: AccountModel
    @State private var isConfirmingSignOut = false

    init(server: ServerURL, session: AppSession) {
        self.server = server
        _account = State(initialValue: AccountModel(session: session))
    }

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                DevicesSection(account: account)
                serverSection
                aboutSection
                Section {
                    Button("Sign Out", role: .destructive) {
                        isConfirmingSignOut = true
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await account.load() }
            .refreshable { await account.load() }
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
            .alert("Couldn't Revoke Device", isPresented: isShowingRevokeError, presenting: account.revokeError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        Section("Account") {
            if let name = session.account?.name {
                LabeledContent("Signed in as", value: name)
            }
            ForEach(account.connectedPlatforms) { connection in
                LabeledContent(connection.label, value: connection.username ?? "Connected")
            }
            if let message = account.errorMessage {
                StatusMessage(message, kind: .error)
            } else if session.account == nil, account.account == nil {
                ProgressView()
            }
        }
    }

    private var serverSection: some View {
        Section("Sylo server") {
            LabeledContent("Address", value: server.displayName)
            if let version = session.serverInfo?.version {
                LabeledContent("Version", value: version)
            }
            Link(destination: server.baseURL) {
                Label("Open Dashboard", systemImage: "safari")
            }
        }
    }

    private var aboutSection: some View {
        Section("About") {
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

    private static let privacyPolicy = URL(string: "https://github.com/Ferdinand99/Sylo/blob/main/docs/privacy-policy.md")!
    private static let terms = URL(string: "https://github.com/Ferdinand99/Sylo/blob/main/docs/terms-of-service.md")!
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
    SettingsView(server: .hosted, session: session)
        .environment(session)
}
