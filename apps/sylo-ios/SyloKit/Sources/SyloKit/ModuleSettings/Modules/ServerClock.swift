import Foundation

/// The clock the server counts a schedule's days and time of day on, compared with the phone's.
///
/// Reminder weekdays and the cleanup time are read on the server's own clock. A server that sends its
/// zone (`timeZone`, an IANA name, on the reminders and cleanup lists) lets the app show a cleanup
/// time and its days on the phone's clock instead; a server that does not leaves the app unable to
/// tell, so those summaries say "server time". When the two zones are the same nothing needs saying.
public struct ServerClock: Sendable, Equatable {
    /// How the server's clock relates to the phone's.
    public enum Relation: Sendable, Equatable {
        /// The server did not say, or named a zone this device does not know.
        case unknown
        /// The same rules as the phone's: no conversion, nothing to say.
        case same
        /// Another zone, known: times can be converted.
        case different
    }

    /// The server's zone; nil when unknown.
    public let serverZone: TimeZone?
    public let phoneZone: TimeZone

    public init(serverZone name: String?, phoneZone: TimeZone = .autoupdatingCurrent) {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        serverZone = trimmed.isEmpty ? nil : TimeZone(identifier: trimmed)
        self.phoneZone = phoneZone
    }

    /// A server that did not say its zone.
    public static let unknown = ServerClock(serverZone: nil)

    public func relation(now: Date = .now) -> Relation {
        guard let serverZone else { return .unknown }
        return Self.sameRules(serverZone, phoneZone, now: now) ? .same : .different
    }

    /// Whether the summaries have to say "server time": only when the zone is not known.
    public var needsServerTimeLabel: Bool { serverZone == nil }

    /// The server's zone name when it differs from the phone's, for the one place that names it
    /// (reminder weekdays, which cannot be moved to the phone's clock).
    public func differingZoneName(now: Date = .now) -> String? {
        relation(now: now) == .different ? serverZone?.identifier : nil
    }

    /// Two zones count as the same when they have the same name, or the same offset at four moments
    /// of the year (so UTC and GMT, or two zones that share their rules, do not need converting).
    static func sameRules(_ a: TimeZone, _ b: TimeZone, now: Date) -> Bool {
        if a.identifier == b.identifier { return true }
        let quarter: TimeInterval = 365.25 * 86_400 / 4
        return (0..<4).allSatisfy { step in
            let moment = now.addingTimeInterval(Double(step) * quarter)
            return a.secondsFromGMT(for: moment) == b.secondsFromGMT(for: moment)
        }
    }

    // MARK: - Converting a schedule

    /// A schedule's "HH:MM" and weekdays (0 is Sunday), as the server counts them, on the phone's clock.
    /// Unchanged unless the server's zone is known and differs. An empty set of days means every day
    /// and stays empty.
    public func phoneSchedule(time: String, days: Set<Int>, now: Date = .now) -> (time: String, days: Set<Int>) {
        guard relation(now: now) == .different, let serverZone else { return (time, days) }
        return Self.convert(time: time, days: days, from: serverZone, to: phoneZone, now: now) ?? (time, days)
    }

    /// The other way: a time and weekdays picked on the phone's clock, as the server counts them.
    public func serverSchedule(time: String, days: Set<Int>, now: Date = .now) -> (time: String, days: Set<Int>) {
        guard relation(now: now) == .different, let serverZone else { return (time, days) }
        return Self.convert(time: time, days: days, from: phoneZone, to: serverZone, now: now) ?? (time, days)
    }

    private static func convert(
        time: String, days: Set<Int>, from source: TimeZone, to target: TimeZone, now: Date
    ) -> (time: String, days: Set<Int>)? {
        let parts = time.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0...23).contains(hour), (0...59).contains(minute)
        else { return nil }
        var from = Calendar(identifier: .gregorian)
        from.timeZone = source
        var to = Calendar(identifier: .gregorian)
        to.timeZone = target
        // The time on today's date in the source zone: the day the shift is counted from.
        var day = from.dateComponents([.year, .month, .day], from: now)
        day.hour = hour
        day.minute = minute
        guard let instant = from.date(from: day) else { return nil }
        let moved = to.dateComponents([.hour, .minute], from: instant)
        var shift = (to.component(.weekday, from: instant) - from.component(.weekday, from: instant)) % 7
        if shift > 3 { shift -= 7 }
        if shift < -3 { shift += 7 }
        let text = String(format: "%02d:%02d", moved.hour ?? hour, moved.minute ?? minute)
        let shifted = Set(days.map { (($0 + shift) % 7 + 7) % 7 })
        return (text, shifted)
    }
}
