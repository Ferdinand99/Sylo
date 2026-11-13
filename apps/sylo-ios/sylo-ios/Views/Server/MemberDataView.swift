import SwiftUI
import SyloKit

/// Member data: pick a member to see what Sylo stores about them in this server, and delete it on
/// request (for example a data-erasure request). Mirrors web-v2/src/pages/MemberData.jsx.
///
/// This is personal data: nothing is logged, the lookup is dropped when the screen goes away, and
/// the erasure asks for a typed confirmation.
struct MemberDataView: View {
    let server: ServerID
    let session: AppSession

    @State private var model: MemberDataModel
    @State private var member: MemberChoice?
    @State private var isForgetting = false

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: MemberDataModel(server: server, session: session))
    }

    var body: some View {
        List {
            Section {
                MemberPicker("Member", server: server, session: session, selection: $member)
            } footer: {
                Text("Look up what Sylo has stored about a member in this server and delete it on request. Deletion is permanent, and Sylo sends the member a message listing exactly what was removed.")
            }

            if model.isLoading {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }

            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }

            if let lookup = model.lookup {
                profileSection(lookup)
                if let notice = model.forgetNotice {
                    Section { StatusMessage(notice, kind: .notice) }
                }
                dataSections(lookup)
            }
        }
        .navigationTitle("Member Data")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: member) { _, chosen in
            guard let chosen else {
                model.clear()
                return
            }
            Task { await model.look(up: chosen) }
        }
        // Nothing about the member stays in memory once the screen is gone.
        .onDisappear { model.clear() }
        .sheet(isPresented: $isForgetting) {
            if let lookup = model.lookup {
                ForgetMemberSheet(model: model, lookup: lookup)
            }
        }
        .sensoryFeedback(trigger: model.forgetNotice) { _, new in new == nil ? nil : .success }
    }

    private func profileSection(_ lookup: MemberDataLookup) -> some View {
        Section {
            HStack(spacing: 12) {
                if let avatar = lookup.profile.avatar {
                    AuthenticatedImage(url: avatar, contentMode: .fill)
                        .frame(width: 44, height: 44)
                        .clipShape(Circle())
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: lookup.profile.title)
                        .font(.headline)
                    Text(verbatim: lookup.profile.id)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func dataSections(_ lookup: MemberDataLookup) -> some View {
        if lookup.data.total == 0 {
            Section {
                Text("Sylo has no stored data for this member in this server.")
                    .foregroundStyle(.secondary)
            }
        } else {
            Section {
                ForEach(lookup.data.filled) { item in
                    LabeledContent {
                        Text(item.count, format: .number)
                    } label: {
                        Text(verbatim: item.label)
                    }
                }
            } header: {
                Text("Stored data")
            } footer: {
                if !model.unaffected.isEmpty {
                    Text(verbatim: model.unaffected)
                }
            }

            Section {
                Button("Delete This Member's Data…", role: .destructive) {
                    isForgetting = true
                }
            } footer: {
                if lookup.data.erasable == 0 {
                    Text("Only safety records are stored, and deleting a member's data keeps those.")
                } else {
                    Text("Deletes what is listed above, except safety records (moderation cases, a temporary ban, honeypot catches, a counting penalty). The member is told what was removed.")
                }
            }
        }
    }
}

/// The erasure's confirmation: what happens, an optional note for the member, and the word to type.
private struct ForgetMemberSheet: View {
    let model: MemberDataModel
    let lookup: MemberDataLookup

    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var typed = ""

    private var canDelete: Bool {
        MemberForget.isConfirmed(typed) && !model.isForgetting
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Everything Sylo stores about \(lookup.profile.title) in this server is permanently deleted, and Sylo sends them a message listing what was removed. Moderation cases and other safety records are kept.")
                        .font(.subheadline)
                }

                Section {
                    TextField("Note to the member (optional)", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                        .onChange(of: reason) {
                            if reason.count > MemberForget.reasonLength {
                                reason = String(reason.prefix(MemberForget.reasonLength))
                            }
                        }
                } header: {
                    Text("Note")
                } footer: {
                    Text("For example \"Processed at your request\". It goes in the server's audit log and in the message to the member.")
                }

                Section {
                    TextField(MemberForget.confirmationWord, text: $typed)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                } header: {
                    Text("Type \(MemberForget.confirmationWord) to confirm")
                }

                if let message = model.forgetError {
                    Section { StatusMessage(message, kind: .error) }
                }

                Section {
                    Button(role: .destructive) {
                        Task {
                            if await model.forget(reason: reason, typed: typed) { dismiss() }
                        }
                    } label: {
                        if model.isForgetting {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Deleting…")
                            }
                        } else {
                            Text("Delete Member's Data")
                        }
                    }
                    .disabled(!canDelete)
                }
            }
            .navigationTitle("Delete Data")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.isForgetting)
                }
            }
            .interactiveDismissDisabled(model.isForgetting)
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LookupMemberData {
            return MemberDataAnswer(
                lookup: MemberDataLookup(
                    profile: MemberProfile(id: "111111111111111111", tag: "alex"),
                    data: MemberDataSummary(items: [
                        MemberDataItem(key: "leveling", label: "Leveling record", count: 1),
                        MemberDataItem(key: "warnings", label: "Moderation cases (kept by /forget)", count: 2, isKept: true),
                    ])),
                unaffected: "Messages already posted to channels are not affected.")
        }
        return nil
    }
    NavigationStack {
        MemberDataView(server: "1", session: session)
    }
    .environment(session)
}
