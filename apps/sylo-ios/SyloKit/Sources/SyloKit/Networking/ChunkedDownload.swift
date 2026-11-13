import Foundation

#if !canImport(FoundationNetworking)
/// One big download (a database backup), received in the chunks `URLSession` hands over and written to
/// a file as they arrive. It is the delegate of a session made for this one transfer.
///
/// - Progress is reported as `(bytesReceived, bytesExpected)`, with 0 when the server did not say how
///   long the answer is.
/// - Cancelling the task that runs it cancels the transfer.
/// - It stops at `limit` bytes (by the declared length before anything is read, and by what has arrived
///   while reading), refuses redirects, and keeps nothing on disk when it fails.
final class ChunkedDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    // @unchecked: the delegate callbacks come one at a time on the session's serial queue and are the
    // only code that touches the transfer state; `lock` guards what `run` and the callbacks share.
    typealias Outcome = Result<DownloadedFile, NetworkError>

    private let limit: Int64
    private let directory: URL?
    private let progress: (@Sendable (Int64, Int64) -> Void)?

    private let lock = NSLock()
    private var continuation: CheckedContinuation<Outcome, Never>?
    private var finished: Outcome?

    // Transfer state, touched only by the delegate callbacks.
    private var http: HTTPURLResponse?
    private var handle: FileHandle?
    private var destination: URL?
    private var filename = ""
    private var mimeType = ""
    private var written: Int64 = 0
    private var errorBody = Data()
    /// Why the app stopped the transfer itself (too long, disk full), so that wins over "cancelled".
    private var failure: NetworkError?

    private static let errorBodyBytes = 16 * 1024

    init(limit: Int64, directory: URL?, progress: (@Sendable (Int64, Int64) -> Void)?) {
        self.limit = limit
        self.directory = directory
        self.progress = progress
    }

    /// Runs the request on `session` (which must have this object as its delegate) and waits for the end.
    func run(on session: URLSession, request: URLRequest) async -> Outcome {
        let task = session.dataTask(with: request)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
                lock.withLock { self.continuation = continuation }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    private func finish(_ outcome: Outcome) {
        let waiting: CheckedContinuation<Outcome, Never>? = lock.withLock {
            let waiting = continuation
            continuation = nil
            if waiting == nil { finished = outcome }
            return waiting
        }
        waiting?.resume(returning: outcome)
    }

    private static func isSuccess(_ http: HTTPURLResponse) -> Bool {
        (200..<300).contains(http.statusCode)
    }

    // MARK: URLSessionDataDelegate

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            failure = .notASyloServer
            completionHandler(.cancel)
            return
        }
        self.http = http
        if Self.isSuccess(http) {
            // Too long by its own account: stop before any byte is read or written.
            if http.expectedContentLength > limit {
                failure = NetworkError.tooLarge
                completionHandler(.cancel)
                return
            }
            let (name, mime) = URLSessionAPIClient.descriptor(of: http)
            do {
                let url = try DownloadedFile.makeDestination(filename: name, in: directory)
                destination = url
                guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: DownloadedFile.fileAttributes) else {
                    throw NetworkError.transport(code: CocoaError.fileWriteUnknown.rawValue)
                }
                handle = try FileHandle(forWritingTo: url)
                filename = name
                mimeType = mime
            } catch {
                failure = NetworkError(error)
                completionHandler(.cancel)
                return
            }
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil, let http else { return }
        if Self.isSuccess(http) {
            written += Int64(data.count)
            guard written <= limit else {
                failure = NetworkError.tooLarge
                dataTask.cancel()
                return
            }
            do {
                try handle?.write(contentsOf: data)
            } catch {
                failure = NetworkError(error)
                dataTask.cancel()
                return
            }
            progress?(written, Swift.max(0, http.expectedContentLength))
        } else if errorBody.count < Self.errorBodyBytes {
            errorBody.append(data.prefix(Self.errorBodyBytes - errorBody.count))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        try? handle?.close()
        handle = nil
        let outcome: Outcome
        if let failure {
            outcome = .failure(failure)
        } else if let error {
            outcome = .failure(NetworkError(error))
        } else if let http, !Self.isSuccess(http) {
            do {
                try URLSessionAPIClient.checkDownloadStatus(http, errorBody: errorBody)
                outcome = .failure(.notASyloServer)
            } catch {
                outcome = .failure(NetworkError(error))
            }
        } else if let destination, http != nil {
            outcome = .success(DownloadedFile(
                fileURL: destination, filename: filename, mimeType: mimeType, byteCount: Int(written)))
        } else {
            outcome = .failure(.notASyloServer)
        }
        if case .failure = outcome, let destination {
            try? FileManager.default.removeItem(at: destination.deletingLastPathComponent())
        }
        finish(outcome)
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
#endif
