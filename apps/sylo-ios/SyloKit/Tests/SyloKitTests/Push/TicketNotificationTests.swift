import Foundation
import Testing
@testable import SyloKit

@Suite("Ticket notification")
struct TicketNotificationTests {
    static func userInfo(
        kind: Any = "ticket", server: Any = "https://sylo.example.com", guildId: Any = "fluxer:1",
        ticketId: Any = 12
    ) -> [AnyHashable: Any] {
        [
            "aps": ["alert": ["title": "Alpha", "body": "member: Hi"], "thread-id": "fluxer:1:12"],
            "sylo": ["kind": kind, "server": server, "guildId": guildId, "ticketId": ticketId],
        ]
    }

    @Test("A ticket notification names its Sylo server, the server and the ticket")
    func parses() throws {
        let note = try #require(TicketNotification(userInfo: Self.userInfo()))
        #expect(note.server == (try ServerURL("https://sylo.example.com")))
        #expect(note.guildID == "fluxer:1")
        #expect(note.ticketID == 12)
    }

    @Test("A ticket id sent as a number object or a string still reads")
    func numberShapes() throws {
        #expect(TicketNotification(userInfo: Self.userInfo(ticketId: NSNumber(value: 7)))?.ticketID == 7)
        #expect(TicketNotification(userInfo: Self.userInfo(ticketId: "8"))?.ticketID == 8)
    }

    @Test("Anything that isn't a whole ticket notification is nil")
    func rejects() {
        #expect(TicketNotification(userInfo: [:]) == nil)
        #expect(TicketNotification(userInfo: ["aps": ["alert": "Hi"]]) == nil)
        #expect(TicketNotification(userInfo: ["sylo": "ticket"]) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(kind: "appeal")) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(server: "not a server")) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(server: "http://example.com")) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(server: 5)) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(guildId: "")) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(guildId: 1)) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(ticketId: 0)) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(ticketId: -3)) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(ticketId: "twelve")) == nil)
        #expect(TicketNotification(userInfo: Self.userInfo(ticketId: 1.5)) == nil)
    }

    @Test("It matches the Sylo server it came from, however that address is spelled")
    func matches() throws {
        let note = try #require(TicketNotification(userInfo: Self.userInfo(server: "https://Sylo.Example.com:443/")))
        #expect(note.matches(try ServerURL("sylo.example.com")))
        #expect(!note.matches(try ServerURL("other.example.com")))
        #expect(!note.matches(try ServerURL("sylo.example.com/sub")))
        #expect(!note.matches(.hosted))

        let hosted = try #require(TicketNotification(userInfo: Self.userInfo(server: "https://app.sylobot.com")))
        #expect(hosted.matches(.hosted))
    }
}
