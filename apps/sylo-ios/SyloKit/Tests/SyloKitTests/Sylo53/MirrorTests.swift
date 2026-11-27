import Foundation
import Testing
@testable import SyloKit

// Mirror to Fluxer (Sylo 5.3, `mirror`): the state of both sides of a pair, the Fluxer server picker, the preview and
// report, what the app posts, and the rule that only the owner of the server shown changes anything.

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

/// `GET .../mirror` on a Discord server whose mirror runs and has changes waiting.
let mirrorLiveJSON = #"""
{
  "platform": "discord", "canMirror": true, "fluxerConnected": true, "isOwner": true,
  "pair": {
    "id": 4, "side": "source", "status": "live", "resumeStatus": "",
    "options": {"name": true, "icon": true, "banner": false, "roles": true, "channels": true, "emoji": true,
                "stickers": true, "modules": true, "continuous": true, "mirrorDeletes": false, "mirrorDeletesRequested": true},
    "otherId": "fluxer:900000000000000401", "otherName": "Sylo on Fluxer", "otherPresent": true,
    "requestedBy": "Ferdi (dashboard)", "consent": {"source": {"by": "Ferdi", "at": 1763640000000}, "target": {"by": "", "at": 1763640100000}},
    "pauseKind": "", "pausedBy": "", "codeExpiresAt": 0, "lastError": "", "copiedAt": 1763640200000, "copyRun": 2,
    "createdAt": 1763640000000
  },
  "progress": {"run": 2, "total": 40, "done": 37, "skipped": 1, "failed": 1, "waiting": 1, "percent": 98,
               "waitingChanges": 3, "pendingDeletes": [],
               "removed": [{"kind": "channel", "label": "#old-news", "at": 1763640300000}]},
  "defaults": {"name": true},
  "limits": {"emoji": 500, "stickers": 500}
}
"""#

/// `GET .../mirror/preview`.
let mirrorPreviewJSON = #"""
{
  "ok": false,
  "blockers": [{"code": "role-hierarchy", "message": "Sylo's role is not the highest on this server."}],
  "warnings": [{"code": "target-not-empty", "message": "The Fluxer server is not empty: 3 channel(s)."}],
  "summary": {"channel": {"create": 5, "update": 1, "unchanged": 0, "skip": 2}, "role": {"create": 0, "update": 3, "unchanged": 4, "skip": 0},
              "guild": {"create": 0, "update": 1, "unchanged": 0, "skip": 0}, "odd": "x"},
  "notes": [{"code": "c1", "scope": "module", "message": "Tickets: the transcript channel is not copied."},
            {"code": "c2", "scope": "role", "message": "Bots' roles are not copied."},
            {"code": "c3", "scope": "channel", "message": "Overwrites for single members are skipped.", "ref": {"id": "1"}},
            {"code": "c4", "scope": "role", "message": "@everyone keeps Fluxer's defaults."}],
  "target": {"id": "fluxer:900000000000000401", "name": "Sylo on Fluxer"},
  "steps": [{"key": "channel:1", "kind": "channel", "name": "#general", "op": "create", "reason": null, "notes": 0},
            {"key": "role:2", "kind": "role", "name": "Mods", "op": "skip", "reason": "managed by an app", "notes": 1}]
}
"""#

@Suite("Mirror: decoding")
struct MirrorDecodingTests {
    @Test("A running mirror reads: the pair, its options, progress and what was removed on Discord")
    func live() throws {
        let state = try decode(MirrorState.self, mirrorLiveJSON)
        #expect(state.platform == .discord)
        #expect(state.isOwner)
        let pair = try #require(state.pair)
        #expect(pair.side == .source)
        #expect(pair.status == .live)
        #expect(pair.otherID == "fluxer:900000000000000401")
        #expect(pair.otherName == "Sylo on Fluxer")
        #expect(pair.copyRun == 2)
        #expect(pair.codeExpiresAt == nil)
        #expect(pair.copiedAt == Date(timeIntervalSince1970: 1_763_640_200))
        #expect(pair.canCopyAgain)
        #expect(!pair.options[.banner])
        #expect(pair.options[.roles])
        #expect(pair.options.shows(.mirrorDeletes))
        #expect(pair.options.deletesWaitForFluxer)
        let progress = try #require(state.progress)
        #expect(progress.percent == 98)
        #expect(progress.text == "39 of 40 steps done, 1 failed, 1 skipped")
        #expect(progress.removed.first?.label == "#old-news")
        #expect(state.isBusy)
        #expect(state.step == .copy)
    }

    @Test("No pair, an empty answer and unknown values still read; nobody is the owner unless the server says so")
    func lenient() throws {
        let empty = try decode(MirrorState.self, "{}")
        #expect(empty.pair == nil)
        #expect(!empty.isOwner)
        #expect(!empty.isBusy)
        #expect(empty.step == .ask)
        #expect(empty.emojiLimit == 500)
        let target = try decode(MirrorState.self, #"{"platform":"fluxer","pair":{"id":1,"side":"target","status":"resyncing","options":{"future":true}}}"#)
        #expect(!target.canMirror)
        #expect(target.pair?.side == .target)
        #expect(target.pair?.status == .other("resyncing"))
        #expect(target.pair?.options[.name] == true)
        #expect(target.pair?.options.values["future"] == true)
        #expect(target.step == .copy)
    }

    @Test("The wizard's step follows the pair's state")
    func steps() {
        #expect(MirrorState(pair: MirrorPair(id: 1, status: .pending)).step == .agree)
        #expect(MirrorState(pair: MirrorPair(id: 1, status: .ready)).step == .preview)
        #expect(MirrorState(pair: MirrorPair(id: 1, status: .paused)).step == .copy)
        #expect(MirrorState(pair: MirrorPair(id: 1, status: .copying)).isBusy)
        #expect(!MirrorState(pair: MirrorPair(id: 1, status: .live), progress: MirrorProgress(waitingChanges: 0)).isBusy)
        #expect(MirrorStep.ask < MirrorStep.copy)
    }

    @Test("Resuming: only the side that paused, or anyone after a pause Sylo made; the button says why")
    func resume() {
        #expect(MirrorPair(id: 1, side: .source, status: .paused, pausedBy: "source").canResume)
        #expect(!MirrorPair(id: 1, side: .source, status: .paused, pausedBy: "target").canResume)
        #expect(MirrorPair(id: 1, side: .target, status: .paused, pausedBy: "system").canResume)
        #expect(MirrorPair(id: 1, side: .source, status: .paused, pausedBy: "target").resumeNote?.contains("Fluxer server paused") == true)
        #expect(MirrorPair(id: 1, side: .target, status: .paused, pausedBy: "source").resumeNote?.contains("Discord server paused") == true)
        #expect(MirrorPair(id: 1, status: .paused, pauseKind: "deletes").resumeTitle == "Review the Deletions")
        #expect(MirrorPair(id: 1, status: .paused, pauseKind: "ownership").resumeTitle == "Confirm the Mirror as the Owner")
        #expect(MirrorPair(id: 1, status: .paused, pauseKind: "owner").resumeTitle == "Resume")
    }

    @Test("The Fluxer servers to pick from, with what Sylo still needs there")
    func fluxerServers() throws {
        let list = try decode(MirrorFluxerServers.self, #"""
        {"fluxerConnected": true, "connected": true, "servers": [
          {"id": "fluxer:900000000000000401", "name": "Sylo on Fluxer", "icon": "https://cdn.example/icon.png", "memberCount": 1204, "inUse": false,
           "notes": [{"code": "role-hierarchy", "message": "Drag Sylo's role to the top."}]},
          {"id": "fluxer:900000000000000402", "name": "Old", "icon": null, "memberCount": null, "inUse": true, "notes": []},
          {"name": "no id"}
        ]}
        """#)
        #expect(list.connected)
        #expect(list.servers.count == 2)
        #expect(list.servers[0].iconURL?.absoluteString == "https://cdn.example/icon.png")
        #expect(list.servers[0].notes.first?.message == "Drag Sylo's role to the top.")
        #expect(list.servers[1].inUse)
        #expect(list.servers[1].memberText == "Members not known")
        #expect(MirrorFluxerChoice(id: "x", name: "x", memberCount: 1).memberText == "1 member")
        let notConnected = try decode(MirrorFluxerServers.self, #"{"fluxerConnected": true, "connected": false, "servers": []}"#)
        #expect(!notConnected.connected)
    }

    @Test("The preview: blockers, warnings, one line per kind, notes grouped in the dashboard's order")
    func preview() throws {
        let preview = try decode(MirrorPreview.self, mirrorPreviewJSON)
        #expect(!preview.ok)
        #expect(preview.blockers.first?.code == "role-hierarchy")
        #expect(preview.warnings.count == 1)
        #expect(preview.targetName == "Sylo on Fluxer")
        #expect(preview.summary.count == 3)
        #expect(preview.summaryLines == [
            "Update the server name, icon and banner",
            "Update 3 roles, 4 already match",
            "Create 5 channels, update 1, skip 2",
        ])
        let groups = MirrorNoteGroup.groups(preview.notes)
        #expect(groups.map(\.scope) == ["role", "channel", "module"])
        #expect(groups.first?.notes.count == 2)
        #expect(groups.first?.title == "Roles")
        #expect(preview.steps.map(\.op) == ["create", "skip"])
        #expect(preview.steps.last?.reason == "managed by an app")
        #expect(try decode(MirrorPreview.self, "{}").ok)
    }

    @Test("The report: what failed, the notes and the bridge step")
    func report() throws {
        let report = try decode(MirrorReport.self, #"""
        {"run": 2, "items": [], "notes": [], "summary": {},
         "failed": [{"kind": "emoji", "op": "create", "sourceId": "9", "name": "party", "status": "failed", "detail": "Fluxer refused the file."}],
         "bridge": {"status": "done", "detail": "12 channels linked"}}
        """#)
        #expect(report.failed.first?.name == "party")
        #expect(report.failed.first?.detail == "Fluxer refused the file.")
        #expect(report.bridgeLine == "Linking channels through the bridge: 12 channels linked.")
        let waiting = try decode(MirrorReport.self, #"{"failed": [], "bridge": {"status": "running", "detail": ""}}"#)
        #expect(waiting.bridgeLine == "Linking channels through the bridge: waiting.")
        #expect(try decode(MirrorReport.self, #"{"bridge": null}"#).bridgeLine == nil)
    }

    @Test("Words: deletions, the code's time left, and what counts as a Fluxer server id or a code")
    func words() {
        let deletes = (1...12).map { MirrorDeletion(kind: "channel", name: "#c\($0)", action: $0 == 1 ? "delete" : "lock") }
        let text = MirrorText.deleteSummary(deletes)
        #expect(text.hasPrefix("delete channel #c1, lock channel #c2"))
        #expect(text.hasSuffix(", and 2 more"))
        #expect(MirrorText.deleteSummary([MirrorDeletion(kind: "role", name: "Mod")]) == "lock role Mod")
        let now = Date(timeIntervalSince1970: 1000)
        #expect(MirrorText.codeLeft(until: now.addingTimeInterval(41 * 60 + 5), now: now) == "42 minutes")
        #expect(MirrorText.codeLeft(until: now.addingTimeInterval(30), now: now) == "1 minute")
        #expect(MirrorText.codeLeft(until: now.addingTimeInterval(-1), now: now) == nil)
        #expect(MirrorText.codeLeft(until: nil, now: now) == nil)
        #expect(MirrorText.isTargetID("900000000000000401"))
        #expect(MirrorText.isTargetID(" fluxer:900000000000000401 "))
        #expect(!MirrorText.isTargetID("discord:900000000000000401"))
        #expect(!MirrorText.isTargetID("1234"))
        #expect(!MirrorText.isTargetID("９００000000000000401"))
        #expect(MirrorText.isCode("K7QW-H2NP"))
        #expect(!MirrorText.isCode(" K7QW "))
    }
}

@Suite("Mirror: the calls")
struct MirrorCallTests {
    @Test("The routes are the server's, one per call")
    func routes() {
        let base = "/api/v2/guilds/1/mirror"
        #expect(Endpoints.LoadMirror(server: "1").path == base)
        #expect(Endpoints.LoadMirrorFluxerServers(server: "1").path == base + "/fluxer-servers")
        #expect(Endpoints.LoadMirrorPreview(server: "1").path == base + "/preview")
        #expect(Endpoints.LoadMirrorReport(server: "1").path == base + "/report")
        #expect(Endpoints.RequestMirror(server: "1", targetID: "x").path == base + "/request")
        #expect(Endpoints.AcceptMirror(server: "fluxer:5", code: "x").path == "/api/v2/guilds/fluxer%3A5/mirror/accept")
        #expect(Endpoints.SetMirrorOption(server: "1", key: .roles, on: false).path == base + "/options")
        #expect(Endpoints.AllowMirrorDeletes(server: "1", allow: true).path == base + "/deletes")
        #expect(Endpoints.StartMirror(server: "1").path == base + "/start")
        for action in MirrorControl.allCases {
            #expect(Endpoints.ChangeMirror(server: "1", action: action).path == base + "/\(action.rawValue)")
            #expect(Endpoints.ChangeMirror(server: "1", action: action).method == .post)
        }
    }

    @Test("Each call sends only what the dashboard sends")
    func bodies() throws {
        #expect(try bodyJSON(Endpoints.RequestMirror(server: "1", targetID: " fluxer:9 ").body) as NSDictionary == ["targetGuildId": "fluxer:9"])
        #expect(try bodyJSON(Endpoints.AcceptMirror(server: "1", code: " K7QW-H2NP ").body) as NSDictionary == ["code": "K7QW-H2NP"])
        #expect(try bodyJSON(Endpoints.SetMirrorOption(server: "1", key: .continuous, on: false).body) as NSDictionary == ["continuous": false])
        #expect(try bodyJSON(Endpoints.AllowMirrorDeletes(server: "1", allow: true).body) as NSDictionary == ["allow": true])
        #expect(try bodyJSON(Endpoints.StartMirror(server: "1").body) as NSDictionary == ["confirm": true])
        #expect(try bodyJSON(Endpoints.ChangeMirror(server: "1", action: .pause).body).isEmpty)
        #expect(try bodyJSON(Endpoints.ChangeMirror(server: "1", action: .resume).body).isEmpty)
        #expect(try bodyJSON(Endpoints.ChangeMirror(server: "1", action: .resume, confirm: true).body) as NSDictionary == ["confirm": true])
        // A confirmation means something only for a resume.
        #expect(try bodyJSON(Endpoints.ChangeMirror(server: "1", action: .stop, confirm: true).body).isEmpty)
    }
}

@MainActor
@Suite("Mirror: the model")
struct MirrorModelTests {
    private func makeModel(_ clients: StubClients) -> MirrorModel {
        MirrorModel(server: "1", session: makeSignedInSession(clients: clients))
    }

    @Test("The owner of a Discord server picks a Fluxer server, asks, and keeps the code while the request waits")
    func asks() async {
        let pending = MirrorState(pair: MirrorPair(id: 1, status: .pending, otherID: "fluxer:900000000000000401"))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LoadMirrorFluxerServers {
                return MirrorFluxerServers(servers: [MirrorFluxerChoice(id: "fluxer:900000000000000401", name: "Sylo on Fluxer")])
            }
            if endpoint is Endpoints.RequestMirror { return MirrorRequestAnswer(state: pending, code: "K7QW-H2NP") }
            return MirrorState()
        }
        let model = makeModel(clients)
        await model.load()
        await model.loadFluxerServers()
        #expect(model.fluxerListState == .loaded)
        #expect(!model.canAsk)
        model.targetID = model.fluxerServers?.servers.first?.id ?? ""
        #expect(model.canAsk)
        #expect(await model.requestMirror())
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.RequestMirror }
        #expect(sent.first?.targetID == "fluxer:900000000000000401")
        #expect(model.code == "K7QW-H2NP")
        #expect(model.state?.step == .agree)
        #expect(model.targetID == "")
    }

    @Test("When the same person owns both servers, both agree at once and there is no code")
    func agreedAtOnce() async {
        let ready = MirrorState(pair: MirrorPair(id: 1, status: .ready))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RequestMirror { return MirrorRequestAnswer(state: ready, code: nil, agreed: true) }
            return MirrorState()
        }
        let model = makeModel(clients)
        await model.load()
        model.targetID = "900000000000000401"
        #expect(await model.requestMirror())
        #expect(model.code == nil)
        #expect(model.notice?.contains("Both servers agreed") == true)
        #expect(model.state?.step == .preview)
    }

    @Test("Someone who is not the server owner can look but sends no change, and the picker is not asked for")
    func notOwner() async {
        let paused = MirrorState(isOwner: false, pair: MirrorPair(id: 1, status: .paused, pausedBy: "source"))
        let clients = StubClients { _ in paused }
        let model = makeModel(clients)
        await model.load()
        await model.loadFluxerServers()
        model.targetID = "900000000000000401"
        #expect(!model.canAsk)
        #expect(await model.requestMirror() == false)
        #expect(await model.start() == false)
        await model.setOption(.roles, to: false)
        await model.pause()
        await model.stop()
        await model.resume()
        await model.allowDeletes(true)
        #expect(clients.calls.allSatisfy { $0.endpoint is Endpoints.LoadMirror })
    }

    @Test("The preview holds only for the options it was made for")
    func previewFollowsOptions() async {
        let first = MirrorState(pair: MirrorPair(id: 1, status: .ready, options: MirrorOptions(["roles": true])))
        let changed = MirrorState(pair: MirrorPair(id: 1, status: .ready, options: MirrorOptions(["roles": false])))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LoadMirrorPreview { return MirrorPreview(targetName: "Sylo on Fluxer") }
            if endpoint is Endpoints.SetMirrorOption { return changed }
            return first
        }
        let model = makeModel(clients)
        await model.load()
        await model.loadPreview()
        #expect(model.preview?.targetName == "Sylo on Fluxer")
        await model.setOption(.roles, to: false)
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.SetMirrorOption }
        #expect(sent.first?.key == .roles)
        #expect(sent.first?.on == false)
        #expect(model.preview == nil)
    }

    @Test("Resuming with deletions waiting shows them first, and only the confirmation sends confirm")
    func resumeWithDeletions() async {
        let waiting = [MirrorDeletion(kind: "channel", name: "#old", action: "lock")]
        let paused = MirrorState(
            pair: MirrorPair(id: 1, status: .paused, pauseKind: "deletes", pausedBy: "system"),
            progress: MirrorProgress(pendingDeletes: waiting))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ChangeMirror { return MirrorState(pair: MirrorPair(id: 1, status: .live)) }
            return paused
        }
        let model = makeModel(clients)
        await model.load()
        await model.resume()
        #expect(model.deletionsToConfirm == waiting)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ChangeMirror })
        await model.confirmDeletions()
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.ChangeMirror }
        #expect(sent.count == 1)
        #expect(sent.first?.action == .resume)
        #expect(sent.first?.confirm == true)
        #expect(model.deletionsToConfirm == nil)
        #expect(model.pair?.status == .live)
    }

    @Test("A resume the server holds back for deletions it now lists reads the page again and asks")
    func resumeAsksAfterRefusal() async {
        let waiting = [MirrorDeletion(kind: "role", name: "Mods", action: "delete")]
        let before = MirrorState(pair: MirrorPair(id: 1, status: .paused, pausedBy: "source"))
        let after = MirrorState(
            pair: MirrorPair(id: 1, status: .paused, pauseKind: "deletes", pausedBy: "source"),
            progress: MirrorProgress(pendingDeletes: waiting))
        let loads = CallCounter()
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ChangeMirror {
                throw NetworkError.http(status: HTTPStatus(409, message: "Confirm the deletions first."))
            }
            return loads.next() == 0 ? before : after
        }
        let model = makeModel(clients)
        await model.load()
        await model.resume()
        #expect(model.deletionsToConfirm == waiting)
        #expect(model.actionError == nil)
    }

    @Test("A plain resume sends no confirmation; the refusal of the other side's pause is shown in the server's words")
    func plainResume() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ChangeMirror {
                throw NetworkError.http(status: HTTPStatus(409, message: "Only the owner of the Fluxer server can resume it."))
            }
            return MirrorState(pair: MirrorPair(id: 1, status: .paused, pausedBy: "system"))
        }
        let model = makeModel(clients)
        await model.load()
        await model.resume()
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.ChangeMirror }
        #expect(sent.first?.confirm == false)
        #expect(model.actionError == "Only the owner of the Fluxer server can resume it.")
        #expect(model.deletionsToConfirm == nil)
    }

    @Test("On the Fluxer server the owner agrees with the code, and allows or stops deleting")
    func target() async {
        let pending = MirrorState(platform: .fluxer, canMirror: false, pair: MirrorPair(id: 1, side: .target, status: .pending))
        let ready = MirrorState(platform: .fluxer, canMirror: false, pair: MirrorPair(id: 1, side: .target, status: .ready))
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.AcceptMirror || endpoint is Endpoints.AllowMirrorDeletes { return ready }
            return pending
        }
        let model = makeModel(clients)
        await model.load()
        await model.loadFluxerServers()
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.LoadMirrorFluxerServers })
        model.acceptCode = "K7QW"
        #expect(await model.agree() == false)
        model.acceptCode = " K7QW-H2NP "
        #expect(await model.agree())
        #expect(clients.calls.compactMap { ($0.endpoint as? Endpoints.AcceptMirror)?.code }.first == " K7QW-H2NP ")
        #expect(model.acceptCode == "")
        await model.allowDeletes(true)
        #expect(clients.calls.compactMap { ($0.endpoint as? Endpoints.AllowMirrorDeletes)?.allow } == [true])
        #expect(model.notice == "Deleting is allowed.")
    }

    @Test("While a copy runs the page is read again until it is done")
    func follows() async {
        let loads = CallCounter()
        let clients = StubClients { _ in
            loads.next() < 2
                ? MirrorState(pair: MirrorPair(id: 1, status: .copying), progress: MirrorProgress(total: 10, waiting: 5, percent: 50))
                : MirrorState(pair: MirrorPair(id: 1, status: .live), progress: MirrorProgress(total: 10, percent: 100))
        }
        let model = makeModel(clients)
        await model.load()
        #expect(model.state?.isBusy == true)
        await model.followProgress(every: .milliseconds(1))
        #expect(model.state?.isBusy == false)
        #expect(model.pair?.status == .live)
    }

    @Test("The code is forgotten once the request is answered or cancelled")
    func codeGoes() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.RequestMirror {
                return MirrorRequestAnswer(state: MirrorState(pair: MirrorPair(id: 1, status: .pending)), code: "K7QW-H2NP")
            }
            if endpoint is Endpoints.ChangeMirror { return MirrorState() }
            return MirrorState()
        }
        let model = makeModel(clients)
        await model.load()
        model.targetID = "900000000000000401"
        await model.requestMirror()
        #expect(model.code == "K7QW-H2NP")
        await model.remove()
        #expect(model.code == nil)
        #expect(model.notice == "The request was cancelled.")
    }

    @Test("A report is shown for the copy it belongs to")
    func reportKey() async {
        let state = CallCounter()
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LoadMirrorReport { return MirrorReport(bridgeStatus: "done", bridgeDetail: "3 linked") }
            return MirrorState(pair: MirrorPair(id: 1, status: .live, copyRun: state.next() == 0 ? 1 : 2))
        }
        let model = makeModel(clients)
        await model.load()
        await model.loadReport()
        #expect(model.report?.bridgeDetail == "3 linked")
        await model.load()
        #expect(model.report == nil)
    }
}

/// Counts calls from a stub handler (which is `@Sendable`).
private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    /// The count before this call.
    func next() -> Int {
        lock.withLock {
            defer { value += 1 }
            return value
        }
    }
}
