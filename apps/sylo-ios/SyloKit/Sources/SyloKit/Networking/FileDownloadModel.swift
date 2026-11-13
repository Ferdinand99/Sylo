import Foundation
import Observation

/// Downloads one file at a time for a screen (an export, a transcript, a card) and holds it until
/// the screen is done with it. The view shows ``file`` through Quick Look or a share link, and the
/// model removes the temporary file when it is replaced or cleared.
@MainActor
@Observable
public final class FileDownloadModel {
    /// The last file downloaded, until ``clear()`` or the next download.
    public private(set) var file: DownloadedFile?
    public private(set) var isDownloading = false
    /// Why the last download failed, in words for the person; nil when it worked.
    public var errorMessage: String?
    /// Goes up with every finished download, for a haptic.
    public private(set) var downloadCount = 0

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    /// Downloads the endpoint's answer into ``file``. Does nothing while another download runs.
    /// - Returns: Whether a file is ready.
    @discardableResult
    public func download<E: APIEndpoint>(_ endpoint: E) async -> Bool {
        guard !isDownloading else { return false }
        isDownloading = true
        defer { isDownloading = false }
        errorMessage = nil
        do {
            let downloaded = try await session.download(endpoint)
            file?.discard()
            file = downloaded
            downloadCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return false
        }
    }

    /// Forgets the file and deletes it from disk.
    public func clear() {
        file?.discard()
        file = nil
    }
}
