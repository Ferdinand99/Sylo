import Foundation
import Testing
@testable import SyloKit

private let sampleToken = StoredToken(
    token: "sylo_dGVzdC10b2tlbi1ub3QtYS1yZWFsLW9uZS0xMjM0NTY",
    expiresAt: Date(timeIntervalSince1970: 1_799_999_999.999)
)

@Suite("Stored token")
struct StoredTokenTests {
    @Test("expired at and after its expiry, not before")
    func expiry() {
        let expiry = sampleToken.expiresAt
        #expect(!sampleToken.isExpired(now: expiry.addingTimeInterval(-1)))
        #expect(sampleToken.isExpired(now: expiry))
        #expect(sampleToken.isExpired(now: expiry.addingTimeInterval(1)))
    }

    @Test("survives a JSON round trip unchanged")
    func codable() throws {
        let data = try JSONEncoder().encode(sampleToken)
        #expect(try JSONDecoder().decode(StoredToken.self, from: data) == sampleToken)
    }

    @Test("its description does not show the token")
    func redacted() {
        #expect(!String(describing: sampleToken).contains(sampleToken.token))
        #expect(!String(reflecting: sampleToken).contains(sampleToken.token))
        var dumped = ""
        dump(sampleToken, to: &dumped)
        #expect(!dumped.contains(sampleToken.token))
    }
}

@Suite("In-memory token store")
struct InMemoryTokenStoreTests {
    @Test("nothing stored at first")
    func empty() throws {
        #expect(try InMemoryTokenStore().token(for: "https://app.sylobot.com") == nil)
    }

    @Test("save, read, replace and delete per origin")
    func roundTrip() throws {
        let store = InMemoryTokenStore()
        let other = StoredToken(token: "sylo_other", expiresAt: Date(timeIntervalSince1970: 1))
        try store.save(sampleToken, for: "https://app.sylobot.com")
        try store.save(other, for: "http://192.168.1.5:3000")
        #expect(try store.token(for: "https://app.sylobot.com") == sampleToken)
        #expect(try store.token(for: "http://192.168.1.5:3000") == other)

        try store.save(other, for: "https://app.sylobot.com")
        #expect(try store.token(for: "https://app.sylobot.com") == other)

        try store.delete(for: "https://app.sylobot.com")
        #expect(try store.token(for: "https://app.sylobot.com") == nil)
        #expect(try store.token(for: "http://192.168.1.5:3000") == other)
        try store.delete(for: "https://never-saved.example")
    }

    @Test("starts with the tokens it is given")
    func seeded() throws {
        let store = InMemoryTokenStore(tokens: ["https://app.sylobot.com": sampleToken])
        #expect(try store.token(for: "https://app.sylobot.com") == sampleToken)
    }

    @Test("safe to use from many tasks at once")
    func concurrent() async throws {
        let store = InMemoryTokenStore()
        await withTaskGroup(of: Void.self) { group in
            for index in 0..<200 {
                group.addTask {
                    let token = StoredToken(token: "sylo_\(index)", expiresAt: Date(timeIntervalSince1970: 0))
                    try? store.save(token, for: "https://\(index).example")
                    _ = try? store.token(for: "https://\(index).example")
                    if index.isMultiple(of: 2) {
                        try? store.delete(for: "https://\(index).example")
                    }
                }
            }
        }
        for index in 0..<200 {
            let stored = try store.token(for: "https://\(index).example")
            #expect(stored?.token == (index.isMultiple(of: 2) ? nil : "sylo_\(index)"))
        }
    }
}

@Suite("Device name")
struct DeviceNameTests {
    @Test("the model plus Sylo app", arguments: [("iPhone", "iPhone — Sylo app"), ("iPad", "iPad — Sylo app")])
    func model(model: String, expected: String) {
        #expect(SignInRequest.deviceName(model: model, systemName: "iOS") == expected)
        #expect(SignInRequest.deviceName(model: model, systemName: "iPadOS") == expected)
    }

    @Test("surrounding whitespace is trimmed")
    func trimmed() {
        #expect(SignInRequest.deviceName(model: "  iPad \n", systemName: "iPadOS") == "iPad — Sylo app")
    }

    @Test("the system name without a model, Sylo app without either")
    func fallbacks() {
        #expect(SignInRequest.deviceName(model: " ", systemName: "iOS") == "iOS — Sylo app")
        #expect(SignInRequest.deviceName(model: "", systemName: "") == "Sylo app")
    }

    @Test("at most 100 characters, and the suffix stays")
    func length() {
        let name = SignInRequest.deviceName(model: String(repeating: "x", count: 300), systemName: "iOS")
        #expect(name.unicodeScalars.count == 100)
        #expect(name.hasSuffix(" — Sylo app"))
    }

    @Test("long names are not cut inside a character")
    func graphemes() {
        let family = "👨‍👩‍👧" // five Unicode scalars, one character
        let name = SignInRequest.deviceName(model: String(repeating: family, count: 40), systemName: "iOS")
        #expect(name.unicodeScalars.count <= 100)
        #expect(name.hasSuffix(" — Sylo app"))
        let model = name.dropLast(" — Sylo app".count)
        #expect(model.allSatisfy { String($0) == family })
        #expect(model.count == 17)
    }
}
