import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the server pages and the account calls put on the wire, through the real client and the mock
// URL protocol: method, path, query and body keys. They extend `APIClientTests` so they run one
// after another: the mock's state is shared.
extension APIClientTests {
    private func pagesClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func pagesBody(_ request: RecordedRequest) throws -> [String: Any] {
        let body = try #require(request.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test("Insights ask for the range, and Refresh now is a body-less POST")
    func insightsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, InsightsDecodingTests.hourJSON), .json(200, #"{"ok":true}"#)])
        let client = try pagesClient()
        let report = try await client.send(Endpoints.Insights(server: "fluxer:1", range: .last24Hours))
        #expect(report.granularity == .hour)
        _ = try await client.send(Endpoints.RefreshInsights(server: "fluxer:1"))

        let read = try #require(mock.requests.first)
        #expect(read.url.absoluteString == "https://example.com/sylo/api/v2/guilds/fluxer%3A1/insights?range=24")
        #expect(read.method == "GET")
        #expect(read.header("Authorization") == "Bearer sylo_secret")
        let refresh = try #require(mock.requests.last)
        #expect(refresh.url.absoluteString == "https://example.com/sylo/api/v2/guilds/fluxer%3A1/insights/refresh")
        #expect(refresh.method == "POST")
        #expect(refresh.body == nil || refresh.body?.isEmpty == true)
    }

    @Test("The leaderboard asks for its period; the public switch and the short link post their own keys")
    func leaderboardOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, LeaderboardDecodingTests.pageJSON),
            .json(200, #"{"publicLeaderboard":false}"#),
            .json(200, #"{"vanitySlug":"beta"}"#),
        ])
        let client = try pagesClient()
        let page = try await client.send(Endpoints.Leaderboard(server: "1", period: .week))
        #expect(page.total == 42)
        let off = try await client.send(Endpoints.SetLeaderboardPublic(server: "1", isPublic: false))
        #expect(!off.isPublic)
        let vanity = try await client.send(Endpoints.SetLeaderboardVanity(server: "1", slug: "Beta"))
        #expect(vanity.slug == "beta")

        let requests = mock.requests
        #expect(requests[0].url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/leaderboard?period=week")
        #expect(requests[1].url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/leaderboard/public")
        #expect(requests[1].method == "POST")
        let publicBody = try pagesBody(requests[1])
        #expect(Set(publicBody.keys) == ["publicLeaderboard"])
        #expect(publicBody["publicLeaderboard"] as? Bool == false)
        #expect(requests[2].url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/leaderboard/vanity")
        let vanityBody = try pagesBody(requests[2])
        #expect(Set(vanityBody.keys) == ["slug"])
        #expect(vanityBody["slug"] as? String == "Beta")
    }

    @Test("A refused short link comes back as the server's own word")
    func vanityRefusedOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(400, #"{"error":"taken"}"#)])
        do {
            _ = try await pagesClient().send(Endpoints.SetLeaderboardVanity(server: "1", slug: "busy"))
            Issue.record("the refusal should have thrown")
        } catch {
            #expect(NetworkError(error) == .badRequest(message: "taken"))
        }
    }

    @Test("The audit log is a plain GET")
    func auditOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, AuditLogDecodingTests.json)])
        let page = try await pagesClient().send(Endpoints.AuditLog(server: "1"))
        #expect(page.entries.count == 3)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/audit")
        #expect(request.method == "GET")
    }

    @Test("The command list is public: no token goes with it")
    func commandsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, CommandListDecodingTests.json)])
        let page = try await pagesClient().send(Endpoints.CommandList())
        #expect(page.commands.count == 3)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/public/commands")
        #expect(request.header("Authorization") == nil)
    }

    @Test("The roadmap loads, a vote is a body-less POST, a suggestion posts a title and a description")
    func roadmapOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, RoadmapDecodingTests.json),
            .json(200, #"{"voted":true,"votes":13}"#),
            .json(200, #"{"ok":true}"#),
        ])
        let client = try pagesClient()
        let board = try await client.send(Endpoints.Roadmap())
        #expect(board.canParticipate)
        let vote = try await client.send(Endpoints.VoteRoadmapPost(id: 1))
        #expect(vote == RoadmapVoteResult(voted: true, votes: 13))
        _ = try await client.send(Endpoints.SuggestRoadmapPost(title: "Idea", description: "Text"))

        let requests = mock.requests
        #expect(requests[0].url.absoluteString == "https://example.com/sylo/api/v2/roadmap")
        #expect(requests[1].url.absoluteString == "https://example.com/sylo/api/v2/roadmap/1/vote")
        #expect(requests[1].method == "POST")
        #expect(requests[1].body == nil || requests[1].body?.isEmpty == true)
        #expect(requests[2].url.absoluteString == "https://example.com/sylo/api/v2/roadmap/suggest")
        let body = try pagesBody(requests[2])
        #expect(Set(body.keys) == ["title", "description"])
    }

    @Test("The announcement and the invite links are plain GETs")
    func announcementOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, #"{"announcement":{"title":"Hi","severity":"info","createdAt":5}}"#),
            .json(200, #"{"invites":[{"platform":"discord","label":"Discord","url":"https://discord.com/oauth2/authorize?client_id=1"}]}"#),
        ])
        let client = try pagesClient()
        let answer = try await client.send(Endpoints.CurrentAnnouncement())
        #expect(answer.announcement?.title == "Hi")
        let invites = try await client.send(Endpoints.Invites())
        #expect(invites.invites.count == 1)
        #expect(mock.requests[0].url.absoluteString == "https://example.com/sylo/api/v2/announcement")
        #expect(mock.requests[1].url.absoluteString == "https://example.com/sylo/api/v2/invites")
    }

    @Test("A bulk switch posts the ids and the switch")
    func bulkOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true,"count":2,"enabled":true}"#)])
        let result = try await pagesClient().send(
            Endpoints.SetModulesBulk(server: "1", modules: ["welcome", "polls"], enabled: true))
        #expect(result == BulkToggleResult(count: 2, isEnabled: true))
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/bulk")
        #expect(request.method == "POST")
        let json = try pagesBody(request)
        #expect(Set(json.keys) == ["ids", "enabled"])
        #expect(json["ids"] as? [String] == ["welcome", "polls"])
        #expect(json["enabled"] as? Bool == true)
    }

    @Test("Disconnecting is a body-less POST; a 409 is not read as a sign-out")
    func disconnectOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true}"#), .json(409, #"{"error":"You can't disconnect your only sign-in."}"#)])
        let client = try pagesClient()
        _ = try await client.send(Endpoints.DisconnectPlatform(platform: .fluxer))
        let first = try #require(mock.requests.first)
        #expect(first.url.absoluteString == "https://example.com/sylo/api/v2/account/disconnect/fluxer")
        #expect(first.method == "POST")
        do {
            _ = try await client.send(Endpoints.DisconnectPlatform(platform: .discord))
            Issue.record("the conflict should have thrown")
        } catch {
            #expect(NetworkError(error) == .http(status: 409))
        }
    }

    @Test("Starting a connect posts to the app API and reads the one-time code")
    func startConnectOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"code":"one-time"}"#)])
        let grant = try await pagesClient().send(Endpoints.StartConnect(platform: .discord))
        #expect(grant == ConnectGrant(code: "one-time"))
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/mobile/connect/discord")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
    }
}
