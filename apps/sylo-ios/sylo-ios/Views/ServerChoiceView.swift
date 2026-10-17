import SwiftUI
import SyloKit

/// First launch, or "Use Another Server": the hosted Sylo or the address of your own.
struct ServerChoiceView: View {
    @Environment(AppSession.self) private var session
    @State private var choice = Choice.hosted
    @State private var address = ""
    @FocusState private var isAddressFocused: Bool

    private enum Choice: Hashable {
        case hosted
        case own
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Sylo server", selection: $choice) {
                        ChoiceRow(title: "Sylo", detail: "app.sylobot.com")
                            .tag(Choice.hosted)
                        ChoiceRow(title: "Your own server", detail: "A Sylo you or your community runs")
                            .tag(Choice.own)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } header: {
                    Text("Sylo server")
                } footer: {
                    Text("Manage Sylo on your Discord and Fluxer servers from here.")
                }

                if choice == .own {
                    Section {
                        TextField("Server address", text: $address, prompt: Text(verbatim: "sylo.example.com"))
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.continue)
                            .focused($isAddressFocused)
                            .onSubmit { Task { await choose() } }
                    } header: {
                        Text("Server address")
                    } footer: {
                        Text("The address you open your Sylo dashboard at.")
                    }
                }

                if let message = session.errorMessage {
                    Section {
                        StatusMessage(message, kind: .error)
                    }
                }
            }
            .navigationTitle("Welcome to Sylo")
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await choose() }
                } label: {
                    Group {
                        if session.isBusy {
                            ProgressView()
                                .accessibilityLabel("Checking server")
                        } else {
                            Text("Continue")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .primaryActionStyle()
                .controlSize(.large)
                .disabled(!canContinue)
                .padding([.horizontal, .bottom])
            }
            .onAppear(perform: prefill)
            .onChange(of: choice) {
                session.errorMessage = nil
                isAddressFocused = choice == .own
            }
        }
    }

    private var canContinue: Bool {
        !session.isBusy && (choice == .hosted || !address.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    private func choose() async {
        guard canContinue else { return }
        await session.chooseServer(choice == .hosted ? ServerURL.hosted.description : address)
    }

    /// Back from sign-in with your own server chosen: show its address again.
    private func prefill() {
        guard let remembered = session.rememberedAddress, remembered != ServerURL.hosted.description else { return }
        choice = .own
        address = remembered
    }
}

/// One option in the server picker: a name and a line saying what it is.
private struct ChoiceRow: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    ServerChoiceView()
        .environment(AppSession.preview(.choosingServer))
}

#Preview("Largest text, dark") {
    ServerChoiceView()
        .environment(AppSession.preview(.choosingServer))
        .dynamicTypeSize(.accessibility3)
        .preferredColorScheme(.dark)
}
