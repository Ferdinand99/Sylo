import SwiftUI
import SyloKit

/// A "Send test message" section for a module that posts to one configured channel (Welcome,
/// Birthdays, Logging, Twitch, YouTube, Starboard, Free games). The server sends from the *saved*
/// settings, so the button is off while the screen has unsaved changes. Mirrors the web
/// dashboard's SendTestButton.
///
/// ```swift
/// SendTestButton(model: test, hasUnsavedChanges: model.hasChanges,
///                sample: "a sample alert", channelName: name)
/// ```
struct SendTestButton: View {
    let model: ModuleTestModel
    /// Whether the module screen has edits that are not saved yet.
    let hasUnsavedChanges: Bool
    /// What is posted: "a sample alert".
    let sample: String
    /// The channel it goes to, as far as the screen knows.
    let channelName: String?
    /// Anything else worth saying: "the first streamer in the list".
    var note = ""

    var body: some View {
        // Like the dashboard, only while the module is on.
        Group {
            if model.isAvailable {
                section
            }
        }
        .task { await model.loadAvailability() }
    }

    private var section: some View {
        Section {
            Button {
                Task { await model.send() }
            } label: {
                if model.isSending {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Sending…")
                    }
                } else {
                    Label("Send Test Message", systemImage: "paperplane")
                }
            }
            .disabled(hasUnsavedChanges || model.isSending)
            if let outcome = model.outcome {
                StatusMessage(outcome.text, kind: outcome.isSent ? .notice : .error)
            }
        } footer: {
            if hasUnsavedChanges {
                Text("Save your changes first. The test uses the saved settings.")
            } else {
                Text(verbatim: ModuleTestText.postsTo(sample: sample, channelName: channelName, note: note))
            }
        }
        // A result describes the settings as they were saved; once they change it is out of date.
        .onChange(of: hasUnsavedChanges) { model.clearOutcome() }
        .sensoryFeedback(trigger: model.outcome) { _, new in new?.isSent == true ? .success : nil }
    }
}
