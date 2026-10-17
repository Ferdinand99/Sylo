import Foundation
#if canImport(Security)
import Security
#endif

/// `count` bytes from the system's cryptographically secure generator: `SecRandomCopyBytes` on
/// Apple platforms, `SystemRandomNumberGenerator` elsewhere (also cryptographically secure on every
/// platform Swift supports, and the fallback should `SecRandomCopyBytes` ever fail).
func secureRandomBytes(count: Int) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: max(count, 0))
    guard !bytes.isEmpty else { return bytes }
    #if canImport(Security)
    let status = bytes.withUnsafeMutableBytes { buffer -> OSStatus in
        guard let base = buffer.baseAddress else { return errSecParam }
        return SecRandomCopyBytes(kSecRandomDefault, buffer.count, base)
    }
    if status == errSecSuccess { return bytes }
    #endif
    var generator = SystemRandomNumberGenerator()
    for index in bytes.indices {
        bytes[index] = generator.next()
    }
    return bytes
}

/// Base64url without padding (RFC 4648 section 5), as PKCE and the server expect.
func base64URLEncoded(_ bytes: [UInt8]) -> String {
    Data(bytes).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
