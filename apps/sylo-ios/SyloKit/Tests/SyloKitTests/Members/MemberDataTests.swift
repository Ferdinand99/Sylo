import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Member data")
struct MemberDataTests {
    /// `GET /member-data?user=`, shaped like the server sends it.
    static let lookupJSON = #"""
        {"lookup":{
           "profile":{"id":"111111111111111111","tag":"alex","avatar":"https://cdn.example.com/a.png"},
           "data":{"items":[
              {"key":"warnings","label":"Moderation cases (kept by /forget)","count":2,"kept":true},
              {"key":"leveling","label":"Leveling record (XP / level / message count)","count":1,"kept":false},
              {"key":"tickets","label":"Modmail tickets they opened","count":0,"kept":false},
              {"key":"invites","label":"Invite records","count":4}],
             "total":7,"erasable":5}},
         "unaffected":"Messages already posted to channels are not affected."}
        """#

    @Test("a lookup decodes the member, the sources and the totals")
    func decodesLookup() throws {
        let answer = try decode(MemberDataAnswer.self, Self.lookupJSON)
        let lookup = try #require(answer.lookup)
        #expect(lookup.profile.id == "111111111111111111")
        #expect(lookup.profile.title == "alex")
        #expect(lookup.profile.avatar?.absoluteString == "https://cdn.example.com/a.png")
        #expect(lookup.data.items.count == 4)
        #expect(lookup.data.total == 7)
        #expect(lookup.data.erasable == 5)
        #expect(lookup.data.items.first?.isKept == true)
        #expect(lookup.data.items.last?.isKept == false)
        #expect(answer.unaffected.hasPrefix("Messages already posted"))
    }

    @Test("only the sources with something in them are listed")
    func filled() throws {
        let lookup = try #require(try decode(MemberDataAnswer.self, Self.lookupJSON).lookup)
        #expect(lookup.data.filled.map(\.key) == ["warnings", "leveling", "invites"])
    }

    @Test("no member asked for is a null lookup")
    func noLookup() throws {
        let answer = try decode(MemberDataAnswer.self, #"{"lookup":null,"unaffected":"x"}"#)
        #expect(answer.lookup == nil)
        #expect(try decode(MemberDataAnswer.self, "{}").lookup == nil)
    }

    @Test("a lookup that is there but cannot be read is an error, not nothing found")
    func malformedLookup() {
        #expect(throws: DecodingError.self) {
            try decode(MemberDataAnswer.self, #"{"lookup":{"profile":"x"},"unaffected":""}"#)
        }
        #expect(throws: DecodingError.self) {
            try decode(MemberDataAnswer.self, #"{"lookup":"x"}"#)
        }
    }

    @Test("an unknown member has no tag and no picture, and reads as unknown")
    func unknownMember() throws {
        let profile = try decode(MemberProfile.self, #"{"id":"111111111111111111","tag":null,"avatar":null}"#)
        #expect(profile.tag == nil)
        #expect(profile.avatar == nil)
        #expect(profile.title == "Unknown member")
    }

    @Test("a picture link that is not https is never kept")
    func avatarMustBeHTTPS() throws {
        let plain = try decode(MemberProfile.self, #"{"id":"1","avatar":"http://cdn.example.com/a.png"}"#)
        #expect(plain.avatar == nil)
        let script = try decode(MemberProfile.self, #"{"id":"1","avatar":"javascript:alert(1)"}"#)
        #expect(script.avatar == nil)
    }

    @Test("a broken source is dropped, missing totals are counted from the sources")
    func tolerant() throws {
        let summary = try decode(MemberDataSummary.self, #"""
            {"items":[{"label":"no key","count":3},{"key":"leveling","count":2},{"key":"x","label":"X","count":"many"}]}
            """#)
        #expect(summary.items.map(\.key) == ["leveling", "x"])
        #expect(summary.items.first?.label == "leveling")
        #expect(summary.total == 2)
        #expect(summary.erasable == 2)
    }

    @Test("the confirmation word is exactly DELETE, as the dashboard compares it")
    func confirmationWord() {
        #expect(MemberForget.isConfirmed("DELETE"))
        #expect(!MemberForget.isConfirmed("delete"))
        #expect(!MemberForget.isConfirmed("Delete"))
        #expect(!MemberForget.isConfirmed(" DELETE "))
        #expect(!MemberForget.isConfirmed(""))
        #expect(!MemberForget.isConfirmed("DELET"))
        #expect(!MemberForget.isConfirmed("RESET"))
    }

    @Test("the reason is optional, trimmed and cut at 500 characters")
    func reasonRules() {
        #expect(MemberForget.cleanedReason("").isEmpty)
        #expect(MemberForget.cleanedReason("  \n ") .isEmpty)
        #expect(MemberForget.cleanedReason("  At their request  ") == "At their request")
        #expect(MemberForget.cleanedReason(String(repeating: "a", count: 900)).count == 500)
    }

    @Test("the notice says whether the member was told")
    func notice() {
        #expect(ForgetMemberResult(dmDelivered: true).message.contains("sent the member a message"))
        #expect(ForgetMemberResult(dmDelivered: false).message.contains("could not message the member"))
    }
}

@MainActor
@Suite("Member data model")
struct MemberDataModelTests {
    let alex = MemberChoice(id: "111111111111111111", name: "Alex")

    /// Answers the lookup (with fewer records after an erasure) and the erasure; records what is sent.
    private final class Server: @unchecked Sendable {
        private let lock = NSLock()
        private var erased = false
        private var forgot: [(userID: String, reason: String)] = []
        var forgets: [(userID: String, reason: String)] { lock.withLock { forgot } }

        func handle(_ endpoint: any APIEndpoint) throws -> Any {
            if endpoint is Endpoints.LookupMemberData {
                let json = lock.withLock { erased } ? MemberDataModelTests.erasedJSON : MemberDataTests.lookupJSON
                return try JSONDecoder().decode(MemberDataAnswer.self, from: Data(json.utf8))
            }
            if let forget = endpoint as? Endpoints.ForgetMemberData {
                lock.withLock {
                    erased = true
                    forgot.append((forget.userID, forget.reason))
                }
                return ForgetMemberResult(dmDelivered: true)
            }
            throw NetworkError.notFound
        }
    }

    nonisolated static let erasedJSON = #"""
        {"lookup":{"profile":{"id":"111111111111111111","tag":"alex"},
          "data":{"items":[{"key":"warnings","label":"Cases","count":2,"kept":true}],"total":2,"erasable":0}},
         "unaffected":"x"}
        """#

    private func make(_ server: Server) -> MemberDataModel {
        let clients = StubClients { try server.handle($0) }
        return MemberDataModel(server: "1", session: makeSignedInSession(clients: clients))
    }

    @Test("looking a member up shows who they are and what is stored")
    func looksUp() async {
        let model = make(Server())
        await model.look(up: alex)
        #expect(model.lookup?.profile.title == "alex")
        #expect(model.lookup?.data.total == 7)
        #expect(model.unaffected.hasPrefix("Messages already posted"))
        #expect(model.errorMessage == nil)
        #expect(!model.isLoading)
    }

    @Test("a refused lookup shows the server's words and no member")
    func refusedLookup() async {
        let clients = StubClients { _ in throw NetworkError.badRequest(message: "“abc” is not a valid user ID or mention.") }
        let model = MemberDataModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.look(up: MemberChoice(id: "abc"))
        #expect(model.lookup == nil)
        #expect(model.errorMessage == "“abc” is not a valid user ID or mention.")
    }

    @Test("a malformed lookup shows an error and no member")
    func malformedLookupModel() async {
        let clients = StubClients { _ in
            try JSONDecoder().decode(MemberDataAnswer.self, from: Data(#"{"lookup":{"profile":1}}"#.utf8))
        }
        let model = MemberDataModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.look(up: alex)
        #expect(model.lookup == nil)
        #expect(model.errorMessage != nil)
    }

    @Test("forgetting needs the typed word and sends nothing without it")
    func needsTypedWord() async {
        let server = Server()
        let model = make(server)
        await model.look(up: alex)
        let done = await model.forget(reason: "At their request", typed: "delet")
        #expect(!done)
        #expect(model.forgetError != nil)
        #expect(server.forgets.isEmpty)
    }

    @Test("forgetting without a reason still goes ahead, with an empty reason")
    func reasonIsOptional() async {
        let server = Server()
        let model = make(server)
        await model.look(up: alex)
        #expect(await model.forget(reason: "   ", typed: "DELETE"))
        #expect(server.forgets.count == 1)
        #expect(server.forgets.first?.reason == "")
        #expect(model.forgetError == nil)
    }

    @Test("forgetting sends the member and the cleaned reason, then reads the counts again")
    func forgets() async {
        let server = Server()
        let model = make(server)
        await model.look(up: alex)
        let done = await model.forget(reason: "  At their request ", typed: "DELETE")
        #expect(done)
        #expect(server.forgets.count == 1)
        #expect(server.forgets.first?.userID == "111111111111111111")
        #expect(server.forgets.first?.reason == "At their request")
        #expect(model.forgetNotice?.contains("Member data deleted") == true)
        #expect(model.lookup?.data.erasable == 0)
        #expect(model.forgetError == nil)
    }

    @Test("a failed erasure keeps the data on screen and says why")
    func failedForget() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LookupMemberData {
                return try JSONDecoder().decode(MemberDataAnswer.self, from: Data(MemberDataTests.lookupJSON.utf8))
            }
            throw NetworkError.forbidden(message: "No access")
        }
        let model = MemberDataModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.look(up: alex)
        let done = await model.forget(reason: "Reason", typed: "DELETE")
        #expect(!done)
        #expect(model.forgetError == "No access")
        #expect(model.lookup?.data.total == 7)
        #expect(model.forgetNotice == nil)
    }

    @Test("forgetting with nobody looked up does nothing")
    func nobody() async {
        let server = Server()
        let model = make(server)
        #expect(!(await model.forget(reason: "Reason", typed: "DELETE")))
        #expect(server.forgets.isEmpty)
    }

    @Test("clearing drops the member, the notice and the errors")
    func clears() async {
        let model = make(Server())
        await model.look(up: alex)
        _ = await model.forget(reason: "Reason", typed: "DELETE")
        model.clear()
        #expect(model.lookup == nil)
        #expect(model.forgetNotice == nil)
        #expect(model.unaffected.isEmpty)
        #expect(model.errorMessage == nil)
    }
}
