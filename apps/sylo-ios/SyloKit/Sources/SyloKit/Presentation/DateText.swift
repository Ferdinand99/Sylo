import Foundation

// One way to word dates and numbers for the whole app, like the web dashboard does ("Thu 24 Sep",
// "24 Sep 2026", "3m ago"): never all-numeric dates, which read differently in each country
// ("5/6/2026" is May or June). Everything goes through Date.FormatStyle, so it follows the
// person's language and region; the parameters exist for tests and for showing an event in its own
// time zone.

/// Dates and counts as people read them.
public enum DateText {
    /// "Thu 24 Sep" for a day this year, "24 Sep 2026" for another year (the order of the parts
    /// follows the locale).
    public static func day(
        _ date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current,
        timeZone: TimeZone? = nil
    ) -> String {
        let zone = timeZone ?? calendar.timeZone
        var calendar = calendar
        calendar.timeZone = zone
        let sameYear = calendar.isDate(date, equalTo: now, toGranularity: .year)
        let base = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: zone)
        let style = sameYear
            ? base.weekday(.abbreviated).day().month(.abbreviated)
            : base.day().month(.abbreviated).year()
        return date.formatted(style)
    }

    /// "Thu 24 Sep, 19:00": the day, then the time.
    public static func dayAndTime(
        _ date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current,
        timeZone: TimeZone? = nil
    ) -> String {
        let zone = timeZone ?? calendar.timeZone
        var calendar = calendar
        calendar.timeZone = zone
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale,
                                                   calendar: calendar, timeZone: zone))
        return day(date, now: now, calendar: calendar, locale: locale, timeZone: zone) + ", " + time
    }

    /// "3 min. ago", "in 2 days": how far away a moment is, for lists that show recency.
    public static func relative(_ date: Date, now: Date = .now, locale: Locale = .current) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .abbreviated
        formatter.dateTimeStyle = .numeric
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// A count with the thousands separators of the person's region ("1,284").
    public static func count(_ value: Int, locale: Locale = .current) -> String {
        value.formatted(.number.locale(locale))
    }
}

/// Times the way Messages words them, for the ticket list and conversations.
public enum MessageTime {
    /// "14:05" today, "Yesterday", the weekday this week, else "24 Sep 2026" or "Thu 24 Sep".
    public static func listLabel(
        for date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current
    ) -> String {
        if calendar.isDateInToday(date) {
            return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar))
        }
        if calendar.isDateInYesterday(date) {
            return String(localized: "Yesterday")
        }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(Date.FormatStyle(locale: locale, calendar: calendar).weekday(.wide))
        }
        return DateText.day(date, now: now, calendar: calendar, locale: locale)
    }

    /// The label above a group of messages: "Today 14:05", "Yesterday 09:12", "Monday 18:30", or
    /// the day and time ("Thu 24 Sep, 19:00").
    public static func separatorLabel(
        for date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current
    ) -> String {
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar))
        if calendar.isDateInToday(date) { return String(localized: "Today \(time)") }
        if calendar.isDateInYesterday(date) { return String(localized: "Yesterday \(time)") }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return "\(date.formatted(Date.FormatStyle(locale: locale, calendar: calendar).weekday(.wide))) \(time)"
        }
        return DateText.dayAndTime(date, now: now, calendar: calendar, locale: locale)
    }
}
