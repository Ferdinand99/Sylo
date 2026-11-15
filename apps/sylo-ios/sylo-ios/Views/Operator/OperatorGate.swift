import SwiftUI
import SyloKit

/// Shows an operator-only screen only while the signed-in account is an operator, as the account page
/// last said for the sign-in that is live now. Anyone else sees nothing of the screen. This is only a
/// convenience: the server refuses every operator call from an account that is not one.
///
/// While the account is being read (the first time, or again after the sign-in changed) it shows that it
/// is loading, and when the read failed it says so with a way to try again: neither is a verdict that
/// the person is not an operator.
struct OperatorGate<Content: View>: View {
    let account: AccountModel
    @ViewBuilder let content: () -> Content

    var body: some View {
        if account.isOperator {
            content()
        } else if account.hasLoadedForSignIn {
            OperatorRefusedView()
        } else if account.isLoading {
            ProgressView()
        } else if let message = account.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Check Your Account", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await account.load() } }
            }
        } else {
            ProgressView()
        }
    }
}

/// What an operator screen shows when the server said it is not for this account (403).
struct OperatorRefusedView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Only for Operators", systemImage: "lock")
        } description: {
            Text(verbatim: OperatorOnly.refusal)
        }
    }
}
