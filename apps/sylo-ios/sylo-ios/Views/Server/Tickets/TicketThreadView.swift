import SwiftUI
import SyloKit
import UIKit

/// One ticket as a conversation, like Messages: the member's messages on the left, staff replies
/// on the right in the accent colour, system notes centred, a time above each burst of messages,
/// and a reply field at the bottom. New messages arrive every few seconds while it is open.
struct TicketThreadView: View {
    let server: ServerID
    let route: TicketRoute

    @Environment(PushCoordinator.self) private var push
    @State private var model: TicketThreadModel
    @State private var reply = ""
    @State private var isConfirmingClose = false
    @State private var closingMessage = ""

    init(server: ServerID, route: TicketRoute, session: AppSession) {
        self.server = server
        self.route = route
        _model = State(initialValue: TicketThreadModel(server: server, ticketID: route.id, session: session))
    }

    var body: some View {
        content
            .navigationTitle(model.ticket?.user ?? route.user)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.ticket != nil, !model.isClosed {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Close Ticket") {
                            closingMessage = ""
                            isConfirmingClose = true
                        }
                    }
                }
            }
            .task {
                await model.load()
                await model.poll(every: .seconds(5))
            }
            // New messages show here anyway: no banner for this conversation while it is open.
            .onAppear { push.visibleTicket = (server: server, id: route.id) }
            .onDisappear {
                if push.visibleTicket?.server == server, push.visibleTicket?.id == route.id {
                    push.visibleTicket = nil
                }
            }
            .alert("Close This Ticket?", isPresented: $isConfirmingClose) {
                TextField("Closing message (optional)", text: $closingMessage)
                Button("Close Ticket", role: .destructive) {
                    Task { _ = await model.close(message: closingMessage) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The member is told the ticket is closed. You can add a last message.")
            }
            .alert("Couldn't Close Ticket", isPresented: isShowingActionError, presenting: model.actionError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
    }

    @ViewBuilder
    private var content: some View {
        if model.ticket != nil {
            conversation
                .safeAreaInset(edge: .bottom) { composer }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Can't Load Ticket", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    // MARK: - Conversation

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 6) {
                    if let opened = model.ticket?.openedAt {
                        Text("Opened \(MessageTime.separatorLabel(for: opened))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.bottom, 8)
                    }
                    ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                        if let label = separator(before: index) {
                            Text(verbatim: label)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.top, 10)
                        }
                        MessageBubble(message: message)
                            .id(BubbleID.message(message.id))
                    }
                    ForEach(model.outgoing) { outgoing in
                        OutgoingBubble(reply: outgoing) {
                            model.retry(outgoing.id)
                        } discard: {
                            model.discard(outgoing.id)
                        }
                        .id(BubbleID.outgoing(outgoing.id))
                    }
                    if let warning = model.deliveryWarning {
                        StatusMessage(warning, kind: .notice)
                            .padding(.top, 8)
                    }
                    if model.isClosed {
                        Text("This ticket is closed.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.top, 12)
                    }
                    Color.clear.frame(height: 1).id(BubbleID.bottom)
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages.count + model.outgoing.count) {
                withAnimation { proxy.scrollTo(BubbleID.bottom, anchor: .bottom) }
            }
        }
    }

    /// A time label before the message at `index` when it starts a new burst (first message, or
    /// over 15 minutes after the one before).
    private func separator(before index: Int) -> String? {
        guard let date = model.messages[index].at else { return nil }
        if index > 0, let previous = model.messages[index - 1].at, date.timeIntervalSince(previous) < 15 * 60 {
            return nil
        }
        return MessageTime.separatorLabel(for: date)
    }

    // MARK: - Composer

    @ViewBuilder
    private var composer: some View {
        if !model.isClosed {
            HStack(alignment: .bottom, spacing: 8) {
                ComposerField(text: $reply)
                Button {
                    if model.send(reply) != nil { reply = "" }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .symbolRenderingMode(.hierarchical)
                }
                .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

private enum BubbleID: Hashable {
    case message(Int)
    case outgoing(UUID)
    case bottom
}

/// The reply field: grows to five lines; Liquid Glass on iOS 26 and later.
private struct ComposerField: View {
    @Binding var text: String

    var body: some View {
        let field = TextField("Reply as Staff", text: $text, axis: .vertical)
            .lineLimit(1...5)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        if #available(iOS 26, *) {
            field.glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))
        } else {
            field.background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(Color(uiColor: .separator)))
        }
    }
}

/// One message from the server: the member's on the left, staff on the right, system centred.
private struct MessageBubble: View {
    let message: TicketMessage

    var body: some View {
        switch message.kind {
        case .staff:
            VStack(alignment: .trailing, spacing: 2) {
                HStack {
                    Spacer(minLength: 48)
                    bubble(foreground: .white, background: AnyShapeStyle(.tint))
                }
                if !message.isDelivered {
                    Label("Not delivered as a DM", systemImage: "exclamationmark.circle")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
        case .system:
            Text(verbatim: message.content)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        default:
            HStack {
                bubble(foreground: .primary, background: AnyShapeStyle(Color(uiColor: .secondarySystemBackground)))
                Spacer(minLength: 48)
            }
        }
    }

    private func bubble(foreground: Color, background: AnyShapeStyle) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !message.content.isEmpty {
                Text(verbatim: message.content)
            }
            ForEach(message.attachments, id: \.self) { url in
                Link(destination: url) {
                    Label(url.lastPathComponent, systemImage: "paperclip")
                        .underline()
                }
                .foregroundStyle(foreground)
            }
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .contextMenu {
            if !message.content.isEmpty {
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = message.content
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: "\(message.who): \(message.content)"))
    }
}

/// A reply on its way, or one that failed (tap to try again; hold to delete).
private struct OutgoingBubble: View {
    let reply: TicketThreadModel.OutgoingReply
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack {
                Spacer(minLength: 48)
                Text(verbatim: reply.content)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.tint, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .opacity(isSending ? 0.6 : 1)
                    .contextMenu {
                        Button("Delete", systemImage: "trash", role: .destructive, action: discard)
                    }
            }
            switch reply.state {
            case .sending:
                Text("Sending…")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            case .failed(let message):
                Button(action: retry) {
                    Label("Not sent. Tap to try again.", systemImage: "exclamationmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
                .accessibilityHint(Text(verbatim: message))
            }
        }
    }

    private var isSending: Bool {
        if case .sending = reply.state { return true }
        return false
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.Ticket else { return nil }
        return PreviewData.ticketThread
    }
    NavigationStack {
        TicketThreadView(server: "1", route: TicketRoute(id: 1, user: "member#0001"), session: session)
    }
    .environment(session)
    .environment(PushCoordinator(session: session))
}
