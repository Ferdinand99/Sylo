import Foundation

/// Checks which server a sign-in or connect callback came from.
///
/// A Sylo server adds `iss=<its public address>` (origin only, such as `https://app.sylobot.com`) to the
/// callbacks `sylo://auth` and `sylo://connected`. The app compares it with the address it actually talks
/// to, the one the person chose, and never with anything a server announces about itself. A callback
/// that names another server was relayed from there (a different server answering the sheet) and is
/// refused before its code or result is used. A callback without `iss` (an older Sylo) is accepted as
/// before.
public enum CallbackIssuer {
    /// What the check found.
    public enum Verdict: Equatable, Sendable {
        /// No issuer was named, or it is the chosen server.
        case accepted
        /// Another server (or something that is not a server address) was named. `claimed` is safe to
        /// show: a plain `scheme://host[:port]`, or "an unknown address".
        case mismatch(claimed: String)
    }

    /// What is shown for an issuer that is not a usable address.
    public static let unknownAddress = "an unknown address"

    /// `scheme://host[:port]` in one spelling: scheme and host lowercase, an IPv6 host in its canonical compressed
    /// form, the default port left out, no path, query or fragment. Nil when the text is not an http(s)
    /// address with a plain host and no user name or password.
    public static func origin(of text: String) -> String? {
        guard !text.contains("\\"), let components = URLComponents(string: text),
            let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
            components.user == nil, components.password == nil,
            let rawHost = components.encodedHost?.lowercased(), isPlainHost(rawHost)
        else { return nil }
        let host = canonicalHost(rawHost)
        var port = components.port
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) { port = nil }
        return "\(scheme)://\(host)" + (port.map { ":\($0)" } ?? "")
    }

    /// An IPv6 literal such as `[2001:db8:0:0::1]` as `[2001:db8::1]` (what a URL's origin gives), so the same
    /// address typed two ways compares equal. Anything else is returned as it is.
    static func canonicalHost(_ host: String) -> String {
        guard host.hasPrefix("["), host.hasSuffix("]"), host.count > 2 else { return host }
        let inner = String(host.dropFirst().dropLast())
        var address = in6_addr()
        guard inet_pton(AF_INET6, inner, &address) == 1 else { return host }
        var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN) + 1)
        guard inet_ntop(AF_INET6, &address, &buffer, socklen_t(INET6_ADDRSTRLEN)) != nil else { return host }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return "[" + String(decoding: bytes, as: UTF8.self) + "]"
    }

    /// Compares the `iss` values of a callback with the chosen server's origin.
    /// - Parameters:
    ///   - issuers: Every `iss` value in the callback; nil when it has none.
    ///   - serverOrigin: The chosen server's origin (``ServerURL/origin``). Nil with an issuer present
    ///     means nothing can be compared, which is a mismatch.
    public static func check(issuers: [String]?, serverOrigin: String?) -> Verdict {
        guard let issuers else { return .accepted }
        // Two issuers, or none that reads as an address, cannot be trusted to mean one place.
        guard issuers.count == 1, let claimed = origin(of: issuers[0]) else {
            return .mismatch(claimed: unknownAddress)
        }
        // Both sides in the same spelling (the chosen origin may have been typed with an uncompressed IPv6 host).
        guard let serverOrigin, claimed == origin(of: serverOrigin) else { return .mismatch(claimed: claimed) }
        return .accepted
    }

    /// A DNS name, an IPv4 address or a bracketed IPv6 address: nothing that could be read as a
    /// separator, a space or an escape.
    private static func isPlainHost(_ host: String) -> Bool {
        guard !host.isEmpty, host.count <= 253 else { return false }
        if host.hasPrefix("[") {
            return host.hasSuffix("]") && host.count > 2
                && host.dropFirst().dropLast().allSatisfy { $0.isHexDigit || $0 == ":" || $0 == "." }
        }
        return host.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || "-_.".contains($0) }
    }

}
