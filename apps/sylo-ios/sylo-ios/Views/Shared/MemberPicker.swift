import SwiftUI
import SyloKit

/// A form row that picks one member of a server: it shows who is picked, and opens a screen where
/// the person searches by name as they type, or pastes a member id or an @mention.
///
/// Search uses the server's member search, or the Temporary roles one on a server that has no
/// general one (see ``MemberSearchModel``). Where neither exists, only the id or mention works, and
/// the screen says so. Needs a surrounding `NavigationStack`.
///
/// ```swift
/// MemberPicker("Member", server: server, session: session, selection: $member)
/// ```
struct MemberPicker: View {
    let title: LocalizedStringKey
    let server: ServerID
    let session: AppSession
    @Binding var selection: MemberChoice?

    init(_ title: LocalizedStringKey, server: ServerID, session: AppSession, selection: Binding<MemberChoice?>) {
        self.title = title
        self.server = server
        self.session = session
        _selection = selection
    }

    var body: some View {
        NavigationLink {
            MemberSearchScreen(server: server, session: session, selection: $selection)
        } label: {
            LabeledContent(title) {
                if let selection {
                    Text(verbatim: selection.name)
                } else {
                    Text("None")
                }
            }
        }
    }
}

/// The search screen behind ``MemberPicker``: a search field, the matches, and a row for a pasted id.
private struct MemberSearchScreen: View {
    @State private var model: MemberSearchModel
    @Binding var selection: MemberChoice?
    @Environment(\.dismiss) private var dismiss

    init(server: ServerID, session: AppSession, selection: Binding<MemberChoice?>) {
        _model = State(initialValue: MemberSearchModel(server: server, session: session))
        _selection = selection
    }

    var body: some View {
        List {
            if let id = model.pastedID {
                Section {
                    Button {
                        choose(MemberChoice(id: id))
                    } label: {
                        Label("Use member ID \(id)", systemImage: "number")
                    }
                } footer: {
                    Text("Picks this member by their ID, even if they aren't listed below.")
                }
            }

            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            if !model.isAvailable {
                Section {
                    StatusMessage(
                        "This server can't search for members. Paste a member ID or an @mention instead.",
                        kind: .notice)
                }
            }

            if !model.results.isEmpty {
                Section {
                    ForEach(model.results) { member in
                        Button {
                            choose(MemberChoice(member))
                        } label: {
                            MemberRow(member: member, isPicked: member.id == selection?.id)
                        }
                        .foregroundStyle(.primary)
                    }
                }
            }

            if selection != nil {
                Section {
                    Button("Clear Selection", role: .destructive) {
                        selection = nil
                        dismiss()
                    }
                }
            }
        }
        .overlay {
            if model.isAvailable, model.pastedID == nil, model.results.isEmpty, model.errorMessage == nil {
                if model.isSearching {
                    ProgressView()
                } else if model.searchedText != nil {
                    ContentUnavailableView.search(text: model.searchedText ?? "")
                } else {
                    ContentUnavailableView(
                        "Find a Member", systemImage: "person.crop.circle.badge.questionmark",
                        description: Text("Type a name, or paste a member ID or an @mention."))
                }
            }
        }
        .navigationTitle("Choose a Member")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Name, ID or mention")
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        // Searches a moment after the person stops typing; a newer query cancels this one.
        .task(id: model.query) {
            do {
                try await Task.sleep(for: .milliseconds(300))
            } catch {
                return
            }
            await model.search()
        }
    }

    private func choose(_ choice: MemberChoice) {
        selection = choice
        dismiss()
    }
}

/// A search result: the name, the account name below it when it differs, and a check when picked.
private struct MemberRow: View {
    let member: MemberMatch
    let isPicked: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: member.name)
                if !member.username.isEmpty, member.username != member.name {
                    Text(verbatim: member.username)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if isPicked {
                Image(systemName: "checkmark")
                    .foregroundStyle(.tint)
                    .accessibilityLabel("Picked")
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.SearchMembers else { return nil }
        return MemberSearchResult(members: [
            MemberMatch(id: "111111111111111111", name: "Alex", username: "alex_99"),
            MemberMatch(id: "222222222222222222", name: "Sam", username: "sam"),
        ])
    }
    NavigationStack {
        Form {
            MemberPicker("Member", server: "1", session: session, selection: .constant(nil))
        }
    }
    .environment(session)
}
