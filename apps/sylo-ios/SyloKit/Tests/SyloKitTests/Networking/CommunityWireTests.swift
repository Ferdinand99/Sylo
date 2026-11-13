import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the community actions (events, suggestions, quotes, giveaways) put on the wire, through the
// real client and the mock URL protocol: method, path, query and body. They extend `APIClientTests`
// so they run one after another: the mock's state is shared.
extension APIClientTests {
    private func communityClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func sentJSON(_ mock: MockState) throws -> [String: Any] {
        let body = try #require(mock.requests.first?.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test("Posting an event sends the wall-clock times, the zone, a null capacity and the channel, and reads the list back")
    func createEventOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"events":[{"id":5,"title":"Quiz","state":"scheduled"}]}"#)])
        let draft = EventDraft(
            title: "Quiz", start: EventTime.floating(fromText: "2026-11-06T22:00")!, timeZone: "Europe/Oslo",
            reminderMinutes: 60, channelID: "222222222222222222")
        let answer = try await communityClient().send(Endpoints.CreateEvent(server: "1", draft: draft))
        #expect(answer.events.map(\.id) == [5])

        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/events/events")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.header("Content-Type") == "application/json")
        let json = try sentJSON(mock)
        #expect(json["start"] as? String == "2026-11-06T22:00")
        #expect(json["timeZone"] as? String == "Europe/Oslo")
        #expect(json["capacity"] is NSNull)
        #expect(json["channelId"] as? String == "222222222222222222")
    }

    @Test("An event the server refuses comes back as its own sentence")
    func eventRefusal() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(400, #"{"error":"The start time must be in the future."}"#)])
        let draft = EventDraft(
            title: "Quiz", start: EventTime.floating(fromText: "2020-01-01T10:00")!, timeZone: "UTC", channelID: "1")
        do {
            _ = try await communityClient().send(Endpoints.CreateEvent(server: "1", draft: draft))
            Issue.record("a 400 should throw")
        } catch {
            #expect(NetworkError(error).communityMessage == "The start time must be in the future.")
        }
    }

    @Test("Editing and cancelling an event post to the event's own paths")
    func editAndCancelEventOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"events":[]}"#)])
        let client = try communityClient()
        let draft = EventDraft(title: "Quiz", start: EventTime.floating(fromText: "2026-11-06T22:00")!, timeZone: "UTC")
        _ = try await client.send(Endpoints.UpdateEvent(server: "1", id: 12, draft: draft))
        _ = try await client.send(Endpoints.CancelEvent(server: "1", id: 12))
        let urls = mock.requests.map(\.url.absoluteString)
        #expect(urls == [
            "https://example.com/sylo/api/v2/guilds/1/modules/events/events/12",
            "https://example.com/sylo/api/v2/guilds/1/modules/events/events/12/cancel",
        ])
        #expect(mock.requests.map(\.method) == ["POST", "POST"])
        let edit = try #require(mock.requests.first?.body)
        let json = try #require(try JSONSerialization.jsonObject(with: edit) as? [String: Any])
        #expect(json["channelId"] == nil)
        #expect(json["roleId"] == nil)
    }

    @Test("Suggestions are listed with a filter and an order, decided with a reason and moved back in batches")
    func suggestionsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, SuggestionActionsTests.listJSON),
            .json(200, #"{"suggestion":{"id":1,"number":12,"text":"x","status":"approved","reason":"Yes"},"moved":false,"copied":false,"dm":true}"#),
            .json(200, #"{"moved":2,"remaining":0,"failed":[],"next":9}"#),
        ])
        let client = try communityClient()
        let list = try await client.send(Endpoints.SuggestionList(server: "1", status: .open, sort: .top))
        #expect(list.outside == 3)
        let decision = try await client.send(
            Endpoints.DecideSuggestion(server: "1", number: 12, action: .approve, reason: "Yes"))
        #expect(decision.suggestion.status == .approved)
        let batch = try await client.send(Endpoints.MoveAllSuggestionsBack(server: "1", after: 4))
        #expect(batch.moved == 2)

        let requests = mock.requests
        #expect(requests.map(\.method) == ["GET", "POST", "POST"])
        #expect(requests[0].url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/suggestions/list?status=open&sort=top")
        #expect(requests[1].url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/suggestions/12/decision")
        let sent = try #require(requests[1].body)
        let json = try #require(try JSONSerialization.jsonObject(with: sent) as? [String: String])
        #expect(json == ["action": "approve", "reason": "Yes"])
        #expect(requests[2].url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/suggestions/move-all-back")
        let after = try #require(try JSONSerialization.jsonObject(with: try #require(requests[2].body)) as? [String: Int])
        #expect(after == ["after": 4])
    }

    @Test("Quotes are searched with q and deleted by number")
    func quotesOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, QuoteEndpointsTests.listJSON), .json(200, #"{"ok":true}"#)])
        let client = try communityClient()
        let list = try await client.send(Endpoints.QuoteList(server: "1", search: "meant to"))
        #expect(list.total == 41)
        _ = try await client.send(Endpoints.DeleteQuote(server: "1", number: 7))
        let requests = mock.requests
        #expect(requests[0].method == "GET")
        let url = try #require(URLComponents(url: requests[0].url, resolvingAgainstBaseURL: false))
        #expect(url.path == "/sylo/api/v2/guilds/1/modules/quote-board/list")
        #expect(url.queryItems == [URLQueryItem(name: "q", value: "meant to")])
        #expect(requests[1].method == "POST")
        #expect(requests[1].url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/quote-board/7/delete")
    }

    @Test("Giveaways are ended, cancelled and rerolled with a count")
    func giveawaysOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, GiveawayActionsTests.listJSON),
            .json(200, #"{"giveaways":[],"refunded":2,"failed":0}"#),
            .json(200, GiveawayActionsTests.listJSON),
        ])
        let client = try communityClient()
        let ended = try await client.send(Endpoints.EndGiveaway(server: "1", id: 12))
        #expect(ended.giveaways.count == 3)
        let cancelled = try await client.send(Endpoints.CancelGiveaway(server: "1", id: 12))
        #expect(cancelled.refunded == 2)
        _ = try await client.send(Endpoints.RerollGiveaway(server: "1", id: 9, count: 3))

        let requests = mock.requests
        #expect(requests.map(\.method) == ["POST", "POST", "POST"])
        #expect(requests.map(\.url.absoluteString) == [
            "https://example.com/sylo/api/v2/guilds/1/modules/giveaways/12/end",
            "https://example.com/sylo/api/v2/guilds/1/modules/giveaways/12/cancel",
            "https://example.com/sylo/api/v2/guilds/1/modules/giveaways/9/reroll",
        ])
        let count = try #require(try JSONSerialization.jsonObject(with: try #require(requests[2].body)) as? [String: Int])
        #expect(count == ["count": 3])
    }
}
