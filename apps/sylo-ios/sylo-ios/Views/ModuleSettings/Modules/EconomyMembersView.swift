import SwiftUI
import SyloKit

/// The Economy member lookup: the members with the most money, or whoever a name search finds,
/// with their balances. Read only; a member opens to their transactions.
struct EconomyMembersView: View {
    @State private var model: EconomyMembersModel
    private let server: ServerID
    private let session: AppSession
    private let currencyEmoji: String
    private let currencyName: String

    init(server: ServerID, session: AppSession, currencyEmoji: String, currencyName: String) {
        self.server = server
        self.session = session
        self.currencyEmoji = currencyEmoji
        self.currencyName = currencyName
        _model = State(initialValue: EconomyMembersModel(server: server, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                ForEach(model.rows) { row in
                    NavigationLink {
                        EconomyMemberView(
                            server: server, session: session, userID: row.userId, name: row.displayName,
                            currencyEmoji: currencyEmoji, currencyName: currencyName)
                    } label: {
                        MemberRow(row: row, currencyEmoji: currencyEmoji, currencyName: currencyName)
                    }
                }
                if model.canLoadMore {
                    Button("Show More") { Task { await model.loadMore() } }
                        .disabled(model.isLoading)
                }
            } header: {
                if model.hasLoaded {
                    Text(model.isSearch ? "Search results" : "Members with an account (\(model.total))")
                }
            } footer: {
                if model.hasLoaded, model.rows.isEmpty {
                    Text(model.isSearch ? "No member matches that name." : "Nobody has earned anything yet.")
                } else if model.isSearch {
                    Text("A member without an account shows a zero balance.")
                }
            }
        }
        .overlay {
            if !model.hasLoaded {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load Members", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await model.load() } }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Member Balances")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.query, prompt: "Search by name")
        // The first run loads at once; typing waits for a pause before it asks the server.
        .task(id: model.query) {
            if model.hasLoaded { try? await Task.sleep(for: .milliseconds(400)) }
            guard !Task.isCancelled else { return }
            await model.load()
        }
        .refreshable { await model.load() }
    }
}

/// A member: their name and what they hold.
private struct MemberRow: View {
    let row: EconomyMemberRow
    let currencyEmoji: String
    let currencyName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: row.displayName)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(verbatim: EconomyMoney.format(
                    row.account.total, emoji: currencyEmoji, name: currencyName))
                    .foregroundStyle(.secondary)
            }
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var details: String {
        var parts = [
            String(localized: "Cash \(row.account.cash.formatted())"),
            String(localized: "Bank \(row.account.bank.formatted())"),
        ]
        if row.member?.inServer == false { parts.append(String(localized: "left the server")) }
        return parts.joined(separator: " · ")
    }
}

/// One member's balances and their latest transactions, newest first.
struct EconomyMemberView: View {
    @State private var model: EconomyMemberModel
    private let server: ServerID
    private let name: String
    private let currencyEmoji: String
    private let currencyName: String

    init(server: ServerID, session: AppSession, userID: String, name: String, currencyEmoji: String,
         currencyName: String) {
        self.server = server
        self.name = name
        self.currencyEmoji = currencyEmoji
        self.currencyName = currencyName
        _model = State(initialValue: EconomyMemberModel(server: server, userID: userID, session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, model.detail != nil {
                Section { StatusMessage(message, kind: .error) }
            }
            if let detail = model.detail {
                Section {
                    LabeledContent("Cash", value: money(detail.account.cash))
                    LabeledContent("Bank", value: money(detail.account.bank))
                    LabeledContent("Total", value: money(detail.account.total))
                    LabeledContent("Daily streak", value: String(localized: "\(detail.account.dailyStreak) days"))
                } footer: {
                    if !detail.account.hasAccount {
                        Text("This member has no account yet. Their balance is zero until they earn something.")
                    }
                }

                Section {
                    if detail.transactions.isEmpty {
                        Text("No transactions yet.").foregroundStyle(.secondary)
                    }
                    ForEach(detail.transactions) { transaction in
                        TransactionRow(transaction: transaction)
                    }
                } header: {
                    Text("Latest transactions")
                } footer: {
                    if detail.transactionCount > detail.transactions.count {
                        Text("Showing the latest \(detail.transactions.count) of \(detail.transactionCount).")
                    }
                }

                DashboardLinkSection(
                    server: server, module: EconomyPage.moduleID,
                    footer: "Add, remove or set money, and see the inventory, in the web dashboard.")
            }
        }
        .overlay {
            if model.detail == nil {
                if let message = model.errorMessage {
                    ContentUnavailableView {
                        Label("Couldn't Load Member", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await model.load() } }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    private func money(_ amount: Int) -> String {
        EconomyMoney.format(amount, emoji: currencyEmoji, name: currencyName)
    }
}

/// One change to a member's money: what it was, how much, and who or why.
private struct TransactionRow: View {
    let transaction: EconomyTransaction

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: transaction.kindLabel)
                Spacer(minLength: 8)
                Text(verbatim: EconomyMoney.signed(transaction.amount))
                    .monospacedDigit()
                    .foregroundStyle(transaction.amount < 0 ? Color.red : Color.primary)
            }
            if !details.isEmpty {
                Text(verbatim: details)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// "5 min. ago · with Sam · by Mod · Spam".
    private var details: String {
        var parts: [String] = []
        if let date = transaction.date { parts.append(DateText.relative(date)) }
        if let other = transaction.counterparty { parts.append(String(localized: "with \(other.name)")) }
        if let actor = transaction.actor { parts.append(String(localized: "by \(actor.name)")) }
        if !transaction.reason.isEmpty { parts.append(transaction.reason) }
        return parts.joined(separator: " · ")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.EconomyMembers {
            return EconomyMemberList(
                rows: [
                    EconomyMemberRow(
                        userId: "1", account: EconomyAccount(cash: 1200, bank: 300),
                        member: EconomyPerson(id: "1", name: "Alex")),
                    EconomyMemberRow(userId: "2", account: EconomyAccount(cash: 0, bank: 40)),
                ],
                page: 1, pages: 1, total: 2)
        }
        return nil
    }
    NavigationStack {
        EconomyMembersView(server: "1", session: session, currencyEmoji: "🪙", currencyName: "coins")
    }
    .environment(session)
}
