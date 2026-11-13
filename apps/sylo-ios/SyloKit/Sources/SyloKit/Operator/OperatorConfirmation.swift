import Foundation

/// The questions an operator must answer by typing a word before something irreversible happens, with
/// the exact words of the dashboard (web-v2/src/pages/Health.jsx and Personalizer.jsx) and what must be
/// typed. The app shows them in a typed-confirmation alert; the models check ``accepts(_:)`` again
/// before they send anything, so a screen that forgets to ask cannot skip the question.
///
/// The dashboard asks for a typed word only before a restore (the backup's name); for the others it
/// shows a plain confirmation. The app asks for a word in every case, because a phone is easy to tap
/// by accident.
public enum OperatorConfirmation: Sendable, Equatable {
    /// Replace the live database with a backup and restart the bot.
    case restore(backup: String)
    /// Store a file the person picked as a backup.
    case importFile(name: String)
    /// Delete a backup for good.
    case deleteBackup(name: String)
    /// Take the live announcement down for everyone.
    case clearAnnouncement

    public var title: String {
        switch self {
        case .restore: "Restore the database?"
        case .importFile: "Import this backup file?"
        case .deleteBackup: "Delete this backup?"
        case .clearAnnouncement: "Clear the live announcement?"
        }
    }

    /// What will happen, in the dashboard's words with the app's extra warnings. The restore and the
    /// import say clearly which of them touches the live data.
    public var message: String {
        switch self {
        case .restore(let name):
            "All current data is replaced with \(name) and the bot restarts. A prerestore snapshot is taken first. "
                + "This changes the data of every server at once, and you are signed out if the backup is older than your sign-in."
        case .importFile(let name):
            "\(name) is stored as a snapshot. Nothing is restored until you press Restore on its row. "
                + "Importing can remove the oldest snapshots, to stay within the number the server keeps."
        case .deleteBackup(let name):
            "\(name) is removed from the backups folder for good."
        case .clearAnnouncement:
            "It disappears from every dashboard page for everyone straight away."
        }
    }

    /// The confirming button.
    public var confirmTitle: String {
        switch self {
        case .restore: "Restore and Restart"
        case .importFile: "Import"
        case .deleteBackup: "Delete Backup"
        case .clearAnnouncement: "Clear Announcement"
        }
    }

    /// What must be typed, exactly: the backup's name for a restore (as on the dashboard), a word for
    /// the others.
    public var word: String {
        switch self {
        case .restore(let name): name
        case .importFile: "IMPORT"
        case .deleteBackup: "DELETE"
        case .clearAnnouncement: "CLEAR"
        }
    }

    /// Whether `typed` is the word, character for character.
    public func accepts(_ typed: String) -> Bool {
        !word.isEmpty && typed == word
    }
}
