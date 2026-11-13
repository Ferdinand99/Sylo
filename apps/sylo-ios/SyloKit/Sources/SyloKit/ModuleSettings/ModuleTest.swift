import Foundation
import Observation

// "Send a test message" (src/bot/lib/moduleTest.js; route POST /api/v2/guilds/:id/modules/:id/test in
// src/web/routes/v2Api.js; the dashboard's SendTestButton.jsx): posts one sample message from the
// module's saved settings to its channel, so staff can check the channel and the bot's permissions
// without waiting for a real event. Only some modules have one.

/// The modules the server can send a test message for (`TESTABLE` in moduleTest.js).
public enum ModuleTestable {
    public static let ids: Set<ModuleID> = [
        "welcome", "birthdays", "logging", "twitch-alerts", "youtube-alerts", "starboard", "free-games",
    ]

    public static func isTestable(_ module: ModuleID) -> Bool { ids.contains(module) }
}

/// Why a test message was not sent.
public enum ModuleTestFailure: Sendable, Equatable {
    /// The module has no channel set yet (`no-channel`).
    case noChannel
    /// The channel is set but the bot could not post in it (`send-failed`).
    case sendFailed
    /// Any other reason a newer server may give.
    case other
}

/// The answer to a test: `{ok, channelName?, reason?}`.
public struct ModuleTestResult: Decodable, Sendable, Equatable {
    public let isSent: Bool
    /// The channel the message went to (its name, or its id when the bot cannot see the name).
    public let channelName: String?
    /// Set when it was not sent.
    public let failure: ModuleTestFailure?

    public init(isSent: Bool, channelName: String? = nil, failure: ModuleTestFailure? = nil) {
        self.isSent = isSent
        self.channelName = channelName
        self.failure = failure
    }

    private enum CodingKeys: String, CodingKey { case ok, channelName, reason }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isSent = try c.decode(forKey: .ok, or: false)
        let name = try c.decodeIfPresent(String.self, forKey: .channelName)
        channelName = (name?.isEmpty ?? true) ? nil : name
        if isSent {
            failure = nil
        } else {
            switch try c.decodeIfPresent(String.self, forKey: .reason) {
            case "no-channel": failure = .noChannel
            case "send-failed": failure = .sendFailed
            default: failure = .other
            }
        }
    }

    /// What to tell the person, in the dashboard's words.
    public var message: String {
        if isSent {
            if let channelName { return "Test sent to #\(channelName)." }
            return "Test sent."
        }
        switch failure {
        case .noChannel: return "Set a channel for this module first."
        case .sendFailed: return "Send failed. Check that the bot has access to that channel."
        case .other, nil: return "The test message could not be sent."
        }
    }
}

/// The line next to a test button that says what it posts and where.
public enum ModuleTestText {
    /// "Posts a sample alert to #general (the first streamer in the list)." `sample` is what is
    /// posted ("a sample alert"); `channelName` is where, as far as the screen knows.
    public static func postsTo(sample: String, channelName: String?, note: String = "") -> String {
        let what = sample.isEmpty ? "a sample message" : sample
        let name = channelName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let place = name.isEmpty ? "the channel set above" : "#\(name)"
        return "Posts \(what) to \(place)" + (note.isEmpty ? "" : " (\(note))") + "."
    }
}

extension Endpoints {
    /// `POST /api/v2/guilds/:id/modules/:module/test`, with no body. The server sends from the saved
    /// settings, so the screen asks for unsaved changes to be saved first. 400 for a module with no
    /// test message.
    public struct SendModuleTest: APIEndpoint {
        public typealias Response = ModuleTestResult
        public let server: ServerID
        public let module: ModuleID

        public init(server: ServerID, module: ModuleID) {
            self.server = server
            self.module = module
        }

        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/\(module.pathComponent)/test"
        }
        public var method: HTTPMethod { .post }
    }
}

/// Sends one module's test message and keeps the outcome for the screen.
@MainActor
@Observable
public final class ModuleTestModel {
    public enum Outcome: Sendable, Equatable {
        /// Posted.
        case sent(String)
        /// Not posted, and why (also a failed call).
        case failed(String)

        public var text: String {
            switch self {
            case .sent(let text), .failed(let text): text
            }
        }

        public var isSent: Bool {
            if case .sent = self { return true }
            return false
        }
    }

    public let server: ServerID
    public let module: ModuleID
    public private(set) var isSending = false
    public private(set) var outcome: Outcome?
    /// Whether the module is on, from the server's overview; nil until known (or when the overview
    /// could not be read).
    public private(set) var isModuleEnabled: Bool?

    /// Whether the screen shows the button. Like the dashboard, only while the module is on; a module
    /// whose state is not known is treated as on, because the server's route does not care.
    public var isAvailable: Bool { isModuleEnabled != false }

    private var hasLoadedAvailability = false
    private let session: AppSession

    public init(server: ServerID, module: ModuleID, session: AppSession) {
        self.server = server
        self.module = module
        self.session = session
    }

    /// Reads whether the module is on (the dashboard reads the same overview). A failed read leaves
    /// the state unknown, so the button stays.
    public func loadAvailability() async {
        // Once per screen: the row comes and goes as the form scrolls, and the overview is a big read.
        guard !hasLoadedAvailability else { return }
        hasLoadedAvailability = true
        guard let overview = try? await session.send(Endpoints.Overview(server: server)) else { return }
        let card = overview.groups.lazy.flatMap(\.cards).first { $0.id == module.rawValue }
        isModuleEnabled = card?.isEnabled
    }

    /// Sends the test. Does nothing while one is on its way.
    public func send() async {
        guard !isSending else { return }
        isSending = true
        outcome = nil
        defer { isSending = false }
        do {
            let result = try await session.send(Endpoints.SendModuleTest(server: server, module: module))
            outcome = result.isSent ? .sent(result.message) : .failed(result.message)
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { outcome = .failed(error.userMessage) }
        }
    }

    /// Forgets the outcome (the settings changed, so it no longer describes what is saved).
    public func clearOutcome() { outcome = nil }
}
