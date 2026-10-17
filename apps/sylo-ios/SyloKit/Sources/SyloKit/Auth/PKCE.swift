/// The PKCE pair for one sign-in (RFC 7636, S256). Only the challenge goes through the browser; the
/// verifier goes straight to `POST /api/mobile/token`, so a code caught on its way back to the app
/// is useless without it. Its description never shows the verifier.
public struct PKCE: Sendable, Equatable {
    /// 43 characters of base64url (32 random bytes), sent once, with the code, to get a token.
    public let verifier: String
    /// `base64url(SHA-256(verifier))`, 43 characters, sent in the sign-in URL.
    public let challenge: String

    init(verifier: String) {
        self.verifier = verifier
        challenge = base64URLEncoded(sha256(Array(verifier.utf8)))
    }

    /// A new pair from 32 cryptographically secure random bytes.
    public static func generate() -> PKCE {
        PKCE(verifier: base64URLEncoded(secureRandomBytes(count: 32)))
    }
}

extension PKCE: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { "PKCE(S256)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}
