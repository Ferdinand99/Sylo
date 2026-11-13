import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// 2023-11-14 00:00:00 UTC, and 22:00 of that day.
private let dayStart = Date(timeIntervalSince1970: 1_699_920_000)
private let hourStart = Date(timeIntervalSince1970: 1_699_920_000 + 22 * 3600)

@Suite("Insights")
struct InsightsDecodingTests {
    static let dayJSON = #"""
        {"range":3,"granularity":"day","series":[
          {"label":"2023-11-14","joins":2,"leaves":1,"messages":10,"activeMembers":3,"voiceMinutes":30,"voiceActiveMembers":1,"voicePeak":2},
          {"label":"2023-11-15","joins":0,"leaves":3,"messages":0,"activeMembers":0,"voiceMinutes":0,"voiceActiveMembers":0,"voicePeak":0},
          {"label":"2023-11-16","joins":1,"leaves":0,"messages":5,"activeMembers":1,"voiceMinutes":0,"voiceActiveMembers":0,"voicePeak":0}],
         "totals":{"messages":15,"joins":3,"leaves":4,"net":-1,"peakActive":3,"voiceMinutes":30,"voicePeak":2},
         "topChannels":[{"name":"general","messages":12}],"topVoice":[{"name":"Lounge","minutes":30}]}
        """#

    static let hourJSON = #"""
        {"range":24,"granularity":"hour","series":[
          {"label":"2023-11-14T22","joins":1,"leaves":0,"messages":4,"activeMembers":2,"voiceMinutes":0,"voiceActiveMembers":0,"voicePeak":0}],
         "totals":{"messages":4,"joins":1,"leaves":0,"net":1,"peakActive":2,"voiceMinutes":0,"voicePeak":0},
         "topChannels":[],"topVoice":[]}
        """#

    @Test("The ranges: hours for 24 and 48, days for the others")
    func rangeGranularity() {
        #expect(InsightsRange.last24Hours.granularity == .hour)
        #expect(InsightsRange.last48Hours.granularity == .hour)
        #expect(InsightsRange.last7Days.granularity == .day)
        #expect(InsightsRange.last30Days.granularity == .day)
        #expect(InsightsRange.last90Days.granularity == .day)
        #expect(InsightsRange.allCases.map(\.queryValue) == ["24", "48", "7", "30", "90"])
        #expect(InsightsRange.last48Hours.count == 48)
        #expect(InsightsRange.last90Days.count == 90)
    }

    @Test("A day report reads its series, totals and top channels")
    func dayReport() throws {
        let report = try decode(InsightsReport.self, Self.dayJSON)
        #expect(report.granularity == .day)
        #expect(report.range == 3)
        #expect(report.series.count == 3)
        #expect(report.series[0].date == dayStart)
        #expect(report.series[1].date == dayStart.addingTimeInterval(86_400))
        #expect(report.series[0].messages == 10)
        #expect(report.series[0].voicePeak == 2)
        #expect(report.totals.net == -1)
        #expect(report.totals.voiceMinutes == 30)
        #expect(report.topChannels == [InsightsChannel(name: "general", value: 12)])
        #expect(report.topVoice == [InsightsChannel(name: "Lounge", value: 30)])
    }

    @Test("An hour report labels its buckets by the hour")
    func hourReport() throws {
        let report = try decode(InsightsReport.self, Self.hourJSON)
        #expect(report.granularity == .hour)
        #expect(report.series.first?.date == hourStart)
        #expect(report.topChannels.isEmpty)
    }

    @Test("Day labels and hour labels are told apart, and an odd label has no date")
    func labels() {
        #expect(InsightsPoint.date(fromLabel: "2023-11-14") == dayStart)
        #expect(InsightsPoint.date(fromLabel: "2023-11-14T22") == hourStart)
        #expect(InsightsPoint.date(fromLabel: "2023-11-14T25") == nil)
        #expect(InsightsPoint.date(fromLabel: "yesterday") == nil)
        #expect(InsightsPoint.date(fromLabel: "2023-11") == nil)
        #expect(InsightsPoint.date(fromLabel: "") == nil)
    }

    @Test("Member growth adds joins minus leaves up, bucket by bucket")
    func growth() throws {
        let report = try decode(InsightsReport.self, Self.dayJSON)
        #expect(report.growth.map(\.total) == [1, -2, -1])
        #expect(report.growth.first?.date == dayStart)
    }

    @Test("A bucket with an unreadable label stays out of the charts")
    func undatedBucketsAreLeftOut() throws {
        let json = #"""
            {"range":2,"granularity":"day","series":[{"label":"?","joins":5},{"label":"2023-11-14","joins":1}],"totals":{}}
            """#
        let report = try decode(InsightsReport.self, json)
        #expect(report.series.count == 2)
        #expect(report.datedSeries.map(\.label) == ["2023-11-14"])
        #expect(report.growth.map(\.total) == [6])
    }

    @Test("Missing fields read as zero, fractions round, and a missing granularity means days")
    func lenient() throws {
        let report = try decode(
            InsightsReport.self,
            #"{"series":[{"label":"2023-11-14","voiceMinutes":12.6,"messages":null}],"unknown":true}"#)
        #expect(report.granularity == .day)
        #expect(report.range == 0)
        #expect(report.series[0].voiceMinutes == 13)
        #expect(report.series[0].messages == 0)
        #expect(report.totals == InsightsTotals())
        #expect(report.topChannels.isEmpty)
    }

    @Test("Voice time reads in minutes, then hours; long totals keep whole hours")
    func durations() {
        #expect(InsightsFormat.duration(minutes: 45) == "45 min")
        #expect(InsightsFormat.duration(minutes: 60) == "1 h")
        #expect(InsightsFormat.duration(minutes: 185) == "3 h 5 m")
        #expect(InsightsFormat.shortDuration(minutes: 599) == "9 h 59 m")
        #expect(InsightsFormat.shortDuration(minutes: 600) == "10 h")
        #expect(InsightsFormat.shortDuration(minutes: 144_121) == "2402 h")
        #expect(InsightsFormat.duration(minutes: -5) == "0 min")
    }

    @Test("The calls go where the server expects")
    func endpoints() {
        let hourly = Endpoints.Insights(server: "fluxer:1", range: .last24Hours)
        #expect(hourly.path == "/api/v2/guilds/fluxer%3A1/insights")
        #expect(hourly.method == .get)
        #expect(hourly.query == [URLQueryItem(name: "range", value: "24")])
        #expect(Endpoints.Insights(server: "1", range: .last90Days).query == [URLQueryItem(name: "range", value: "90")])
        let refresh = Endpoints.RefreshInsights(server: "1")
        #expect(refresh.path == "/api/v2/guilds/1/insights/refresh")
        #expect(refresh.method == .post)
    }
}

@MainActor
@Suite("Insights model")
struct InsightsModelTests {
    nonisolated static let report = try! decode(InsightsReport.self, InsightsDecodingTests.dayJSON)

    static func clients() -> StubClients {
        StubClients { endpoint in
            if endpoint is Endpoints.RefreshInsights { return OKResponse() }
            return Self.report
        }
    }

    func calls(_ clients: StubClients) -> [String] {
        clients.calls.map { call in
            switch call.endpoint {
            case let insights as Endpoints.Insights: "insights \(insights.range.queryValue)"
            case is Endpoints.RefreshInsights: "refresh"
            default: "other"
            }
        }
    }

    @Test("Loading reads the 30 day report first")
    func loads() async {
        let clients = Self.clients()
        let model = InsightsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.report == Self.report)
        #expect(model.errorMessage == nil)
        #expect(calls(clients) == ["insights 30"])
    }

    @Test("Another range loads that range")
    func otherRange() async {
        let clients = Self.clients()
        let model = InsightsModel(server: "1", session: makeSignedInSession(clients: clients))
        model.range = .last24Hours
        await model.load()
        #expect(calls(clients) == ["insights 24"])
    }

    @Test("A failed load explains and keeps the report already shown")
    func failedLoad() async {
        let clients = Self.clients()
        let model = InsightsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { _ in throw NetworkError.offline }
        await model.load()
        #expect(model.report == Self.report)
        #expect(model.errorMessage == NetworkError.offline.userMessage)
        clients.setHandler { _ in Self.report }
        await model.load()
        #expect(model.errorMessage == nil)
    }

    @Test("Refreshing asks the server to save its counts, then reads the report again")
    func refreshes() async {
        let clients = Self.clients()
        let model = InsightsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.refresh()
        #expect(calls(clients) == ["refresh", "insights 30"])
        #expect(model.report == Self.report)
        #expect(model.refreshError == nil)
        #expect(!model.isRefreshing)
    }

    @Test("A refresh that fails says why, and still reads the report")
    func failedRefresh() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RefreshInsights { throw NetworkError.rateLimited }
            return Self.report
        }
        let model = InsightsModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.refresh()
        #expect(model.refreshError == NetworkError.rateLimited.userMessage)
        #expect(model.report == Self.report)
    }
}
