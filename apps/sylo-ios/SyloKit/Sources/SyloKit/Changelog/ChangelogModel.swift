import Foundation
import Observation

/// The What's New page: the Sylo server's release notes, shown ten releases at a time.
@MainActor
@Observable
public final class ChangelogModel {
    /// How many releases show at first, and how many more each "Show Older Releases" adds.
    public static let pageSize = 10

    /// Every release the server sent, newest first.
    public private(set) var releases: [ChangelogRelease] = []
    /// The version the server runs, to mark its release as this version.
    public private(set) var serverVersion: String?
    public private(set) var isLoading = false
    /// Whether a load has finished at least once, so an empty list means "nothing here yet".
    public private(set) var hasLoaded = false
    /// Why the release notes could not be loaded.
    public var errorMessage: String?
    private var visibleCount = ChangelogModel.pageSize

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    /// The releases shown now: the newest ``pageSize``, plus any older ones asked for.
    public var visibleReleases: [ChangelogRelease] { Array(releases.prefix(visibleCount)) }

    /// Whether there are releases beyond ``visibleReleases``.
    public var hasOlderReleases: Bool { releases.count > visibleCount }

    public func showOlderReleases() {
        visibleCount += Self.pageSize
    }

    /// Whether `release` is the version the server runs.
    public func isCurrent(_ release: ChangelogRelease) -> Bool {
        release.version == serverVersion
    }

    public func load() async {
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            let page = try await session.send(Endpoints.Changelog())
            releases = page.releases
            serverVersion = page.version ?? session.serverInfo?.version
            errorMessage = nil
        } catch {
            show(error)
        }
    }

    private func show(_ error: any Error) {
        let error = NetworkError(error)
        if error == .cancelled || error == .unauthorized { return }
        errorMessage = error.userMessage
    }
}
