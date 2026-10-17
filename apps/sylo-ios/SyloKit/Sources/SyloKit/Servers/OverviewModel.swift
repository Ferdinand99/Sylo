import Foundation
import Observation

/// One server's overview: its header and module cards, and switching modules on and off.
@MainActor
@Observable
public final class OverviewModel {
    public let server: ServerID
    public private(set) var overview: ServerOverview?
    public private(set) var isLoading = false
    /// Why the overview could not be loaded.
    public var errorMessage: String?
    /// Why the last switch did not go through (the toggle is back where it was).
    public var toggleError: String?

    private var pending: Set<String> = []
    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public func card(_ id: String) -> OverviewCard? {
        overview?.groups.lazy.flatMap(\.cards).first { $0.id == id }
    }

    /// Whether a switch of this card is on its way to the server.
    public func isPending(_ id: String) -> Bool { pending.contains(id) }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            overview = try await session.send(Endpoints.Overview(server: server))
            errorMessage = nil
        } catch let error as NetworkError {
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        } catch {
            errorMessage = NetworkError(error).userMessage
        }
    }

    /// Switches a module on or off. The card changes at once; when the server answers it shows
    /// the server's state, and on failure it goes back with a ``toggleError``.
    /// - Returns: The running switch, or nil when there is nothing to switch (no such module card,
    ///   or a switch of it is already on its way).
    @discardableResult
    public func setModule(_ id: String, enabled: Bool) -> Task<Void, Never>? {
        guard let card = card(id), card.hasToggle, let module = card.moduleID, !pending.contains(id) else {
            return nil
        }
        let before = card.isEnabled ?? false
        toggleError = nil
        pending.insert(id)
        update(id, isEnabled: enabled)
        return Task {
            defer { pending.remove(id) }
            do {
                let result = try await session.send(
                    Endpoints.SetModule(server: server, module: module, enabled: enabled))
                update(id, isEnabled: result.isEnabled)
            } catch {
                update(id, isEnabled: before)
                let error = NetworkError(error)
                if error != .cancelled, error != .unauthorized { toggleError = error.userMessage }
            }
        }
    }

    private func update(_ id: String, isEnabled: Bool) {
        guard let overview else { return }
        let groups = overview.groups.map { group in
            OverviewGroup(title: group.title, cards: group.cards.map { $0.id == id ? $0.with(isEnabled: isEnabled) : $0 })
        }
        self.overview = ServerOverview(
            server: overview.server, openTickets: overview.openTickets, openAppeals: overview.openAppeals,
            groups: groups)
    }
}

extension OverviewCard {
    /// This card switched on or off. A module that can't run (``ModuleStatus/blocked``) stays so.
    func with(isEnabled: Bool) -> OverviewCard {
        OverviewCard(
            kind: kind, id: id, name: name, icon: icon, description: description, hasToggle: hasToggle,
            isEnabled: isEnabled, isBeta: isBeta, missingIntents: missingIntents,
            status: status == .blocked ? .blocked : (isEnabled ? .on : .off),
            webPath: webPath, lines: lines)
    }
}
