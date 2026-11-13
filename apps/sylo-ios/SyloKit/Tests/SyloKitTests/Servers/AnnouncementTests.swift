import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// Remembers the dismissed announcement in memory.
@MainActor
private final class MemoryDismissedStore: DismissedAnnouncementStore {
    var dismissedID: String?
    init(_ id: String? = nil) { dismissedID = id }
}

@Suite("Announcement")
struct AnnouncementDecodingTests {
    @Test("A notice reads with its severity and time")
    func decodes() throws {
        let answer = try decode(
            AnnouncementAnswer.self,
            #"{"announcement":{"title":"Maintenance","body":"At 22:00 UTC.","severity":"warning","createdAt":1700000000000}}"#)
        let notice = try #require(answer.announcement)
        #expect(notice.title == "Maintenance")
        #expect(notice.body == "At 22:00 UTC.")
        #expect(notice.severity == .warning)
        #expect(notice.createdAt == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(notice.id == "1700000000000")
        #expect(notice.isDismissible)
    }

    @Test("No notice, an unreadable one and an unknown severity")
    func edges() throws {
        #expect(try decode(AnnouncementAnswer.self, #"{"announcement":null}"#).announcement == nil)
        #expect(try decode(AnnouncementAnswer.self, "{}").announcement == nil)
        #expect(try decode(AnnouncementAnswer.self, #"{"announcement":{"body":"no title"}}"#).announcement == nil)
        let loud = try decode(
            AnnouncementAnswer.self, #"{"announcement":{"title":"T","severity":"apocalyptic","createdAt":5}}"#)
        #expect(loud.announcement?.severity == .other("apocalyptic"))
        #expect(loud.announcement?.isDismissible == true)
        #expect(loud.announcement?.body == "")
    }

    @Test("A critical notice cannot be dismissed")
    func critical() throws {
        let answer = try decode(
            AnnouncementAnswer.self, #"{"announcement":{"title":"Down","severity":"critical","createdAt":5}}"#)
        #expect(answer.announcement?.severity == .critical)
        #expect(answer.announcement?.isDismissible == false)
    }

    @Test("The call goes where the server expects")
    func endpoint() {
        #expect(Endpoints.CurrentAnnouncement().path == "/api/v2/announcement")
    }
}

@MainActor
@Suite("Announcement model")
struct AnnouncementModelTests {
    nonisolated static func notice(
        _ title: String = "Maintenance", severity: AnnouncementSeverity = .info, at seconds: Double = 1_700_000_000
    ) -> Announcement {
        Announcement(title: title, severity: severity, createdAt: Date(timeIntervalSince1970: seconds))
    }

    private func makeModel(
        _ clients: StubClients, store: MemoryDismissedStore = MemoryDismissedStore()
    ) -> AnnouncementModel {
        AnnouncementModel(session: makeSignedInSession(clients: clients), store: store)
    }

    @Test("A notice shows until it is dismissed, and stays dismissed")
    func dismisses() async {
        let store = MemoryDismissedStore()
        let clients = StubClients { _ in AnnouncementAnswer(announcement: Self.notice()) }
        let model = makeModel(clients, store: store)
        await model.load()
        #expect(model.visible?.title == "Maintenance")

        model.dismiss()
        #expect(model.visible == nil)
        #expect(store.dismissedID == "1700000000000")

        // Loaded again, or in a later launch: still hidden.
        await model.load()
        #expect(model.visible == nil)
        let later = makeModel(clients, store: store)
        await later.load()
        #expect(later.visible == nil)
    }

    @Test("A new notice shows even when the old one was dismissed")
    func replacedNotice() async {
        let clients = StubClients { _ in AnnouncementAnswer(announcement: Self.notice(at: 1_700_000_000)) }
        let model = makeModel(clients)
        await model.load()
        model.dismiss()
        #expect(model.visible == nil)
        clients.setHandler { _ in AnnouncementAnswer(announcement: Self.notice("Back up", at: 1_700_000_500)) }
        await model.load()
        #expect(model.visible?.title == "Back up")
    }

    @Test("A critical notice stays, dismissed or not")
    func criticalStays() async {
        let store = MemoryDismissedStore("1700000000000")
        let clients = StubClients { _ in AnnouncementAnswer(announcement: Self.notice(severity: .critical)) }
        let model = makeModel(clients, store: store)
        await model.load()
        #expect(model.visible != nil)
        model.dismiss()
        #expect(model.visible != nil)
        #expect(store.dismissedID == "1700000000000")
    }

    @Test("When the operator clears the notice it goes away")
    func cleared() async {
        let clients = StubClients { _ in AnnouncementAnswer(announcement: Self.notice()) }
        let model = makeModel(clients)
        await model.load()
        #expect(model.visible != nil)
        clients.setHandler { _ in AnnouncementAnswer(announcement: nil) }
        await model.load()
        #expect(model.visible == nil)
    }

    @Test("A failed load is silent and keeps what was shown; an older Sylo (404) shows nothing")
    func failures() async {
        let clients = StubClients { _ in AnnouncementAnswer(announcement: Self.notice()) }
        let model = makeModel(clients)
        await model.load()
        clients.setHandler { _ in throw NetworkError.offline }
        await model.load()
        #expect(model.visible != nil)
        clients.setHandler { _ in throw NetworkError.notFound }
        await model.load()
        #expect(model.visible == nil)
    }
}
