import SwiftUI
import SyloKit

/// The Tools tab of the focused moderator view (an Inbox-level person on a Sylo 5.3 server): the queues that are not
/// tickets or appeals (applications, suggestions) and Member data, and the way back to the full app. The same
/// pages the web dashboard's focused sidebar lists.
struct FocusedToolsView: View {
    let model: OverviewModel
    /// Whether the person chose to see everything; set to true to leave the focused view.
    @Binding var showEverything: Bool

    @Environment(AppSession.self) private var session

    @ScaledMetric(relativeTo: .body) private var iconWidth = 28

    var body: some View {
        let tools = ModeratorView.tools(overview: model.overview)
        List {
            if let message = model.errorMessage, model.overview == nil {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                ForEach(tools, id: \.self) { tool in
                    row(for: tool)
                }
            } header: {
                Text("Moderation tools")
            } footer: {
                Text("Tickets and ban appeals have their own tabs.")
            }
            Section {
                Button {
                    showEverything = true
                } label: {
                    Label("Show Everything", systemImage: "square.grid.2x2")
                }
            } footer: {
                Text("You have Inbox access, so Sylo shows the moderation tools only. Show everything brings back the modules and the settings; they stay switched off for your level.")
            }
        }
        .tabBarClearance()
        .refreshable { await model.load() }
    }

    @ViewBuilder
    private func row(for tool: ModeratorView.Tool) -> some View {
        switch tool {
        case .applications:
            NavigationLink(value: ModuleRoute(moduleID: "applications")) {
                label("Applications", symbol: "doc.text")
            }
        case .suggestions:
            NavigationLink(value: ModuleRoute(moduleID: "suggestions")) {
                label("Suggestions", symbol: "lightbulb")
            }
        case .memberData:
            NavigationLink {
                MemberDataView(server: model.server, session: session)
            } label: {
                label("Member Data", symbol: "person.text.rectangle")
            }
        }
    }

    private func label(_ title: LocalizedStringKey, symbol: String) -> some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(.tint)
                .frame(width: iconWidth)
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        FocusedToolsView(model: OverviewModel(server: "1", session: session), showEverything: .constant(false))
    }
    .environment(session)
}
