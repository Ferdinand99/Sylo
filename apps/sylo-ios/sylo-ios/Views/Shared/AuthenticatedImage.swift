import SwiftUI
import SyloKit
import UIKit

/// A picture that the Sylo server serves behind the sign-in (a ticket attachment, a card preview):
/// loaded through the app's session, so the bearer token goes along, which `AsyncImage` cannot do.
///
/// A link to another host is shown with a plain `AsyncImage` and no token, so the token never goes
/// anywhere but the Sylo server. Pictures that are public on the server (collectibles under `/c/`)
/// work too. Loaded pictures are kept in memory for the rest of the launch.
struct AuthenticatedImage: View {
    private enum Source {
        case path(String, [URLQueryItem])
        case url(URL?)
    }

    private let source: Source
    private let contentMode: ContentMode

    @Environment(AppSession.self) private var session
    @State private var phase: Phase = .loading

    private enum Phase {
        case loading
        case loaded(UIImage)
        case failed
    }

    /// Drops every picture kept in memory. Called at sign-out, so one account's pictures do not
    /// stay in memory while no one is signed in.
    static func clearCache() { ImageCache.clear() }

    /// A picture at a path on the server (`/api/v2/...`, percent-encoded).
    init(path: String, query: [URLQueryItem] = [], contentMode: ContentMode = .fit) {
        source = .path(path, query)
        self.contentMode = contentMode
    }

    /// A picture at a link the server sent. A link on the Sylo server is fetched with the token, any
    /// other link without it.
    init(url: URL?, contentMode: ContentMode = .fit) {
        source = .url(url)
        self.contentMode = contentMode
    }

    var body: some View {
        if let outside = outsideURL {
            AsyncImage(url: outside) { image in
                image.resizable().aspectRatio(contentMode: contentMode)
            } placeholder: {
                ProgressView()
            }
        } else {
            content
                .task(id: resource?.cacheKey(on: session.server)) { await load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ProgressView()
        case .loaded(let image):
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: contentMode)
        case .failed:
            Image(systemName: "photo")
                .foregroundStyle(.secondary)
                .accessibilityLabel("Picture not available")
        }
    }

    /// The link when it points to another host.
    private var outsideURL: URL? {
        guard case .url(let url) = source, let url else { return nil }
        guard let server = session.server, server.apiPath(of: url) != nil else { return url }
        return nil
    }

    /// What to fetch from the Sylo server, nil when there is nothing (no link, or not signed in).
    private var resource: Endpoints.Resource? {
        switch source {
        case .path(let path, let query):
            return Endpoints.Resource(path: path, query: query, maxDownloadBytes: Self.maxPictureBytes)
        case .url(let url):
            guard let url, let server = session.server else { return nil }
            return Endpoints.Resource(url: url, on: server, maxDownloadBytes: Self.maxPictureBytes)
        }
    }

    private static let maxPictureBytes = 12 * 1024 * 1024

    private func load() async {
        guard let resource, let server = session.server else {
            phase = .failed
            return
        }
        // What one account was shown is not kept for the next one (sign-out, another account).
        let generation = session.generation
        ImageCache.useGeneration(generation)
        let key = resource.cacheKey(on: server) as NSString
        if let cached = ImageCache.images.object(forKey: key) {
            phase = .loaded(cached)
            return
        }
        phase = .loading
        do {
            let file = try await session.download(resource)
            // Decoded from the bytes: the file is deleted at once, and an image that reads from a path
            // would come back blank after a memory purge.
            let data: Data
            do {
                // The download itself is capped at the same size (see `resource`).
                data = try file.contents()
            } catch {
                file.discard()
                phase = .failed
                return
            }
            file.discard()
            guard let image = UIImage(data: data) else {
                phase = .failed
                return
            }
            if session.generation == generation { ImageCache.images.setObject(image, forKey: key) }
            phase = .loaded(image)
        } catch {
            if NetworkError(error) != .cancelled { phase = .failed }
        }
    }
}

private enum ImageCache {
    static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 100
        return cache
    }()

    private static var generation: Int?

    /// Empties the cache at once (sign-out); the next load starts clean.
    static func clear() {
        images.removeAllObjects()
        generation = nil
    }

    /// Empties the cache when the session's sign-in is not the one the pictures were loaded for.
    static func useGeneration(_ current: Int) {
        if generation != current {
            images.removeAllObjects()
            generation = current
        }
    }
}

private extension Endpoints.Resource {
    /// One key per server and resource.
    func cacheKey(on server: ServerURL?) -> String {
        let query = percentEncodedQuery ?? self.query.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
        return (server?.description ?? "") + "|" + path + "?" + query
    }
}
