import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func value(_ json: String) throws -> JSONValue { try decode(JSONValue.self, json) }

private func object(_ json: String) throws -> [String: JSONValue] {
    guard case .object(let fields) = try value(json) else { return [:] }
    return fields
}

@Suite("Config diff")
struct ConfigDiffTests {
    @Test("A changed setting shows its readable name, before and after")
    func changed() throws {
        let result = ConfigDiff.rows(before: try object(#"{"channelId":"1","enabled":false}"#),
                                     after: try object(#"{"channelId":"2","enabled":false}"#))
        #expect(result.rows.count == 1)
        #expect(result.rows[0].pathText == "Channel")
        #expect(result.rows[0].kind == .changed(before: .string("1"), after: .string("2")))
        #expect(result.more == 0)
    }

    @Test("A setting the server has no label for shows its own key")
    func rawKey() throws {
        let rows = ConfigDiff.rows(before: try object(#"{"someNewThing":1}"#), after: try object(#"{"someNewThing":2}"#)).rows
        #expect(rows[0].pathText == "someNewThing")
        #expect(ConfigDiff.label(for: "joinMessage") == "Welcome message")
    }

    @Test("Added and removed settings")
    func addedRemoved() throws {
        let rows = ConfigDiff.rows(before: try object(#"{"a":1}"#), after: try object(#"{"b":2}"#)).rows
        #expect(rows.count == 2)
        #expect(rows[0].kind == .removed(.int(1)))
        #expect(rows[1].kind == .added(.int(2)))
    }

    @Test("A list of plain values shows what was added and removed")
    func plainList() throws {
        let rows = ConfigDiff.rows(before: try object(#"{"ignoreRoles":["1","2"]}"#),
                                   after: try object(#"{"ignoreRoles":["2","3"]}"#)).rows
        #expect(rows[0].kind == .list(added: [.string("3")], removed: [.string("1")]))
        #expect(rows[0].pathText == "Ignored roles")
    }

    @Test("The same items in another order are one change")
    func reordered() throws {
        let rows = ConfigDiff.rows(before: try object(#"{"roles":["1","2"]}"#), after: try object(#"{"roles":["2","1"]}"#)).rows
        #expect(rows.count == 1)
        if case .changed = rows[0].kind {} else { Issue.record("expected a changed row") }
    }

    @Test("Items with an id are matched by it, so one removed does not change the rest")
    func itemsById() throws {
        let before = try object(#"{"rules":[{"id":"a","name":"One","channel":"1"},{"id":"b","name":"Two","channel":"2"}]}"#)
        let after = try object(#"{"rules":[{"id":"b","name":"Two","channel":"3"},{"id":"c","name":"Three","channel":"4"}]}"#)
        let rows = ConfigDiff.rows(before: before, after: after).rows
        #expect(rows.map(\.pathText) == ["Rules \u{203A} Two \u{203A} Channel", "Rules \u{203A} Three", "Rules \u{203A} One"])
        #expect(rows[0].kind == .changed(before: .string("2"), after: .string("3")))
        if case .added = rows[1].kind {} else { Issue.record("expected an added row") }
        if case .removed = rows[2].kind {} else { Issue.record("expected a removed row") }
    }

    @Test("Items without an id leave out the ones that are the same on both sides")
    func itemsWithoutId() throws {
        let before = try object(#"{"stickies":[{"text":"a"},{"text":"b"}]}"#)
        let after = try object(#"{"stickies":[{"text":"b"}]}"#)
        let rows = ConfigDiff.rows(before: before, after: after).rows
        #expect(rows.count == 1)
        if case .removed = rows[0].kind {} else { Issue.record("expected a removed row") }
    }

    @Test("Equal sides give no rows, and a side that only differs in a secret is hidden")
    func equalAndHidden() throws {
        #expect(ConfigDiff.rows(before: try object(#"{"a":1}"#), after: try object(#"{"a":1}"#)).rows.count == 1)
        let rows = ConfigDiff.rows(before: try object(#"{"a":1}"#), after: try object(#"{"a":1}"#)).rows
        #expect(rows[0].kind == .hidden)
    }

    @Test("At most sixty rows are shown and the rest are counted")
    func capped() throws {
        let many = (0..<70).map { "\"k\($0)\":1" }.joined(separator: ",")
        let more = (0..<70).map { "\"k\($0)\":2" }.joined(separator: ",")
        let result = ConfigDiff.rows(before: try object("{\(many)}"), after: try object("{\(more)}"))
        #expect(result.rows.count == ConfigDiff.maxRows)
        #expect(result.more == 10)
    }

    @Test("Values read as the dashboard words them")
    func format() {
        let names = ["1": "#general"]
        #expect(ConfigDiff.format(nil) == "(not set)")
        #expect(ConfigDiff.format(.null) == "(empty)")
        #expect(ConfigDiff.format(.string("")) == "(empty)")
        #expect(ConfigDiff.format(.bool(true)) == "On")
        #expect(ConfigDiff.format(.bool(false)) == "Off")
        #expect(ConfigDiff.format(.int(5)) == "5")
        #expect(ConfigDiff.format(.double(1.5)) == "1.5")
        #expect(ConfigDiff.format(.double(2)) == "2")
        #expect(ConfigDiff.format(.string("1"), names: names) == "#general")
        #expect(ConfigDiff.format(.string(ConfigDiff.mask)) == "\(ConfigDiff.mask) (hidden)")
        #expect(ConfigDiff.format(.array([])) == "(empty list)")
        #expect(ConfigDiff.format(.array([.string("1"), .string("x")]), names: names) == "#general, x")
        let seven = JSONValue.array((1...7).map { .int($0) })
        #expect(ConfigDiff.format(seven) == "1, 2, 3, 4, 5, 6 and 1 more")
        let long = String(repeating: "a", count: 250)
        #expect(ConfigDiff.format(.string(long)).count == 201)
        #expect(ConfigDiff.format(.object(["a": .int(1)])) == #"{"a":1}"#)
    }
}

@Suite("Audit history")
struct AuditHistoryDecodingTests {
    static let changeJSON = #"""
        {"entry":{"id":7,"actor":"Ferdi (dashboard)","action":"module:welcome","detail":"saved","at":1700000000000,"ago":"1d","revertsId":null},
         "kind":"module","before":{"joinChannel":"1"},"after":{"joinChannel":"2"},"names":{"1":"#old","2":"#new"},
         "undo":{"available":true,"reason":null,"state":"changed","laterChanges":["joinChannel"],"token":"abc123",
                 "notRestored":[{"key":"autoroleEnabled","reason":"it goes with the Roles page"}],"droppedSecrets":["feeds"]}}
        """#

    @Test("An entry from a 5.2 server says it kept its change; a 5.1 entry does not")
    func entryFlags() throws {
        let page = try decode(AuditLogPage.self, #"""
            {"kept":500,"hasMore":true,"actions":[{"action":"module:welcome","count":3}],"entries":[
              {"id":9,"actor":"A","action":"module:welcome","at":2000,"hasChange":true,"revertsId":4},
              {"id":8,"actor":"A","action":"settings:server","at":1000}]}
            """#)
        #expect(page.hasMore)
        #expect(page.actions == [AuditActionCount(action: "module:welcome", count: 3)])
        #expect(page.entries[0].hasChange)
        #expect(page.entries[0].revertsID == "4")
        #expect(!page.entries[1].hasChange)
        #expect(page.entries[1].revertsID == nil)
        let old = try decode(AuditLogPage.self, #"{"kept":500,"entries":[{"id":1,"actor":"A","action":"x","at":1}]}"#)
        #expect(!old.hasMore)
        #expect(old.actions.isEmpty)
        #expect(!old.entries[0].hasChange)
    }

    @Test("The change view reads before, after, names and the undo state")
    func change() throws {
        let change = try decode(AuditChange.self, Self.changeJSON)
        #expect(change.kind == "module")
        #expect(!change.isTooLarge)
        #expect(change.before == ["joinChannel": .string("1")])
        #expect(change.names["2"] == "#new")
        let undo = change.undo
        #expect(undo.isAvailable)
        #expect(undo.state == .changed)
        #expect(undo.needsConfirmation)
        #expect(undo.laterChanges == ["joinChannel"])
        #expect(undo.token == "abc123")
        #expect(undo.notRestored == [AuditNotRestored(key: "autoroleEnabled", reason: "it goes with the Roles page")])
        #expect(undo.droppedSecrets == ["feeds"])
        #expect(change.diff.rows.count == 1)
    }

    @Test("A change that was too large has no diff and no undo")
    func tooLarge() throws {
        let change = try decode(AuditChange.self, #"""
            {"entry":{"id":1},"tooLarge":true,"undo":{"available":false,"reason":"This change was too large to keep a copy of."}}
            """#)
        #expect(change.isTooLarge)
        #expect(!change.undo.isAvailable)
        #expect(change.undo.reason == "This change was too large to keep a copy of.")
        #expect(change.diff.rows.isEmpty)
    }

    @Test("A clean entry needs no confirmation")
    func clean() throws {
        let undo = try decode(AuditUndoInfo.self, #"{"available":true,"state":"clean"}"#)
        #expect(!undo.needsConfirmation)
        let reverted = try decode(AuditUndoInfo.self, #"{"available":false,"state":"reverted","reason":"The settings already have the earlier values."}"#)
        #expect(!reverted.needsConfirmation)
    }

    @Test("The undo answer is worded like the dashboard")
    func result() throws {
        let plain = try decode(AuditUndoResult.self, #"{"ok":true,"adjusted":[],"notRestored":[]}"#)
        #expect(plain.summary == "Change undone.")
        let notes = try decode(AuditUndoResult.self, #"{"ok":true,"adjusted":["cooldownSeconds"],"notRestored":["autoroleEnabled"]}"#)
        #expect(notes.summary == "Change undone. Some settings are not exactly as before: Cooldown (seconds). Left as they are: Give auto-roles.")
    }

    @Test("The calls go where the server expects, and the undo always sends confirm and token")
    func endpoints() throws {
        #expect(Endpoints.LoadAuditChange(server: "fluxer:9", entry: "7").path == "/api/v2/guilds/fluxer%3A9/audit/7/change")
        let undo = Endpoints.UndoAuditChange(server: "1", entry: "7", confirm: true, token: "abc")
        #expect(undo.path == "/api/v2/guilds/1/audit/7/undo")
        #expect(undo.method == .post)
        let body = try #require(undo.body)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(json["confirm"] as? Bool == true)
        #expect(json["token"] as? String == "abc")
        #expect(Endpoints.AuditLog(server: "1").query.isEmpty)
        #expect(Endpoints.AuditLog(server: "1", before: "5", action: "module:welcome").query
            == [URLQueryItem(name: "before", value: "5"), URLQueryItem(name: "action", value: "module:welcome")])
        #expect(Endpoints.AuditLog(server: "1", action: "").query.isEmpty)
    }
}

@MainActor
@Suite("Audit history model")
struct AuditChangeModelTests {
    nonisolated static let changed = try! decode(AuditChange.self, AuditHistoryDecodingTests.changeJSON)
    nonisolated static let clean = try! decode(AuditChange.self, #"""
        {"kind":"module","before":{"a":1},"after":{"a":2},"undo":{"available":true,"state":"clean"}}
        """#)

    @Test("Show changes loads the diff once")
    func loads() async {
        let clients = StubClients { _ in Self.clean }
        let model = AuditChangeModel(server: "1", entry: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        await model.load()
        #expect(model.change == Self.clean)
        #expect(clients.calls.count == 1)
    }

    @Test("A clean entry is undone without a confirmation")
    func undoClean() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.UndoAuditChange { return AuditUndoResult() }
            return Self.clean
        }
        let model = AuditChangeModel(server: "1", entry: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.undo(confirmed: false))
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.UndoAuditChange }.first)
        #expect(!sent.confirm)
        #expect(sent.token == "")
        #expect(model.doneMessage == "Change undone.")
        #expect(model.undoCount == 1)
    }

    @Test("When the settings changed since, the undo carries the confirmation and the token the view gave")
    func undoChangedSince() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.UndoAuditChange { return AuditUndoResult() }
            return Self.changed
        }
        let model = AuditChangeModel(server: "1", entry: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.change?.undo.needsConfirmation == true)
        #expect(await model.undo(confirmed: true))
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.UndoAuditChange }.first)
        #expect(sent.confirm)
        #expect(sent.token == "abc123")
    }

    @Test("A 409 reads the change again and asks the person to look once more")
    func conflict() async {
        let moved = try! decode(AuditChange.self, #"""
            {"kind":"module","before":{"a":1},"after":{"a":2},
             "undo":{"available":true,"state":"changed","laterChanges":["a"],"token":"fresh"}}
            """#)
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.UndoAuditChange {
                throw NetworkError.http(status: HTTPStatus(409, message: "These settings were changed again after this entry."))
            }
            return Self.clean
        }
        let model = AuditChangeModel(server: "1", entry: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { endpoint in
            if endpoint is Endpoints.UndoAuditChange {
                throw NetworkError.http(status: HTTPStatus(409, message: "These settings were changed again after this entry."))
            }
            return moved
        }
        #expect(await model.undo(confirmed: false) == false)
        #expect(model.change?.undo.token == "fresh")
        #expect(model.undoError?.contains("changed again") == true)
        #expect(model.undoCount == 0)
    }

    @Test("A person without Edit is refused by the server, with its words")
    func viewOnly() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.UndoAuditChange {
                throw NetworkError.forbidden(message: "Your dashboard access in this server is View only, so you can't do this.")
            }
            return Self.clean
        }
        let model = AuditChangeModel(server: "1", entry: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.undo(confirmed: false) == false)
        #expect(model.undoError?.contains("View only") == true)
    }

    @Test("An entry with no saved change says so")
    func missing() async {
        let clients = StubClients { _ in throw NetworkError.notFound(message: "That entry has no saved change.") }
        let model = AuditChangeModel(server: "1", entry: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.phase == .failed("That entry has no saved change."))
        #expect(!(await model.undo(confirmed: false)))
    }

    @Test("Nothing to undo when it is not available")
    func unavailable() async {
        let reverted = try! decode(AuditChange.self, #"{"undo":{"available":false,"state":"reverted","reason":"The settings already have the earlier values."}}"#)
        let clients = StubClients { _ in reverted }
        let model = AuditChangeModel(server: "1", entry: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!(await model.undo(confirmed: true)))
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.UndoAuditChange })
    }
}

@MainActor
@Suite("Audit log paging")
struct AuditLogPagingTests {
    nonisolated static func page(_ ids: [Int], hasMore: Bool) -> AuditLogPage {
        AuditLogPage(entries: ids.map { AuditEntry(id: String($0), actor: "A", action: "x", date: Date(timeIntervalSince1970: Double($0))) },
                     hasMore: hasMore, actions: [AuditActionCount(action: "x", count: 5)])
    }

    @Test("Show more asks for the entries before the last one shown and adds them")
    func more() async throws {
        let clients = StubClients { endpoint in
            guard let log = endpoint as? Endpoints.AuditLog else { throw NetworkError.notFound }
            return log.before == nil ? Self.page([5, 4], hasMore: true) : Self.page([3, 2], hasMore: false)
        }
        let model = AuditLogModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.page?.hasMore == true)
        await model.loadMore()
        #expect(model.page?.entries.map(\.id) == ["5", "4", "3", "2"])
        #expect(model.page?.hasMore == false)
        let asked = clients.calls.compactMap { $0.endpoint as? Endpoints.AuditLog }
        #expect(asked.last?.before == "4")
    }

    @Test("The filter is sent and a filter the server does not list stays pickable")
    func filter() async {
        let clients = StubClients { _ in Self.page([1], hasMore: false) }
        let model = AuditLogModel(server: "1", session: makeSignedInSession(clients: clients))
        model.filter = "module:welcome"
        await model.load()
        let asked = clients.calls.compactMap { $0.endpoint as? Endpoints.AuditLog }
        #expect(asked.first?.action == "module:welcome")
        #expect(model.filterChoices.map(\.action) == ["x", "module:welcome"])
    }
}
