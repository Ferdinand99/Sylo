import ImageIO
import SwiftUI
import SyloKit
import UIKit

// A native look-alike of how Discord shows a bot's message with embeds: the header line (avatar, the
// bot's name and its verified "APP" tag), the text, the embeds and the buttons. It is only a
// preview for the editors: colours, fields in rows of up to three, thumbnail and image, author and
// footer, and Discord's inline Markdown. No web view.
//
// Pictures come from links anyone with edit rights typed, so nothing is fetched until the person
// taps "Tap to load images", and then without the Sylo token, over https only, and capped in size.

/// Discord's blurple.
private let blurple = Color(red: 0.345, green: 0.396, blue: 0.949)

/// A message's text as Discord shows it: inline Markdown (bold, italic, strike-through, code, links).
/// Links that are not `http` or `https` are plain text. Text that is not valid Markdown shows as it
/// is.
func discordText(_ text: String) -> Text {
    guard var attributed = try? AttributedString(
        markdown: text, options: AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace)) else {
        return Text(verbatim: text)
    }
    let unsafe = attributed.runs.compactMap { run -> Range<AttributedString.Index>? in
        guard let link = run.link else { return nil }
        let scheme = link.scheme?.lowercased()
        return scheme == "http" || scheme == "https" ? nil : run.range
    }
    for range in unsafe { attributed[range].link = nil }
    return Text(attributed)
}

/// The verified "✓ APP" tag next to a bot's name. Sylo is a verified app, never a "BOT".
struct VerifiedAppTag: View {
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "checkmark")
                .font(.system(size: 8, weight: .heavy))
            Text(verbatim: "APP")
                .font(.caption2.bold())
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(RoundedRectangle(cornerRadius: 4).fill(blurple))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Verified app")
    }
}

/// The first line of a message in Discord: avatar, name, the verified app tag and "Today".
struct BotMessageHeader: View {
    var botName = "Sylo"

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: String(botName.prefix(1)))
                .font(.subheadline.bold())
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Circle().fill(blurple))
                .accessibilityHidden(true)
            Text(verbatim: botName)
                .font(.subheadline.weight(.semibold))
            VerifiedAppTag()
            Text("Today")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Pictures

/// Whether the person agreed to load the pictures of embed previews. Kept for the sign-in only (a
/// new sign-in asks again), and in memory only.
@MainActor
@Observable
final class PreviewImageConsent {
    static let shared = PreviewImageConsent()

    private var generation: Int?

    func isAllowed(for session: AppSession) -> Bool { generation == session.generation }

    func allow(for session: AppSession) { generation = session.generation }
}

/// Fetches an embed picture the way a stranger's link must be fetched: no token, no cookies, https
/// only (also after a redirect), at most 8 MB read in the chunks the network delivers, at most
/// 4096 pixels on a side, and shown downsized.
private nonisolated enum RemotePictureLoader {
    static let maxBytes = 8 * 1024 * 1024
    /// Longest side of a picture the preview will decode; a small file can claim huge dimensions.
    static let maxSourcePixels = 4096
    static let maxPixels = 1024

    private nonisolated(unsafe) static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration)
    }()

    private nonisolated(unsafe) static let cache: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.countLimit = 60
        return cache
    }()

    @concurrent static func image(from url: URL) async -> UIImage? {
        guard url.scheme?.lowercased() == "https" else { return nil }
        if let cached = cache.object(forKey: url as NSURL) { return cached }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        guard let data = await CappedDownload.fetch(request, on: session, maxBytes: maxBytes),
              let image = downsized(data) else { return nil }
        cache.setObject(image, forKey: url as NSURL)
        return image
    }

    /// The picture at most ``maxPixels`` on its longest side, so a huge one cannot fill the memory.
    /// A picture whose dimensions are over ``maxSourcePixels`` is refused before it is decoded.
    static func downsized(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= maxSourcePixels, height <= maxSourcePixels else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

/// One download that stops as soon as it is over the size limit: the declared length is checked
/// before any byte is kept, and the chunks that arrive are counted. Only `https` is followed.
private nonisolated final class CappedDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    // @unchecked: `data`, `continuation` and `finished` are only touched while holding `lock`.
    private let lock = NSLock()
    private let maxBytes: Int
    private var data = Data()
    private var continuation: CheckedContinuation<Data?, Never>?
    private var finished = false

    private init(maxBytes: Int) {
        self.maxBytes = maxBytes
        super.init()
    }

    /// The body of a successful answer, nil for anything else (a status other than 200, a link that
    /// leaves https, too much data, an error).
    static func fetch(_ request: URLRequest, on session: URLSession, maxBytes: Int) async -> Data? {
        let download = CappedDownload(maxBytes: maxBytes)
        let task = session.dataTask(with: request)
        task.delegate = download
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
                download.lock.withLock { download.continuation = continuation }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    private func finish(_ result: Data?) {
        let pending: CheckedContinuation<Data?, Never>? = lock.withLock {
            guard !finished else { return nil }
            finished = true
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(returning: result)
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.url?.scheme?.lowercased() == "https",
              http.expectedContentLength <= Int64(maxBytes) else {
            completionHandler(.cancel)
            finish(nil)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        let tooMuch: Bool = lock.withLock {
            data.append(chunk)
            return data.count > maxBytes
        }
        if tooMuch {
            dataTask.cancel()
            finish(nil)
        }
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        // A redirect away from https ends the download.
        if request.url?.scheme?.lowercased() == "https" {
            completionHandler(request)
        } else {
            completionHandler(nil)
            finish(nil)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        if error == nil {
            finish(lock.withLock { data })
        } else {
            finish(nil)
        }
    }
}

/// A picture at an `https` link, loaded without the Sylo token.
private struct RemotePicture: View {
    let url: URL
    let contentMode: ContentMode

    private enum Phase {
        case loading
        case loaded(UIImage)
        case failed
    }

    @State private var phase: Phase = .loading

    var body: some View {
        Group {
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
            }
        }
        .task(id: url) {
            phase = .loading
            if let image = await RemotePictureLoader.image(from: url) {
                phase = .loaded(image)
            } else if !Task.isCancelled {
                phase = .failed
            }
        }
    }
}

/// A picture at a link the person typed, shown once they agreed to load pictures
/// (``PreviewImageConsent``). The link is only fetched a moment after typing stops, so a half-typed
/// address does not start a request per key. Only `https` links are shown.
struct PreviewImage: View {
    let urlString: String
    var contentMode: ContentMode = .fit

    @Environment(AppSession.self) private var session
    @State private var shown: URL?

    init(_ urlString: String, contentMode: ContentMode = .fit) {
        self.urlString = urlString
        self.contentMode = contentMode
        _shown = State(initialValue: Self.url(from: urlString))
    }

    var body: some View {
        Group {
            if PreviewImageConsent.shared.isAllowed(for: session), let shown {
                RemotePicture(url: shown, contentMode: contentMode)
            } else {
                Color.clear
            }
        }
        .task(id: urlString) {
            let candidate = Self.url(from: urlString)
            guard candidate != shown else { return }
            guard candidate != nil else {
                shown = nil
                return
            }
            try? await Task.sleep(for: .milliseconds(600))
            if !Task.isCancelled { shown = candidate }
        }
    }

    /// The link when it is an `https` address without spaces and with a host.
    static func url(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("https://"), !trimmed.contains(where: \.isWhitespace),
              let url = URL(string: trimmed), url.host?.isEmpty == false else { return nil }
        return url
    }
}

// MARK: - The embed

/// One embed as Discord draws it: a coloured bar on the left, then author, title, text, fields,
/// image and footer. What the editor's options hide is left out, like the server does.
struct EmbedPreviewCard: View {
    let draft: EmbedDraft
    var options = EmbedOptions()

    @Environment(AppSession.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if draft.isEmpty(options) {
                Text("Nothing in this embed yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                author
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        if !draft.title.isEmpty {
                            discordText(draft.title)
                                .font(.subheadline.weight(.semibold))
                        }
                        if options.description, !draft.description.isEmpty {
                            discordText(draft.description)
                                .font(.footnote)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if options.thumbnail, PreviewImage.url(from: draft.thumbnail) != nil {
                        PreviewImage(draft.thumbnail, contentMode: .fill)
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                            .accessibilityHidden(true)
                    }
                }
                fieldRows
                if PreviewImage.url(from: draft.image) != nil {
                    PreviewImage(draft.image)
                        .frame(maxWidth: .infinity, maxHeight: 220)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                        .accessibilityHidden(true)
                }
                footer
                loadImagesPrompt
            }
        }
        .padding(.vertical, 12)
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The coloured bar down the left edge, as tall as the card.
        .overlay(alignment: .leading) {
            accent.frame(width: 4)
        }
        .background(Color.secondary.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
    }

    private var accent: Color {
        let rgb = draft.rgb(options)
        return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
    }

    // MARK: Pictures

    /// Whether the embed has a picture the preview would fetch.
    private var hasPictures: Bool {
        let thumbnail = options.thumbnail && PreviewImage.url(from: draft.thumbnail) != nil
        let authorIcon = options.author && !draft.authorName.isEmpty && PreviewImage.url(from: draft.authorIcon) != nil
        let footerIcon = options.footerIcon && !draft.footerText.isEmpty && PreviewImage.url(from: draft.footerIcon) != nil
        return thumbnail || authorIcon || footerIcon || PreviewImage.url(from: draft.image) != nil
    }

    /// Until the person agrees, no picture is fetched: this is what they tap.
    @ViewBuilder
    private var loadImagesPrompt: some View {
        if hasPictures, !PreviewImageConsent.shared.isAllowed(for: session) {
            Button {
                PreviewImageConsent.shared.allow(for: session)
            } label: {
                Label("Tap to load images", systemImage: "photo")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .accessibilityHint("Loads the pictures from this embed's links. Their servers see your address.")
        }
    }

    // MARK: Author

    @ViewBuilder
    private var author: some View {
        if options.author, !draft.authorName.isEmpty {
            HStack(spacing: 6) {
                if PreviewImage.url(from: draft.authorIcon) != nil {
                    PreviewImage(draft.authorIcon, contentMode: .fill)
                        .frame(width: 20, height: 20)
                        .clipShape(Circle())
                        .accessibilityHidden(true)
                }
                Text(verbatim: draft.authorName)
                    .font(.caption.weight(.semibold))
            }
        }
    }

    // MARK: Fields

    /// The fields in rows: up to three inline fields side by side, any other field on its own row. A
    /// field needs both a name and a value, as on the server; any other is not shown.
    static func rows(of fields: [EmbedDraft.Field]) -> [[EmbedDraft.Field]] {
        var rows: [[EmbedDraft.Field]] = []
        for field in fields where !field.name.isEmpty && !field.value.isEmpty {
            if field.inline, let last = rows.last, last.allSatisfy(\.inline), last.count < 3 {
                rows[rows.count - 1].append(field)
            } else {
                rows.append([field])
            }
        }
        return rows
    }

    @ViewBuilder
    private var fieldRows: some View {
        if options.fields {
            let rows = Self.rows(of: draft.fields)
            ForEach(rows.indices, id: \.self) { index in
                HStack(alignment: .top, spacing: 12) {
                    ForEach(rows[index]) { field in
                        VStack(alignment: .leading, spacing: 2) {
                            discordText(field.name)
                                .font(.caption.weight(.semibold))
                            discordText(field.value)
                                .font(.caption)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    // MARK: Footer

    @ViewBuilder
    private var footer: some View {
        let showsTime = options.timestamp && draft.timestamp
        if !draft.footerText.isEmpty || showsTime {
            HStack(spacing: 6) {
                if options.footerIcon, !draft.footerText.isEmpty, PreviewImage.url(from: draft.footerIcon) != nil {
                    PreviewImage(draft.footerIcon, contentMode: .fill)
                        .frame(width: 16, height: 16)
                        .clipShape(Circle())
                        .accessibilityHidden(true)
                }
                Text(verbatim: footerLine(showsTime: showsTime))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func footerLine(showsTime: Bool) -> String {
        guard showsTime else { return draft.footerText }
        let time = String(localized: "Today at \(Date.now.formatted(date: .omitted, time: .shortened))")
        return draft.footerText.isEmpty ? time : draft.footerText + " \u{2022} " + time
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    VStack(alignment: .leading, spacing: 12) {
        BotMessageHeader()
        EmbedPreviewCard(
            draft: EmbedDraft(
                color: "#57f287", authorName: "Staff", title: "Welcome to **Sylo**",
                description: "Read the rules, then say hi.", image: "https://example.com/i.png",
                footerText: "Be nice", timestamp: true,
                fields: [
                    EmbedDraft.Field(name: "One", value: "a", inline: true),
                    EmbedDraft.Field(name: "Two", value: "b", inline: true),
                    EmbedDraft.Field(name: "Three", value: "c"),
                ]),
            options: EmbedOptions(timestamp: true))
    }
    .padding()
    .environment(session)
}
