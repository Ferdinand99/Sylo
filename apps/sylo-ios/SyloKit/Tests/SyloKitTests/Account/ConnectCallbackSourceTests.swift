import Foundation
import Testing

/// The connect result may only come from the sign-in sheet that the session itself opened. A
/// `sylo://connected?...` URL that reaches the app any other way (a link in a browser or message, a
/// hostile app) must never be completed: it could attach someone else's login to this account.
/// These tests read the source, because the open-URL path is in the app target, out of reach of a
/// runtime test: the app has to stay free of any handler for incoming URLs, and the complete call
/// has to stay reachable from `AccountModel.connect` only.
@Suite("Connect callback source guard")
struct ConnectCallbackSourceTests {
    /// `apps/sylo-ios`, found from this file.
    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private static func swiftFiles(under directory: URL) -> [URL] {
        guard let walker = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil) else {
            return []
        }
        return walker.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    private static func files(_ directory: URL, containing needle: String) -> [String] {
        swiftFiles(under: directory).filter { url in
            (try? String(contentsOf: url, encoding: .utf8))?.contains(needle) == true
        }.map(\.lastPathComponent).sorted()
    }

    @Test("The app has no handler for incoming URLs, so a sylo://connected link from outside is ignored")
    func noOpenURLHandler() throws {
        let app = Self.appRoot.appendingPathComponent("sylo-ios")
        #expect(FileManager.default.fileExists(atPath: app.path), "\(app.path) is missing, so the guard reads nothing")
        #expect(!Self.swiftFiles(under: app).isEmpty)
        for needle in ["onOpenURL", "handlesExternalEvents", "onContinueUserActivity", "open url: URL", "OpenURLOptionsKey"] {
            #expect(Self.files(app, containing: needle).isEmpty, "found \(needle) in the app")
        }
    }

    @Test("Only the sheet's own callback is read as a connect result, and only the model completes it")
    func completeIsReachedFromTheModelOnly() {
        let root = Self.appRoot
        let kit = root.appendingPathComponent("SyloKit/Sources/SyloKit")
        let app = root.appendingPathComponent("sylo-ios")
        #expect(FileManager.default.fileExists(atPath: kit.path), "\(kit.path) is missing, so the guard reads nothing")
        #expect(FileManager.default.fileExists(atPath: app.path), "\(app.path) is missing, so the guard reads nothing")
        #expect(Self.files(kit, containing: "Endpoints.CompleteConnect(") == ["AccountModel.swift"])
        #expect(Self.files(kit, containing: "ConnectCallback.result(") == ["AccountModel.swift"])
        #expect(Self.files(app, containing: "CompleteConnect").isEmpty)
        #expect(Self.files(app, containing: "ConnectCallback.result(").isEmpty)
    }
}
