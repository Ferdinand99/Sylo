import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the member tools and the small module gaps put on the wire, through the real client and the
// mock URL protocol: method, path, query and body keys, and the files the exports download. They
// extend `APIClientTests` so they run one after another: the mock's state is shared.
extension APIClientTests {
    private func toolsClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func toolsBody(_ request: RecordedRequest) throws -> [String: Any] {
        let body = try #require(request.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private var base: String { "https://example.com/sylo/api/v2/guilds/1" }

    // MARK: Counting, invite bonus, XP

    @Test("Counting: set sends current, reset sends only reset, release sends the member")
    func countingOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, """
            {"state":{"guild_id":"1","current":41,"record":120,"last_user_id":"222222222222222222",
                      "last_message_id":"333333333333333333","updated_at":1700000000000}}
            """)])
        let client = try toolsClient()
        let set = try await client.send(Endpoints.SetCountingCount(server: "1", count: 41))
        #expect(set.state?.current == 41)
        #expect(set.state?.lastUserId == "222222222222222222")
        _ = try await client.send(Endpoints.ResetCountingCount(server: "1"))
        _ = try await client.send(Endpoints.ReleaseCountingPenalty(server: "1", userID: "111111111111111111"))

        let requests = mock.requests
        #expect(requests.count == 3)
        for request in requests.prefix(2) {
            #expect(request.url.absoluteString == "\(base)/modules/counting/count")
            #expect(request.method == "POST")
            #expect(request.header("Authorization") == "Bearer sylo_secret")
        }
        let setBody = try toolsBody(requests[0])
        #expect(Set(setBody.keys) == ["current"])
        #expect(setBody["current"] as? Int == 41)
        let reset = try toolsBody(requests[1])
        #expect(Set(reset.keys) == ["reset"])
        #expect(reset["reset"] as? Bool == true)
        #expect(requests[2].url.absoluteString == "\(base)/modules/counting/penalty/release")
        #expect(requests[2].method == "POST")
        let release = try toolsBody(requests[2])
        #expect(Set(release.keys) == ["userId"])
        #expect(release["userId"] as? String == "111111111111111111")
    }

    @Test("Invite tracker: the bonus goes as userId and bonus, a negative one stays negative")
    func inviteBonusOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"board":{"total":0,"canReadInvites":true,"rows":[]}}"#)])
        _ = try await toolsClient().send(Endpoints.SetInviteBonus(server: "1", userID: "111111111111111111", bonus: -3))
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "\(base)/modules/invite-tracker/bonus")
        #expect(request.method == "POST")
        let body = try toolsBody(request)
        #expect(Set(body.keys) == ["userId", "bonus"])
        #expect(body["bonus"] as? Int == -3)
    }

    @Test("Leveling: set XP sends userId and xp; the reset body is only reset: true and has no userId")
    func xpOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true}"#)])
        let client = try toolsClient()
        _ = try await client.send(Endpoints.SetMemberXP(server: "1", userID: "111111111111111111", xp: 5000))
        _ = try await client.send(Endpoints.ResetAllXP(server: "1"))

        let requests = mock.requests
        for request in requests {
            #expect(request.url.absoluteString == "\(base)/modules/leveling/xp")
            #expect(request.method == "POST")
        }
        let set = try toolsBody(requests[0])
        #expect(Set(set.keys) == ["userId", "xp"])
        #expect(set["xp"] as? Int == 5000)
        let reset = try toolsBody(requests[1])
        #expect(Set(reset.keys) == ["reset"])
        #expect(reset["reset"] as? Bool == true)
    }

    @Test("A refused tool comes back as the server's own words")
    func toolRefusedOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(404, #"{"error":"That member is not benched."}"#)])
        do {
            _ = try await toolsClient().send(Endpoints.ReleaseCountingPenalty(server: "1", userID: "111111111111111111"))
            Issue.record("the refusal should have thrown")
        } catch {
            #expect(NetworkError(error).userMessage == "That member is not benched.")
        }
    }

    // MARK: Temporary roles

    @Test("Temp roles: the list leaves out an empty filter, and sends q and roleId when set")
    func tempRoleListOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"list":{"total":2,"matching":1,"rows":[]}}"#)])
        let client = try toolsClient()
        _ = try await client.send(Endpoints.TempRoleListing(server: "1"))
        let answer = try await client.send(
            Endpoints.TempRoleListing(server: "1", filter: TempRoleFilter(text: "  alex ", roleID: "222222222222222222")))
        #expect(answer.list.matching == 1)

        let requests = mock.requests
        #expect(requests[0].url.absoluteString == "\(base)/modules/temp-roles/list")
        #expect(requests[0].method == "GET")
        #expect(requests[1].url.absoluteString == "\(base)/modules/temp-roles/list?q=alex&roleId=222222222222222222")
    }

    @Test("Temp roles: give sends member, role, duration, reason and the filter; take back sends member and role")
    func tempRoleActionsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, #"{"replaced":false,"alreadyHadRole":false,"expiresAt":1700000000000,"list":{"total":1,"matching":1,"rows":[]}}"#),
            .json(200, #"{"roleRemoved":true,"warning":null,"list":{"total":0,"matching":0,"rows":[]}}"#),
        ])
        let client = try toolsClient()
        let filter = TempRoleFilter(text: "alex", roleID: "")
        let added = try await client.send(Endpoints.AddTempRole(
            server: "1", userID: "111111111111111111", roleID: "222222222222222222", duration: "7d",
            reason: "Trial", filter: filter))
        #expect(added.expiresDate == Date(timeIntervalSince1970: 1_700_000_000))
        let removed = try await client.send(Endpoints.RemoveTempRole(
            server: "1", userID: "111111111111111111", roleID: "222222222222222222", filter: filter))
        #expect(removed.roleRemoved)

        let requests = mock.requests
        #expect(requests[0].url.absoluteString == "\(base)/modules/temp-roles/add")
        #expect(requests[0].method == "POST")
        let add = try toolsBody(requests[0])
        #expect(Set(add.keys) == ["userId", "roleId", "duration", "reason", "filter"])
        #expect(add["duration"] as? String == "7d")
        let addFilter = try #require(add["filter"] as? [String: Any])
        #expect(Set(addFilter.keys) == ["q", "roleId"])
        #expect(addFilter["q"] as? String == "alex")

        #expect(requests[1].url.absoluteString == "\(base)/modules/temp-roles/remove")
        #expect(requests[1].method == "POST")
        let remove = try toolsBody(requests[1])
        #expect(Set(remove.keys) == ["userId", "roleId", "filter"])
    }

    // MARK: Test messages

    @Test("A test message is a body-less POST to the module's test route, and each answer reads")
    func moduleTestOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, #"{"ok":true,"channelName":"welcome"}"#),
            .json(200, #"{"ok":false,"reason":"no-channel"}"#),
            .json(200, #"{"ok":false,"reason":"send-failed"}"#),
            .json(400, #"{"error":"This module has no test message."}"#),
        ])
        let client = try toolsClient()
        let sent = try await client.send(Endpoints.SendModuleTest(server: "1", module: "welcome"))
        #expect(sent.isSent)
        #expect(sent.message == "Test sent to #welcome.")
        let none = try await client.send(Endpoints.SendModuleTest(server: "1", module: "birthdays"))
        #expect(none.failure == .noChannel)
        let failed = try await client.send(Endpoints.SendModuleTest(server: "1", module: "starboard"))
        #expect(failed.failure == .sendFailed)
        do {
            _ = try await client.send(Endpoints.SendModuleTest(server: "1", module: "afk"))
            Issue.record("a module with no test message should be refused")
        } catch {
            #expect(NetworkError(error).userMessage == "This module has no test message.")
        }

        let requests = mock.requests
        #expect(requests[0].url.absoluteString == "\(base)/modules/welcome/test")
        #expect(requests[0].method == "POST")
        #expect(requests[0].body == nil || requests[0].body?.isEmpty == true)
        #expect(requests[1].url.absoluteString == "\(base)/modules/birthdays/test")
        #expect(requests[3].url.absoluteString == "\(base)/modules/afk/test")
    }

    // MARK: Member data

    @Test("Member data: the lookup asks for the user, the erasure sends the confirmation and the reason")
    func memberDataOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, MemberDataTests.lookupJSON),
            .json(200, #"{"ok":true,"userId":"111111111111111111","dmDelivered":false,"result":{"leveling":2}}"#),
        ])
        let client = try toolsClient()
        let answer = try await client.send(Endpoints.LookupMemberData(server: "1", userID: "111111111111111111"))
        #expect(answer.lookup?.profile.id == "111111111111111111")
        let result = try await client.send(Endpoints.ForgetMemberData(
            server: "1", userID: "111111111111111111", reason: "At their request"))
        #expect(!result.dmDelivered)

        let requests = mock.requests
        #expect(requests[0].url.absoluteString == "\(base)/member-data?user=111111111111111111")
        #expect(requests[0].method == "GET")
        #expect(requests[1].url.absoluteString == "\(base)/member-data/forget")
        #expect(requests[1].method == "POST")
        let body = try toolsBody(requests[1])
        #expect(Set(body.keys) == ["userId", "reason", "confirm"])
        #expect(body["confirm"] as? Bool == true)
        #expect(body["reason"] as? String == "At their request")
    }

    // MARK: Files

    @Test("The configuration export is a GET download named by the server")
    func configExportOnTheWire() async throws {
        let mock = MockURLProtocol.state
        let json = Data(#"{"modules":[]}"#.utf8)
        mock.reset([.response(
            status: 200,
            headers: ["Content-Type": "application/json; charset=utf-8",
                      "Content-Disposition": #"attachment; filename="sylo-1-config.json""#],
            body: json)])
        let file = try await toolsClient().download(Endpoints.ExportGuildConfig(server: "1"))
        defer { file.discard() }
        #expect(file.filename == "sylo-1-config.json")
        #expect(file.mimeType == "application/json")
        #expect(try file.contents() == json)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "\(base)/export")
        #expect(request.method == "GET")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
    }

    @Test("A ticket transcript is an HTML download named ticket-<id>-transcript.html")
    func transcriptOnTheWire() async throws {
        let mock = MockURLProtocol.state
        let html = Data("<!doctype html><html><body>Hi</body></html>".utf8)
        mock.reset([.response(
            status: 200,
            headers: ["Content-Type": "text/html; charset=utf-8",
                      "Content-Disposition": #"attachment; filename="ticket-7-transcript.html""#],
            body: html)])
        let file = try await toolsClient().download(Endpoints.TicketTranscript(server: "fluxer:1", id: 7))
        defer { file.discard() }
        #expect(file.filename == "ticket-7-transcript.html")
        #expect(file.mimeType == "text/html")
        #expect(try file.contents() == html)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/fluxer%3A1/tickets/7/transcript")
    }

    @Test("A transcript of a ticket that is not there is a plain not found")
    func transcriptNotFound() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.response(status: 404, headers: ["Content-Type": "text/plain"], body: Data("Not found".utf8))])
        await #expect(throws: NetworkError.notFound) {
            try await toolsClient().download(Endpoints.TicketTranscript(server: "1", id: 9))
        }
    }

    @Test("The welcome image preview is fetched with the token and a version in the query")
    func welcomePreviewOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.response(status: 200, headers: ["Content-Type": "image/png"], body: Data([0x89, 0x50, 0x4E, 0x47]))])
        let resource = Endpoints.Resource(
            path: WelcomeCardPreview.path(server: "1"), query: WelcomeCardPreview.query(version: 3))
        let file = try await toolsClient().download(resource)
        defer { file.discard() }
        #expect(file.mimeType == "image/png")
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "\(base)/modules/welcome/card-preview?v=3")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
    }
}
