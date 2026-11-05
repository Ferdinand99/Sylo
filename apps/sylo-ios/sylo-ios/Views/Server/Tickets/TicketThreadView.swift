import SwiftUI
import SyloKit
import UIKit

/// One ticket as a conversation, like Messages: the member's messages on the left in neutral
/// bubbles, staff replies on the right in Sylo cyan, system notes centred, a time above each burst
/// of messages, and a reply field at the bottom. New messages arrive every few seconds while it is
/// open.
struct TicketThreadView: View {
    let server: ServerID
    let route: TicketRoute

    @Environment(PushCoordinator.self) private var push
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model: TicketThreadModel
    @State private var reply = ""
    @State private var sentCount = 0
    @State private var isConfirmingClose = false
    @State private var closingMessage = ""

    init(server: ServerID, route: TicketRoute, session: AppSession) {
        self.server = server
        self.route = route
        _model = State(initialValue: TicketThreadModel(server: server, ticketID: route.id, session: session))
    }

    var body: some View {
        content
            .background { SyloBackground() }
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
            EmptyState(
                "Couldn't Load Ticket", systemImage: "exclamationmark.triangle", message: Text(message),
                isError: true, actionTitle: "Try Again") {
                    Task { await model.load() }
                }
        } else {
            SyloLoadingView()
        }
    }

    // MARK: - Conversation

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 6) {
                    if let ticket = model.ticket {
                        TicketHeader(ticket: ticket, isClosed: model.isClosed)
                            .padding(.bottom, 8)
                    }
                    ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                        if let label = separator(before: index) {
                            Text(verbatim: label)
                                .font(.syloNumber(.caption, weight: .regular))
                                .foregroundStyle(Color.syloMuted)
                                .padding(.top, 10)
                        }
                        MessageBubble(message: message, showsSender: startsRun(at: index))
                            .id(BubbleID.message(message.id))
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.92, anchor: message.kind == .staff ? .bottomTrailing : .bottomLeading).combined(with: .opacity))
                    }
                    ForEach(model.outgoing) { outgoing in
                        OutgoingBubble(reply: outgoing) {
                            model.retry(outgoing.id)
                        } discard: {
                            model.discard(outgoing.id)
                        }
                        .id(BubbleID.outgoing(outgoing.id))
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.92, anchor: .bottomTrailing).combined(with: .opacity))
                    }
                    if let warning = model.deliveryWarning {
                        StatusMessage(warning, kind: .notice)
                            .padding(.top, 8)
                    }
                    if model.isClosed {
                        Text("This ticket is closed.")
                            .font(.footnote)
                            .foregroundStyle(Color.syloMuted)
                            .padding(.top, 12)
                    }
                    Color.clear.frame(height: 1).id(BubbleID.bottom)
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .animation(reduceMotion ? nil : SyloMotion.quick, value: model.messages.count + model.outgoing.count)
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

    /// Whether the message at `index` is the first of a run by the same side, which gets a name.
    private func startsRun(at index: Int) -> Bool {
        guard index > 0 else { return true }
        return separator(before: index) != nil || model.messages[index - 1].kind != model.messages[index].kind
    }

    // MARK: - Composer

    @ViewBuilder
    private var composer: some View {
        if !model.isClosed {
            let canSend = !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            HStack(alignment: .bottom, spacing: 8) {
                ComposerField(text: $reply)
                Button {
                    if model.send(reply) != nil {
                        reply = ""
                        sentCount += 1
                    }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(canSend ? Color.syloOnCyan : Color.syloMuted)
                        .frame(width: 44, height: 44)
                        .background(canSend ? Color.syloCyan : Color.syloCard2, in: Circle())
                        .overlay { Circle().strokeBorder(canSend ? Color.clear : Color.syloLineStrong, lineWidth: 1) }
                        .syloGlow(isLive: canSend, radius: 10)
                }
                .buttonStyle(.syloPress)
                .disabled(!canSend)
                .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
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

/// The ticket at the top of the thread: its number, whether it is open, and when it was opened.
private struct TicketHeader: View {
    let ticket: TicketInfo
    let isClosed: Bool

    var body: some View {
        HStack(spacing: SyloSpacing.s) {
            Text(verbatim: "#\(ticket.id)")
                .font(.syloNumber(.footnote))
                .foregroundStyle(Color.syloText)
            if isClosed {
                SyloPill("Closed", systemImage: "checkmark.circle", tint: .syloMuted)
            } else {
                HStack(spacing: 5) {
                    LiveDot(size: 7, pulses: false)
                    Text("Open")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.syloBrand)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.syloCyan.opacity(0.14), in: Capsule())
                .overlay { Capsule().strokeBorder(Color.syloCyan.opacity(0.35), lineWidth: 1) }
            }
            if let opened = ticket.openedAt {
                Text("Opened \(MessageTime.separatorLabel(for: opened))")
                    .font(.caption)
                    .foregroundStyle(Color.syloMuted)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, SyloSpacing.m)
        .padding(.vertical, 8)
        .syloCard(radius: 18)
        .accessibilityElement(children: .combine)
    }
}

/// The reply field: grows to five lines; Liquid Glass on iOS 26 and later.
private struct ComposerField: View {
    @Binding var text: String

    var body: some View {
        let field = TextField("Reply as Staff", text: $text, axis: .vertical)
            .lineLimit(1...5)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
        if #available(iOS 26, *) {
            field.glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
        } else {
            field.background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(Color.syloLineStrong))
        }
    }
}

/// The shape of a chat bubble: round, with a tighter corner on the side of whoever wrote it.
private func bubbleShape(isStaff: Bool) -> UnevenRoundedRectangle {
    UnevenRoundedRectangle(
        topLeadingRadius: 20, bottomLeadingRadius: isStaff ? 20 : 6,
        bottomTrailingRadius: isStaff ? 6 : 20, topTrailingRadius: 20, style: .continuous)
}

/// One message from the server: the member's on the left, staff on the right, system centred.
private struct MessageBubble: View {
    let message: TicketMessage
    let showsSender: Bool

    var body: some View {
        switch message.kind {
        case .staff:
            VStack(alignment: .trailing, spacing: 2) {
                if showsSender {
                    sender
                }
                HStack {
                    Spacer(minLength: 48)
                    bubble(isStaff: true)
                }
                if !message.isDelivered {
                    Label("Not delivered as a DM", systemImage: "exclamationmark.circle")
                        .font(.caption2)
                        .foregroundStyle(Color.syloBad)
                }
            }
        case .system:
            Text(verbatim: message.content)
                .font(.footnote)
                .foregroundStyle(Color.syloMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(Color.syloLine, in: Capsule())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        default:
            VStack(alignment: .leading, spacing: 2) {
                if showsSender {
                    sender
                }
                HStack {
                    bubble(isStaff: false)
                    Spacer(minLength: 48)
                }
            }
        }
    }

    private var sender: some View {
        Text(verbatim: message.who)
            .font(.caption)
            .foregroundStyle(Color.syloMuted)
            .padding(.horizontal, 6)
            .padding(.top, 4)
    }

    private func bubble(isStaff: Bool) -> some View {
        let shape = bubbleShape(isStaff: isStaff)
        let foreground = isStaff ? Color.syloOnCyan : Color.syloText
        return VStack(alignment: .leading, spacing: 6) {
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
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background {
            if isStaff {
                shape.fill(LinearGradient(
                    colors: [Color.syloCyan, Color.syloCyan.opacity(0.88)], startPoint: .top, endPoint: .bottom))
            } else {
                shape.fill(Color.syloCard2)
            }
        }
        .overlay { if !isStaff { shape.strokeBorder(Color.syloLine, lineWidth: 1) } }
        .contentShape(.contextMenuPreview, shape)
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
                    .foregroundStyle(Color.syloOnCyan)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.syloCyan, in: bubbleShape(isStaff: true))
                    .opacity(isSending ? 0.6 : 1)
                    .contextMenu {
                        Button("Delete", systemImage: "trash", role: .destructive, action: discard)
                    }
            }
            switch reply.state {
            case .sending:
                Text("Sending…")
                    .font(.caption2)
                    .foregroundStyle(Color.syloMuted)
            case .failed(let message):
                Button(action: retry) {
                    Label("Not sent. Tap to try again.", systemImage: "exclamationmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(Color.syloBad)
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
