import Foundation
import Observation

/// How loud an announcement is.
public enum AnnouncementSeverity: Hashable, Sendable, RawRepresentable, Codable {
    case info
    case warning
    /// Stays on screen until the operator clears it: there is no dismiss button.
    case critical
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "info": self = .info
        case "warning": self = .warning
        case "critical": self = .critical
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .info: "info"
        case .warning: "warning"
        case .critical: "critical"
        case .other(let raw): raw
        }
    }
}

/// The notice the operator of a Sylo can show everyone who is signed in (an incident, maintenance).
public struct Announcement: Decodable, Sendable, Hashable, Identifiable {
    public let title: String
    public let body: String
    public let severity: AnnouncementSeverity
    /// When it was published. Publishing a new one makes a new id, so a dismissed notice that is
    /// replaced shows again.
    public let createdAt: Date

    public var id: String { String(Int(createdAt.timeIntervalSince1970 * 1000)) }

    /// Whether the person can hide it.
    public var isDismissible: Bool { severity != .critical }

    public init(title: String, body: String = "", severity: AnnouncementSeverity = .info, createdAt: Date) {
        self.title = title
        self.body = body
        self.severity = severity
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case title, body, severity, createdAt }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        severity = try c.decodeIfPresent(AnnouncementSeverity.self, forKey: .severity) ?? .info
        createdAt = try c.decodeEpochMillisecondsIfPresent(forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
    }
}

/// The answer of `GET /api/v2/announcement`: the notice, or nothing.
public struct AnnouncementAnswer: Decodable, Sendable, Equatable {
    public let announcement: Announcement?

    public init(announcement: Announcement?) { self.announcement = announcement }

    private enum CodingKeys: String, CodingKey { case announcement }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A notice the app cannot read is no notice, not a failed screen.
        announcement = try? c.decodeIfPresent(Announcement.self, forKey: .announcement)
    }
}

extension Endpoints {
    /// `GET /api/v2/announcement`: the operator's notice, for every signed-in person.
    public struct CurrentAnnouncement: APIEndpoint {
        public typealias Response = AnnouncementAnswer
        public init() {}
        public var path: String { "/api/v2/announcement" }
    }
}

/// Remembers which announcement the person dismissed.
@MainActor
public protocol DismissedAnnouncementStore: AnyObject {
    var dismissedID: String? { get set }
}

/// The dismissed announcement of one server, kept on this device.
@MainActor
public final class UserDefaultsDismissedAnnouncement: DismissedAnnouncementStore {
    private let defaults: UserDefaults
    private let key: String

    /// - Parameter server: The server the announcement came from, so two Sylo servers keep their own.
    public init(server: ServerURL, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.key = "dismissedAnnouncement." + server.description
    }

    public var dismissedID: String? {
        get { defaults.string(forKey: key) }
        set { defaults.set(newValue, forKey: key) }
    }
}

/// The announcement banner: the operator's current notice, unless the person dismissed it.
@MainActor
@Observable
public final class AnnouncementModel {
    public private(set) var announcement: Announcement?
    private var dismissedID: String?

    private let session: AppSession
    private let store: any DismissedAnnouncementStore

    public init(session: AppSession, store: any DismissedAnnouncementStore) {
        self.session = session
        self.store = store
        self.dismissedID = store.dismissedID
    }

    /// The notice to show, nil when there is none or the person dismissed this very one. A
    /// critical notice is always shown.
    public var visible: Announcement? {
        guard let announcement else { return nil }
        if announcement.isDismissible, announcement.id == dismissedID { return nil }
        return announcement
    }

    /// Loads the notice. Silent on failure: a banner that cannot load is simply not there, and an
    /// older Sylo without the route answers 404.
    public func load() async {
        do {
            announcement = try await session.send(Endpoints.CurrentAnnouncement()).announcement
        } catch {
            if NetworkError(error) == .notFound { announcement = nil }
        }
    }

    /// Hides the current notice until a different one is published. A critical one stays.
    public func dismiss() {
        guard let announcement, announcement.isDismissible else { return }
        dismissedID = announcement.id
        store.dismissedID = announcement.id
    }
}
