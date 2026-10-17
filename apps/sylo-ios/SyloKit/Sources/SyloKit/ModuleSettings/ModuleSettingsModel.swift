import Foundation
import Observation

/// Loads one module's settings page, holds the person's unsaved edits (``draft``) and saves them.
@MainActor
@Observable
public final class ModuleSettingsModel<Page: ModuleSettingsPage> {
    public let server: ServerID
    public private(set) var page: Page?
    /// What the form edits. nil until the first load.
    public var draft: Page.Settings?
    /// The settings as last loaded or saved.
    public private(set) var saved: Page.Settings?
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    /// Why the page could not be loaded.
    public var errorMessage: String?
    /// Why the last save did not go through (the draft is kept).
    public var saveError: String?
    /// Goes up with every successful save, for a "saved" haptic.
    public private(set) var saveCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Whether the draft differs from what the server has.
    public var hasChanges: Bool { draft != nil && draft != saved }

    /// Loads the page. Unsaved edits are kept; only the lists around them are refreshed.
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await session.send(Endpoints.LoadModuleSettings<Page>(server: server))
            let keepDraft = hasChanges
            self.page = page
            saved = page.settings
            if !keepDraft { draft = page.settings }
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Saves the draft. The server's answer (normalised) becomes both draft and saved.
    /// - Returns: Whether the settings are saved (also true when there was nothing to save).
    @discardableResult
    public func save() async -> Bool {
        guard let draft, hasChanges else { return true }
        guard !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        saveError = nil
        do {
            let result = try await session.send(Endpoints.SaveModuleSettings<Page>(server: server, settings: draft))
            saved = result.settings
            self.draft = result.settings
            saveCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { saveError = error.userMessage }
            return false
        }
    }

    /// Throws the unsaved edits away.
    public func discardChanges() {
        draft = saved
    }
}
