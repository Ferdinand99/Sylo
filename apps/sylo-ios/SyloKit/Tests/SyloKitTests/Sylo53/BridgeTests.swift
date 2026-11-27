import Foundation
import Testing
@testable import SyloKit

// The Bridge module (Sylo 5.3, `bridge`): what the server answers, what the app posts, and the owner-only rule.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func bodyJSON(_ body: (any Encodable & Sendable)?) throws -> [String: Any] {
    struct Box: Encodable {
        let value: any Encodable
        func encode(to encoder: any Encoder) throws { try value.encode(to: encoder) }
    }
    let value = try #require(body)
    let data = try JSONEncoder().encode(Box(value: value))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// `GET .../modules/bridge/config` of a Discord server with one running and one stopped link and a waiting request.
let bridgeJSON = #"""
{
  "platform": "discord", "bothPlatforms": true, "enabled": true,
  "limits": {"links": 100, "requests": 5},
  "links": [
    {"id": 1, "status": "active", "pausedByMe": false, "pausedByThem": false, "resumable": false, "problem": null,
     "pauseNote": null,
     "mine": {"channelId": "900000000000000301", "platform": "discord", "server": "Sylo HQ", "channel": "general", "ageRestricted": false},
     "theirs": {"platform": "fluxer", "server": "Sylo on Fluxer", "channel": "general", "ageRestricted": false},
     "options": {"bots": false, "joinMessages": true, "uploadFiles": true},
     "theirOptions": {"bots": true, "joinMessages": false, "uploadFiles": true},
     "createdAt": 1763640000000, "by": "Ferdi (dashboard)", "queued": 2, "dropped": 0},
    {"id": 2, "status": "failed", "pausedByMe": false, "pausedByThem": false, "resumable": true,
     "problem": {"code": "webhook-gone", "text": "The webhook in #news is gone."},
     "mine": {"channelId": "900000000000000302", "platform": "discord", "server": "Sylo HQ", "channel": "news", "ageRestricted": true},
     "theirs": {"platform": "fluxer", "server": "Sylo on Fluxer", "channel": "news", "ageRestricted": true},
     "options": {}, "theirOptions": {}, "queued": 0, "dropped": 4}
  ],
  "requests": [{"id": 7, "channelId": "900000000000000303", "channel": "events", "expiresAt": 1763640900000, "requestedBy": "Ferdi (dashboard)"}],
  "channels": [
    {"id": "900000000000000301", "name": "general", "ageRestricted": false, "taken": true},
    {"id": "900000000000000304", "name": "off-topic", "ageRestricted": false, "taken": false},
    {"id": "900000000000000305", "name": "after-dark", "ageRestricted": true, "taken": false}
  ],
  "owner": true
}
"""#

@Suite("Bridge: decoding")
struct BridgeDecodingTests {
    @Test("The page reads: links with both ends and options, the waiting request, the channels and the owner flag")
    func full() throws {
        let page = try decode(BridgeOverview.self, bridgeJSON)
        #expect(page.platform == .discord)
        #expect(page.otherPlatform == .fluxer)
        #expect(page.isReady)
        #expect(page.isOwner)
        #expect(page.maxLinks == 100)
        #expect(page.links.count == 2)
        let running = page.links[0]
        #expect(running.status == .active)
        #expect(running.mine.channelId == "900000000000000301")
        #expect(running.theirs.server == "Sylo on Fluxer")
        #expect(running.options.joinMessages)
        #expect(!running.options.bots)
        #expect(running.theirOptions.bots)
        #expect(running.queued == 2)
        #expect(running.statusTitle == "Running")
        #expect(running.details.contains("2 waiting to send"))
        let stopped = page.links[1]
        #expect(stopped.status == .failed)
        #expect(stopped.problem == "The webhook in #news is gone.")
        #expect(stopped.canResume)
        #expect(stopped.options == .defaults)
        #expect(stopped.details.contains("age-restricted"))
        #expect(page.requests.first?.channel == "events")
        #expect(page.requests.first?.expiresAt == Date(timeIntervalSince1970: 1_763_640_900))
        #expect(page.freeChannels.map(\.id) == ["900000000000000304", "900000000000000305"])
        #expect(page.freeChannels.last?.label == "#after-dark (age-restricted)")
        #expect(page.linksTitle == "Bridged Channels (2 of 100)")
        #expect(page.limitNote == nil)
    }

    @Test("An empty or odd answer still reads: nothing ready, and nobody is the owner unless the server says so")
    func lenient() throws {
        let empty = try decode(BridgeOverview.self, "{}")
        #expect(!empty.isReady)
        #expect(!empty.isOwner)
        #expect(empty.links.isEmpty)
        let odd = try decode(BridgeOverview.self, #"{"platform":"fluxer","bothPlatforms":"yes","links":[{"id":"x"},{"id":3,"status":"mirror-held"}],"owner":1}"#)
        #expect(odd.platform == .fluxer)
        #expect(odd.otherPlatform == .discord)
        #expect(!odd.bothPlatforms)
        #expect(!odd.isOwner)
        #expect(odd.links.map(\.id) == [3])
        #expect(odd.links.first?.status == .other("mirror-held"))
    }

    @Test("A paused link: who paused it, and whether this side may resume")
    func paused() throws {
        let mine = try decode(BridgeLink.self, #"{"id":1,"status":"paused","pausedByMe":true}"#)
        #expect(mine.statusTitle == "Paused by this server")
        #expect(mine.canResume)
        let theirs = try decode(BridgeLink.self, #"{"id":2,"status":"paused","pausedByThem":true,"resumable":false}"#)
        #expect(theirs.statusTitle == "Paused by the other server")
        #expect(!theirs.canResume)
        let held = try decode(BridgeLink.self, #"{"id":3,"status":"paused","resumable":false,"pauseNote":"The server mirror holds this link."}"#)
        #expect(held.pauseNote == "The server mirror holds this link.")
        #expect(!held.canResume)
    }

    @Test("At the limit, the note says who raises it")
    func limit() throws {
        let links = (1...3).map { BridgeLink(id: $0) }
        let full = BridgeOverview(maxLinks: 3, links: links)
        #expect(full.limitNote?.contains("reached the limit of 3") == true)
        #expect(full.limitNote?.contains("BRIDGE_MAX_LINKS") == true)
        let over = BridgeOverview(maxLinks: 2, links: links)
        #expect(over.linksTitle == "Bridged Channels (3)")
        #expect(over.limitNote?.contains("more bridged channels than the limit of 2") == true)
    }
}

@Suite("Bridge: the calls")
struct BridgeCallTests {
    @Test("The routes are the server's, one per call")
    func routes() {
        #expect(Endpoints.LoadBridge(server: "1").path == "/api/v2/guilds/1/modules/bridge/config")
        #expect(Endpoints.LoadBridge(server: "1").method == .get)
        let request = Endpoints.RequestBridgeLink(server: "fluxer:7", channelID: "5", options: .defaults)
        #expect(request.path == "/api/v2/guilds/fluxer%3A7/modules/bridge/request")
        #expect(request.method == .post)
        #expect(Endpoints.CancelBridgeRequest(server: "1", id: 4).path == "/api/v2/guilds/1/modules/bridge/requests/4/cancel")
        #expect(Endpoints.AcceptBridgeLink(server: "1", code: "A", channelID: "5", options: .defaults).path == "/api/v2/guilds/1/modules/bridge/accept")
        #expect(Endpoints.SetBridgeOption(server: "1", id: 9, key: .bots, on: true).path == "/api/v2/guilds/1/modules/bridge/links/9/options")
        for action in BridgeLinkAction.allCases {
            let call = Endpoints.ChangeBridgeLink(server: "1", id: 9, action: action)
            #expect(call.path == "/api/v2/guilds/1/modules/bridge/links/9/\(action.rawValue)")
            #expect(call.method == .post)
        }
    }

    @Test("A request sends the channel and the three switches; a code adds the code")
    func bodies() throws {
        let options = BridgeOptions(bots: true, joinMessages: false, uploadFiles: false)
        let request = try bodyJSON(Endpoints.RequestBridgeLink(server: "1", channelID: "5", options: options).body)
        #expect(Set(request.keys) == ["channelId", "options"])
        #expect(request["channelId"] as? String == "5")
        let sent = try #require(request["options"] as? [String: Bool])
        #expect(sent == ["bots": true, "joinMessages": false, "uploadFiles": false])
        let accept = try bodyJSON(Endpoints.AcceptBridgeLink(server: "1", code: "ABCD-EFGH-JKLM", channelID: "6", options: .defaults).body)
        #expect(Set(accept.keys) == ["code", "channelId", "options"])
        #expect(accept["code"] as? String == "ABCD-EFGH-JKLM")
    }

    @Test("A switch sends only itself, under options; the server keeps the others")
    func optionBody() throws {
        let json = try bodyJSON(Endpoints.SetBridgeOption(server: "1", id: 9, key: .joinMessages, on: true).body)
        #expect(Set(json.keys) == ["options"])
        #expect(json["options"] as? [String: Bool] == ["joinMessages": true])
    }
}

@MainActor
@Suite("Bridge: the model")
struct BridgeModelTests {
    nonisolated static func page(owner: Bool = true, ready: Bool = true, links: [BridgeLink] = [BridgeLink(id: 1)]) -> BridgeOverview {
        BridgeOverview(
            bothPlatforms: true, enabled: ready, links: links,
            channels: [BridgeChannel(id: "5", name: "general"), BridgeChannel(id: "6", name: "news", taken: true)],
            isOwner: owner)
    }

    private func makeModel(_ clients: StubClients) -> BridgeModel {
        BridgeModel(server: "1", session: makeSignedInSession(clients: clients))
    }

    @Test("Asking for a link sends the picked channel and switches, and keeps the code it gives")
    func asks() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RequestBridgeLink {
                return BridgeIssuedCode(code: "ABCD-EFGH-JKLM", expiresAt: Date(timeIntervalSince1970: 100), overview: Self.page())
            }
            return Self.page()
        }
        let model = makeModel(clients)
        await model.load()
        #expect(!model.canAsk)
        model.askChannelID = "5"
        model.askOptions.bots = true
        #expect(model.canAsk)
        #expect(await model.requestLink())
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.RequestBridgeLink }
        #expect(sent.first?.channelID == "5")
        #expect(sent.first?.options.bots == true)
        #expect(model.issuedCode?.code == "ABCD-EFGH-JKLM")
        #expect(model.askChannelID == "")
        model.dismissCode()
        #expect(model.issuedCode == nil)
    }

    @Test("Someone who is not the server owner can read the page but sends nothing")
    func notOwner() async {
        let clients = StubClients { _ in Self.page(owner: false) }
        let model = makeModel(clients)
        await model.load()
        #expect(model.hasLoaded)
        #expect(!model.isOwner)
        model.askChannelID = "5"
        model.code = "ABCD-EFGH-JKLM"
        model.useChannelID = "5"
        #expect(!model.canAsk)
        #expect(!model.canUseCode)
        #expect(await model.requestLink() == false)
        #expect(await model.acceptCode() == false)
        await model.change(BridgeLink(id: 1), .pause)
        await model.setOption(.bots, to: true, on: BridgeLink(id: 1))
        #expect(clients.calls.allSatisfy { $0.endpoint is Endpoints.LoadBridge })
    }

    @Test("The server's owner-only refusal is shown in its words")
    func refused() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ChangeBridgeLink { throw NetworkError.forbidden(message: "Only the server owner can do this.") }
            return Self.page()
        }
        let model = makeModel(clients)
        await model.load()
        await model.change(BridgeLink(id: 1), .unlink)
        #expect(model.actionError == "Only the server owner can do this.")
    }

    @Test("Using a code trims it, sends it with the channel, and clears the form when the bridge is on")
    func usesCode() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LoadBridge { return Self.page() }
            return BridgeAnswer(overview: Self.page(links: [BridgeLink(id: 1), BridgeLink(id: 2)]))
        }
        let model = makeModel(clients)
        await model.load()
        model.code = "  ABCD-EFGH-JKLM \n"
        model.useChannelID = "5"
        #expect(await model.acceptCode())
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.AcceptBridgeLink }
        #expect(sent.first?.code == "ABCD-EFGH-JKLM")
        #expect(model.code == "")
        #expect(model.overview?.links.count == 2)
        #expect(model.notice == "The bridge is on.")
    }

    @Test("A module that is off, or a Sylo on one platform only, offers no link")
    func notReady() async {
        let model = makeModel(StubClients { _ in Self.page(ready: false) })
        await model.load()
        model.askChannelID = "5"
        #expect(!model.canAsk)
    }

    @Test("Every change replaces the page with the one in the answer")
    func answers() async {
        let clients = StubClients { endpoint in
            if let change = endpoint as? Endpoints.ChangeBridgeLink, change.action == .pause {
                return BridgeAnswer(overview: Self.page(links: [BridgeLink(id: 1, status: .paused, pausedByMe: true)]))
            }
            if let option = endpoint as? Endpoints.SetBridgeOption {
                return BridgeAnswer(overview: Self.page(links: [BridgeLink(id: 1, options: BridgeOptions(bots: option.on))]))
            }
            return Self.page()
        }
        let model = makeModel(clients)
        await model.load()
        await model.change(BridgeLink(id: 1), .pause)
        #expect(model.overview?.links.first?.status == .paused)
        await model.setOption(.bots, to: true, on: BridgeLink(id: 1))
        #expect(model.overview?.links.first?.options.bots == true)
        #expect(model.successCount == 2)
    }
}
