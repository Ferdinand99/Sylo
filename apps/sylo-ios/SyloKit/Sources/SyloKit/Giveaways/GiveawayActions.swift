import Foundation
import Observation

// Ending, cancelling and rerolling a giveaway (src/web/routes/v2Api.js:
// `POST /modules/giveaways/:id/end`, `/cancel` and `/reroll`), the same calls the dashboard makes.
// Each answers with the giveaway list again (`{giveaways}`). Cancelling needs Sylo 5.1: an older
// server sends no `cancelled`, so the screen offers no Cancel there.

/// What every giveaway call answers: the giveaways as they are now.
public struct GiveawayListAnswer: Decodable, Sendable, Equatable {
    public let giveaways: [GiveawaysGiveaway]

    public init(giveaways: [GiveawaysGiveaway] = []) { self.giveaways = giveaways }

    private enum CodingKeys: String, CodingKey { case giveaways }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        giveaways = try c.decodeLossyArray(of: GiveawaysGiveaway.self, forKey: .giveaways)
    }
}

/// The answer to cancelling: the list, and how many entry fees went back.
public struct GiveawayCancelAnswer: Decodable, Sendable, Equatable {
    public let giveaways: [GiveawaysGiveaway]
    /// Entry fees given back.
    public let refunded: Int
    /// Entry fees that could not be given back just now; Sylo tries those again within a minute.
    public let failed: Int

    public init(giveaways: [GiveawaysGiveaway] = [], refunded: Int = 0, failed: Int = 0) {
        self.giveaways = giveaways
        self.refunded = refunded
        self.failed = failed
    }

    private enum CodingKeys: String, CodingKey { case giveaways, refunded, failed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        giveaways = try c.decodeLossyArray(of: GiveawaysGiveaway.self, forKey: .giveaways)
        refunded = try c.decode(forKey: .refunded, or: 0)
        failed = try c.decode(forKey: .failed, or: 0)
    }
}

extension GiveawaysGiveaway {
    /// How many winners a reroll draws (LIMITS.winners on the server, which also bounds a start).
    public static let rerollRange = 1...20
}

extension Endpoints {
    /// `POST /api/v2/guilds/:id/modules/giveaways/:id/end`: ends a running giveaway now and draws the
    /// winners. 400 when it is not running.
    public struct EndGiveaway: APIEndpoint {
        public typealias Response = GiveawayListAnswer
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/giveaways/\(id)/end" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/modules/giveaways/:id/cancel`: nobody wins and every entry fee goes back.
    public struct CancelGiveaway: APIEndpoint {
        public typealias Response = GiveawayCancelAnswer
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/giveaways/\(id)/cancel" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/modules/giveaways/:id/reroll` with `{count}`: draws new winners
    /// from the entrants of an ended giveaway. 400 when it has not ended.
    public struct RerollGiveaway: APIEndpoint {
        public typealias Response = GiveawayListAnswer
        public let server: ServerID
        public let id: Int
        /// How many winners to draw; the server keeps it between 1 and 20.
        public let count: Int

        public init(server: ServerID, id: Int, count: Int = 1) {
            self.server = server
            self.id = id
            self.count = count
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/giveaways/\(id)/reroll" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(count: count) }

        private struct Body: Encodable, Sendable { let count: Int }
    }
}

/// Ending, cancelling and rerolling giveaways. Each answer carries the whole list, kept in
/// ``giveaways`` so the screen can show it without loading the page again.
@MainActor
@Observable
public final class GiveawayActionsModel {
    public let server: ServerID
    /// The giveaways as the last action answered them; nil until one did, or after ``forgetAnswer()``.
    public private(set) var giveaways: [GiveawaysGiveaway]?
    /// The id of the giveaway an action is running on.
    public private(set) var busyID: Int?
    /// Why the last action did not go through.
    public var errorMessage: String?
    /// What cancelling did to the entry fees, for an alert.
    public var notice: CommunityNotice?
    /// Goes up with every action that went through, for a haptic.
    public private(set) var doneCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Ends a running giveaway and draws its winners.
    @discardableResult
    public func end(_ giveaway: GiveawaysGiveaway) async -> Bool {
        guard begin(giveaway.id) else { return false }
        defer { busyID = nil }
        do {
            giveaways = try await session.send(Endpoints.EndGiveaway(server: server, id: giveaway.id)).giveaways
            doneCount += 1
            return true
        } catch {
            fail(error)
            return false
        }
    }

    /// Cancels a running giveaway; explains in ``notice`` what happened to the entry fees.
    @discardableResult
    public func cancel(_ giveaway: GiveawaysGiveaway) async -> Bool {
        guard begin(giveaway.id) else { return false }
        defer { busyID = nil }
        do {
            let answer = try await session.send(Endpoints.CancelGiveaway(server: server, id: giveaway.id))
            giveaways = answer.giveaways
            if giveaway.entryFee > 0 {
                notice = Self.refundNotice(refunded: answer.refunded, failed: answer.failed)
            }
            doneCount += 1
            return true
        } catch {
            fail(error)
            return false
        }
    }

    /// Draws new winners for an ended giveaway. The count is pulled into the range the server keeps.
    @discardableResult
    public func reroll(_ giveaway: GiveawaysGiveaway, count: Int) async -> Bool {
        guard begin(giveaway.id) else { return false }
        defer { busyID = nil }
        let range = GiveawaysGiveaway.rerollRange
        let count = min(max(count, range.lowerBound), range.upperBound)
        do {
            giveaways = try await session.send(
                Endpoints.RerollGiveaway(server: server, id: giveaway.id, count: count)).giveaways
            doneCount += 1
            return true
        } catch {
            fail(error)
            return false
        }
    }

    /// Drops the answer, so the screen shows the page's own list again (after the page was loaded anew).
    public func forgetAnswer() {
        giveaways = nil
    }

    /// "3 entry fee(s) were given back." and, when some failed, that Sylo tries those again.
    nonisolated static func refundNotice(refunded: Int, failed: Int) -> CommunityNotice {
        if failed > 0 {
            return CommunityNotice(
                "\(refunded) entry fee(s) were given back. \(failed) could not be just now: Sylo tries those again within a minute.",
                isError: true)
        }
        return CommunityNotice("\(refunded) entry fee(s) were given back.")
    }

    private func begin(_ id: Int) -> Bool {
        guard busyID == nil else {
            errorMessage = CommunityMessage.busy
            return false
        }
        busyID = id
        errorMessage = nil
        return true
    }

    private func fail(_ error: any Error) {
        let error = NetworkError(error)
        if error != .cancelled, error != .unauthorized { errorMessage = error.communityMessage }
    }
}
