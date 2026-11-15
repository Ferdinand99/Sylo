import Foundation
import Observation

/// The Infractions side of the moderation hub: cases, bans, the lockdown, and the actions on them.
///
/// Every action asks the server and then reloads the lists, like the dashboard does. A failed
/// action sets ``actionError`` to the server's own words; a good one sets ``notice`` with the
/// outcome ("Warned. They now have 2 warnings."). The views confirm before calling any of these.
@MainActor
@Observable
public final class ModerationModel {
    /// The longest warning reason the server keeps, in characters.
    public static let maxWarnReasonLength = 400
    /// The longest case reason the server keeps, in characters.
    public static let maxCaseReasonLength = 1000

    /// What is shown when an action starts while another is still running.
    public static let busyMessage = "Another action is still running. Wait a moment, then try again."

    public let server: ServerID
    public private(set) var overview: ModerationOverview?
    public private(set) var isLoading = false
    public private(set) var isWorking = false
    /// Why the lists could not be loaded (the last lists, if any, stay).
    public var errorMessage: String?
    /// Why the last action did not go through, in the server's words.
    public var actionError: String?
    /// What the last action did, in a sentence; nil once shown.
    public var notice: String?
    /// Goes up with every action that went through, for a haptic.
    public private(set) var actionCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var hasLoaded: Bool { overview != nil }

    /// The case with this number in the loaded list.
    public func moderationCase(_ number: Int) -> ModerationCase? {
        overview?.cases.first { $0.caseNumber == number }
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            overview = try await session.send(Endpoints.LoadModeration(server: server))
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    // MARK: Actions

    /// Warns a member. The reason is required: it is trimmed, cut at 400 characters and sent to the
    /// member by DM.
    @discardableResult
    public func warn(_ member: MemberChoice, reason: String) async -> Bool {
        let reason = Self.cut(reason, to: Self.maxWarnReasonLength)
        guard !reason.isEmpty else { return false }
        return await perform(Endpoints.WarnMember(server: server, userId: member.id, reason: reason)) { result in
            var text = "Warned. They now have \(Self.count(result.warnings, "warning"))."
            if !result.dmDelivered { text += " They could not be sent a DM." }
            return text
        }
    }

    /// Removes every warning of a member.
    @discardableResult
    public func clearWarnings(of member: MemberChoice) async -> Bool {
        await perform(Endpoints.ClearWarnings(server: server, userId: member.id)) { result in
            "Removed \(Self.count(result.removed, "warning"))."
        }
    }

    /// Lifts a ban (or a scheduled one). `name` is for the confirmation text only.
    @discardableResult
    public func unban(userId: String, name: String) async -> Bool {
        await perform(Endpoints.UnbanMember(server: server, userId: userId)) { _ in "\(name) unbanned." }
    }

    @discardableResult
    public func lockAllChannels() async -> Bool {
        await perform(Endpoints.LockAllChannels(server: server)) { "Locked \(Self.count($0.locked, "channel"))." }
    }

    @discardableResult
    public func endLockdown() async -> Bool {
        await perform(Endpoints.UnlockAllChannels(server: server)) { "Unlocked \(Self.count($0.unlocked, "channel"))." }
    }

    @discardableResult
    public func unlockChannel(_ lock: ChannelLock) async -> Bool {
        await perform(Endpoints.UnlockChannel(server: server, channelId: lock.channelId)) { _ in "Channel unlocked." }
    }

    /// Rewrites a case's reason. Required: it is trimmed and cut at 1000 characters.
    @discardableResult
    public func editReason(of moderationCase: ModerationCase, to reason: String) async -> Bool {
        let reason = Self.cut(reason, to: Self.maxCaseReasonLength)
        guard !reason.isEmpty else { return false }
        return await perform(
            Endpoints.EditCaseReason(server: server, caseNumber: moderationCase.caseNumber, reason: reason)
        ) { _ in "Reason updated." }
    }

    /// Deletes a case (it stays on record, marked deleted) or restores a deleted one.
    @discardableResult
    public func setActive(_ active: Bool, for moderationCase: ModerationCase) async -> Bool {
        let number = moderationCase.caseNumber
        return await perform(Endpoints.SetCaseActive(server: server, caseNumber: number, active: active)) { _ in
            active ? "Case #\(number) restored." : "Case #\(number) deleted."
        }
    }

    // MARK: Plumbing

    private func perform<E: APIEndpoint>(_ endpoint: E, notice makeNotice: (E.Response) -> String) async -> Bool {
        guard !isWorking else {
            actionError = Self.busyMessage
            return false
        }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        notice = nil
        do {
            let result = try await session.send(endpoint)
            notice = makeNotice(result)
            actionCount += 1
            await load()
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized {
                actionError = error.userMessage
                // The list may be out of date (already unbanned, case gone): show how it stands now.
                if error == .notFound || error == .http(status: 409) { await load() }
            }
            return false
        }
    }

    static func cut(_ text: String, to limit: Int) -> String {
        String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(limit))
    }

    static func count(_ number: Int, _ noun: String) -> String {
        number == 1 ? "1 \(noun)" : "\(number) \(noun)s"
    }
}
