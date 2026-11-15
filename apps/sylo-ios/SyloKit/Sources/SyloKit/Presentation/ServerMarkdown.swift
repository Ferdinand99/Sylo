import Foundation

/// Inline Markdown that a Sylo server sent (a roadmap post, a changelog entry), made safe to show.
///
/// A server's Markdown can hold links to anything: `[text](tel:…)`, a custom app scheme, `http:` or a
/// relative path. Only `https` links with a host stay tappable; every other link shows as plain text, so a
/// tap can never start a call, a mail, another app or an unencrypted page.
public enum ServerMarkdown {
    /// The text as inline Markdown (bold, italic, code, links) with every link that is not an openable
    /// `https` address removed. Text that is not valid Markdown shows as it is.
    public static func attributed(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard var text = try? AttributedString(markdown: source, options: options) else {
            return AttributedString(source)
        }
        let unsafe = text.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard let link = run.link else { return nil }
            return isOpenable(link) ? nil : run.range
        }
        for range in unsafe { text[range].link = nil }
        return text
    }

    /// Whether the app may open a link a server sent: `https`, with a host and no user name or password in
    /// it (`https://example.com@evil.example` reads as a different place than it looks).
    public static func isOpenable(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https" else { return false }
        guard let host = url.host(percentEncoded: false), !host.isEmpty else { return false }
        return url.user(percentEncoded: false) == nil && url.password(percentEncoded: false) == nil
    }

    /// The address when it may be opened, otherwise nil.
    public static func openable(_ url: URL?) -> URL? {
        guard let url, isOpenable(url) else { return nil }
        return url
    }
}
