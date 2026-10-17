import SwiftUI
import SyloKit

/// Signed in. For now only who and where, and Sign Out; the server list replaces this next.
struct SignedInView: View {
    let server: ServerURL

    @Environment(AppSession.self) private var session
    @State private var isConfirmingSignOut = false

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("You're Signed In", systemImage: "checkmark.circle")
            } description: {
                Text(description)
            }
            .navigationTitle("Sylo")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Sign Out") { isConfirmingSignOut = true }
                }
            }
            .confirmationDialog(
                "Sign out of \(server.displayName)?", isPresented: $isConfirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign Out", role: .destructive) {
                    Task { await session.signOut() }
                }
            } message: {
                Text("You'll need to sign in again to manage your servers on this device.")
            }
        }
    }

    private var description: String {
        if let name = session.account?.name {
            "Signed in to \(server.displayName) as \(name). Your servers show here soon."
        } else {
            "Signed in to \(server.displayName). Your servers show here soon."
        }
    }
}

#Preview {
    SignedInView(server: .hosted)
        .environment(AppSession.preview(.signedIn))
}
