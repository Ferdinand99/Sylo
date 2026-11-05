import Foundation
import Testing
@testable import SyloKit

@Suite("Dates and counts")
struct DateTextTests {
    static let utc = TimeZone(identifier: "UTC")!
    static let us = Locale(identifier: "en_US")
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        calendar.locale = us
        return calendar
    }

    /// 2026-09-24 19:00 UTC, a Thursday.
    static let thursday = Date(timeIntervalSince1970: 1_790_276_400)
    static let now = Date(timeIntervalSince1970: 1_790_000_000)  // 2026-09-21

    @Test("a day this year is the weekday, day and month, never all numbers")
    func dayThisYear() {
        let text = DateText.day(Self.thursday, now: Self.now, calendar: Self.calendar, locale: Self.us, timeZone: Self.utc)
        #expect(text.contains("Thu"))
        #expect(text.contains("24"))
        #expect(text.contains("Sep"))
        #expect(!text.contains("2026"))
        #expect(!text.contains("/"))
    }

    @Test("a day in another year has the year and no weekday")
    func dayOtherYear() {
        let later = Date(timeIntervalSince1970: 1_790_000_000 + 400 * 86_400)
        let text = DateText.day(Self.thursday, now: later, calendar: Self.calendar, locale: Self.us, timeZone: Self.utc)
        #expect(text.contains("2026"))
        #expect(text.contains("Sep"))
        #expect(text.contains("24"))
        #expect(!text.contains("Thu"))
        #expect(!text.contains("/"))
    }

    @Test("the day follows the time zone it is shown in")
    func timeZone() {
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        // 19:00 UTC on the 24th is already the 25th in Tokyo.
        let text = DateText.day(Self.thursday, now: Self.now, calendar: Self.calendar, locale: Self.us, timeZone: tokyo)
        #expect(text.contains("25"))
        #expect(text.contains("Fri"))
    }

    @Test("the day and time carry both")
    func dayAndTime() {
        let text = DateText.dayAndTime(
            Self.thursday, now: Self.now, calendar: Self.calendar, locale: Self.us, timeZone: Self.utc)
        #expect(text.contains("Thu"))
        #expect(text.contains("24"))
        #expect(text.contains("7:00"))
    }

    @Test("recency is worded relative to now")
    func relative() {
        let past = Self.now.addingTimeInterval(-3 * 60)
        let text = DateText.relative(past, now: Self.now, locale: Self.us)
        #expect(text.contains("3"))
        #expect(text.lowercased().contains("ago"))
        let future = DateText.relative(Self.now.addingTimeInterval(2 * 86_400), now: Self.now, locale: Self.us)
        #expect(future.lowercased().contains("in"))
    }

    @Test("counts have the region's thousands separators")
    func counts() {
        #expect(DateText.count(1284, locale: Self.us) == "1,284")
        #expect(DateText.count(24, locale: Self.us) == "24")
        #expect(DateText.count(1_284_000, locale: Locale(identifier: "de_DE")) == "1.284.000")
    }

    @Test("a ticket older than a week shows the day, not a numeric date")
    func messageTimeOld() {
        let text = MessageTime.listLabel(for: Self.thursday, now: Self.now.addingTimeInterval(30 * 86_400),
                                         calendar: Self.calendar, locale: Self.us)
        #expect(text.contains("Sep"))
        #expect(!text.contains("/"))
        let separator = MessageTime.separatorLabel(for: Self.thursday, now: Self.now.addingTimeInterval(30 * 86_400),
                                                   calendar: Self.calendar, locale: Self.us)
        #expect(separator.contains("Sep"))
        #expect(!separator.contains("/"))
    }

    @Test("a ticket this week shows its weekday")
    func messageTimeWeek() {
        let now = Self.thursday.addingTimeInterval(3 * 86_400 + 3600)
        let text = MessageTime.listLabel(for: Self.thursday, now: now, calendar: Self.calendar, locale: Self.us)
        #expect(text == "Thursday")
    }
}
