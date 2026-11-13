import Foundation
import Testing
@testable import SyloKit

// GitHub alerts: the watch list page (as Sylo 5.0 and 5.1.1 send it, and as a server before 5.0), the form's draft, what the
// form sends, and the screen's model, in particular that a new secret replaces the one on screen.
// The dashboard's form is web-v2/src/moduleForms/GithubAlerts.jsx.

private func jsonObject(of value: some Encodable) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private let feedChannel = "444444444444444444"
private let devRole = "555555555555555555"

enum GithubFixtures {
    /// `GET .../modules/github/watches` as Sylo 5.0 and 5.1.1 send it (the same shape in both, checked
    /// against the v5.0.0 and v5.1.1 tags).
    static let page511 = #"""
    {
      "watches": [
        {"id": 3, "repo": "Ferdinand99/Sylo", "channelId": "444444444444444444", "roleId": "555555555555555555",
         "changelogPath": "CHANGELOG.md", "events": ["push", "release"], "enabled": true,
         "secret": "s3cret-one", "webhookUrl": "https://sylo.example.com/webhooks/github/tok1"},
        {"id": 4, "repo": "example/app", "channelId": "444444444444444444", "roleId": "",
         "changelogPath": "", "events": ["issues", "futureEvent"], "enabled": false,
         "secret": "s3cret-two", "webhookUrl": null}
      ],
      "channels": [{"id": "444444444444444444", "name": "dev-feed"}],
      "roles": [{"id": "555555555555555555", "name": "Devs"}],
      "eventTypes": [{"key": "push", "label": "Commits pushed"}, {"key": "release", "label": "Release published"},
                     {"key": "issues", "label": "Issue opened / closed"}],
      "dashboardUrlSet": true
    }
    """#

    /// A server from before 5.0: it sends neither the event list nor the public address flag.
    static let pagePre50 = #"""
    {
      "watches": [{"id": 1, "repo": "a/b", "channelId": "444444444444444444", "events": ["push"], "enabled": true,
                   "secret": "x", "webhookUrl": "https://sylo.example.com/webhooks/github/t"}],
      "channels": [{"id": "444444444444444444", "name": "dev-feed"}],
      "roles": []
    }
    """#

    static func decode(_ json: String) throws -> GithubWatchesPage {
        try JSONDecoder().decode(GithubWatchesPage.self, from: Data(json.utf8))
    }
}

@Suite("GitHub alerts: decoding")
struct GithubDecodingTests {
    @Test("a current page: watches with their secret and webhook address, the lists and the flag")
    func decodesPage() throws {
        let page = try GithubFixtures.decode(GithubFixtures.page511)

        #expect(page.watches.map(\.id) == [3, 4])
        #expect(page.channels.map(\.name) == ["dev-feed"])
        #expect(page.roles.map(\.name) == ["Devs"])
        #expect(page.eventTypes.map(\.key) == ["push", "release", "issues"])
        #expect(page.dashboardUrlSet)

        let first = page.watches[0]
        #expect(first.repo == "Ferdinand99/Sylo")
        #expect(first.roleId == devRole)
        #expect(first.changelogPath == "CHANGELOG.md")
        #expect(first.events == ["push", "release"])
        #expect(first.secret == "s3cret-one")
        #expect(first.webhookUrl == "https://sylo.example.com/webhooks/github/tok1")

        let second = page.watches[1]
        #expect(!second.enabled)
        #expect(second.webhookUrl == nil)
        // An event the app does not list stays on the watch.
        #expect(second.events == ["issues", "futureEvent"])
    }

    @Test("a page from before 5.0 gets the standard event list and no warning about the address")
    func decodesOlderPage() throws {
        let page = try GithubFixtures.decode(GithubFixtures.pagePre50)

        #expect(page.eventTypes == GithubEventType.standard)
        #expect(page.eventTypes.count == 6)
        #expect(page.dashboardUrlSet)
        #expect(page.watches.count == 1)
        #expect(page.watches[0].roleId == "")
        #expect(page.watches[0].changelogPath == "")
    }

    @Test("a watch that cannot be read is dropped, an odd value falls back")
    func lossy() throws {
        let page = try GithubFixtures.decode(#"""
        {"watches": [{"id": "x"}, {"id": 2, "repo": 5, "events": "push", "webhookUrl": ""}]}
        """#)

        #expect(page.watches.map(\.id) == [2])
        #expect(page.watches[0].repo == "")
        #expect(page.watches[0].events == [])
        #expect(page.watches[0].webhookUrl == nil)
    }

    @Test("the answer of a save, a toggle or a new secret holds the watch, or null when it is gone")
    func answers() throws {
        let answer = try JSONDecoder().decode(
            GithubWatchAnswer.self,
            from: Data(#"{"watch": {"id": 3, "repo": "a/b", "secret": "fresh", "webhookUrl": "https://x.example/w/t"}}"#.utf8))
        #expect(answer.watch?.secret == "fresh")
        let gone = try JSONDecoder().decode(GithubWatchAnswer.self, from: Data(#"{"watch": null}"#.utf8))
        #expect(gone.watch == nil)
    }

    @Test("a watch prints without its secret")
    func secretIsNotPrinted() throws {
        let watch = try #require(try GithubFixtures.decode(GithubFixtures.page511).watches.first)
        #expect(!watch.debugDescription.contains("s3cret-one"))
        #expect(watch.debugDescription.contains("Ferdinand99/Sylo"))
    }
}

@Suite("GitHub alerts: what is typed")
struct GithubInputTests {
    @Test("a repository is owner/repo, or a pasted github.com address")
    func repos() {
        #expect(GithubInput.repo(from: "Ferdinand99/Sylo") == "Ferdinand99/Sylo")
        #expect(GithubInput.repo(from: "  owner/repo  ") == "owner/repo")
        #expect(GithubInput.repo(from: "https://github.com/owner/repo") == "owner/repo")
        #expect(GithubInput.repo(from: "https://www.github.com/owner/repo.git") == "owner/repo")
        #expect(GithubInput.repo(from: "HTTP://GitHub.com/owner/repo/") == "owner/repo")
        #expect(GithubInput.repo(from: "owner/my.repo_name-1") == "owner/my.repo_name-1")
        for bad in ["", "owner", "owner/", "/repo", "owner/repo/extra", "-owner/repo", "owner/re po",
                    "https://example.com/owner/repo", "owner/repo?x=1"] {
            #expect(GithubInput.repo(from: bad) == nil, "\(bad) should not be a repo")
        }
    }

    @Test("a changelog path is a plain relative path, or empty")
    func changelogPaths() {
        #expect(GithubInput.changelogPath(from: "") == "")
        #expect(GithubInput.changelogPath(from: "  ") == "")
        #expect(GithubInput.changelogPath(from: "CHANGELOG.md") == "CHANGELOG.md")
        #expect(GithubInput.changelogPath(from: "/docs/CHANGELOG.md") == "docs/CHANGELOG.md")
        #expect(GithubInput.changelogPath(from: "../secrets") == nil)
        #expect(GithubInput.changelogPath(from: "a/../b") == nil)
        #expect(GithubInput.changelogPath(from: "a\nb") == nil)
        #expect(GithubInput.changelogPath(from: String(repeating: "a", count: 301)) == nil)
        #expect(GithubInput.changelogPath(from: String(repeating: "a", count: 300)) != nil)
        #expect(GithubInput.changelogPath(from: "abcdef", limit: 5) == nil)
    }
}

@Suite("GitHub alerts: the form's draft")
struct GithubDraftTests {
    static func valid() -> GithubWatchDraft {
        var draft = GithubWatchDraft()
        draft.repo = "owner/repo"
        draft.channelId = feedChannel
        return draft
    }

    @Test("a new watch posts pushes and releases and needs a repository and a channel")
    func newDraft() {
        var draft = GithubWatchDraft()
        #expect(draft.events == ["push", "release"])
        #expect(draft.problem() == "Enter a repo as owner/repo (or paste its github.com URL).")

        draft.repo = "owner/repo"
        #expect(draft.problem() == "Pick a channel.")

        draft.channelId = feedChannel
        #expect(draft.problem() == nil)
    }

    @Test("a watch needs an event or a changelog file")
    func needsSomethingToPost() {
        var draft = Self.valid()
        draft.events = []
        #expect(draft.problem() == "Pick at least one event to announce, or set a changelog file path.")

        draft.changelogPath = "CHANGELOG.md"
        #expect(draft.problem() == nil)

        draft.changelogPath = "../x"
        #expect(draft.problem()?.hasPrefix("That changelog path looks invalid") == true)
    }

    @Test("editing copies the stored watch, an event the app does not list included")
    func editing() throws {
        let page = try GithubFixtures.decode(GithubFixtures.page511)
        let draft = GithubWatchDraft(editing: page.watches[1])

        #expect(draft.repo == "example/app")
        #expect(draft.channelId == feedChannel)
        #expect(draft.events == ["issues", "futureEvent"])
    }

    @Test("the body holds exactly the dashboard's five keys, the events in order")
    func bodyKeys() throws {
        var draft = Self.valid()
        draft.repo = "  https://github.com/owner/repo  "
        draft.roleId = devRole
        draft.changelogPath = " CHANGELOG.md "
        draft.events = ["release", "push", "futureEvent"]
        let body = try jsonObject(of: GithubWatchBody(draft: draft))

        #expect(Set(body.keys) == ["repo", "channelId", "roleId", "changelogPath", "events"])
        #expect(body["repo"] as? String == "https://github.com/owner/repo")
        #expect(body["channelId"] as? String == feedChannel)
        #expect(body["roleId"] as? String == devRole)
        #expect(body["changelogPath"] as? String == "CHANGELOG.md")
        // A stored event the app does not list goes back as it was.
        #expect(body["events"] as? [String] == ["futureEvent", "push", "release"])
    }

    @Test("the calls go where the dashboard's go")
    func paths() {
        let draft = GithubWatchDraft()
        let base = "/api/v2/guilds/1/modules/github/watches"
        #expect(Endpoints.LoadGithubWatches(server: "1").path == base)
        #expect(Endpoints.LoadGithubWatches(server: "1").method == .get)
        #expect(Endpoints.SaveGithubWatch(server: "1", draft: draft).path == base)
        #expect(Endpoints.SaveGithubWatch(server: "1", draft: draft).method == .post)
        #expect(Endpoints.SaveGithubWatch(server: "1", id: 3, draft: draft).path == base + "/3")
        #expect(Endpoints.DeleteGithubWatch(server: "1", id: 3).path == base + "/3/delete")
        #expect(Endpoints.ToggleGithubWatch(server: "1", id: 3).path == base + "/3/toggle")
        #expect(Endpoints.RegenerateGithubSecret(server: "1", id: 3).path == base + "/3/regen-secret")
        #expect(Endpoints.RegenerateGithubSecret(server: "1", id: 3).method == .post)
    }
}

/// The server's side of the watches for the model tests.
final class FakeGithubServer: @unchecked Sendable {
    // @unchecked: every field is only touched while holding `lock`.
    private let lock = NSLock()
    private var _calls: [String] = []
    private var _watches: [GithubWatch]
    private var _failure: NetworkError?
    private var nextID = 40
    private var secretCount = 0

    init(watches: [GithubWatch] = []) { _watches = watches }

    var calls: [String] { lock.withLock { _calls } }
    var watches: [GithubWatch] { lock.withLock { _watches } }

    func fail(with error: NetworkError?) { lock.withLock { _failure = error } }
    func removeAll() { lock.withLock { _watches = [] } }

    private func record(_ call: String) { lock.withLock { _calls.append(call) } }

    private static func replacing(_ old: GithubWatch, enabled: Bool? = nil, secret: String? = nil) -> GithubWatch {
        GithubWatch(
            id: old.id, repo: old.repo, channelId: old.channelId, roleId: old.roleId,
            changelogPath: old.changelogPath, events: old.events, enabled: enabled ?? old.enabled,
            secret: secret ?? old.secret, webhookUrl: old.webhookUrl)
    }

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.LoadGithubWatches {
                record("list")
                return GithubWatchesPage(
                    watches: watches, channels: [ChannelOption(id: feedChannel, name: "dev-feed")],
                    roles: [RoleOption(id: devRole, name: "Devs")])
            }
            if let save = endpoint as? Endpoints.SaveGithubWatch {
                record("save:\(save.id.map(String.init) ?? "new")")
                if let error = lock.withLock({ _failure }) { throw error }
                // The server answers 404 for a watch that is gone.
                if let id = save.id, lock.withLock({ !_watches.contains { $0.id == id } }) {
                    throw NetworkError.notFound(message: "No such watch")
                }
                return lock.withLock {
                    let id = save.id ?? nextID
                    if save.id == nil { nextID += 1 }
                    let draft = save.draft
                    let old = _watches.first { $0.id == id }
                    let watch = GithubWatch(
                        id: id, repo: GithubInput.repo(from: draft.repo) ?? draft.repo, channelId: draft.channelId,
                        roleId: draft.roleId, changelogPath: draft.changelogPath, events: draft.events.sorted(),
                        enabled: old?.enabled ?? true, secret: old?.secret ?? "generated-\(id)",
                        webhookUrl: "https://sylo.example.com/webhooks/github/t\(id)")
                    if let index = _watches.firstIndex(where: { $0.id == id }) {
                        _watches[index] = watch
                    } else {
                        _watches.append(watch)
                    }
                    return GithubWatchAnswer(watch: watch)
                }
            }
            if let toggle = endpoint as? Endpoints.ToggleGithubWatch {
                record("toggle:\(toggle.id)")
                if let error = lock.withLock({ _failure }) { throw error }
                return lock.withLock {
                    guard let index = _watches.firstIndex(where: { $0.id == toggle.id }) else {
                        return GithubWatchAnswer(watch: nil)
                    }
                    let flipped = Self.replacing(_watches[index], enabled: !_watches[index].enabled)
                    _watches[index] = flipped
                    return GithubWatchAnswer(watch: flipped)
                }
            }
            if let regen = endpoint as? Endpoints.RegenerateGithubSecret {
                record("regen:\(regen.id)")
                if let error = lock.withLock({ _failure }) { throw error }
                // The real answer for a watch that is gone is a 404, not a null watch.
                if lock.withLock({ !_watches.contains { $0.id == regen.id } }) {
                    throw NetworkError.notFound(message: "No such watch")
                }
                return lock.withLock {
                    guard let index = _watches.firstIndex(where: { $0.id == regen.id }) else {
                        return GithubWatchAnswer(watch: nil)
                    }
                    secretCount += 1
                    let fresh = Self.replacing(_watches[index], secret: "regenerated-\(secretCount)")
                    _watches[index] = fresh
                    return GithubWatchAnswer(watch: fresh)
                }
            }
            if let delete = endpoint as? Endpoints.DeleteGithubWatch {
                record("delete:\(delete.id)")
                if let error = lock.withLock({ _failure }) { throw error }
                lock.withLock { _watches.removeAll { $0.id == delete.id } }
                return EmptyResponse()
            }
            throw NetworkError.notFound
        }
    }
}

@MainActor
@Suite("GitHub alerts: the screen's model")
struct GithubAlertsModelTests {
    static let stored = GithubWatch(
        id: 3, repo: "owner/repo", channelId: feedChannel, events: ["push"], secret: "old-secret",
        webhookUrl: "https://sylo.example.com/webhooks/github/t3")

    func make(_ server: FakeGithubServer) async -> GithubAlertsModel {
        let model = GithubAlertsModel(server: "9", session: makeSignedInSession(clients: server.clients()))
        await model.load()
        return model
    }

    @Test("loading fills the list, the channels, the roles and the event types")
    func loads() async {
        let model = await make(FakeGithubServer(watches: [Self.stored]))

        #expect(model.hasLoaded)
        #expect(model.watches.map(\.id) == [3])
        #expect(model.channels.map(\.name) == ["dev-feed"])
        #expect(model.roles.map(\.name) == ["Devs"])
        #expect(model.eventTypes == GithubEventType.standard)
        #expect(model.dashboardUrlSet)
    }

    @Test("a page that cannot be loaded says why")
    func loadFails() async {
        let model = GithubAlertsModel(
            server: "9", session: makeSignedInSession(clients: StubClients { _ in throw NetworkError.notFound }))
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage != nil)
    }

    @Test("a new watch is added to the list with the secret the server made")
    func creates() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)

        #expect(await model.save(GithubDraftTests.valid(), editing: nil))

        #expect(server.calls == ["list", "save:new"])
        #expect(model.watches.map(\.id) == [3, 40])
        #expect(model.watch(id: 40)?.secret == "generated-40")
    }

    @Test("a draft that is not ready is not sent")
    func refusesBeforeSending() async {
        let server = FakeGithubServer()
        let model = await make(server)

        #expect(!(await model.save(GithubWatchDraft(), editing: nil)))

        #expect(model.saveError == "Enter a repo as owner/repo (or paste its github.com URL).")
        #expect(server.calls == ["list"])
    }

    @Test("an edit replaces the watch and keeps its secret")
    func updates() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)
        var draft = GithubWatchDraft(editing: Self.stored)
        draft.events = ["push", "release"]

        #expect(await model.save(draft, editing: 3))

        #expect(server.calls == ["list", "save:3"])
        #expect(model.watch(id: 3)?.events == ["push", "release"])
        #expect(model.watch(id: 3)?.secret == "old-secret")
    }

    @Test("a refused save keeps the list and the server's words")
    func saveFails() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)
        server.fail(with: .badRequest(message: "Pick a channel."))

        #expect(!(await model.save(GithubDraftTests.valid(), editing: nil)))

        #expect(model.saveError == "Pick a channel.")
        #expect(model.watches.map(\.id) == [3])
    }

    @Test("a regenerated secret replaces the one the list holds")
    func regeneratedSecretReplaces() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)
        #expect(model.watch(id: 3)?.secret == "old-secret")

        let done = await model.regenerateSecret(3)

        #expect(done)
        #expect(server.calls == ["list", "regen:3"])
        #expect(model.watch(id: 3)?.secret == "regenerated-1")
        #expect(model.watch(id: 3)?.webhookUrl == "https://sylo.example.com/webhooks/github/t3")
        #expect(model.watches.count == 1)

        #expect(await model.regenerateSecret(3))
        #expect(model.watch(id: 3)?.secret == "regenerated-2")
    }

    @Test("a refused new secret keeps the old one and says why")
    func regenerateFails() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)
        server.fail(with: .forbidden(message: "You can't change watches."))

        let done = await model.regenerateSecret(3)

        #expect(!done)
        #expect(model.watch(id: 3)?.secret == "old-secret")
        #expect(model.actionError == "You can't change watches.")
    }

    @Test("a new secret for a watch that is gone (404 No such watch) removes the stale row and says why")
    func regenerateGone() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)
        server.removeAll()

        #expect(!(await model.regenerateSecret(3)))

        #expect(server.calls == ["list", "regen:3"])
        #expect(model.watches.isEmpty)
        #expect(model.actionError == "No such watch")
    }

    @Test("an edit of a watch that is gone (404) removes the stale row and says why")
    func updateGone() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)
        server.removeAll()

        #expect(!(await model.save(GithubWatchDraft(editing: Self.stored), editing: 3)))

        #expect(model.watches.isEmpty)
        #expect(model.saveError == "No such watch")
    }

    @Test("pause and resume take the watch from the server's answer, a deleted one leaves the list")
    func toggles() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)

        await model.toggle(3)
        #expect(model.watch(id: 3)?.enabled == false)
        await model.toggle(3)
        #expect(model.watch(id: 3)?.enabled == true)

        server.removeAll()
        await model.toggle(3)
        #expect(model.watches.isEmpty)
        #expect(model.actionError == nil)
    }

    @Test("a delete removes the watch, a refused one keeps it and says why")
    func deletes() async {
        let server = FakeGithubServer(watches: [Self.stored])
        let model = await make(server)

        server.fail(with: .forbidden(message: "You can't change watches."))
        await model.delete(3)
        #expect(model.watches.count == 1)
        #expect(model.actionError == "You can't change watches.")

        server.fail(with: nil)
        await model.delete(3)
        #expect(model.watches.isEmpty)
    }
}
