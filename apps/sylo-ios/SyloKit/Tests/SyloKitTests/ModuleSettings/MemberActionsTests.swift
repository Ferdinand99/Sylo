import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// Records every call the stub receives and answers each with a fixed value or error.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [any APIEndpoint] = []

    func record(_ endpoint: any APIEndpoint) { lock.withLock { sent.append(endpoint) } }
    var endpoints: [any APIEndpoint] { lock.withLock { sent } }
}

@Suite("Temporary role answers")
struct TempRoleAnswerTests {
    @Test("an add answer reads the end time, the replaced flag and the list")
    func added() throws {
        let added = try decode(TempRoleAdded.self, """
            {"replaced":true,"alreadyHadRole":true,"dm":"sent","expiresAt":1700000000000,
             "list":{"total":1,"matching":1,"rows":[
               {"userId":"1","roleId":"2","member":"Alex","role":"Trial","expiresAt":1700000000000,"reason":""}]}}
            """)
        #expect(added.replaced)
        #expect(added.alreadyHadRole)
        #expect(added.expiresDate == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(added.list.rows.map(\.member) == ["Alex"])
    }

    @Test("an add answer with only the basics still reads")
    func addedMinimal() throws {
        let added = try decode(TempRoleAdded.self, #"{"expiresAt":5000}"#)
        #expect(!added.replaced)
        #expect(added.list.rows.isEmpty)
    }

    @Test("a take-back answer keeps the server's warning, and a null or empty one is no warning")
    func removed() throws {
        let warned = try decode(TempRoleRemoved.self, #"{"roleRemoved":false,"warning":" Sylo could not take it off. ","list":{}}"#)
        #expect(!warned.roleRemoved)
        #expect(warned.warning == "Sylo could not take it off.")
        let none = try decode(TempRoleRemoved.self, #"{"roleRemoved":true,"warning":null}"#)
        #expect(none.warning == nil)
        let empty = try decode(TempRoleRemoved.self, #"{"warning":"  "}"#)
        #expect(empty.warning == nil)
        #expect(empty.roleRemoved)
    }

    @Test("the count answer reads the state, and an unreadable one is no state")
    func countAnswer() throws {
        let answer = try decode(CountingStateAnswer.self, #"{"state":{"current":41,"record":120,"last_user_id":"1"}}"#)
        #expect(answer.state?.current == 41)
        #expect(answer.state?.record == 120)
        #expect(try decode(CountingStateAnswer.self, #"{"state":"nope"}"#).state == nil)
        #expect(try decode(CountingStateAnswer.self, "{}").state == nil)
    }

    @Test("the bonus answer reads the board, and an unreadable one is no board")
    func bonusAnswer() throws {
        let answer = try decode(InviteBonusAnswer.self, """
            {"board":{"total":1,"canReadInvites":true,"rows":[{"rank":1,"userId":"1","name":"Alex","net":6,"regular":5,"leaves":0,"bonus":1}]}}
            """)
        #expect(answer.board?.rows.first?.bonus == 1)
        #expect(try decode(InviteBonusAnswer.self, #"{"board":{"rows":[{"rank":"x"}]}}"#).board == nil)
        #expect(try decode(InviteBonusAnswer.self, "{}").board == nil)
    }

    @Test("a filter is active with text or a role, and spaces alone are not text")
    func filterActive() {
        #expect(!TempRoleFilter().isActive)
        #expect(!TempRoleFilter(text: "   ").isActive)
        #expect(TempRoleFilter(text: "alex").isActive)
        #expect(TempRoleFilter(roleID: "2").isActive)
    }
}

/// What the server answers each tool with, by default.
private func defaultAnswer(_ endpoint: any APIEndpoint) throws -> Any {
    if endpoint is Endpoints.SetCountingCount || endpoint is Endpoints.ResetCountingCount {
        return CountingStateAnswer(state: CountingState(current: 7, record: 9))
    }
    if endpoint is Endpoints.SetInviteBonus { return InviteBonusAnswer(board: nil) }
    return EmptyResponse()
}

@MainActor
@Suite("Member action model")
struct MemberActionModelTests {
    private func make(
        _ answer: @escaping @Sendable (any APIEndpoint) throws -> Any = { try defaultAnswer($0) }
    ) -> (MemberActionModel, Recorder) {
        let recorder = Recorder()
        let clients = StubClients { endpoint in
            recorder.record(endpoint)
            return try answer(endpoint)
        }
        return (MemberActionModel(server: "1", session: makeSignedInSession(clients: clients)), recorder)
    }

    @Test("setting the count sends it and says what it is now")
    func setsCount() async throws {
        let (model, recorder) = make()
        #expect(await model.setCount(41))
        let sent = try #require(recorder.endpoints.first as? Endpoints.SetCountingCount)
        #expect(sent.count == 41)
        #expect(model.notice == "The count is now 41.")
        #expect(model.doneCount == 1)
    }

    @Test("a count outside the limits is refused before any call")
    func refusesBadCount() async {
        let (model, recorder) = make()
        #expect(!(await model.setCount(-1)))
        #expect(!(await model.setCount(MemberActionLimits.count.upperBound + 1)))
        #expect(model.errorMessage != nil)
        #expect(recorder.endpoints.isEmpty)
        #expect(await model.setCount(0))
        #expect(await model.setCount(MemberActionLimits.count.upperBound))
    }

    @Test("resetting the count and releasing a member each make their call")
    func resetsAndReleases() async throws {
        let (model, recorder) = make()
        #expect(await model.resetCount())
        #expect(await model.releasePenalty(userID: "222222222222222222", name: "Sam"))
        #expect(recorder.endpoints.first is Endpoints.ResetCountingCount)
        let release = try #require(recorder.endpoints.last as? Endpoints.ReleaseCountingPenalty)
        #expect(release.userID == "222222222222222222")
        #expect(model.notice == "Sam can count again.")
    }

    @Test("a member who is not benched shows the server's words and no notice")
    func releaseRefused() async {
        let (model, _) = make { _ in throw NetworkError.notFound(message: "That member is not benched.") }
        #expect(!(await model.releasePenalty(userID: "2", name: "Sam")))
        #expect(model.errorMessage == "That member is not benched.")
        #expect(model.notice == nil)
        #expect(model.doneCount == 0)
    }

    @Test("the invite bonus keeps its sign and is held to the limits")
    func inviteBonus() async throws {
        let (model, recorder) = make()
        let alex = MemberChoice(id: "111111111111111111", name: "Alex")
        #expect(await model.setInviteBonus(member: alex, bonus: -5))
        let sent = try #require(recorder.endpoints.first as? Endpoints.SetInviteBonus)
        #expect(sent.bonus == -5)
        #expect(sent.userID == "111111111111111111")
        #expect(model.notice == "Alex now has -5 bonus invites.")
        #expect(!(await model.setInviteBonus(member: alex, bonus: 100_001)))
        #expect(!(await model.setInviteBonus(member: alex, bonus: -100_001)))
        #expect(recorder.endpoints.count == 1)
    }

    @Test("setting XP sends the total, and a negative one is refused")
    func setsXP() async throws {
        let (model, recorder) = make()
        let alex = MemberChoice(id: "111111111111111111", name: "Alex")
        #expect(await model.setXP(member: alex, xp: 1200))
        let sent = try #require(recorder.endpoints.first as? Endpoints.SetMemberXP)
        #expect(sent.xp == 1200)
        #expect(!(await model.setXP(member: alex, xp: -1)))
        #expect(recorder.endpoints.count == 1)
    }

    @Test("the XP reset is its own call with no member in it")
    func resetsXP() async {
        let (model, recorder) = make()
        #expect(await model.resetAllXP())
        #expect(recorder.endpoints.count == 1)
        #expect(recorder.endpoints.first is Endpoints.ResetAllXP)
        #expect(model.notice == "All leveling data is wiped.")
    }

    @Test("a refused XP change (a reward role the person may not give) shows the server's words")
    func xpRefused() async {
        let (model, _) = make { _ in throw NetworkError.forbidden(message: "You cannot give the Admin role.") }
        let alex = MemberChoice(id: "111111111111111111", name: "Alex")
        #expect(!(await model.setXP(member: alex, xp: 99_999)))
        #expect(model.errorMessage == "You cannot give the Admin role.")
    }

    @Test("a count call keeps the state the server answered with, until the page is read again")
    func keepsCountingState() async throws {
        let (model, _) = make()
        #expect(model.countingState == nil)
        #expect(await model.setCount(7))
        #expect(model.countingState == CountingState(current: 7, record: 9))
        model.pageReloaded()
        #expect(model.countingState == nil)
        #expect(await model.resetCount())
        #expect(model.countingState?.current == 7)
    }

    @Test("an answer with no readable state leaves nothing to show, so the screen reads the page")
    func countAnswerWithoutState() async {
        let (model, _) = make { _ in CountingStateAnswer(state: nil) }
        #expect(await model.setCount(5))
        #expect(model.countingState == nil)
    }

    @Test("the bonus call keeps the leaderboard the server answered with")
    func keepsBoard() async throws {
        let board = InviteTrackerBoard(total: 1, rows: [InviteTrackerInviter(rank: 1, userId: "1", name: "Alex", net: 5, bonus: 5)])
        let (model, _) = make { _ in InviteBonusAnswer(board: board) }
        #expect(await model.setInviteBonus(member: MemberChoice(id: "1", name: "Alex"), bonus: 5))
        #expect(model.inviteBoard == board)
        model.pageReloaded()
        #expect(model.inviteBoard == nil)
    }

    @Test("the reset word is RESET, as on the web")
    func resetWord() {
        #expect(MemberActionLimits.resetXPWord == "RESET")
    }
}

@MainActor
@Suite("Temporary roles model")
struct TempRolesModelTests {
    nonisolated static let listJSON = """
        {"list":{"total":2,"matching":1,"rows":[
          {"userId":"1","roleId":"2","member":"Alex","role":"Trial","expiresAt":1700000000000}]}}
        """

    private func make(
        _ answer: @escaping @Sendable (any APIEndpoint) throws -> Any
    ) -> (TempRolesModel, Recorder) {
        let recorder = Recorder()
        let clients = StubClients { endpoint in
            recorder.record(endpoint)
            return try answer(endpoint)
        }
        return (TempRolesModel(server: "1", session: makeSignedInSession(clients: clients)), recorder)
    }

    private let alex = MemberChoice(id: "111111111111111111", name: "Alex")

    @Test("a give is held back until a member, a role and a good duration are set")
    func problems() {
        #expect(TempRolesModel.problem(member: nil, roleID: "2", duration: "7d") == "Pick a member.")
        #expect(TempRolesModel.problem(member: alex, roleID: "", duration: "7d") == "Pick a role.")
        #expect(TempRolesModel.problem(member: alex, roleID: "2", duration: "soon") != nil)
        #expect(TempRolesModel.problem(member: alex, roleID: "2", duration: "30") != nil)
        #expect(TempRolesModel.problem(member: alex, roleID: "2", duration: "1d12h") == nil)
        #expect(TempRolesModel.problem(member: alex, roleID: "2", duration: "366d") != nil)
    }

    @Test("giving a role sends the duration and the trimmed reason, and keeps the list it gets back")
    func gives() async throws {
        let (model, recorder) = make { _ in
            try decode(TempRoleAdded.self, """
                {"replaced":false,"alreadyHadRole":false,"expiresAt":1700000000000,
                 "list":{"total":1,"matching":1,"rows":[{"userId":"111111111111111111","roleId":"2","member":"Alex","role":"Trial","expiresAt":1700000000000}]}}
                """)
        }
        model.filter = TempRoleFilter(text: "alex")
        let ok = await model.give(member: alex, roleID: "2", roleName: "Trial", duration: "7d", reason: "  Trial period ")
        #expect(ok)
        let sent = try #require(recorder.endpoints.first as? Endpoints.AddTempRole)
        #expect(sent.duration == "7d")
        #expect(sent.reason == "Trial period")
        #expect(sent.userID == "111111111111111111")
        #expect(sent.roleID == "2")
        #expect(sent.filter == TempRoleFilter(text: "alex"))
        #expect(model.list?.rows.map(\.member) == ["Alex"])
        #expect(model.lastGiven?.memberName == "Alex")
        #expect(model.lastGiven?.roleName == "Trial")
        #expect(model.lastGiven?.expires == Date(timeIntervalSince1970: 1_700_000_000))
    }

    @Test("a reason longer than the server keeps is cut")
    func cutsReason() async throws {
        let (model, recorder) = make { _ in try decode(TempRoleAdded.self, #"{"expiresAt":1}"#) }
        _ = await model.give(member: alex, roleID: "2", roleName: "Trial", duration: "7d",
                             reason: String(repeating: "x", count: 800))
        let sent = try #require(recorder.endpoints.first as? Endpoints.AddTempRole)
        #expect(sent.reason.count == MemberActionLimits.tempRoleReasonLength)
    }

    @Test("a bad duration is refused before any call, with the server's own wording")
    func refusesBadDuration() async {
        let (model, recorder) = make { _ in EmptyResponse() }
        let ok = await model.give(member: alex, roleID: "2", roleName: "Trial", duration: "1d1d", reason: "")
        #expect(!ok)
        #expect(model.errorMessage?.hasPrefix("Use each unit once") == true)
        #expect(recorder.endpoints.isEmpty)
    }

    @Test("a refused give (a role above the person's own) shows the server's words and no confirmation")
    func giveRefused() async {
        let (model, _) = make { _ in throw NetworkError.forbidden(message: "That role is above your own.") }
        let ok = await model.give(member: alex, roleID: "2", roleName: "Trial", duration: "7d", reason: "")
        #expect(!ok)
        #expect(model.errorMessage == "That role is above your own.")
        #expect(model.lastGiven == nil)
    }

    @Test("taking a role back sends the member and role and keeps the warning")
    func removes() async throws {
        let (model, recorder) = make { _ in
            try decode(TempRoleRemoved.self, #"{"roleRemoved":false,"warning":"Sylo could not take the role off.","list":{"total":0,"matching":0,"rows":[]}}"#)
        }
        let row = TempRoleRow(userId: "111111111111111111", roleId: "2", member: "Alex", role: "Trial", expiresAt: 5)
        #expect(await model.remove(row))
        let sent = try #require(recorder.endpoints.first as? Endpoints.RemoveTempRole)
        #expect(sent.userID == "111111111111111111")
        #expect(sent.roleID == "2")
        #expect(model.removalWarning == "Sylo could not take the role off.")
        #expect(model.list?.rows.isEmpty == true)
    }

    @Test("applying a filter asks for it, and the page's list is replaced")
    func appliesFilter() async throws {
        let (model, recorder) = make { _ in try decode(TempRoleListAnswer.self, Self.listJSON) }
        model.filter = TempRoleFilter(text: "alex", roleID: "2")
        await model.applyFilter()
        let sent = try #require(recorder.endpoints.first as? Endpoints.TempRoleListing)
        #expect(sent.filter == TempRoleFilter(text: "alex", roleID: "2"))
        #expect(model.list?.matching == 1)
    }

    @Test("when the page is read again, the fetched list is dropped, and fetched again only under a filter")
    func pageReloaded() async {
        let (model, recorder) = make { _ in try decode(TempRoleListAnswer.self, Self.listJSON) }
        await model.applyFilter()
        #expect(model.list != nil)
        await model.pageReloaded()
        #expect(model.list == nil)
        #expect(recorder.endpoints.count == 1)
        model.filter = TempRoleFilter(text: "alex")
        await model.pageReloaded()
        #expect(model.list != nil)
        #expect(recorder.endpoints.count == 2)
    }

    @Test("a failed filter explains and keeps the list that was on screen")
    func filterFails() async {
        let (model, _) = make { _ in throw NetworkError.offline }
        model.filter = TempRoleFilter(text: "alex")
        await model.applyFilter()
        #expect(model.errorMessage != nil)
        #expect(model.list == nil)
    }
}
