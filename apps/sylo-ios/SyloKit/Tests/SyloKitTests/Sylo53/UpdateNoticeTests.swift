import Foundation
import Testing
@testable import SyloKit

// The operators' update notice (Sylo 5.3, `update-notice`): what `GET /api/v2/update` and the Wise Wren calls answer,
// how a run reads while Sylo restarts, and the model that follows it. The app decodes every payload leniently: a field
// that is missing or of an odd type never loses the notice.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// A count a @Sendable stub can bump.
private final class Tally: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next() -> Int { lock.withLock { count += 1; return count } }
    var value: Int { lock.withLock { count } }
}

/// The shape of `GET /api/v2/update` on a 5.3 server with a newer release and Wise Wren set up.
let updateAvailableJSON = #"""
{
  "enabled": true, "current": "5.2.0", "latest": "5.3.0", "available": true,
  "checkedAt": "2026-11-20T10:00:00.000Z", "checkFailed": false,
  "releaseUrl": "https://github.com/Ferdinand99/Sylo/releases/tag/v5.3.0", "publishedAt": "2026-11-20T09:00:00Z",
  "notes": {"version": "5.3.0", "date": "2026-11-20", "url": null, "sections": [
    {"title": "New", "kind": "features", "items": [
      {"scope": "dashboard", "text": "A **focused** view for `Inbox` access", "refs": [{"label": "#365", "url": "https://github.com/Ferdinand99/Sylo/pull/365"}]}
    ]}
  ]},
  "notesText": null,
  "command": "docker compose pull && docker compose up -d",
  "wren": {
    "configured": true, "error": null, "openMode": false,
    "target": {"name": "sylo", "server": "main", "status": "update", "installedVersion": "5.2.0", "latestVersion": "5.3.0", "mode": "approve", "lastCheckedAt": "2026-11-20T09:55:00Z"},
    "updateSeen": true, "canApprove": true, "whyNot": null, "latestRun": null
  }
}
"""#

@Suite("Update notice: decoding")
struct UpdateNoticeDecodingTests {
    @Test("A newer release with notes and Wise Wren reads completely")
    func available() throws {
        let status = try decode(UpdateStatus.self, updateAvailableJSON)
        #expect(status.isEnabled)
        #expect(status.current == "5.2.0")
        #expect(status.latest == "5.3.0")
        #expect(status.isAvailable)
        #expect(status.releaseURL?.absoluteString == "https://github.com/Ferdinand99/Sylo/releases/tag/v5.3.0")
        #expect(status.command == "docker compose pull && docker compose up -d")
        let notes = try #require(status.notes)
        #expect(notes.version == "5.3.0")
        #expect(notes.sections.first?.items.first?.scope == "dashboard")
        #expect(notes.sections.first?.items.first?.refs.first?.label == "#365")
        let wren = try #require(status.wren)
        #expect(wren.target?.name == "sylo")
        #expect(wren.target?.installedVersion == "5.2.0")
        #expect(wren.updateSeen)
        #expect(wren.canApprove)
        #expect(wren.latestRun == nil)
        #expect(status.offersUpdateNow)
        #expect(status.needsAttention)
        #expect(status.headline == "Sylo 5.3.0 is available. This Sylo runs 5.2.0.")
        #expect(status.summary == "5.3.0 is available")
    }

    @Test("Without Wise Wren there is the notice and the command, and no Update now")
    func withoutWren() throws {
        let status = try decode(
            UpdateStatus.self,
            #"{"enabled":true,"current":"5.2.0","latest":"5.3.0","available":true,"command":"docker compose pull && docker compose up -d","wren":null}"#)
        #expect(status.wren == nil)
        #expect(status.isAvailable)
        #expect(!status.offersUpdateNow)
        #expect(status.needsAttention)
    }

    @Test("Up to date, check off and failed check each read in words")
    func headlines() throws {
        let current = try decode(UpdateStatus.self, #"{"enabled":true,"current":"5.3.0","latest":"5.3.0","available":false}"#)
        #expect(current.headline == "Sylo 5.3.0 is up to date.")
        #expect(current.summary == "Up to date")
        #expect(!current.needsAttention)
        let off = try decode(UpdateStatus.self, #"{"enabled":false,"current":"5.3.0","latest":null,"available":false}"#)
        #expect(off.headline == "Sylo 5.3.0. The update check is off.")
        #expect(off.summary == "Check is off")
        let failed = try decode(
            UpdateStatus.self, #"{"enabled":true,"current":"5.3.0","latest":null,"available":false,"checkFailed":true}"#)
        #expect(failed.headline == "Sylo 5.3.0. The latest release could not be checked.")
        #expect(failed.summary == "Couldn't check")
    }

    @Test("Missing, null and wrong-typed fields never fail the decode")
    func lenient() throws {
        let empty = try decode(UpdateStatus.self, "{}")
        #expect(empty.isEnabled)
        #expect(empty.current == "")
        #expect(empty.latest == nil)
        #expect(!empty.isAvailable)
        #expect(empty.command == UpdateStatus.defaultCommand)
        #expect(empty.wren == nil)

        let odd = try decode(
            UpdateStatus.self,
            #"{"enabled":"yes","current":5,"latest":{"a":1},"available":"true","notes":"text","wren":{"canApprove":"yes","latestRun":{"id":"x"},"target":7},"command":"","someFutureField":[1,2,3]}"#)
        #expect(odd.isEnabled)
        #expect(odd.current == "")
        #expect(odd.notes == nil)
        #expect(odd.command == UpdateStatus.defaultCommand)
        #expect(odd.wren?.canApprove == false)
        #expect(odd.wren?.latestRun == nil)
        #expect(odd.wren?.target == nil)
    }

    @Test("A release link that is not https is not offered")
    func releaseLink() throws {
        let status = try decode(UpdateStatus.self, #"{"available":true,"current":"5.2.0","latest":"5.3.0","releaseUrl":"javascript:alert(1)"}"#)
        #expect(status.releaseURL == nil)
    }

    @Test("Notes that are not in the usual format come as plain text")
    func notesText() throws {
        let status = try decode(
            UpdateStatus.self,
            #"{"available":true,"current":"5.2.0","latest":"5.3.0","notes":null,"notesText":"Fixes and improvements."}"#)
        #expect(status.notes == nil)
        #expect(status.notesText == "Fixes and improvements.")
    }

    @Test("Wise Wren's problem, open mode and the reason it cannot update read as sent")
    func wrenStates() throws {
        let problem = try decode(
            UpdateStatus.self,
            #"{"available":true,"current":"5.2.0","latest":"5.3.0","wren":{"configured":true,"error":{"code":"wren_unauthorized","message":"Wise Wren did not accept Sylo's token."},"openMode":false,"target":null,"updateSeen":false,"canApprove":false,"whyNot":null,"latestRun":null}}"#)
        #expect(problem.wren?.error?.code == "wren_unauthorized")
        #expect(problem.wren?.error?.message == "Wise Wren did not accept Sylo's token.")
        #expect(!problem.offersUpdateNow)

        let open = try decode(
            UpdateStatus.self,
            #"{"available":true,"current":"5.2.0","latest":"5.3.0","wren":{"configured":true,"error":null,"openMode":true,"target":{"name":"sylo"},"updateSeen":true,"canApprove":false,"whyNot":"Update now needs a dashboard login.","latestRun":null}}"#)
        #expect(open.wren?.isOpenMode == true)
        #expect(open.wren?.canApprove == false)
        #expect(open.wren?.whyNot == "Update now needs a dashboard login.")
        // The button is shown but off; the server says why.
        #expect(open.offersUpdateNow)
    }

    @Test("A run that is going keeps the notice asking for attention, also with no newer release")
    func runningRun() throws {
        let status = try decode(
            UpdateStatus.self,
            #"{"available":false,"current":"5.2.0","latest":"5.2.0","wren":{"configured":true,"canApprove":false,"latestRun":{"id":12,"status":"running","finished":false,"steps":[{"step":"snapshot","status":"done","durationMs":10},{"step":"update","status":"running","durationMs":null}]}}}"#)
        #expect(status.needsAttention)
        #expect(status.wren?.latestRun?.id == 12)
        #expect(status.wren?.latestRun?.isFinished == false)
        #expect(status.wren?.latestRun?.described.step == "Starting the new version")
    }
}

@Suite("Update notice: runs")
struct UpdateRunTests {
    @Test("Every Wise Wren status has its own sentence and tone")
    func described() {
        func run(_ status: String, steps: [WrenRun.Step] = []) -> WrenRun.Description {
            WrenRun(id: 1, status: status, steps: steps).described
        }
        #expect(run("queued").tone == .working)
        #expect(run("running").tone == .working)
        #expect(run("succeeded").tone == .success)
        for failure in ["rolled_back", "failed", "rollback_failed", "refused", "cancelled", "lapsed"] {
            #expect(run(failure).tone == .failure)
        }
        #expect(run("rolled_back").text.contains("rolled back"))
        #expect(run("rollback_failed").text.contains("rollback failed"))
        // A state a newer Wise Wren adds still reads, as work in progress.
        #expect(run("hovering").tone == .working)
        #expect(run("hovering").text == "Wise Wren is working on the update.")
    }

    @Test("A run is finished in every status but queued and running, and the server's word wins")
    func finished() throws {
        #expect(!WrenRun(id: 1, status: "queued").isFinished)
        #expect(!WrenRun(id: 1, status: "running").isFinished)
        for status in ["succeeded", "rolled_back", "failed", "rollback_failed", "refused", "cancelled", "lapsed"] {
            #expect(WrenRun(id: 1, status: status).isFinished)
        }
        #expect(try decode(WrenRun.self, #"{"id":3,"status":"failed"}"#).isFinished)
        #expect(try decode(WrenRun.self, #"{"id":3,"status":"running","finished":true}"#).isFinished)
        #expect(try decode(WrenRun.self, #"{"id":3}"#).status == "queued")
    }

    @Test("The step it is on shows in words; a step the app does not know shows as named")
    func steps() {
        let running = WrenRun(
            id: 1, status: "running",
            steps: [
                WrenRun.Step(step: "preflight", status: "done"),
                WrenRun.Step(step: "snapshot", status: "running"),
            ])
        #expect(running.described.step == "Taking a snapshot of the data")
        let odd = WrenRun(id: 1, status: "running", steps: [WrenRun.Step(step: "warmup", status: "running")])
        #expect(odd.described.step == "warmup")
        #expect(WrenRun(id: 1, status: "running").described.step == nil)
        #expect(WrenRun.stepLabel("health") == "Checking that Sylo is healthy")
    }

    @Test("A failed read is Sylo restarting when it has no words from Wise Wren")
    func syloIsDown() {
        for down in [
            NetworkError.offline, .unreachable, .timeout, .notASyloServer, .transport(code: -1),
            .server(status: HTTPStatus(502)), .server(status: 503),
        ] {
            #expect(UpdateModel.syloIsDown(down), "\(down)")
        }
        for answer in [
            NetworkError.server(status: HTTPStatus(502, message: "Wise Wren did not accept Sylo's token.")),
            .http(status: HTTPStatus(409, message: "An update of Sylo is already running in Wise Wren.")),
            .notFound(message: "Wise Wren does not know this target."), .forbidden, .rateLimited,
            .decoding("x"), .badRequest(message: nil),
        ] {
            #expect(!UpdateModel.syloIsDown(answer), "\(answer)")
        }
    }

    @Test("The calls go to the update routes, operators only")
    func endpoints() throws {
        #expect(Endpoints.LoadUpdate().path == "/api/v2/update")
        #expect(Endpoints.LoadUpdate().query.isEmpty)
        #expect(Endpoints.LoadUpdate(refresh: true).query == [URLQueryItem(name: "refresh", value: "1")])
        #expect(Endpoints.LoadUpdate().method == .get)
        let approve = Endpoints.ApproveUpdate()
        #expect(approve.path == "/api/v2/update/wren/approve")
        #expect(approve.method == .post)
        #expect(approve.body == nil)
        #expect(approve.rawBody == nil)
        #expect(Endpoints.LoadUpdateRun(id: 42).path == "/api/v2/update/wren/runs/42")
        let started = try decode(UpdateStarted.self, #"{"runId":42,"status":"queued","from":"5.2.0"}"#)
        #expect(started.runID == 42)
        #expect(started.from == "5.2.0")
        #expect(try decode(UpdateRunAnswer.self, #"{"run":{"id":42,"status":"running","steps":[]}}"#).run.id == 42)
    }
}

@MainActor
@Suite("Update notice: the model")
struct UpdateModelTests {
    private func makeModel(_ clients: StubClients, giveUpAfter: Duration = .seconds(10)) -> UpdateModel {
        UpdateModel(
            session: makeSignedInSession(clients: clients), pollEvery: .milliseconds(1), giveUpAfter: giveUpAfter)
    }

    private func waitUntilDone(_ model: UpdateModel) async {
        for _ in 0..<2000 where model.progress?.isDone != true { try? await Task.sleep(for: .milliseconds(2)) }
    }

    nonisolated private static func availableStatus(current: String = "5.2.0", canApprove: Bool = true) -> UpdateStatus {
        UpdateStatus(
            current: current, latest: "5.3.0", isAvailable: true,
            wren: WrenStatus(target: WrenStatus.Target(name: "sylo"), updateSeen: true, canApprove: canApprove))
    }

    @Test("Loading reads the notice; an account that is not an operator reads nothing")
    func loads() async {
        let clients = StubClients { endpoint in
            guard endpoint is Endpoints.LoadUpdate else { throw NetworkError.notFound }
            return Self.availableStatus()
        }
        let model = makeModel(clients)
        await model.load()
        #expect(model.status?.latest == "5.3.0")
        #expect(model.errorMessage == nil)
        #expect(!model.isRefused)

        let refused = makeModel(StubClients { _ in throw NetworkError.forbidden })
        await refused.load()
        #expect(refused.isRefused)
        #expect(refused.status == nil)
        #expect(refused.progress == nil)
    }

    @Test("Update now asks Wise Wren, follows the run through Sylo's restart and ends on the new version")
    func updatesThroughRestart() async {
        let runReads = Tally()
        let statusReads = Tally()
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadUpdate:
                // The first read is the model's own; later ones are after the restart.
                return Self.availableStatus(current: statusReads.next() == 1 ? "5.2.0" : "5.3.0")
            case is Endpoints.ApproveUpdate:
                return UpdateStarted(runID: 7, from: "5.2.0")
            case is Endpoints.LoadUpdateRun:
                switch runReads.next() {
                case 1: return UpdateRunAnswer(run: WrenRun(id: 7, status: "running"))
                case 2: throw NetworkError.unreachable
                case 3: throw NetworkError.server(status: HTTPStatus(502))
                default: return UpdateRunAnswer(run: WrenRun(id: 7, status: "succeeded"))
                }
            default: throw NetworkError.notFound
            }
        }
        let model = makeModel(clients)
        await model.load()
        #expect(await model.approve())
        #expect(model.progress?.runID == 7)
        await waitUntilDone(model)
        let progress = model.progress
        #expect(progress?.isDone == true)
        #expect(progress?.newVersion == "5.3.0")
        #expect(progress?.text == "Sylo is now on 5.3.0.")
        #expect(progress?.tone == .success)
        #expect(progress?.timedOut == false)
        #expect(runReads.value >= 4)
        #expect(clients.calls.filter { $0.endpoint is Endpoints.ApproveUpdate }.count == 1)
        model.closeProgress()
        #expect(model.progress == nil)
        #expect(!model.isFollowing)
    }

    @Test("A run that ends in a rollback ends the asking, with the old version still running")
    func rollsBack() async {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadUpdate: return Self.availableStatus()
            case is Endpoints.ApproveUpdate: return UpdateStarted(runID: 8, from: "5.2.0")
            case is Endpoints.LoadUpdateRun: return UpdateRunAnswer(run: WrenRun(id: 8, status: "rolled_back"))
            default: throw NetworkError.notFound
            }
        }
        let model = makeModel(clients)
        await model.load()
        #expect(await model.approve())
        await waitUntilDone(model)
        #expect(model.progress?.isDone == true)
        #expect(model.progress?.newVersion == nil)
        #expect(model.progress?.tone == .failure)
        #expect(model.progress?.text.contains("rolled back") == true)
    }

    @Test("Wise Wren's refusal is shown in its own words and nothing is followed")
    func refused() async {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadUpdate: return Self.availableStatus()
            case is Endpoints.ApproveUpdate:
                throw NetworkError.http(
                    status: HTTPStatus(409, message: "An update of Sylo is already running in Wise Wren."))
            default: throw NetworkError.notFound
            }
        }
        let model = makeModel(clients)
        await model.load()
        #expect(await model.approve() == false)
        #expect(model.actionError == "An update of Sylo is already running in Wise Wren.")
        #expect(model.progress == nil)
        #expect(!model.isFollowing)
    }

    @Test("Nothing is asked of Wise Wren when there is no update to approve, or Wise Wren is not set up")
    func guarded() async {
        let calls = StubClients { endpoint in
            if endpoint is Endpoints.LoadUpdate { return UpdateStatus(current: "5.3.0", latest: "5.3.0") }
            throw NetworkError.notFound
        }
        let model = makeModel(calls)
        await model.load()
        #expect(await model.approve() == false)
        #expect(!calls.calls.contains { $0.endpoint is Endpoints.ApproveUpdate })

        let noWren = StubClients { endpoint in
            if endpoint is Endpoints.LoadUpdate { return UpdateStatus(current: "5.2.0", latest: "5.3.0", isAvailable: true) }
            throw NetworkError.notFound
        }
        let plain = makeModel(noWren)
        await plain.load()
        #expect(await plain.approve() == false)
        #expect(!noWren.calls.contains { $0.endpoint is Endpoints.ApproveUpdate })
    }

    @Test("A run that is already going (started elsewhere) is followed when the notice loads")
    func followsRunningRun() async {
        let reads = Tally()
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadUpdate:
                return UpdateStatus(
                    current: "5.2.0", latest: "5.3.0", isAvailable: true,
                    wren: WrenStatus(latestRun: WrenRun(id: 21, status: "running")))
            case is Endpoints.LoadUpdateRun:
                return UpdateRunAnswer(run: WrenRun(id: 21, status: reads.next() < 3 ? "running" : "failed"))
            default: throw NetworkError.notFound
            }
        }
        let model = makeModel(clients)
        await model.load()
        #expect(model.progress?.runID == 21)
        await waitUntilDone(model)
        #expect(model.progress?.run?.status == "failed")
        #expect(model.progress?.tone == .failure)
    }

    @Test("An update that never comes back ends with a note after the time is up")
    func givesUp() async {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadUpdate: return Self.availableStatus()
            case is Endpoints.ApproveUpdate: return UpdateStarted(runID: 9, from: "5.2.0")
            case is Endpoints.LoadUpdateRun: throw NetworkError.unreachable
            default: throw NetworkError.notFound
            }
        }
        let model = makeModel(clients, giveUpAfter: .milliseconds(40))
        await model.load()
        #expect(await model.approve())
        await waitUntilDone(model)
        #expect(model.progress?.timedOut == true)
        #expect(model.progress?.isDone == true)
        #expect(model.progress?.isSyloDown == true)
    }
}
