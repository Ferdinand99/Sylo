import Foundation
import Observation

// The Introductions prompt message (src/web/routes/v2Intro.js: `/modules/introductions/prompt/publish`
// and `/modules/introductions/prompt/unpublish`): a pinned "Introduce yourself" message with a Create
// my intro button in the introductions channel. Staff publish it (or update it in place) and remove it,
// the same calls the dashboard makes.

/// The answer to publishing or removing the prompt: the module's settings as the server stored them
/// (with the prompt's channel and message ids), and a warning when something around it went wrong.
public struct IntroPromptResult: Decodable, Sendable, Equatable {
    public let settings: IntroductionsSettings
    /// Set when the prompt is out but something is off (the old prompt in another channel could not be
    /// removed).
    public let warning: String?

    public init(settings: IntroductionsSettings, warning: String? = nil) {
        self.settings = settings
        self.warning = warning
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case warning
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let warning = try c.decodeIfPresent(String.self, forKey: .warning)
        self.init(
            settings: try c.decode(forKey: .settings, or: IntroductionsSettings()),
            warning: warning?.isEmpty == false ? warning : nil)
    }
}

extension Endpoints {
    /// `POST /api/v2/guilds/:id/modules/introductions/prompt/publish`: posts the prompt message (or edits
    /// the one that is out) in the channel. The channel and text are the form's, so a draft can be
    /// published before it is saved; the server saves those two with it. 400 with the server's reason
    /// when there is no channel or Sylo lacks a permission there.
    public struct PublishIntroPrompt: APIEndpoint {
        public typealias Response = IntroPromptResult
        public let server: ServerID
        public let channelId: String
        /// "" for the server's own text.
        public let promptText: String

        public init(server: ServerID, channelId: String, promptText: String) {
            self.server = server
            self.channelId = channelId
            self.promptText = promptText
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/introductions/prompt/publish" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(channelId: channelId, promptText: promptText) }

        private struct Body: Encodable, Sendable {
            let channelId: String
            let promptText: String
        }
    }

    /// `POST /api/v2/guilds/:id/modules/introductions/prompt/unpublish`: deletes the prompt message.
    /// 502 when Sylo may not delete it (the stored message stays so it can be tried again).
    public struct UnpublishIntroPrompt: APIEndpoint {
        public typealias Response = IntroPromptResult
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/introductions/prompt/unpublish" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

/// Publishing and removing the prompt message.
@MainActor
@Observable
public final class IntroPromptModel {
    public let server: ServerID
    public private(set) var isBusy = false
    /// Why the last publish or removal did not go through.
    public var errorMessage: String?
    /// What the server flagged about a publish that did go through.
    public private(set) var notice: String?
    /// Goes up with every success, for a haptic.
    public private(set) var successCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Posts the prompt (or updates it) in `channelId` with `text` ("" for the server's own).
    /// - Returns: The settings as the server stored them, nil on failure (see ``errorMessage``).
    @discardableResult
    public func publish(channelId: String, text: String) async -> IntroductionsSettings? {
        guard !isBusy else { return nil }
        guard !channelId.isEmpty else {
            errorMessage = "Pick the introductions channel first."
            return nil
        }
        return await run(Endpoints.PublishIntroPrompt(server: server, channelId: channelId, promptText: text))
    }

    /// Deletes the prompt message.
    @discardableResult
    public func unpublish() async -> IntroductionsSettings? {
        guard !isBusy else { return nil }
        return await run(Endpoints.UnpublishIntroPrompt(server: server))
    }

    private func run<E: APIEndpoint>(_ endpoint: E) async -> IntroductionsSettings?
    where E.Response == IntroPromptResult {
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        notice = nil
        do {
            let result = try await session.send(endpoint)
            notice = result.warning
            successCount += 1
            return result.settings
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized {
                errorMessage = EditorFailure.message(
                    for: error,
                    serverFailure: "Sylo could not delete the prompt message. It needs Manage Messages in that channel.")
            }
            return nil
        }
    }
}
