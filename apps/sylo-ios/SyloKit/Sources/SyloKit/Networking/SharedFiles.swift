import Foundation

/// Files the app writes only to hand them to the share sheet (a backup, the configuration export).
/// They hold the server's data, so they are encrypted at rest while the device is locked, live in
/// one folder of the temporary directory, and are deleted as soon as the share sheet closes. Any
/// that are left (the app was killed while sharing) are cleared at launch.
public enum SharedFiles {
    static let folderName = "sylo-shared"

    /// The folder the files go in.
    public static var folder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(folderName, isDirectory: true)
    }

    /// Writes `data` as `fileName` in the folder and returns its URL. An older file of that name is replaced.
    public static func write(_ data: Data, fileName: String) throws -> URL {
        let directory = folder
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(fileName)
        #if os(iOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtection]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        try data.write(to: url, options: options)
        return url
    }

    /// Deletes one shared file. A missing file or a nil URL is fine.
    public static func remove(_ url: URL?) {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Deletes everything in the folder. Called at launch.
    public static func clearLeftovers() {
        try? FileManager.default.removeItem(at: folder)
    }
}
