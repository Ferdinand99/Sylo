import Foundation
import Testing
@testable import SyloKit

/// Answers shaped like `src/web/routes/v2Staff.js` sends them, from a current server (with the
/// epoch-ms `lastAt`/`openedAt`/`at` fields) and from an older one (without them).
enum TicketFixtures {
    static let list = #"""
    {
      "open": [
        {"id": 12, "user": "ferdi", "userId": "123456789012345678", "preview": "Hi, I can't post",
         "previewKind": "user", "ago": "5m ago", "lastAt": 1760000000000, "unread": true},
        {"id": 11, "user": "223456789012345678", "userId": "223456789012345678", "preview": "",
         "previewKind": null, "ago": "2h ago", "lastAt": 1759990000000, "unread": false},
        {"user": "broken, no id"}
      ],
      "closed": [
        {"id": 3, "user": "sam", "userId": "323456789012345678", "preview": "Ticket closed",
         "previewKind": "bot", "ago": "3d ago", "unread": false}
      ]
    }
    """#

    static let thread = #"""
    {
      "ticket": {"id": 12, "status": "open", "user": "ferdi", "userId": "123456789012345678",
                 "openedAgo": "1h ago", "openedAt": 1759996400000},
      "messages": [
        {"id": 40, "kind": "user", "who": "ferdi", "content": "Hi, I can't post",
         "attachments": ["https://cdn.discordapp.com/attachments/1/2/screenshot.png", "", 7],
         "delivered": true, "ago": "1h ago", "at": 1759996400000},
        {"id": 41, "kind": "staff", "who": "Staff", "content": "Looking into it",
         "attachments": [], "delivered": false, "ago": "50m ago", "at": 1759997000000},
        {"id": 42, "kind": "system", "who": "System", "content": "Ticket reopened",
         "attachments": [], "delivered": true, "ago": "10m ago", "at": 1759999400000}
      ],
      "lastId": 42
    }
    """#

    static let olderThread = #"""
    {
      "ticket": {"id": 7, "status": "archived", "user": "ferdi", "userId": "1", "openedAgo": "2d ago"},
      "messages": [
        {"id": 5, "kind": "bot", "who": "System", "content": "Hello", "attachments": [],
         "delivered": true, "ago": "2d ago"}
      ],
      "lastId": 5
    }
    """#

    static let update = #"""
    {"status": "closed", "messages": [
      {"id": 43, "kind": "staff", "who": "Staff", "content": "Closing this now", "attachments": [],
       "delivered": true, "ago": "0s ago", "at": 1760000000000}
    ]}
    """#

    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
}

@Suite("Ticket decoding")
struct TicketDecodingTests {
    @Test("The ticket list, with times, unread flags and an entry it can't read dropped")
    func list() throws {
        let list = try TicketFixtures.decode(TicketList.self, TicketFixtures.list)
        #expect(list.open.map(\.id) == [12, 11])
        let first = try #require(list.open.first)
        #expect(first.user == "ferdi")
        #expect(first.userId == "123456789012345678")
        #expect(first.preview == "Hi, I can't post")
        #expect(first.previewKind == .user)
        #expect(first.ago == "5m ago")
        #expect(first.lastAt == Date(timeIntervalSince1970: 1_760_000_000))
        #expect(first.isUnread)
        #expect(list.open[1].previewKind == nil)
        #expect(!list.open[1].isUnread)
    }

    @Test("A ticket from an older server has no time, and an unknown author kind is kept")
    func olderSummary() throws {
        let closed = try #require(try TicketFixtures.decode(TicketList.self, TicketFixtures.list).closed.first)
        #expect(closed.lastAt == nil)
        #expect(closed.ago == "3d ago")
        #expect(closed.previewKind == .other("bot"))
    }

    @Test("A ticket's thread: the ticket, its messages and attachments")
    func thread() throws {
        let thread = try TicketFixtures.decode(TicketThread.self, TicketFixtures.thread)
        #expect(thread.ticket.id == 12)
        #expect(thread.ticket.status == .open)
        #expect(thread.ticket.user == "ferdi")
        #expect(thread.ticket.userId == "123456789012345678")
        #expect(thread.ticket.openedAgo == "1h ago")
        #expect(thread.ticket.openedAt == Date(timeIntervalSince1970: 1_759_996_400))
        #expect(thread.lastId == 42)
        #expect(thread.messages.map(\.kind) == [.user, .staff, .system])

        let first = try #require(thread.messages.first)
        #expect(first.id == 40)
        #expect(first.who == "ferdi")
        #expect(first.content == "Hi, I can't post")
        #expect(first.attachments == [URL(string: "https://cdn.discordapp.com/attachments/1/2/screenshot.png")!])
        #expect(first.isDelivered)
        #expect(first.ago == "1h ago")
        #expect(first.at == Date(timeIntervalSince1970: 1_759_996_400))
        #expect(!thread.messages[1].isDelivered)
    }

    @Test("A thread from an older server: no times, unknown status and kind kept")
    func olderThread() throws {
        let thread = try TicketFixtures.decode(TicketThread.self, TicketFixtures.olderThread)
        #expect(thread.ticket.status == .other("archived"))
        #expect(thread.ticket.openedAt == nil)
        #expect(thread.messages.first?.kind == .other("bot"))
        #expect(thread.messages.first?.at == nil)
    }

    @Test("New messages with the ticket's status")
    func update() throws {
        let update = try TicketFixtures.decode(TicketUpdate.self, TicketFixtures.update)
        #expect(update.status == .closed)
        #expect(update.messages.map(\.id) == [43])
    }

    @Test("A reply's answer says whether the member got it")
    func replyResult() throws {
        let delivered = try TicketFixtures.decode(TicketReplyResult.self, #"{"ok": true, "delivered": true}"#)
        #expect(delivered.ok)
        #expect(delivered.isDelivered)
        let kept = try TicketFixtures.decode(TicketReplyResult.self, #"{"ok": true, "delivered": false}"#)
        #expect(!kept.isDelivered)
    }

    @Test("Statuses and author kinds read from their strings")
    func openEnums() throws {
        let kinds = try TicketFixtures.decode([TicketAuthorKind].self, #"["user","staff","system","bot"]"#)
        #expect(kinds == [.user, .staff, .system, .other("bot")])
        let statuses = try TicketFixtures.decode([TicketStatus].self, #"["open","closed","x"]"#)
        #expect(statuses == [.open, .closed, .other("x")])
        #expect(TicketAuthorKind.other("bot").rawValue == "bot")
        #expect(TicketStatus.closed.rawValue == "closed")
    }
}
