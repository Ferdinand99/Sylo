import Foundation

/// The Health page's report, from `GET /api/v2/health` (Sylo's operators only): whether the bot is
/// up, how big it is, the database and its backups. Missing parts read as empty, so an older or
/// newer server still shows what it has.
public struct HealthReport: Decodable, Sendable, Equatable {
    public struct ModuleUse: Decodable, Sendable, Hashable {
        public let name: String
        /// How many servers have it on.
        public let servers: Int

        public init(name: String, servers: Int) {
            self.name = name
            self.servers = servers
        }

        private enum CodingKeys: String, CodingKey { case name, guilds }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            servers = try c.decodeIfPresent(Int.self, forKey: .guilds) ?? 0
        }
    }

    public struct Database: Decodable, Sendable, Equatable {
        public let size: String?
        public let wal: String?
        public let isPostgres: Bool
        /// Hours between backups; 0 when scheduled backups are off.
        public let backupIntervalHours: Double?
        public let backupsKept: Int?
        /// Where off-site copies go ("WebDAV"), or nil when there are none.
        public let offsite: String?

        public init(
            size: String? = nil, wal: String? = nil, isPostgres: Bool = false, backupIntervalHours: Double? = nil,
            backupsKept: Int? = nil, offsite: String? = nil
        ) {
            self.size = size
            self.wal = wal
            self.isPostgres = isPostgres
            self.backupIntervalHours = backupIntervalHours
            self.backupsKept = backupsKept
            self.offsite = offsite
        }

        private enum CodingKeys: String, CodingKey { case size, wal, postgres, intervalHours, retention, offsite }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            size = try c.decodeIfPresent(String.self, forKey: .size)
            wal = try c.decodeIfPresent(String.self, forKey: .wal)
            isPostgres = try c.decodeIfPresent(Bool.self, forKey: .postgres) ?? false
            backupIntervalHours = try c.decodeIfPresent(Double.self, forKey: .intervalHours)
            backupsKept = try c.decodeIfPresent(Int.self, forKey: .retention)
            offsite = try c.decodeIfPresent(String.self, forKey: .offsite)
        }
    }

    public struct Backup: Decodable, Sendable, Hashable, Identifiable {
        public let name: String
        public let size: String
        /// "3h ago", as the server words it.
        public let age: String
        public var id: String { name }

        public init(name: String, size: String, age: String) {
            self.name = name
            self.size = size
            self.age = age
        }

        private enum CodingKeys: String, CodingKey { case name, size, ago }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            size = try c.decodeIfPresent(String.self, forKey: .size) ?? ""
            age = try c.decodeIfPresent(String.self, forKey: .ago) ?? ""
        }
    }

    public let isReady: Bool
    public let botTag: String?
    public let version: String?
    /// "2d 3h", as the server words it.
    public let uptime: String?
    public let serverCount: Int
    public let memberReach: Int
    /// Milliseconds; nil while the gateway has no measurement.
    public let gatewayPing: Int?
    public let openTickets: Int
    public let ticketsTotal: Int
    public let warningsThisWeek: Int
    public let warningsTotal: Int
    public let modules: [ModuleUse]
    public let database: Database?
    public let backups: [Backup]
    public let isDevLogChannelSet: Bool

    public init(
        isReady: Bool, botTag: String? = nil, version: String? = nil, uptime: String? = nil, serverCount: Int = 0,
        memberReach: Int = 0, gatewayPing: Int? = nil, openTickets: Int = 0, ticketsTotal: Int = 0,
        warningsThisWeek: Int = 0, warningsTotal: Int = 0, modules: [ModuleUse] = [], database: Database? = nil,
        backups: [Backup] = [], isDevLogChannelSet: Bool = false
    ) {
        self.isReady = isReady
        self.botTag = botTag
        self.version = version
        self.uptime = uptime
        self.serverCount = serverCount
        self.memberReach = memberReach
        self.gatewayPing = gatewayPing
        self.openTickets = openTickets
        self.ticketsTotal = ticketsTotal
        self.warningsThisWeek = warningsThisWeek
        self.warningsTotal = warningsTotal
        self.modules = modules
        self.database = database
        self.backups = backups
        self.isDevLogChannelSet = isDevLogChannelSet
    }

    private enum CodingKeys: String, CodingKey {
        case ready, botTag, version, uptime, guildCount, memberReach, gatewayPing, stats, modules, db, backups
        case devLogConfigured
    }

    private enum StatsKeys: String, CodingKey { case openTickets, ticketsTotal, warningsWeek, warningsTotal }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isReady = try c.decodeIfPresent(Bool.self, forKey: .ready) ?? false
        botTag = try c.decodeIfPresent(String.self, forKey: .botTag)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        uptime = try c.decodeIfPresent(String.self, forKey: .uptime)
        serverCount = try c.decodeIfPresent(Int.self, forKey: .guildCount) ?? 0
        memberReach = try c.decodeIfPresent(Int.self, forKey: .memberReach) ?? 0
        gatewayPing = try c.decodeIfPresent(Int.self, forKey: .gatewayPing)
        if c.contains(.stats), try !c.decodeNil(forKey: .stats) {
            let stats = try c.nestedContainer(keyedBy: StatsKeys.self, forKey: .stats)
            openTickets = try stats.decodeIfPresent(Int.self, forKey: .openTickets) ?? 0
            ticketsTotal = try stats.decodeIfPresent(Int.self, forKey: .ticketsTotal) ?? 0
            warningsThisWeek = try stats.decodeIfPresent(Int.self, forKey: .warningsWeek) ?? 0
            warningsTotal = try stats.decodeIfPresent(Int.self, forKey: .warningsTotal) ?? 0
        } else {
            openTickets = 0
            ticketsTotal = 0
            warningsThisWeek = 0
            warningsTotal = 0
        }
        modules = try c.decodeLossyArray(of: ModuleUse.self, forKey: .modules)
        database = try c.decodeIfPresent(Database.self, forKey: .db)
        backups = try c.decodeLossyArray(of: Backup.self, forKey: .backups)
        isDevLogChannelSet = try c.decodeIfPresent(Bool.self, forKey: .devLogConfigured) ?? false
    }
}

/// How serious a dev-log event is.
public enum DevLogLevel: String, Sendable, Hashable, Codable {
    case error
    case warning = "warn"
}

/// One of Sylo's own errors or warnings, from the stored dev log.
public struct DevLogEntry: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let level: DevLogLevel
    /// The part of Sylo it came from ("db", "push", a module).
    public let scope: String
    public let message: String
    public let date: Date

    public init(id: Int, level: DevLogLevel, scope: String, message: String, date: Date) {
        self.id = id
        self.level = level
        self.scope = scope
        self.message = message
        self.date = date
    }

    private enum CodingKeys: String, CodingKey { case id, level, scope, message, at }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        level = (try? c.decode(DevLogLevel.self, forKey: .level)) ?? .error
        scope = try c.decodeIfPresent(String.self, forKey: .scope) ?? ""
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        date = try c.decodeEpochMilliseconds(forKey: .at)
    }
}

/// `GET /api/v2/dev-log`: the newest entries first.
public struct DevLogPage: Decodable, Sendable, Equatable {
    public let entries: [DevLogEntry]

    public init(entries: [DevLogEntry]) { self.entries = entries }

    private enum CodingKeys: String, CodingKey { case entries }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entries = try c.decodeLossyArray(of: DevLogEntry.self, forKey: .entries)
    }
}

/// Which dev-log events this device is notified about (an operator's choice, per device).
public enum DevLogNotificationLevel: String, Sendable, Hashable, Codable, CaseIterable {
    case off
    case errors
    /// Errors and warnings.
    case warnings
}

/// The answer to choosing a dev-log level.
public struct DevLogSettingResult: Decodable, Sendable, Equatable {
    public let devLog: DevLogNotificationLevel

    public init(devLog: DevLogNotificationLevel) { self.devLog = devLog }
}

/// The answer to "send a test to the dev-log channel": `ok`, or why not.
public struct DevLogTestResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let error: String?

    public init(ok: Bool, error: String? = nil) {
        self.ok = ok
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case ok, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }
}

/// A dev-log notification's deep link, from its `userInfo`:
/// `{"sylo": {"kind": "devlog", "server": "<Sylo address>", "level": "error"}}`.
public struct DevLogNotification: Hashable, Sendable {
    public let server: ServerURL
    public let level: DevLogLevel

    public init(server: ServerURL, level: DevLogLevel) {
        self.server = server
        self.level = level
    }

    /// Nil for anything that is not a dev-log notification from a valid Sylo address.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let sylo = userInfo["sylo"] as? [AnyHashable: Any],
            sylo["kind"] as? String == "devlog",
            let address = sylo["server"] as? String,
            let server = try? ServerURL(address)
        else { return nil }
        self.init(server: server, level: (sylo["level"] as? String).flatMap(DevLogLevel.init(rawValue:)) ?? .error)
    }

    /// Whether it came from `server`, the Sylo server the app is signed in to.
    public func matches(_ server: ServerURL) -> Bool { self.server == server }
}

// The Health page's calls: operators only (403 for anyone else).
extension Endpoints {
    /// `GET /api/v2/health`.
    public struct Health: APIEndpoint {
        public typealias Response = HealthReport
        public var path: String { "/api/v2/health" }
        public init() {}
    }

    /// `GET /api/v2/dev-log`: the stored dev log, newest first.
    public struct DevLog: APIEndpoint {
        public typealias Response = DevLogPage
        public let errorsOnly: Bool
        public let limit: Int

        public init(errorsOnly: Bool, limit: Int = 200) {
            self.errorsOnly = errorsOnly
            self.limit = limit
        }

        public var path: String { "/api/v2/dev-log" }
        public var query: [URLQueryItem] {
            var items = [URLQueryItem(name: "limit", value: String(limit))]
            if errorsOnly { items.append(URLQueryItem(name: "level", value: "error")) }
            return items
        }
    }

    /// `POST /api/v2/health/dev-log-test`: posts a test message to the dev-log channel.
    public struct SendDevLogTest: APIEndpoint {
        public typealias Response = DevLogTestResult
        public var path: String { "/api/v2/health/dev-log-test" }
        public var method: HTTPMethod { .post }
        public init() {}
    }

    /// `PUT /api/mobile/push/dev-log`: which dev-log events this device is notified about.
    public struct SetDevLogNotifications: APIEndpoint {
        public typealias Response = DevLogSettingResult
        public let level: DevLogNotificationLevel

        public init(level: DevLogNotificationLevel) { self.level = level }

        public var path: String { "/api/mobile/push/dev-log" }
        public var method: HTTPMethod { .put }
        public var body: (any Encodable & Sendable)? { Body(level: level) }

        private struct Body: Encodable, Sendable { let level: DevLogNotificationLevel }
    }
}
