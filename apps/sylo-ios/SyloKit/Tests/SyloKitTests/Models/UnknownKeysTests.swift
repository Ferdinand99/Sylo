import Foundation
import Testing
@testable import SyloKit

@Suite("Unknown keys")
struct UnknownKeysTests {
    /// Keeps what it does not model, the way every server object in the app does.
    struct Sample: Codable, Equatable {
        var name: String
        var extra: [String: JSONValue]
        static let known: Set<String> = ["name"]

        init(name: String, extra: [String: JSONValue] = [:]) {
            self.name = name
            self.extra = extra
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: AnyCodingKey.self)
            name = try c.decode(String.self, forKey: AnyCodingKey("name"))
            extra = UnknownKeys.read(from: decoder, excluding: Self.known)
        }

        func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: AnyCodingKey.self)
            try UnknownKeys.write(extra, excluding: Self.known, to: &c)
            try c.encode(name, forKey: AnyCodingKey("name"))
        }
    }

    @Test("Every key the type does not list is kept, with its raw value")
    func keeps() throws {
        let json = #"{"name":"a","tier":3,"flags":[true,null],"nested":{"x":1.5},"note":"hi"}"#
        let sample = try JSONDecoder().decode(Sample.self, from: Data(json.utf8))
        #expect(sample.name == "a")
        #expect(sample.extra == [
            "tier": .int(3), "flags": .array([.bool(true), .null]),
            "nested": .object(["x": .double(1.5)]), "note": .string("hi"),
        ])
    }

    @Test("Kept keys go back unchanged, and never over a key the type writes")
    func writes() throws {
        let sample = Sample(name: "real", extra: ["tier": .int(3), "name": .string("stale")])
        let data = try JSONEncoder().encode(sample)
        let sent = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(sent["tier"] as? Int == 3)
        #expect(sent["name"] as? String == "real")
        #expect(sent.count == 2)
    }

    @Test("A round trip keeps a key a newer server added")
    func roundTrip() throws {
        let json = #"{"name":"a","added":{"later":[1,2]}}"#
        let sample = try JSONDecoder().decode(Sample.self, from: Data(json.utf8))
        let again = try JSONDecoder().decode(Sample.self, from: JSONEncoder().encode(sample))
        #expect(again == sample)
        #expect(again.extra["added"] == .object(["later": .array([.int(1), .int(2)])]))
    }
}
