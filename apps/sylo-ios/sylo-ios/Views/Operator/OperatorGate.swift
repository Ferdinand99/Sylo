import SwiftUI
import SyloKit

/// Shows an operator-only screen only while the signed-in account is an operator, as the account page
/// last said for the sign-in that is live now. Anyone else sees nothing of the screen. This is only a
/// convenience: the server refuses every operator call from an account that is not one.
struct OperatorGate<Content: View>: View {
    let account: AccountModel
    @ViewBuilder let content: () -> Content

    var body: some View {
        if account.isOperator {
            content()
        } else if account.account == nil, account.errorMessage == nil {
            // The account is being read: no screen until it says who this is.
            ProgressView()
        } else {
            ContentUnavailableView {
                Label("Only for Operators", systemImage: "lock")
            } description: {
                Text(verbatim: OperatorOnly.refusal)
            }
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
