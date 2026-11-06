import Foundation
import Observation

// What the record based module screens share (reaction roles, custom commands, reminders, channel
// cleanup, GitHub alerts, embed messages). Their data is not one settings object with a Save: it is
// a list of records, each saved, switched or deleted on its own.

/// A list row's own identity while it is edited. Not sent, and never part of a comparison, so two
/// copies of the same data are equal whatever rows they were drawn as.
public struct LocalID: Sendable, Hashable {
    public let value = UUID()

    public init() {}

    public static func == (lhs: LocalID, rhs: LocalID) -> Bool { true }
    public func hash(into hasher: inout Hasher) {}
}

extension NetworkError {
    /// What to tell the person: the server's own words for a refused change ("Pick a channel.",
    /// "You can't disconnect your only sign-in.") when it sent some, else the usual ``userMessage``.
    public var detailMessage: String {
        if let message = serverMessage, !message.isEmpty, message != "invalid_grant" {
            return message
        }
        return userMessage
    }
}

/// Loads one record based module's page and runs the changes the person makes to it. After every
/// change the page is loaded again, so the screen always shows what the server holds.
@MainActor
@Observable
public final class RecordListModel<Page: Sendable> {
    public typealias Loader = @MainActor (AppSession, ServerID) async throws -> Page

    public let server: ServerID
    public private(set) var page: Page?
    public private(set) var isLoading = false
    /// Why the page could not be loaded.
    public var errorMessage: String?
    /// Why the last change did not go through.
    public var actionError: String?
    /// A change is on its way to the server.
    public private(set) var isWorking = false
    /// Goes up with every successful change, for a haptic.
    public private(set) var changeCount = 0

    private let session: AppSession
    private let loader: Loader

    public init(server: ServerID, session: AppSession, loader: @escaping Loader) {
        self.server = server
        self.session = session
        self.loader = loader
    }

    /// Loads the page. A page that was loaded before stays on screen when this fails.
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            page = try await loader(session, server)
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
        }
    }

    /// The reason the last change failed, cleared, for an editor that shows it itself and does not
    /// want the list behind it to show it again.
    public func takeActionError() -> String? {
        defer { actionError = nil }
        return actionError
    }

    /// Runs a change (a save, a switch, a delete) and then loads the page again.
    /// - Returns: What the change returned, or nil when it failed (``actionError`` says why) or
    ///   another change was still running.
    @discardableResult
    public func perform<Output>(
        _ change: @MainActor (AppSession, ServerID) async throws -> Output
    ) async -> Output? {
        guard let output = await attempt(change) else { return nil }
        changeCount += 1
        session.noteModulesChanged()
        await load()
        return output
    }

    /// Runs something that does not change the module (sending a test message): no reload, and
    /// the list stays as it is.
    /// - Returns: What it returned, or nil when it failed (``actionError`` says why) or another
    ///   change was still running.
    public func attempt<Output>(
        _ work: @MainActor (AppSession, ServerID) async throws -> Output
    ) async -> Output? {
        guard !isWorking else {
            actionError = "Another change is still saving."
            return nil
        }
        isWorking = true
        defer { isWorking = false }
        actionError = nil
        do {
            return try await work(session, server)
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.detailMessage }
            return nil
        }
    }
}

/// A day of the week as the server names it: `[0, "Sun"]` (0 is Sunday).
public struct WeekdayOption: Decodable, Sendable, Equatable, Hashable, Identifiable {
    public let number: Int
    public let name: String

    public var id: Int { number }

    public init(number: Int, name: String) {
        self.number = number
        self.name = name
    }

    public init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        let raw = try c.decode(JSONValue.self)
        let name = try c.decode(String.self)
        guard case .number(let number) = raw else {
            throw DecodingError.typeMismatch(
                Int.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "A weekday number"))
        }
        self.init(number: Int(number), name: name)
    }

    /// Sunday to Saturday, for a server that does not send the list.
    public static let week: [WeekdayOption] = [
        WeekdayOption(number: 0, name: "Sun"), WeekdayOption(number: 1, name: "Mon"),
        WeekdayOption(number: 2, name: "Tue"), WeekdayOption(number: 3, name: "Wed"),
        WeekdayOption(number: 4, name: "Thu"), WeekdayOption(number: 5, name: "Fri"),
        WeekdayOption(number: 6, name: "Sat"),
    ]

    /// "every day", or the names of the days in week order ("Mon/Wed").
    public static func summary(of days: [Int], in options: [WeekdayOption]) -> String {
        if Set(days).count >= 7 { return "every day" }
        let names = Dictionary(options.map { ($0.number, $0.name) }, uniquingKeysWith: { first, _ in first })
        return days.sorted().compactMap { names[$0] }.joined(separator: "/")
    }
}

extension Array where Element == Int {
    /// The days of the week every day of which is on, the default of a new schedule.
    public static var allWeek: [Int] { [0, 1, 2, 3, 4, 5, 6] }
}
