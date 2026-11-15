import Foundation
import Observation

/// Downloads one file at a time for a screen (an export, a transcript, a card) and holds it until
/// the screen is done with it. The view shows ``file`` through Quick Look or a share link, and the
/// model removes the temporary file when it is replaced or cleared.
///
/// A download that takes a while (a backup) reports ``fraction`` and can be stopped with ``cancel()``.
@MainActor
@Observable
public final class FileDownloadModel {
    /// The last file downloaded, until ``clear()`` or the next download. It is also deleted when the
    /// model goes away.
    public private(set) var file: DownloadedFile?
    public private(set) var isDownloading = false
    /// Why the last download failed, in words for the person; nil when it worked.
    public var errorMessage: String?
    /// Goes up with every finished download, for a haptic.
    public private(set) var downloadCount = 0
    /// Bytes received so far by the running download, and how many are expected (0 when the server did
    /// not say).
    public private(set) var bytesReceived: Int64 = 0
    public private(set) var bytesExpected: Int64 = 0

    private let session: AppSession
    private let holder = FileHolder()
    private var running: Task<DownloadedFile, any Error>?

    public init(session: AppSession) {
        self.session = session
    }

    /// How much of the running download has arrived, 0 to 1; nil when the length is not known.
    public var fraction: Double? {
        guard bytesExpected > 0 else { return nil }
        return min(1, Double(bytesReceived) / Double(bytesExpected))
    }

    /// Downloads the endpoint's answer into ``file``. Does nothing while another download runs.
    /// - Returns: Whether a file is ready.
    @discardableResult
    public func download<E: APIEndpoint>(_ endpoint: E) async -> Bool where E.Response == EmptyResponse {
        guard !isDownloading else { return false }
        isDownloading = true
        bytesReceived = 0
        bytesExpected = 0
        defer {
            isDownloading = false
            running = nil
        }
        errorMessage = nil
        let relay = ProgressRelay { [weak self] received, expected in
            guard let self, self.isDownloading else { return }
            self.bytesReceived = max(self.bytesReceived, received)
            self.bytesExpected = expected
        }
        let session = self.session
        let task = Task { try await session.download(endpoint, progress: { relay.report($0, $1) }) }
        running = task
        do {
            let downloaded = try await task.value
            file?.discard()
            file = downloaded
            holder.file = downloaded
            downloadCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return false
        }
    }

    /// Stops the running download; what was written is deleted. Nothing is shown for it.
    public func cancel() {
        running?.cancel()
    }

    /// Forgets the file and deletes it from disk.
    public func clear() {
        file?.discard()
        file = nil
        holder.file = nil
    }
}

/// Deletes the file it holds when it is released, so a model that goes away (its screen was closed
/// while a download ran) cannot leave an export on disk. Only the model touches it, on the main actor.
private final class FileHolder: @unchecked Sendable {
    var file: DownloadedFile?

    deinit { file?.discard() }
}
