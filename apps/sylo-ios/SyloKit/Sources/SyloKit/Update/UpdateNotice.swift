import Foundation
import Observation

// The operators' update notice (Sylo 5.3, `update-notice` in `GET /api/mobile/info`; src/web/routes/v2Update.js):
// whether a newer Sylo release is out, what is in it and the command to update by hand, and, when the instance runs
// Wise Wren, "Update now" with the progress of the run. Everything here is for operators only: the server answers
// anyone else 403, and the app shows it only to an operator. Sylo restarts during an update, so the requests fail
// for a while; the app keeps asking until the run is finished or Sylo reports another version.

extension ServerFeature {
    /// `GET /api/v2/update`, and with Wise Wren set up `POST /api/v2/update/wren/approve` and
    /// `GET /api/v2/update/wren/runs/:id`. Operators only.
    public static let updateNotice = ServerFeature(rawValue: "update-notice")
}

/// What `GET /api/v2/update` answers. Every field has a default, so a server of another version still reads.
public struct UpdateStatus: Decodable, Sendable, Equatable {
    /// False when the instance runs with `UPDATE_CHECK=off`: there is nothing else to show then.
    public let isEnabled: Bool
    /// The version that runs, for example `5.2.0`.
    public let current: String
    /// The newest release, nil when it was never read.
    public let latest: String?
    /// Whether `latest` is newer than `current`.
    public let isAvailable: Bool
    /// The last look at GitHub failed (`latest` then holds an earlier answer, if there was one).
    public let checkFailed: Bool
    public let releaseURL: URL?
    /// The release notes, only while an update is available. Shown as text, never as HTML.
    public let notes: ChangelogRelease?
    /// Release notes that are not in the usual format, as plain text.
    public let notesText: String?
    /// What to run by hand.
    public let command: String
    /// Wise Wren, nil when it is not set up.
    public let wren: WrenStatus?

    public static let defaultCommand = "docker compose pull && docker compose up -d"

    public init(
        isEnabled: Bool = true, current: String = "", latest: String? = nil, isAvailable: Bool = false,
        checkFailed: Bool = false, releaseURL: URL? = nil, notes: ChangelogRelease? = nil, notesText: String? = nil,
        command: String = UpdateStatus.defaultCommand, wren: WrenStatus? = nil
    ) {
        self.isEnabled = isEnabled
        self.current = current
        self.latest = latest
        self.isAvailable = isAvailable
        self.checkFailed = checkFailed
        self.releaseURL = releaseURL
        self.notes = notes
        self.notesText = notesText
        self.command = command
        self.wren = wren
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, current, latest, available, checkFailed, releaseUrl, notes, notesText, command, wren
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
        current = (try? c.decodeIfPresent(String.self, forKey: .current)) ?? ""
        latest = (try? c.decodeIfPresent(String.self, forKey: .latest)) ?? nil
        isAvailable = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? false
        checkFailed = (try? c.decodeIfPresent(Bool.self, forKey: .checkFailed)) ?? false
        releaseURL = ServerMarkdown.openable((try? c.decodeURLIfPresent(forKey: .releaseUrl)) ?? nil)
        // `try?`: notes of an odd shape must never lose the notice.
        notes = (try? c.decodeIfPresent(ChangelogRelease.self, forKey: .notes)) ?? nil
        notesText = (try? c.decodeIfPresent(String.self, forKey: .notesText)) ?? nil
        let sent = (try? c.decodeIfPresent(String.self, forKey: .command)) ?? nil
        command = (sent?.isEmpty == false ? sent : nil) ?? Self.defaultCommand
        wren = (try? c.decodeIfPresent(WrenStatus.self, forKey: .wren)) ?? nil
    }

    /// The sentence at the top of the notice.
    public var headline: String {
        if !isEnabled { return "Sylo \(current). The update check is off." }
        if isAvailable, let latest { return "Sylo \(latest) is available. This Sylo runs \(current)." }
        if checkFailed, latest == nil { return "Sylo \(current). The latest release could not be checked." }
        return "Sylo \(current) is up to date."
    }

    /// A short line for a list row.
    public var summary: String {
        if !isEnabled { return "Check is off" }
        if isAvailable, let latest { return "\(latest) is available" }
        if checkFailed, latest == nil { return "Couldn't check" }
        return "Up to date"
    }

    /// Whether the person should be told: a newer release, or an update that Wise Wren is running.
    public var needsAttention: Bool {
        if isAvailable { return true }
        if let run = wren?.latestRun { return !run.isFinished }
        return false
    }

    /// Whether to offer "Update now": Wise Wren is set up and answers, and there is an update to approve. Whether
    /// it can be pressed is the server's call (``WrenStatus/canApprove``, with the reason in ``WrenStatus/whyNot``).
    public var offersUpdateNow: Bool {
        guard let wren, wren.error == nil else { return false }
        return isAvailable || wren.updateSeen
    }
}

/// What Wise Wren says about Sylo's target. It never holds Wise Wren's address or Sylo's token.
public struct WrenStatus: Decodable, Sendable, Equatable {
    /// Wise Wren could not be asked, or does not accept Sylo's token.
    public struct Problem: Decodable, Sendable, Equatable {
        public let code: String
        public let message: String

        public init(code: String, message: String) {
            self.code = code
            self.message = message
        }

        private enum CodingKeys: String, CodingKey { case code, message }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            code = (try? c.decodeIfPresent(String.self, forKey: .code)) ?? ""
            message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
        }
    }

    public struct Target: Decodable, Sendable, Equatable {
        public let name: String
        public let status: String?
        public let installedVersion: String?
        public let latestVersion: String?
        public let mode: String?

        public init(
            name: String, status: String? = nil, installedVersion: String? = nil, latestVersion: String? = nil,
            mode: String? = nil
        ) {
            self.name = name
            self.status = status
            self.installedVersion = installedVersion
            self.latestVersion = latestVersion
            self.mode = mode
        }

        private enum CodingKeys: String, CodingKey { case name, status, installedVersion, latestVersion, mode }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil
            installedVersion = (try? c.decodeIfPresent(String.self, forKey: .installedVersion)) ?? nil
            latestVersion = (try? c.decodeIfPresent(String.self, forKey: .latestVersion)) ?? nil
            mode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? nil
        }
    }

    public let error: Problem?
    /// The dashboard has no login, so Update now is off unless the operator allowed it.
    public let isOpenMode: Bool
    public let target: Target?
    /// Wise Wren sees an update, whatever the GitHub check says (they can differ for a while).
    public let updateSeen: Bool
    public let canApprove: Bool
    /// The reason Update now is off, in words.
    public let whyNot: String?
    /// The run Sylo last approved. While it is not finished, Update now is off and the run is followed.
    public let latestRun: WrenRun?

    public init(
        error: Problem? = nil, isOpenMode: Bool = false, target: Target? = nil, updateSeen: Bool = false,
        canApprove: Bool = false, whyNot: String? = nil, latestRun: WrenRun? = nil
    ) {
        self.error = error
        self.isOpenMode = isOpenMode
        self.target = target
        self.updateSeen = updateSeen
        self.canApprove = canApprove
        self.whyNot = whyNot
        self.latestRun = latestRun
    }

    private enum CodingKeys: String, CodingKey {
        case error, openMode, target, updateSeen, canApprove, whyNot, latestRun
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        error = (try? c.decodeIfPresent(Problem.self, forKey: .error)) ?? nil
        isOpenMode = (try? c.decodeIfPresent(Bool.self, forKey: .openMode)) ?? false
        target = (try? c.decodeIfPresent(Target.self, forKey: .target)) ?? nil
        updateSeen = (try? c.decodeIfPresent(Bool.self, forKey: .updateSeen)) ?? false
        canApprove = (try? c.decodeIfPresent(Bool.self, forKey: .canApprove)) ?? false
        whyNot = (try? c.decodeIfPresent(String.self, forKey: .whyNot)) ?? nil
        latestRun = (try? c.decodeIfPresent(WrenRun.self, forKey: .latestRun)) ?? nil
    }
}

/// A Wise Wren run as the server shapes it (no step logs).
public struct WrenRun: Decodable, Sendable, Equatable {
    public struct Step: Decodable, Sendable, Equatable {
        public let step: String
        public let status: String

        public init(step: String, status: String) {
            self.step = step
            self.status = status
        }

        private enum CodingKeys: String, CodingKey { case step, status }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            step = (try? c.decodeIfPresent(String.self, forKey: .step)) ?? ""
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
        }
    }

    public let id: Int
    /// `queued`, `running`, `succeeded`, `rolled_back`, `failed`, `rollback_failed`, `refused`, `cancelled`,
    /// `lapsed`, or a state a newer Wise Wren adds.
    public let status: String
    public let isFinished: Bool
    public let detail: String?
    public let steps: [Step]

    /// The states in which Wise Wren is done with a run (all but `queued` and `running`).
    static let finishedStatuses: Set<String> = [
        "succeeded", "rolled_back", "failed", "rollback_failed", "refused", "cancelled", "lapsed",
    ]

    public init(id: Int, status: String, isFinished: Bool? = nil, detail: String? = nil, steps: [Step] = []) {
        self.id = id
        self.status = status
        self.isFinished = isFinished ?? Self.finishedStatuses.contains(status)
        self.detail = detail
        self.steps = steps
    }

    private enum CodingKeys: String, CodingKey { case id, status, finished, detail, steps }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        let status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "queued"
        self.status = status
        // `finished` is the server's word; without it the status decides.
        isFinished = (try? c.decodeIfPresent(Bool.self, forKey: .finished)) ?? Self.finishedStatuses.contains(status)
        detail = (try? c.decodeIfPresent(String.self, forKey: .detail)) ?? nil
        steps = try c.decodeLossyArray(of: Step.self, forKey: .steps)
    }

    public enum Tone: Sendable, Equatable {
        case working, success, failure
    }

    /// What to tell the operator about the run.
    public struct Description: Sendable, Equatable {
        public let tone: Tone
        public let text: String
        /// The step it is on, while it works.
        public let step: String?
    }

    /// Wise Wren's step names, in words. A step it adds later shows as it is named.
    public static func stepLabel(_ step: String) -> String {
        switch step {
        case "preflight": "Pulling the new version"
        case "maintenance": "Opening the maintenance window"
        case "stop": "Stopping Sylo"
        case "snapshot": "Taking a snapshot of the data"
        case "update": "Starting the new version"
        case "health": "Checking that Sylo is healthy"
        case "rollback": "Rolling back"
        case "close": "Cleaning up"
        default: step
        }
    }

    public var described: Description {
        switch status {
        case "queued":
            return Description(
                tone: .working, text: "Approved. Waiting for the Wise Wren agent to pick the update up.", step: nil)
        case "running":
            let current = steps.last(where: { $0.status == "running" }) ?? steps.last
            let label: String? = current.flatMap { $0.step.isEmpty ? nil : Self.stepLabel($0.step) }
            return Description(
                tone: .working,
                text: "Wise Wren is updating Sylo. Sylo restarts during this and the app reconnects by itself.",
                step: label)
        case "succeeded":
            return Description(tone: .success, text: "Wise Wren finished the update.", step: nil)
        case "rolled_back":
            return Description(
                tone: .failure,
                text: "The new version did not come up healthy, so Wise Wren rolled back. Sylo runs the old version again.",
                step: nil)
        case "failed":
            return Description(
                tone: .failure, text: "The update failed before anything was changed. Sylo still runs the old version.",
                step: nil)
        case "rollback_failed":
            return Description(
                tone: .failure, text: "The update failed and the rollback failed too. Look at Sylo in Wise Wren now.",
                step: nil)
        case "refused":
            return Description(
                tone: .failure,
                text: "The Wise Wren agent refused the update: its own settings do not allow updating Sylo.", step: nil)
        case "cancelled":
            return Description(tone: .failure, text: "The update was cancelled in Wise Wren.", step: nil)
        case "lapsed":
            return Description(
                tone: .failure, text: "A newer version appeared before the update started, so it was dropped. Try again.",
                step: nil)
        default:
            return Description(tone: .working, text: "Wise Wren is working on the update.", step: nil)
        }
    }
}

/// `POST /api/v2/update/wren/approve`: the run that started, and the version it started from.
public struct UpdateStarted: Decodable, Sendable, Equatable {
    public let runID: Int
    public let status: String
    public let from: String

    public init(runID: Int, status: String = "queued", from: String) {
        self.runID = runID
        self.status = status
        self.from = from
    }

    private enum CodingKeys: String, CodingKey { case runId, status, from }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runID = try c.decode(Int.self, forKey: .runId)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "queued"
        from = (try? c.decodeIfPresent(String.self, forKey: .from)) ?? ""
    }
}

/// `GET /api/v2/update/wren/runs/:id`.
public struct UpdateRunAnswer: Decodable, Sendable, Equatable {
    public let run: WrenRun

    public init(run: WrenRun) { self.run = run }
}

extension Endpoints {
    /// `GET /api/v2/update[?refresh=1]`: the update notice. Operators only. `refresh` asks GitHub again now
    /// (a few times a minute at most).
    public struct LoadUpdate: APIEndpoint {
        public typealias Response = UpdateStatus
        public let refresh: Bool
        public init(refresh: Bool = false) { self.refresh = refresh }
        public var path: String { "/api/v2/update" }
        public var query: [URLQueryItem] { refresh ? [URLQueryItem(name: "refresh", value: "1")] : [] }
    }

    /// `POST /api/v2/update/wren/approve` (no body): asks Wise Wren to update Sylo now, to exactly the version
    /// Wise Wren shows. 404 when Wise Wren is not set up; 409 when there is nothing to approve, Wise Wren refuses
    /// or the dashboard has no login; 502 when Wise Wren cannot be reached. Never retried.
    public struct ApproveUpdate: APIEndpoint {
        public typealias Response = UpdateStarted
        public init() {}
        public var path: String { "/api/v2/update/wren/approve" }
        public var method: HTTPMethod { .post }
    }

    /// `GET /api/v2/update/wren/runs/:id`: a run's progress. Up to 60 a minute.
    public struct LoadUpdateRun: APIEndpoint {
        public typealias Response = UpdateRunAnswer
        public let id: Int
        public init(id: Int) { self.id = id }
        public var path: String { "/api/v2/update/wren/runs/\(id)" }
    }
}

// MARK: - The model

/// Where the update of Sylo stands while the app follows a run.
public struct UpdateProgress: Sendable, Equatable {
    public let runID: Int
    /// The version the update started from.
    public let from: String
    public var run: WrenRun?
    /// Sylo is not answering (it is restarting).
    public var isSyloDown = false
    /// Wise Wren answered with an error, or the progress could not be read.
    public var problem: String?
    /// Sylo answers again and runs another version than `from`: the update worked.
    public var newVersion: String?
    /// Sylo did not come back in time: somebody has to look.
    public var timedOut = false
    /// The model stopped asking.
    public var isDone = false

    public init(runID: Int, from: String) {
        self.runID = runID
        self.from = from
    }

    private var shownRun: WrenRun { run ?? WrenRun(id: runID, status: "queued") }

    /// What to tell the operator now.
    public var text: String {
        if let newVersion { return "Sylo is now on \(newVersion)." }
        if isSyloDown { return "Sylo is restarting. The app keeps trying and shows the result as soon as Sylo is back." }
        return shownRun.described.text
    }

    public var step: String? {
        guard newVersion == nil, !isSyloDown else { return nil }
        return shownRun.described.step
    }

    public var tone: WrenRun.Tone {
        if newVersion != nil { return .success }
        if isSyloDown { return .working }
        return shownRun.described.tone
    }
}

/// The update notice screen: the status, "Check again", "Update now" and the progress of the run.
@MainActor
@Observable
public final class UpdateModel {
    public private(set) var status: UpdateStatus?
    public private(set) var isLoading = false
    /// The server said this account is not an operator (403): nothing is shown.
    public private(set) var isRefused = false
    /// Why the status could not be read.
    public var errorMessage: String?
    /// "Update now" is on its way to the server.
    public private(set) var isApproving = false
    /// Why the last "Update now" did not start, in the server's words.
    public var actionError: String?
    /// The run being followed, nil when none. It stays after the run is done, until ``closeProgress()``.
    public private(set) var progress: UpdateProgress?

    /// The model is asking for the progress of a run now.
    public var isFollowing: Bool { following != nil }

    private let session: AppSession
    private let pollEvery: Duration
    private let giveUpAfter: Duration
    private var following: Task<Void, Never>?
    /// Counts the runs followed, so a stopped poll never clears the reference of a newer one.
    private var followCount = 0

    /// - Parameters:
    ///   - pollEvery: The time between two reads of the run (the server allows 60 a minute).
    ///   - giveUpAfter: How long to wait for an update that has not come back before saying so.
    public init(session: AppSession, pollEvery: Duration = .seconds(3), giveUpAfter: Duration = .seconds(30 * 60)) {
        self.session = session
        self.pollEvery = pollEvery
        self.giveUpAfter = giveUpAfter
    }

    /// Reads the notice. A run that is already going (started here earlier, or in Wise Wren) is followed too.
    public func load(refresh: Bool = false) async {
        isLoading = true
        defer { isLoading = false }
        let generation = session.generation
        do {
            let loaded = try await session.send(Endpoints.LoadUpdate(refresh: refresh))
            guard session.generation == generation else { return }
            status = loaded
            isRefused = false
            errorMessage = nil
            if following == nil, progress?.isDone != true, let run = loaded.wren?.latestRun, !run.isFinished {
                follow(runID: run.id, from: loaded.current)
            }
        } catch {
            guard session.generation == generation else { return }
            let error = NetworkError(error)
            if OperatorOnly.isRefusal(error) {
                isRefused = true
                status = nil
            } else if error != .cancelled, error != .unauthorized {
                errorMessage = error.userMessage
            }
        }
    }

    /// Asks Wise Wren to update Sylo now, then follows the run. The caller has asked the person first.
    @discardableResult
    public func approve() async -> Bool {
        guard !isApproving, following == nil, status?.offersUpdateNow == true else { return false }
        isApproving = true
        defer { isApproving = false }
        actionError = nil
        let generation = session.generation
        do {
            let started = try await session.send(Endpoints.ApproveUpdate())
            guard session.generation == generation else { return false }
            follow(runID: started.runID, from: started.from.isEmpty ? (status?.current ?? "") : started.from)
            return true
        } catch {
            guard session.generation == generation else { return false }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
    }

    /// Stops following and clears the progress (the person closed it).
    public func closeProgress() {
        followCount += 1
        following?.cancel()
        following = nil
        progress = nil
    }

    /// Leaves the screen: stops asking, keeps what was read.
    public func stop() {
        followCount += 1
        following?.cancel()
        following = nil
    }

    /// Starts following a run. A second call while one is followed is ignored.
    public func follow(runID: Int, from: String) {
        guard following == nil else { return }
        progress = UpdateProgress(runID: runID, from: from)
        followCount += 1
        let mine = followCount
        following = Task { [weak self] in
            await self?.poll(runID: runID, from: from, followID: mine)
        }
    }

    /// Whether a failed read means Sylo itself is not answering (it restarts during the update, or a proxy has
    /// no upstream), as opposed to Sylo answering with a Wise Wren error.
    public nonisolated static func syloIsDown(_ error: NetworkError) -> Bool {
        switch error {
        case .offline, .unreachable, .timeout, .notASyloServer, .secureConnectionFailed, .transport:
            return true
        case .server(let status):
            // Wise Wren's refusals come as JSON with the words; a proxy's 502 or 503 has none.
            return status.message == nil
        default:
            return false
        }
    }

    private func poll(runID: Int, from: String, followID: Int) async {
        let clock = ContinuousClock()
        let started = clock.now
        var wasDown = false
        let generation = session.generation
        while !Task.isCancelled {
            var finished = false
            var down = false
            var problem: String?
            var run: WrenRun?
            do {
                let answer = try await session.send(Endpoints.LoadUpdateRun(id: runID))
                run = answer.run
                finished = answer.run.isFinished
            } catch {
                let error = NetworkError(error)
                if error == .cancelled || error == .unauthorized || session.generation != generation { break }
                if Self.syloIsDown(error) {
                    down = true
                    wasDown = true
                } else {
                    problem = error.userMessage
                }
            }
            var newVersion: String?
            // Back after a restart, or finished: Sylo's own version tells whether it worked.
            if !down, wasDown || finished {
                if let fresh = try? await session.send(Endpoints.LoadUpdate()), session.generation == generation {
                    status = fresh
                    if !fresh.current.isEmpty, fresh.current != from { newVersion = fresh.current }
                }
            }
            guard !Task.isCancelled, session.generation == generation else { break }
            var next = progress ?? UpdateProgress(runID: runID, from: from)
            if let run { next.run = run }
            next.isSyloDown = down
            next.problem = problem
            if let newVersion { next.newVersion = newVersion }
            let timedOut = newVersion == nil && !finished && clock.now - started > giveUpAfter
            next.timedOut = timedOut
            next.isDone = newVersion != nil || finished || timedOut
            progress = next
            if next.isDone { break }
            try? await Task.sleep(for: pollEvery)
        }
        if followCount == followID { following = nil }
    }
}
