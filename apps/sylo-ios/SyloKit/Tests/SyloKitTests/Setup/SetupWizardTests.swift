import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// What `GET .../setup/suggest` sends: a welcome item with a channel found by name, a mod-log item that is
/// already set up with a channel others can see, and a verification item that cannot run.
private let proposalJSON = #"""
    {"platform":"discord","inspected":{"channels":3,"roles":2,"members":10},
     "botCan":{"createChannels":true,"createRoles":null},
     "goals":[{"id":"welcome","label":"Welcome new members","description":"Greet people."},
              {"id":"moderation","label":"Moderation and logging","description":"Logs."}],
     "channels":[
       {"id":"100","name":"welcome","problem":null,"exposure":{"everyone":true,"roles":[]}},
       {"id":"101","name":"mod-log","problem":null,"exposure":{"everyone":false,"roles":[{"id":"900","name":"Mods"}]}},
       {"id":"102","name":"locked","problem":"Sylo can't post there: it is missing Send Messages."}],
     "roles":[{"id":"200","name":"Verified","problem":"Sylo can't give this role."},{"id":"201","name":"Member","problem":null}],
     "items":[
       {"id":"welcome","goal":"welcome","name":"Welcome","does":"Greets new members.","configured":false,"enabled":false,
        "blocked":[],"warnings":[],"fields":[
          {"key":"joinChannel","kind":"channel","label":"Welcome channel","optional":false,"post":true,"give":false,
           "match":{"id":"100","name":"welcome"},"unsafeMatch":null,"problem":null,"viewer":false,"viewerOnly":false,"staffOnly":false,
           "create":{"name":"welcome","kind":"channel","private":false,"readOnly":true,"everyoneCanView":false,"existing":null}}]},
       {"id":"modlog","goal":"moderation","name":"Mod-log channel","does":"","configured":true,"enabled":null,
        "blocked":[],"warnings":["Sylo needs the View Audit Log permission."],"fields":[
          {"key":"channel","kind":"channel","label":"Mod-log channel","optional":false,"post":true,"give":false,
           "match":null,"unsafeMatch":{"id":"101","name":"mod-log","gap":"Members with the Mods role can see it."},"problem":null,
           "viewer":false,"viewerOnly":false,"staffOnly":true,
           "create":{"name":"mod-log","kind":"channel","private":true,"readOnly":false,"everyoneCanView":false,
                     "existing":{"id":"101","name":"mod-log","gap":"Members with the Mods role can see it."}}},
          {"key":"staffRole","kind":"role","label":"Role that can see it","optional":true,"post":false,"give":false,
           "match":null,"unsafeMatch":null,"problem":null,"viewer":true,"viewerOnly":true,"staffOnly":false,"create":null}]},
       {"id":"verification","goal":"moderation","name":"Verification","does":"","configured":false,"enabled":false,
        "blocked":["Server Members Intent"],"warnings":[],"fields":[
          {"key":"verifiedRoleId","kind":"role","label":"Verified role","optional":false,"post":false,"give":true,
           "match":null,"unsafeMatch":null,"problem":null,"viewer":false,"viewerOnly":false,"staffOnly":false,
           "create":{"name":"Verified","kind":"role","private":false,"readOnly":false,"everyoneCanView":false,"existing":null}}]}]}
    """#

private func proposal() throws -> SetupProposal { try decode(SetupProposal.self, proposalJSON) }

private func json(_ value: some Encodable) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
}

@Suite("Setup wizard proposal")
struct SetupProposalTests {
    @Test("The proposal reads: counts, what Sylo can create, goals, channels, roles and items")
    func decodes() throws {
        let p = try proposal()
        #expect(p.platform == .discord)
        #expect(p.channelCount == 3)
        #expect(p.roleCount == 2)
        #expect(p.memberCount == 10)
        #expect(p.canCreateChannels == true)
        // The platform cannot say whether Sylo may create roles: Sylo tries and reports the answer.
        #expect(p.canCreateRoles == nil)
        #expect(p.goals.map(\.id) == ["welcome", "moderation"])
        #expect(p.channels.map(\.id) == ["100", "101", "102"])
        #expect(p.channels[1].exposure?.roles.map(\.name) == ["Mods"])
        #expect(p.channels[2].exposure == nil)
        #expect(p.roles[0].problem != nil)
        #expect(p.items.map(\.id) == ["welcome", "modlog", "verification"])
        let welcome = p.items[0]
        #expect(welcome.fields[0].match?.id == "100")
        #expect(welcome.fields[0].create?.readOnly == true)
        #expect(welcome.fields[0].create?.existing == nil)
        #expect(p.items[1].fields[0].unsafeMatch?.gap == "Members with the Mods role can see it.")
        #expect(p.items[1].fields[0].create?.existing?.gap != nil)
        #expect(p.items[2].blocked == ["Server Members Intent"])
        #expect(!p.items[2].isUsable)
        #expect(p.items[1].fields[1].viewerOnly)
    }

    @Test("An empty or odd answer still reads")
    func lenient() throws {
        let empty = try decode(SetupProposal.self, "{}")
        #expect(empty.items.isEmpty)
        #expect(empty.canCreateChannels == nil)
        let odd = try decode(SetupProposal.self, #"{"items":[{"nope":1}],"botCan":7,"inspected":"x"}"#)
        #expect(odd.items.isEmpty)
    }

    @Test("The calls go where the server expects")
    func endpoints() throws {
        #expect(Endpoints.SuggestSetup(server: "fluxer:9").path == "/api/v2/guilds/fluxer%3A9/setup/suggest")
        let apply = Endpoints.ApplySetup(server: "1", request: SetupApplyRequest(items: []))
        #expect(apply.path == "/api/v2/guilds/1/setup/apply")
        #expect(apply.method == .post)
    }
}

@Suite("Setup wizard choices")
struct SetupDraftTests {
    @Test("At first nothing is created or changed and no goal is ticked")
    func initialChoices() throws {
        let draft = SetupDraft(proposal: try proposal())
        #expect(draft.goals.isEmpty)
        #expect(draft.activeItems.isEmpty)
        // A set-up item and one that cannot run are off; a fresh one is on once its goal is ticked.
        #expect(draft.choices["welcome"]?.isOn == true)
        #expect(draft.choices["modlog"]?.isOn == false)
        #expect(draft.choices["verification"]?.isOn == false)
        // What was found by name is picked; a channel others can see is not.
        #expect(draft.choices["welcome"]?.fields["joinChannel"] == SetupFieldChoice(mode: .pick, id: "100", fix: false))
        #expect(draft.choices["modlog"]?.fields["channel"]?.id == "")
        #expect(draft.choices["modlog"]?.fields["channel"]?.mode == .pick)
    }

    @Test("A goal is done when every usable item of it is set up")
    func goalDone() throws {
        let draft = SetupDraft(proposal: try proposal())
        #expect(!draft.isDone(goal: "welcome"))
        // Moderation has one set-up item and one that cannot run, which does not count.
        #expect(draft.isDone(goal: "moderation"))
    }

    @Test("Ticking a goal switches on its fresh items only")
    func activeItems() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["welcome", "moderation"]
        #expect(draft.activeItems.map(\.id) == ["welcome"])
    }

    @Test("An empty required field stops the item until a channel is picked or Create is ticked")
    func problems() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["welcome"]
        let welcome = try #require(draft.proposal.items.first { $0.id == "welcome" })
        #expect(draft.problems(for: welcome).isEmpty)
        draft.choices["welcome"]?.fields["joinChannel"]?.id = ""
        #expect(draft.problems(for: welcome) == ["Welcome channel: pick one, or tick Create."])
        #expect(draft.review.problemCount == 1)
        draft.choices["welcome"]?.fields["joinChannel"]?.mode = .create
        #expect(draft.problems(for: welcome).isEmpty)
        #expect(draft.review.problemCount == 0)
    }

    @Test("A channel Sylo cannot post in, or a channel that is gone, is refused where Sylo posts")
    func refusals() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["welcome"]
        let welcome = try #require(draft.proposal.items.first { $0.id == "welcome" })
        draft.choices["welcome"]?.fields["joinChannel"]?.id = "102"
        #expect(draft.problems(for: welcome) == ["Welcome channel: Sylo can't post there: it is missing Send Messages."])
        draft.choices["welcome"]?.fields["joinChannel"]?.id = "999"
        #expect(draft.problems(for: welcome) == ["Welcome channel: that channel is not on this server any more."])
    }

    @Test("The review lists what applying would create, and one button ticks every missing Create")
    func review() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["welcome"]
        draft.choices["welcome"]?.fields["joinChannel"]?.id = ""
        #expect(draft.missingCreates.map { $0.field } == ["joinChannel"])
        #expect(draft.review.channelsToCreate.isEmpty)
        draft.tickAllCreates()
        #expect(draft.review.channelsToCreate == ["welcome"])
        #expect(draft.review.rolesToCreate.isEmpty)
        #expect(draft.review.itemCount == 1)
        #expect(draft.review.replacedCount == 0)
    }

    @Test("A role to create is counted as a role")
    func rolesToCreate() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["moderation"]
        draft.choices["verification"]?.isOn = true
        draft.choices["verification"]?.fields["verifiedRoleId"]?.mode = .create
        #expect(draft.review.rolesToCreate == ["Verified"])
        #expect(draft.review.channelsToCreate.isEmpty)
    }

    @Test("Create is only sent for an explicit tick")
    func createNeedsATick() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["welcome"]
        let untouched = try json(draft.request)
        let items = try #require(untouched["items"] as? [[String: Any]])
        let fields = try #require(items[0]["fields"] as? [String: [String: Any]])
        #expect(fields["joinChannel"]?["create"] == nil)
        #expect(fields["joinChannel"]?["id"] as? String == "100")

        draft.choices["welcome"]?.fields["joinChannel"] = SetupFieldChoice(mode: .create, id: "", fix: false)
        let ticked = try json(draft.request)
        let tickedItems = try #require(ticked["items"] as? [[String: Any]])
        let tickedFields = try #require(tickedItems[0]["fields"] as? [String: [String: Any]])
        #expect(tickedFields["joinChannel"]?["create"] as? Bool == true)
        #expect(tickedFields["joinChannel"]?["id"] == nil)
    }

    @Test("Only an item that is already set up is replaced, and only when ticked on")
    func replace() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["moderation"]
        #expect(draft.request.items.isEmpty)
        draft.choices["modlog"]?.isOn = true
        draft.choices["modlog"]?.fields["channel"]?.id = "101"
        let item = try #require(draft.request.items.first)
        #expect(item.id == "modlog")
        #expect(item.replace)
        #expect(draft.review.replacedCount == 1)
    }

    @Test("A channel others can see is only changed when the person ticks it")
    func fix() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["moderation"]
        draft.choices["modlog"]?.isOn = true
        let modlog = try #require(draft.proposal.items.first { $0.id == "modlog" })
        let field = modlog.fields[0]
        draft.choices["modlog"]?.fields["channel"] = SetupFieldChoice(mode: .pick, id: "101", fix: false)
        // The channel is not private, and the wizard says how.
        #expect(draft.fixableChannel(item: modlog, field: field, channelID: "101")?.gap == "Members with the Mods role can see it.")
        #expect(draft.review.channelsToChange.isEmpty)
        var body = try json(draft.request)
        var fields = try #require((body["items"] as? [[String: Any]])?[0]["fields"] as? [String: [String: Any]])
        #expect(fields["channel"]?["fix"] == nil)

        draft.choices["modlog"]?.fields["channel"]?.fix = true
        #expect(draft.review.channelsToChange == ["mod-log"])
        body = try json(draft.request)
        fields = try #require((body["items"] as? [[String: Any]])?[0]["fields"] as? [String: [String: Any]])
        #expect(fields["channel"]?["fix"] as? Bool == true)
        #expect(fields["channel"]?["id"] as? String == "101")
    }

    @Test("A role for who may see a channel is sent only when it will be used")
    func viewerRole() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["moderation"]
        draft.choices["modlog"]?.isOn = true
        draft.choices["modlog"]?.fields["channel"] = SetupFieldChoice(mode: .pick, id: "101", fix: false)
        draft.choices["modlog"]?.fields["staffRole"] = SetupFieldChoice(mode: .pick, id: "201", fix: false)
        let modlog = try #require(draft.proposal.items.first { $0.id == "modlog" })
        #expect(!draft.viewerActive(modlog))
        var fields = try #require((try json(draft.request)["items"] as? [[String: Any]])?[0]["fields"] as? [String: [String: Any]])
        #expect(fields["staffRole"]?.isEmpty == true)

        draft.choices["modlog"]?.fields["channel"]?.fix = true
        #expect(draft.viewerActive(modlog))
        fields = try #require((try json(draft.request)["items"] as? [[String: Any]])?[0]["fields"] as? [String: [String: Any]])
        #expect(fields["staffRole"]?["id"] as? String == "201")
    }

    @Test("A staff-only channel another role can see names that role")
    func exposure() throws {
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["moderation"]
        let modlog = try #require(draft.proposal.items.first { $0.id == "modlog" })
        let field = modlog.fields[0]
        #expect(draft.exposureGap(item: modlog, field: field, channelID: "101") == "Members with the Mods role can see it.")
        // The role picked as the one that may see it does not count.
        draft.choices["modlog"]?.fields["staffRole"] = SetupFieldChoice(mode: .pick, id: "900", fix: false)
        #expect(draft.exposureGap(item: modlog, field: field, channelID: "101") == nil)
        // A channel everyone can see.
        #expect(draft.exposureGap(item: modlog, field: field, channelID: "100") == "Everyone can see it.")
        // A channel the proposal did not describe.
        #expect(draft.exposureGap(item: modlog, field: field, channelID: "102") == nil)
    }

    @Test("The overview offers the wizard below three set-up modules")
    func offer() throws {
        func overview(on count: Int) throws -> ServerOverview {
            let cards = (0..<count).map { #"{"kind":"module","id":"m\#($0)","name":"M\#($0)","hasToggle":true,"enabled":true,"status":"on"}"# }
            let off = #"{"kind":"module","id":"off","name":"Off","hasToggle":true,"enabled":false,"status":"off"}"#
            let joined = (cards + [off]).joined(separator: ",")
            return try decode(ServerOverview.self, #"{"guild":{"id":"1","name":"A"},"groups":[{"title":"G","cards":[\#(joined)]}]}"#)
        }
        #expect(SetupDraft.shouldOffer(overview: try overview(on: 0)))
        #expect(SetupDraft.shouldOffer(overview: try overview(on: 2)))
        #expect(!SetupDraft.shouldOffer(overview: try overview(on: 3)))
    }

    @Test("A module that is on but has a setup problem does not count as set up")
    func offerCountsProblems() throws {
        let overview = try decode(ServerOverview.self, #"""
            {"guild":{"id":"1","name":"A"},"groups":[{"title":"G","cards":[
              {"kind":"module","id":"a","name":"A","hasToggle":true,"enabled":true,"status":"on"},
              {"kind":"module","id":"b","name":"B","hasToggle":true,"enabled":true,"status":"on"},
              {"kind":"module","id":"c","name":"C","hasToggle":true,"enabled":true,"status":"on"}]}],
             "attention":{"problems":[{"id":"c","name":"C","issues":["x"]}]}}
            """#)
        #expect(SetupDraft.shouldOffer(overview: overview))
    }
}

@Suite("Setup wizard results")
struct SetupResultTests {
    @Test("The answer shows reuse, creation, changes, partial results and warnings as the server returns them")
    func decodes() throws {
        let answer = try decode(SetupApplyAnswer.self, #"""
            {"results":[
              {"id":"welcome","name":"Welcome","status":"applied","message":"Welcome is set up.","warnings":["Sylo can't ping there."],
               "created":[{"kind":"channel","name":"welcome","id":"500"}],"reused":[{"kind":"role","name":"Member","id":"201"}],"changed":[]},
              {"id":"modlog","name":"Mod-log channel","status":"failed","message":"Created #mod-log, then Sylo could not save it.",
               "warnings":[],"created":[{"kind":"channel","name":"mod-log","id":"501"}]},
              {"id":"verification","name":"Verification","status":"skipped","message":"Already set up."},
              {"id":"x","status":"paused"}]}
            """#)
        #expect(answer.results.map(\.status) == [.applied, .failed, .skipped, .other("paused")])
        let first = answer.results[0]
        #expect(first.warnings == ["Sylo can't ping there."])
        #expect(first.created == [SetupTouched(kind: "channel", name: "welcome", id: "500")])
        #expect(first.reused.first?.name == "Member")
        // A failed item says what was made before it failed.
        #expect(answer.results[1].created.first?.name == "mod-log")
        #expect(answer.results[1].message.contains("Created #mod-log"))
        #expect(answer.results[2].created.isEmpty)
        #expect(SetupResultStatus.applied.label == "Set up")
        #expect(SetupResultStatus.skipped.label == "Left as it is")
        #expect(SetupResultStatus.failed.label == "Not set up")
    }
}

@MainActor
@Suite("Setup wizard model")
struct SetupWizardModelTests {
    nonisolated static let proposal = try! decode(SetupProposal.self, proposalJSON)

    @Test("The steps go look, goals, review, done, and review needs a goal")
    func steps() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SuggestSetup { return Self.proposal }
            return SetupApplyAnswer(results: [SetupResult(id: "welcome", name: "Welcome", status: .applied, message: "Done")])
        }
        let model = SetupWizardModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.step == .look)
        model.goToGoals()
        #expect(model.step == .goals)
        model.goToReview()
        #expect(model.step == .goals)
        model.setGoal("welcome", on: true)
        model.goToReview()
        #expect(model.step == .review)
        #expect(model.canApply)
        model.back()
        #expect(model.step == .goals)
        model.goToReview()
        await model.apply()
        #expect(model.step == .done)
        #expect(model.results.map(\.status) == [.applied])
        let sent = clients.calls.compactMap { $0.endpoint as? Endpoints.ApplySetup }.first
        #expect(sent?.request.items.map(\.id) == ["welcome"])
    }

    @Test("Apply stays off while a field is empty or refused")
    func canApply() async {
        let clients = StubClients { _ in Self.proposal }
        let model = SetupWizardModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.canApply)
        model.setGoal("welcome", on: true)
        #expect(model.canApply)
        model.update { $0.choices["welcome"]?.fields["joinChannel"]?.id = "" }
        #expect(!model.canApply)
        await model.apply()
        #expect(model.step != .done)
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ApplySetup })
    }

    @Test("A Sylo without the wizard answers 404 and the wizard is hidden")
    func olderServer() async {
        let clients = StubClients { _ in throw NetworkError.notFound }
        let model = SetupWizardModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.isAvailable)
        #expect(model.errorMessage == nil)
        #expect(model.draft == nil)
    }

    @Test("A refusal as a whole keeps the review and shows the server's words")
    func refused() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SuggestSetup { return Self.proposal }
            throw NetworkError.http(status: HTTPStatus(409, message: "The setup is already running for this server."))
        }
        let model = SetupWizardModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        model.setGoal("welcome", on: true)
        model.goToGoals()
        model.goToReview()
        await model.apply()
        #expect(model.step == .review)
        #expect(model.errorMessage == "The setup is already running for this server.")
        #expect(model.canApply)
    }

    @Test("A person who may only view cannot apply: the server refuses and says so")
    func viewOnlyRefused() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.SuggestSetup { return Self.proposal }
            throw NetworkError.forbidden(message: "Your dashboard access in this server is View only, so you can't do this.")
        }
        let model = SetupWizardModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        model.setGoal("welcome", on: true)
        model.goToGoals()
        model.goToReview()
        await model.apply()
        #expect(model.step == .review)
        #expect(model.errorMessage?.contains("View only") == true)
    }
}

extension APIClientTests {
    private func setupClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    @Test("The apply goes out as the server reads it: items with id, replace and only the keys that are set")
    func setupApplyOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"results":[{"id":"welcome","name":"Welcome","status":"applied","message":"ok"}]}"#)])
        var draft = SetupDraft(proposal: try proposal())
        draft.goals = ["welcome"]
        draft.choices["welcome"]?.fields["joinChannel"] = SetupFieldChoice(mode: .create, id: "", fix: false)
        let answer = try await setupClient().send(Endpoints.ApplySetup(server: "1", request: draft.request))
        #expect(answer.results.first?.status == .applied)

        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/setup/apply")
        #expect(request.method == "POST")
        let body = try #require(try JSONSerialization.jsonObject(with: try #require(request.body)) as? [String: Any])
        #expect(Set(body.keys) == ["items"])
        let item = try #require((body["items"] as? [[String: Any]])?.first)
        #expect(Set(item.keys) == ["id", "replace", "fields"])
        #expect(item["replace"] as? Bool == false)
        let fields = try #require(item["fields"] as? [String: [String: Any]])
        #expect(fields["joinChannel"] as? [String: Bool] == ["create": true])
    }

    @Test("The proposal is a plain GET")
    func setupSuggestOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, proposalJSON)])
        let p = try await setupClient().send(Endpoints.SuggestSetup(server: "fluxer:9"))
        #expect(p.items.count == 3)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/fluxer%3A9/setup/suggest")
        #expect(request.method == "GET")
    }
}
