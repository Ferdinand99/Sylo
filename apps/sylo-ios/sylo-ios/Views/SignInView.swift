import AuthenticationServices
import SwiftUI
import SyloKit

/// Sign in to the chosen server: one button per login the server offers. The button opens the
/// system sign-in sheet on the server's own pages, which end on its confirmation page.
struct SignInView: View {
    let server: ServerURL

    @Environment(AppSession.self) private var session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @ScaledMetric(relativeTo: .largeTitle) private var symbolSize = 56

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                        .font(.system(size: symbolSize))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)

                    Text("Sign in to \(server.displayName)")
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)

                    Text(explanation)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    if let version = session.serverInfo?.version {
                        Text("Sylo \(version)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if let notice = session.notice {
                        StatusMessage(notice, kind: .notice)
                    }
                    if let message = session.errorMessage {
                        StatusMessage(message, kind: .error)
                    }
                }
                .padding()
                .padding(.top, 32)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .safeAreaInset(edge: .bottom) {
                actions
                    .frame(maxWidth: 520)
                    .padding([.horizontal, .bottom])
            }
            .task { await session.loadServerInfo() }
        }
    }

    private var providers: [Platform] { session.serverInfo?.loginProviders ?? [] }

    private var explanation: String {
        let names = providers.map(\.displayName)
        let account = names.isEmpty ? "the account" : "the \(names.joined(separator: " or ")) account"
        return "Use \(account) you manage your servers with. You'll confirm on the next page."
    }

    private var actions: some View {
        VStack(spacing: 12) {
            if session.serverInfo != nil {
                ForEach(providers, id: \.self) { provider in
                    signInButton(for: provider, isPrimary: provider == providers.first)
                }
            } else if session.isBusy {
                ProgressView("Checking server…")
            } else {
                Button {
                    Task { await session.loadServerInfo() }
                } label: {
                    Text("Try Again").frame(maxWidth: .infinity)
                }
                .secondaryActionStyle()
            }

            Button("Use Another Server") {
                session.changeServer()
            }
            .disabled(session.isBusy)
        }
        .controlSize(.large)
    }

    @ViewBuilder
    private func signInButton(for provider: Platform, isPrimary: Bool) -> some View {
        let button = Button {
            Task { await signIn(with: provider) }
        } label: {
            Text("Sign In with \(provider.displayName)")
                .frame(maxWidth: .infinity)
        }
        .disabled(session.isBusy)

        if isPrimary {
            button.primaryActionStyle()
        } else {
            button.secondaryActionStyle()
        }
    }

    private func signIn(with provider: Platform) async {
        let webAuthenticationSession = self.webAuthenticationSession
        await session.signIn(with: provider) { url in
            do {
                // Shared with Safari: someone signed in to Discord or Fluxer there skips that step.
                if #available(iOS 17.4, *) {
                    return try await webAuthenticationSession.authenticate(
                        using: url,
                        callback: .customScheme(SignInRequest.callbackScheme),
                        preferredBrowserSession: .shared,
                        additionalHeaderFields: [:]
                    )
                } else {
                    return try await webAuthenticationSession.authenticate(
                        using: url,
                        callbackURLScheme: SignInRequest.callbackScheme,
                        preferredBrowserSession: .shared
                    )
                }
            } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                throw SignInError.cancelled
            }
        }
    }
}

#Preview {
    SignInView(server: .hosted)
        .environment(AppSession.preview(.signIn))
}

#Preview("Largest text, dark") {
    SignInView(server: .hosted)
        .environment(AppSession.preview(.signIn))
        .dynamicTypeSize(.accessibility3)
        .preferredColorScheme(.dark)
}
