import Foundation
import Observation

// Welcome Channel (src/modules/welcomeChannel.js, normaliseWelcomeChannelConfig and
// normaliseEmbedSpec; web form web-v2/src/moduleForms/WelcomeChannel.jsx): one rich message
// (text plus up to 10 embeds and banners) for a read-only channel. Saving keeps it as a draft;
// publishing it to the channel, removing the published message and creating the channel are
// separate calls (``WelcomeChannelPublisher``). The elements are shared-editor embeds
// (``EmbedItem``), so a banner's `kind` and every key the app does not know survive a save.

/// The Welcome Channel settings page.
public struct WelcomeChannelPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "welcome-channel"

    public let settings: WelcomeChannelSettings
    public let channels: [ChannelOption]
    /// The "Add element" choices.
    public let presets: [WelcomeChannelPreset]

    public init(settings: WelcomeChannelSettings, channels: [ChannelOption] = [],
                presets: [WelcomeChannelPreset] = []) {
        self.settings = settings
        self.channels = channels
        self.presets = presets
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, presets
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: WelcomeChannelSettings())
        channels = try c.decode(forKey: .channels, or: [])
        presets = try c.decode(forKey: .presets, or: [])
    }
}

/// One "Add element" choice: a ready-made embed or banner.
public struct WelcomeChannelPreset: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let defaults: EmbedDraft

    public init(id: String, label: String, defaults: EmbedDraft) {
        self.id = id
        self.label = label
        self.defaults = defaults
    }

    /// A new element from this preset (its own list id and field ids).
    public func makeEmbed() -> EmbedItem {
        EmbedItem(defaults).duplicated()
    }

    private enum CodingKeys: String, CodingKey { case id, label, defaults }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(forKey: .label, or: id)
        defaults = try c.decode(forKey: .defaults, or: EmbedDraft())
    }
}

public struct WelcomeChannelSettings: Codable, Sendable, Equatable {
    /// The channel the message is published in ("" = none chosen).
    public var channelId: String
    /// The published message (bot-managed, read only; "" = not published).
    public let messageId: String
    /// Text above the embeds; `{server}` and `{memberCount}` are filled in.
    public var content: String
    /// The embeds and banners, in order.
    public var embeds: [EmbedItem]

    public init(channelId: String = "", messageId: String = "", content: String = "", embeds: [EmbedItem] = []) {
        self.channelId = channelId
        self.messageId = messageId
        self.content = content
        self.embeds = embeds
    }

    public var isPublished: Bool { !messageId.isEmpty }

    public static let maxContentLength = 2000
    public static let maxEmbeds = 10

    private enum CodingKeys: String, CodingKey { case channelId, messageId, spec }
    private enum SpecKeys: String, CodingKey { case content, embeds }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channelId = try c.decode(forKey: .channelId, or: "")
        messageId = try c.decode(forKey: .messageId, or: "")
        if c.contains(.spec), try !c.decodeNil(forKey: .spec) {
            let spec = try c.nestedContainer(keyedBy: SpecKeys.self, forKey: .spec)
            content = try spec.decode(forKey: .content, or: "")
            embeds = try spec.decodeLossyArray(of: EmbedItem.self, forKey: .embeds)
        } else {
            content = ""
            embeds = []
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(channelId, forKey: .channelId)
        var spec = c.nestedContainer(keyedBy: SpecKeys.self, forKey: .spec)
        try spec.encode(content, forKey: .content)
        try spec.encode(embeds, forKey: .embeds)
    }
}

// MARK: - Publishing

/// The answer to creating the read-only channel: the config as stored (with the new channel) and the
/// channel list, refreshed.
public struct WelcomeChannelCreated: Decodable, Sendable, Equatable {
    public let settings: WelcomeChannelSettings
    public let channels: [ChannelOption]

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: WelcomeChannelSettings())
        channels = try c.decode(forKey: .channels, or: [])
    }
}

extension Endpoints {
    private static func welcomeChannelPath(_ server: ServerID, _ action: String) -> String {
        "/api/v2/guilds/\(server.pathComponent)/modules/welcome-channel/\(action)"
    }

    /// `POST /api/v2/guilds/:id/modules/welcome-channel/publish`: saves the message as the draft and
    /// posts it to the channel (or edits the message already there). 400 with the server's words
    /// when it cannot (no channel, the bot may not post there, nothing to send).
    public struct PublishWelcomeChannel: APIEndpoint {
        public typealias Response = SavedModuleSettings<WelcomeChannelSettings>
        public let server: ServerID
        public let settings: WelcomeChannelSettings

        public init(server: ServerID, settings: WelcomeChannelSettings) {
            self.server = server
            self.settings = settings
        }

        public var path: String { Endpoints.welcomeChannelPath(server, "publish") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { settings }
    }

    /// `POST /api/v2/guilds/:id/modules/welcome-channel/unpublish`: deletes the posted message; the
    /// draft stays.
    public struct UnpublishWelcomeChannel: APIEndpoint {
        public typealias Response = SavedModuleSettings<WelcomeChannelSettings>
        public let server: ServerID
        public init(server: ServerID) { self.server = server }

        public var path: String { Endpoints.welcomeChannelPath(server, "unpublish") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/modules/welcome-channel/create-channel`: makes a read-only #welcome
    /// channel and stores it as the message's channel.
    public struct CreateWelcomeChannel: APIEndpoint {
        public typealias Response = WelcomeChannelCreated
        public let server: ServerID
        public init(server: ServerID) { self.server = server }

        public var path: String { Endpoints.welcomeChannelPath(server, "create-channel") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

/// Publishing the Welcome Channel message, removing it from the channel and creating the channel,
/// on top of the settings model so the screen's draft and saved state stay in step with the server.
@MainActor
@Observable
public final class WelcomeChannelPublisher {
    public let server: ServerID
    private let model: ModuleSettingsModel<WelcomeChannelPage>
    private let session: AppSession

    public private(set) var isBusy = false
    /// Why the last action did not go through, in the server's words.
    public var errorMessage: String?
    /// Which action `errorMessage` belongs to.
    public private(set) var failedStep: Step?
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0
    /// What the last action did, for a one-line confirmation under the buttons.
    public private(set) var notice: Notice?

    public enum Notice: Sendable, Equatable {
        case published, updated, removed, channelCreated
    }

    public enum Step: Sendable, Equatable {
        case publish, remove, createChannel
    }

    public init(model: ModuleSettingsModel<WelcomeChannelPage>, session: AppSession) {
        self.model = model
        self.session = session
        server = model.server
    }

    /// Whether the message is posted in the channel, as the server last said (not the unsaved draft).
    public var isPublished: Bool { model.page?.settings.isPublished ?? false }

    /// Saves any unsaved edits, then posts the message (or edits the posted one).
    /// - Returns: Whether it is in the channel now.
    @discardableResult
    public func publish() async -> Bool {
        guard !isBusy, model.draft != nil else { return false }
        errorMessage = nil
        failedStep = nil
        notice = nil
        guard model.draft?.channelId.isEmpty == false else {
            errorMessage = "Pick a channel first."
            failedStep = .publish
            return false
        }
        guard !model.isSaving else {
            errorMessage = "A save is still running. Wait for it to finish, then publish again."
            failedStep = .publish
            return false
        }
        isBusy = true
        defer { isBusy = false }
        let wasPublished = isPublished
        if model.hasChanges {
            // A failed save is shown by the settings screen itself.
            guard await model.save() else { return false }
        }
        guard let toPublish = model.draft else { return false }
        do {
            _ = try await session.send(Endpoints.PublishWelcomeChannel(server: server, settings: toPublish))
            await model.load()
            notice = wasPublished ? .updated : .published
            successCount += 1
            return true
        } catch {
            report(error, during: .publish)
            return false
        }
    }

    /// Deletes the posted message. The draft stays.
    @discardableResult
    public func unpublish() async -> Bool {
        guard !isBusy else { return false }
        errorMessage = nil
        failedStep = nil
        notice = nil
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await session.send(Endpoints.UnpublishWelcomeChannel(server: server))
            await model.load()
            notice = .removed
            successCount += 1
            return true
        } catch {
            report(error, during: .remove)
            return false
        }
    }

    /// Makes the read-only channel and picks it for the message.
    @discardableResult
    public func createChannel() async -> Bool {
        guard !isBusy else { return false }
        errorMessage = nil
        failedStep = nil
        notice = nil
        isBusy = true
        defer { isBusy = false }
        do {
            let created = try await session.send(Endpoints.CreateWelcomeChannel(server: server))
            // The server stored the channel already; unsaved edits stay, with the new channel on them.
            await model.load()
            model.draft?.channelId = created.settings.channelId
            notice = .channelCreated
            successCount += 1
            return true
        } catch {
            report(error, during: .createChannel)
            return false
        }
    }

    private func report(_ error: any Error, during step: Step) {
        let error = NetworkError(error)
        if error != .cancelled, error != .unauthorized {
            errorMessage = error.userMessage
            failedStep = step
        }
    }
}
