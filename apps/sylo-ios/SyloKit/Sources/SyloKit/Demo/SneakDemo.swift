import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Capture-only demo server for screen recordings. This file exists on a branch that is never merged.
// A launch argument makes the app talk to this canned Sylo 5.2 instead of a network: every answer has
// the shape of a real one (docs/mobile-app.md), with invented names only.

public enum SneakDemo {
    /// Launch argument that switches the app to the canned server.
    public static let launchArgument = "-SyloSneakDemo"

    /// A client whose every call is answered by ``SneakURLProtocol``, through the real decoders.
    public static func makeClient(server: ServerURL, token: String?) -> URLSessionAPIClient {
        let configuration = URLSessionAPIClient.defaultConfiguration()
        configuration.protocolClasses = [SneakURLProtocol.self]
        let session = URLSession(configuration: configuration)
        return URLSessionAPIClient(server: server, session: session, retryDelays: [], token: { token })
    }
}

final class SneakURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read)
        let reply = SneakServer.answer(
            method: request.httpMethod ?? "GET", path: request.url?.path ?? "", body: body)
        let headers = ["Content-Type": "application/json; charset=utf-8"]
        if let url = request.url,
           let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers) {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(reply.json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
        }
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// The canned Sylo: routes a request to a JSON answer and keeps the few facts a scene changes.
enum SneakServer {
    struct Reply {
        let status: Int
        let json: String
    }

    static let serverID = "9100000000000001"

    // MARK: State a scene changes

    private final class Decisions: @unchecked Sendable {
        private let lock = NSLock()
        private var map: [Int: (status: String, reason: String)] = [:]

        subscript(number: Int) -> (status: String, reason: String)? {
            get { lock.lock(); defer { lock.unlock() }; return map[number] }
            set { lock.lock(); defer { lock.unlock() }; map[number] = newValue }
        }
    }

    private static let decisions = Decisions()

    private struct Suggestion {
        let number: Int
        let title: String
        let text: String
        let status: String
        let reason: String
        let up: Int
        let down: Int
        let author: String
        let minutesAgo: Int
    }

    private static let suggestions: [Suggestion] = [
        Suggestion(number: 14, title: "Weekend build night",
                   text: "Let's run a community build night every Saturday, with a poll for the theme.",
                   status: "open", reason: "", up: 18, down: 1, author: "juniper", minutesAgo: 12),
        Suggestion(number: 13, title: "A pets channel",
                   text: "A place to share photos of our pets, with a slow mode so it stays calm.",
                   status: "open", reason: "", up: 24, down: 2, author: "tidepool", minutesAgo: 95),
        Suggestion(number: 12, title: "Focus voice room",
                   text: "A quiet voice channel for study and work sessions.",
                   status: "open", reason: "", up: 9, down: 0, author: "ember", minutesAgo: 300),
        Suggestion(number: 11, title: "Pin the roadmap",
                   text: "Keep the current roadmap pinned in the announcements channel.",
                   status: "approved", reason: "Added to the pinned messages.", up: 31, down: 0, author: "juniper",
                   minutesAgo: 2_900),
    ]

    /// The suggestions as they stand now, newest first, with the decisions made in this run applied.
    private static func currentSuggestions() -> [Suggestion] {
        suggestions.map { item in
            guard let decided = decisions[item.number] else { return item }
            return Suggestion(number: item.number, title: item.title, text: item.text, status: decided.status,
                              reason: decided.reason, up: item.up, down: item.down, author: item.author,
                              minutesAgo: item.minutesAgo)
        }
    }

    private static func openCount() -> Int {
        currentSuggestions().filter { $0.status == "open" || $0.status == "considering" }.count
    }

    private static func now() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
    private static func ago(minutes: Int) -> Int { now() - minutes * 60_000 }

    // MARK: Routing

    static func answer(method: String, path: String, body: Data?) -> Reply {
        let parts = path.split(separator: "/").map(String.init)
        if parts == ["api", "mobile", "info"] { return ok(info) }
        guard parts.count >= 3, parts[0] == "api", parts[1] == "v2" else { return notFound }
        let rest = Array(parts.dropFirst(2))
        if rest == ["guilds"] { return ok(guilds) }
        guard rest.count >= 3, rest[0] == "guilds", rest[1] == serverID else { return notFound }
        let route = Array(rest.dropFirst(2))
        switch (method, route) {
        case ("GET", ["overview"]): return ok(overview)
        case ("GET", ["health"]): return ok(healthReport)
        case ("GET", ["tickets"]): return ok(tickets)
        case ("GET", ["platform"]): return ok(#"{"platform":"discord","notes":{}}"#)
        case ("GET", ["settings"]): return ok(guildSettings)
        case ("GET", ["audit"]): return ok(auditLog)
        case ("GET", ["setup", "suggest"]): return ok(setupProposal)
        case ("GET", ["modules", "verification", "config"]): return ok(verificationConfig)
        case ("GET", ["modules", "suggestions", "config"]): return ok(suggestionsConfig)
        case ("GET", ["modules", "suggestions", "list"]): return ok(suggestionList)
        default: break
        }
        if method == "GET", route.count == 3, route[0] == "audit", route[2] == "change" {
            return ok(auditChange(id: route[1]))
        }
        if method == "POST", route.count == 3, route[0] == "audit", route[2] == "undo" {
            return ok(#"{"adjusted":[],"notRestored":[]}"#)
        }
        if method == "POST", route.count == 3, route[0] == "modules", route[1] == "suggestions",
           route[2] == "move-all-back" {
            return ok(#"{"moved":0,"remaining":0,"failed":[],"next":0}"#)
        }
        if method == "POST", route.count == 4, route[0] == "modules", route[1] == "suggestions", route[3] == "decision",
           let number = Int(route[2]) {
            return decide(number: number, body: body)
        }
        if method == "POST", route.count == 2, route[0] == "modules" {
            let enabled = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["enabled"] as? Bool
            return ok(#"{"enabled":\#(enabled ?? true)}"#)
        }
        return notFound
    }

    private static func ok(_ json: String) -> Reply { Reply(status: 200, json: json) }
    private static let notFound = Reply(status: 404, json: #"{"error":"Not found."}"#)

    private static func decide(number: Int, body: Data?) -> Reply {
        let object = body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        let action = object?["action"] as? String ?? "approve"
        let reason = object?["reason"] as? String ?? ""
        let status: String
        switch action {
        case "deny": status = "denied"
        case "implement": status = "implemented"
        case "consider": status = "considering"
        default: status = "approved"
        }
        decisions[number] = (status, reason)
        guard let item = currentSuggestions().first(where: { $0.number == number }) else { return notFound }
        return ok(#"{"suggestion":\#(suggestionJSON(item)),"moved":false,"copied":false,"dm":true}"#)
    }

    // MARK: Answers

    private static let info = #"""
    {"name":"Sylo","version":"5.2.0","apiVersion":1,"login":true,"loginProviders":["discord","fluxer"],
     "platforms":["discord","fluxer"],
     "features":["app-login","live-access","changelog","access-levels","health","config-history","config-import",
                 "duplicate","message-templates","message-move","inbox-search","setup-wizard","collectibles"]}
    """#

    private static let guilds = #"""
    {"guilds":[
      {"id":"9100000000000001","name":"Pixel Harbor","platform":"discord","openTickets":2,"unreadTickets":1,
       "memberCount":1284,"messagesToday":3120},
      {"id":"9100000000000002","name":"Quiet Orchard","platform":"discord","memberCount":212,"messagesToday":96},
      {"id":"fluxer:9100000000000003","name":"Lantern Club","platform":"fluxer","memberCount":57}
    ]}
    """#

    private static var channelsJSON: String {
        #"""
        [{"id":"c-welcome","name":"welcome"},{"id":"c-rules","name":"rules"},{"id":"c-verify","name":"verify"},
         {"id":"c-lobby","name":"lobby"},{"id":"c-modlog","name":"mod-log"},{"id":"c-ideas","name":"ideas"}]
        """#
    }

    private static var rolesJSON: String {
        #"""
        [{"id":"r-admin","name":"Harbor Masters"},{"id":"r-mod","name":"Dockhands"},
         {"id":"r-verified","name":"Verified"},{"id":"r-member","name":"Crew"}]
        """#
    }

    private static func card(_ id: String, _ name: String, _ icon: String, enabled: Bool, beta: Bool = false,
                             lines: [(String, String, String)] = []) -> String {
        let status = enabled ? "on" : "off"
        let rendered = lines.map { #"{"label":"\#($0.0)","value":"\#($0.1)","state":"\#($0.2)"}"# }.joined(separator: ",")
        return #"{"kind":"module","id":"\#(id)","name":"\#(name)","icon":"\#(icon)","hasToggle":true,"enabled":\#(enabled),"beta":\#(beta),"missingIntents":[],"status":"\#(status)","lines":[\#(rendered)]}"#
    }

    private static var overview: String {
        let core = [
            #"{"kind":"link","id":"general","name":"Settings","icon":"gear","hasToggle":false,"status":"link","lines":[]}"#,
            card("logging", "Logging", "file-text", enabled: true, lines: [("Log channel", "#mod-log", "on")]),
            card("moderation", "Moderation", "gavel", enabled: true, lines: [("Mod log", "#mod-log", "on")]),
            card("verification", "Verification", "shield-check", enabled: true,
                 lines: [("Verified role", "@Verified", "on"), ("Channel", "#verify", "on")]),
            card("tickets", "Tickets", "ticket", enabled: true, lines: [("Open", "2", "on")]),
        ].joined(separator: ",")
        let engagement = [
            card("welcome", "Welcome", "user-plus", enabled: true, lines: [("Channel", "#welcome", "on")]),
            card("leveling", "Leveling", "trending-up", enabled: true, lines: [("Level-up channel", "#lobby", "on")]),
            card("suggestions", "Suggestions", "lightbulb", enabled: true, lines: [("Channel", "#ideas", "on")]),
            card("starboard", "Starboard", "star", enabled: false),
            card("auto-react", "Auto-react", "smile", enabled: false, beta: true),
        ].joined(separator: ",")
        return #"""
        {"guild":{"id":"9100000000000001","name":"Pixel Harbor","memberCount":1284},
         "openTickets":2,"openAppeals":0,
         "groups":[{"title":"Core","cards":[\#(core)]},{"title":"Engagement","cards":[\#(engagement)]}],
         "attention":{"problems":[],"waitingForOwner":[],"platform":"discord","missingPermissions":[],
           "waiting":{"tickets":2,"appeals":0,"applications":0,"suggestions":\#(openCount())},
           "health":\#(healthReport)}}
        """#
    }

    private static var healthReport: String {
        #"""
        {"available":true,"platform":"discord","checkedAt":\#(ago(minutes: 1)),
         "summary":{"errors":1,"warnings":2},
         "checks":[
          {"module":"verification","moduleName":"Verification","severity":"error","code":"role-above",
           "kind":"role-hierarchy","message":"Sylo can't give Verified: Sylo's role is not above it.",
           "fix":"Move Sylo's role above Verified in Server Settings > Roles.",
           "targetKind":"role","targetId":"r-verified","targetName":"Verified"},
          {"module":"verification","moduleName":"Verification","severity":"warning","code":"missing-embed-links",
           "kind":"channel-permission","message":"Sylo can't send embeds in #verify: it is missing Embed Links.",
           "fix":"Give Sylo's role Embed Links in #verify.",
           "targetKind":"channel","targetId":"c-verify","targetName":"verify"},
          {"module":"welcome","moduleName":"Welcome","severity":"warning","code":"missing-channel-permission",
           "kind":"channel-permission","message":"Sylo can't post in #welcome: it is missing Send Messages.",
           "fix":"Give Sylo's role Send Messages in #welcome.",
           "targetKind":"channel","targetId":"c-welcome","targetName":"welcome"}],
         "targets":{"roles":{"blockedAll":null,"blocked":{"r-verified":"above"}},
                    "channels":{"blocked":{"c-welcome":["Send Messages"]},"noEmbed":["c-verify"]}}}
        """#
    }

    private static var tickets: String {
        #"""
        {"open":[
          {"id":1,"user":"member#0001","userId":"1","preview":"My role is gone after the update, can you check?",
           "previewKind":"user","ago":"2m ago","lastAt":\#(ago(minutes: 2)),"unread":true},
          {"id":2,"user":"gamer#4242","userId":"2","preview":"Thanks, that worked!","previewKind":"staff",
           "ago":"3h ago","lastAt":\#(ago(minutes: 180)),"unread":false}],
         "closed":[]}
        """#
    }

    private static var guildSettings: String {
        #"""
        {"modlogChannelId":"c-modlog","botMasterRoleIds":["r-admin"],"embedColorHex":"#7aa2f7",
         "channels":\#(channelsJSON),"roles":\#(rolesJSON),"platform":"discord",
         "defaultCommandPrefix":"","effectiveCommandPrefix":"","commandPrefixMaxLength":5}
        """#
    }

    private static var verificationConfig: String {
        #"""
        {"config":{"mode":"button","verifiedRoleId":"r-verified","channelId":"c-verify",
                   "title":"Welcome aboard","message":"Press the button below to verify and open up the rest of Pixel Harbor.",
                   "successMessage":"You are verified, welcome to the harbor!","logChannelId":"c-modlog",
                   "kickAfterMinutes":0},
         "channels":\#(channelsJSON),"roles":\#(rolesJSON),"turnstileEnabled":false}
        """#
    }

    private static var auditLog: String {
        #"""
        {"kept":500,"hasMore":false,
         "entries":[
          {"id":3,"actor":"Maple (dashboard)","action":"module:welcome","detail":"saved","at":\#(ago(minutes: 38)),
           "hasChange":true},
          {"id":2,"actor":"Maple (app)","action":"module:verification","detail":"saved","at":\#(ago(minutes: 160)),
           "hasChange":true},
          {"id":1,"actor":"Tide (dashboard)","action":"settings:server","at":\#(ago(minutes: 700)),"hasChange":false}],
         "actions":[{"action":"module:welcome","count":1},{"action":"module:verification","count":1},
                    {"action":"settings:server","count":1}]}
        """#
    }

    private static func auditChange(id: String) -> String {
        let before: String
        let after: String
        if id == "2" {
            before = #"{"mode":"button","kickAfterMinutes":0,"successMessage":"You are verified."}"#
            after = #"{"mode":"button","kickAfterMinutes":60,"successMessage":"You are verified, welcome to the harbor!"}"#
        } else {
            before = #"{"joinChannel":"c-rules","joinMessage":"Welcome, {user}!","dmEnabled":false}"#
            after = #"{"joinChannel":"c-welcome","joinMessage":"Welcome to Pixel Harbor, {user}! Say hi in #lobby.","dmEnabled":true}"#
        }
        return #"""
        {"kind":"module","tooLarge":false,"before":\#(before),"after":\#(after),
         "names":{"c-rules":"#rules","c-welcome":"#welcome"},
         "undo":{"available":true,"reason":null,"state":"clean","laterChanges":[],"token":null,
                 "notRestored":[],"droppedSecrets":[]}}
        """#
    }

    private static func suggestionJSON(_ item: Suggestion) -> String {
        #"{"id":\#(item.number),"number":\#(item.number),"title":"\#(item.title)","text":"\#(item.text)","status":"\#(item.status)","reason":"\#(item.reason)","up":\#(item.up),"down":\#(item.down),"author":"\#(item.author)","anonymous":false,"createdAt":\#(ago(minutes: item.minutesAgo)),"canMoveBack":false}"#
    }

    private static func counts(_ items: [Suggestion]) -> String {
        func n(_ status: String) -> Int { items.filter { $0.status == status }.count }
        return #"{"all":\#(items.count),"open":\#(n("open")),"considering":\#(n("considering")),"approved":\#(n("approved")),"denied":\#(n("denied")),"implemented":\#(n("implemented"))}"#
    }

    private static var suggestionList: String {
        let items = currentSuggestions()
        return #"{"suggestions":[\#(items.map(suggestionJSON).joined(separator: ","))],"outside":0,"counts":\#(counts(items))}"#
    }

    private static var suggestionsConfig: String {
        let items = currentSuggestions()
        return #"""
        {"config":{"channel":"c-ideas","logChannel":"","logMode":"copy","anonymous":false,"dmAuthor":true,
                   "messagesToSuggestions":false,"cooldownSeconds":60,"staffRoles":["r-mod"]},
         "channels":\#(channelsJSON),"roles":\#(rolesJSON),
         "suggestions":[\#(items.map(suggestionJSON).joined(separator: ","))],"outside":0,"counts":\#(counts(items))}
        """#
    }

    private static let setupProposal = #"""
    {"platform":"discord","inspected":{"channels":6,"roles":4,"members":1284},
     "botCan":{"createChannels":true,"createRoles":true},
     "goals":[
      {"id":"welcome","label":"Welcome new members","description":"Greet people in a channel and give them a starter role."},
      {"id":"verify","label":"Keep bots and raiders out","description":"A verification button that gives the Verified role."},
      {"id":"support","label":"Run a help desk","description":"Tickets members can open, with a staff role to answer."},
      {"id":"ideas","label":"Collect community ideas","description":"A suggestions channel with voting and staff decisions."}],
     "channels":[{"id":"c-welcome","name":"welcome"},{"id":"c-rules","name":"rules"},{"id":"c-verify","name":"verify"},
                 {"id":"c-lobby","name":"lobby"},{"id":"c-modlog","name":"mod-log"},{"id":"c-ideas","name":"ideas"}],
     "roles":[{"id":"r-admin","name":"Harbor Masters"},{"id":"r-mod","name":"Dockhands"},
              {"id":"r-verified","name":"Verified","problem":"Sylo's role is not above it."},{"id":"r-member","name":"Crew"}],
     "items":[
      {"id":"welcome","goal":"welcome","name":"Welcome","does":"Greets new members in the welcome channel.",
       "configured":false,"blocked":[],"warnings":[],"fields":[]},
      {"id":"verification","goal":"verify","name":"Verification","does":"Posts a Verify button and gives the Verified role.",
       "configured":true,"blocked":[],"warnings":[],"fields":[]},
      {"id":"tickets","goal":"support","name":"Tickets","does":"Lets members open private help tickets.",
       "configured":false,"blocked":[],"warnings":[],"fields":[]},
      {"id":"suggestions","goal":"ideas","name":"Suggestions","does":"Collects ideas with voting and staff decisions.",
       "configured":true,"blocked":[],"warnings":[],"fields":[]}]}
    """#
}
