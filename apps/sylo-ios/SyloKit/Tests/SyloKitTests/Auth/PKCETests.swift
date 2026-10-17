import Foundation
import Testing
@testable import SyloKit
#if canImport(CryptoKit)
import CryptoKit
#endif

private func hex(_ bytes: [UInt8]) -> String {
    bytes.map { byte in
        let digits = String(byte, radix: 16)
        return digits.count == 1 ? "0" + digits : digits
    }.joined()
}

/// The server's checks (src/web/routes/mobile.js).
private func matches(_ value: String, allowed: String, length: ClosedRange<Int>) -> Bool {
    length.contains(value.count) && value.allSatisfy { allowed.contains($0) }
}

private let alphanumerics = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
private let verifierCharacters = alphanumerics + "._~-"
private let challengeCharacters = alphanumerics + "_-"

@Suite("SHA-256 fallback (FIPS 180 vectors)")
struct FallbackSHA256Tests {
    @Test("abc")
    func abc() {
        #expect(hex(FallbackSHA256.hash(Array("abc".utf8)))
            == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test("the empty message")
    func empty() {
        #expect(hex(FallbackSHA256.hash([]))
            == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test("the 448-bit message")
    func twoBlocks() {
        let message = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
        #expect(hex(FallbackSHA256.hash(Array(message.utf8)))
            == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    }

    @Test("the 896-bit message")
    func longMessage() {
        let message = "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno"
            + "ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"
        #expect(hex(FallbackSHA256.hash(Array(message.utf8)))
            == "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1")
    }

    @Test("a million times 'a'")
    func million() {
        let message = [UInt8](repeating: UInt8(ascii: "a"), count: 1_000_000)
        #expect(hex(FallbackSHA256.hash(message))
            == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0")
    }

    @Test("messages around the padding boundary", arguments: [55, 56, 63, 64, 65, 119, 120])
    func paddingBoundary(length: Int) {
        // The digest of the same bytes must not depend on the path that computes it.
        let message = [UInt8](repeating: 0x61, count: length)
        #expect(FallbackSHA256.hash(message) == sha256(message))
        #expect(FallbackSHA256.hash(message).count == 32)
    }
}

@Suite("base64url")
struct Base64URLTests {
    @Test("uses - and _ and has no padding")
    func alphabet() {
        #expect(base64URLEncoded([0xfb, 0xff, 0xfe]) == "-__-")
        #expect(base64URLEncoded([0x61]) == "YQ")
        #expect(base64URLEncoded([0x61, 0x62]) == "YWI")
        #expect(base64URLEncoded([]) == "")
    }
}

@Suite("PKCE")
struct PKCETests {
    @Test("S256 challenge matches RFC 7636 appendix B")
    func rfcVector() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        #expect(pkce.verifier == "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    }

    @Test("a generated verifier and challenge pass the server's checks")
    func generatedShape() {
        let pkce = PKCE.generate()
        #expect(pkce.verifier.count == 43)
        #expect(matches(pkce.verifier, allowed: verifierCharacters, length: 43...128))
        #expect(pkce.challenge.count == 43)
        #expect(matches(pkce.challenge, allowed: challengeCharacters, length: 43...43))
        #expect(PKCE(verifier: pkce.verifier).challenge == pkce.challenge)
    }

    @Test("every generated verifier is different")
    func generatedIsRandom() {
        let verifiers = Set((0..<200).map { _ in PKCE.generate().verifier })
        #expect(verifiers.count == 200)
    }

    @Test("its description does not show the verifier")
    func redacted() {
        let pkce = PKCE.generate()
        #expect(!String(describing: pkce).contains(pkce.verifier))
        #expect(!String(reflecting: pkce).contains(pkce.verifier))
    }

    @Test("secure random bytes have the requested length and vary")
    func randomBytes() {
        #expect(secureRandomBytes(count: 32).count == 32)
        #expect(secureRandomBytes(count: 0).isEmpty)
        #expect(secureRandomBytes(count: 32) != secureRandomBytes(count: 32))
    }
}

@Suite("Sign-in state")
struct SignInStateTests {
    @Test("a generated state passes the server's check")
    func shape() {
        let state = SignInRequest.makeState()
        #expect((22...43).contains(state.count))
        #expect(matches(state, allowed: verifierCharacters, length: 8...128))
    }

    @Test("every generated state is different")
    func random() {
        let states = Set((0..<200).map { _ in SignInRequest.makeState() })
        #expect(states.count == 200)
    }
}

#if canImport(CryptoKit)
@Suite("SHA-256 on Apple platforms")
struct CryptoKitSHA256Tests {
    @Test("the fallback agrees with CryptoKit", arguments: [0, 1, 31, 55, 56, 64, 100, 1000])
    func agrees(length: Int) {
        let message = (0..<length).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) }
        #expect(FallbackSHA256.hash(message) == Array(CryptoKit.SHA256.hash(data: message)))
        #expect(sha256(message) == Array(CryptoKit.SHA256.hash(data: message)))
    }
}
#endif
