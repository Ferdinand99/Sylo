import Foundation
import Testing
@testable import SyloKit

// The server's clock against the phone's: when the app has to say "server time", and how a cleanup
// time and its days move between the two. The dates sit in November, away from every clock change of
// the zones used here.

@Suite("Server clock")
struct ServerClockTests {
    static let oslo = TimeZone(identifier: "Europe/Oslo")!
    static let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    static let newYork = TimeZone(identifier: "America/New_York")!
    /// 2026-11-06 21:20 UTC: 22:20 in Oslo, 06:20 the next day in Tokyo, 16:20 in New York.
    static let now = Date(timeIntervalSince1970: 1_794_000_000)

    @Test("a zone the server did not give, or this device does not know, is unknown")
    func unknownZones() {
        for name in [nil, "", "  ", "Not/AZone"] as [String?] {
            let clock = ServerClock(serverZone: name, phoneZone: Self.oslo)
            #expect(clock.relation(now: Self.now) == .unknown, "\(name ?? "nil")")
            #expect(clock.needsServerTimeLabel)
            #expect(clock.differingZoneName(now: Self.now) == nil)
        }
        #expect(ServerClock.unknown.needsServerTimeLabel)
    }

    @Test("the phone's own zone, or one with the same rules, needs nothing said")
    func sameZones() {
        let same = ServerClock(serverZone: "Europe/Oslo", phoneZone: Self.oslo)
        #expect(same.relation(now: Self.now) == .same)
        #expect(!same.needsServerTimeLabel)
        #expect(same.differingZoneName(now: Self.now) == nil)

        // Two names for the same rules.
        let utc = ServerClock(serverZone: "UTC", phoneZone: TimeZone(identifier: "GMT")!)
        #expect(utc.relation(now: Self.now) == .same)
    }

    @Test("another known zone can be converted, and is named where it cannot")
    func differentZones() {
        let clock = ServerClock(serverZone: "Europe/Oslo", phoneZone: Self.tokyo)
        #expect(clock.relation(now: Self.now) == .different)
        // A known zone needs no "server time" label: the times are converted.
        #expect(!clock.needsServerTimeLabel)
        #expect(clock.differingZoneName(now: Self.now) == "Europe/Oslo")
    }

    @Test("a server time and its days move to a phone that is ahead, across midnight")
    func toPhoneAhead() {
        let clock = ServerClock(serverZone: "Europe/Oslo", phoneZone: Self.tokyo)

        // 03:00 in Oslo is 11:00 in Tokyo, the same day.
        let early = clock.phoneSchedule(time: "03:00", days: [1, 3], now: Self.now)
        #expect(early.time == "11:00")
        #expect(early.days == [1, 3])

        // 20:00 in Oslo is 04:00 the next day in Tokyo: Monday and Wednesday become Tuesday and Thursday.
        let late = clock.phoneSchedule(time: "20:00", days: [1, 3], now: Self.now)
        #expect(late.time == "04:00")
        #expect(late.days == [2, 4])

        // The week wraps: Saturday becomes Sunday.
        #expect(clock.phoneSchedule(time: "20:00", days: [6], now: Self.now).days == [0])
    }

    @Test("a server time and its days move to a phone that is behind, across midnight")
    func toPhoneBehind() {
        let clock = ServerClock(serverZone: "Asia/Tokyo", phoneZone: Self.oslo)

        // 02:00 in Tokyo is 18:00 the evening before in Oslo: Monday becomes Sunday, Sunday Saturday.
        let moved = clock.phoneSchedule(time: "02:00", days: [1, 0], now: Self.now)
        #expect(moved.time == "18:00")
        #expect(moved.days == [0, 6])
    }

    @Test("a time picked on the phone is turned back into the server's, days included")
    func toServer() {
        let clock = ServerClock(serverZone: "Europe/Oslo", phoneZone: Self.tokyo)

        let back = clock.serverSchedule(time: "04:00", days: [2, 4], now: Self.now)
        #expect(back.time == "20:00")
        #expect(back.days == [1, 3])

        let sameDay = clock.serverSchedule(time: "11:00", days: [1, 3], now: Self.now)
        #expect(sameDay.time == "03:00")
        #expect(sameDay.days == [1, 3])
    }

    @Test("converting there and back gives the time and days that were picked")
    func roundTrip() {
        let zones = [Self.oslo, Self.tokyo, Self.newYork]
        for server in zones {
            for phone in zones {
                let clock = ServerClock(serverZone: server.identifier, phoneZone: phone)
                for time in ["00:00", "03:00", "09:05", "12:00", "18:30", "23:59"] {
                    let days: Set<Int> = [0, 2, 5]
                    let shown = clock.phoneSchedule(time: time, days: days, now: Self.now)
                    let back = clock.serverSchedule(time: shown.time, days: shown.days, now: Self.now)
                    #expect(back.time == time, "\(server.identifier) to \(phone.identifier) at \(time)")
                    #expect(back.days == days, "\(server.identifier) to \(phone.identifier) at \(time)")
                }
            }
        }
    }

    @Test("an unknown or equal zone changes nothing, an empty set of days stays empty, a bad time is kept")
    func unchanged() {
        let unknown = ServerClock(serverZone: nil, phoneZone: Self.tokyo)
        let a = unknown.phoneSchedule(time: "20:00", days: [1, 3], now: Self.now)
        #expect(a.time == "20:00")
        #expect(a.days == [1, 3])

        let same = ServerClock(serverZone: "Asia/Tokyo", phoneZone: Self.tokyo)
        #expect(same.serverSchedule(time: "20:00", days: [1], now: Self.now).time == "20:00")

        let apart = ServerClock(serverZone: "Europe/Oslo", phoneZone: Self.tokyo)
        #expect(apart.phoneSchedule(time: "20:00", days: [], now: Self.now).days.isEmpty)
        let bad = apart.phoneSchedule(time: "25:00", days: [1], now: Self.now)
        #expect(bad.time == "25:00")
        #expect(bad.days == [1])
    }
}
