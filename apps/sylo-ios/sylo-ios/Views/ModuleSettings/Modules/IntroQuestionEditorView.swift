import SwiftUI
import SyloKit

/// One question of the introductions questionnaire: the label on the card, the question Sylo asks in a
/// DM, how long the answer can be, and whether it is required or shown side by side with the next one.
/// Changes go straight into the settings draft; Save is on the screen before this one.
struct IntroQuestionEditorView: View {
    @Binding var question: IntroductionsQuestion

    var body: some View {
        Form {
            Section {
                TextArea(title: "Label on the card", text: $question.label,
                         limit: IntroductionsQuestion.maxLabelLength, lines: 1...2)
            } footer: {
                if question.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("A question without a label is not kept.")
                } else {
                    Text("The name of the field on the member's card.")
                }
            }

            Section {
                TextArea(title: "Question asked in the DM", text: $question.prompt,
                         limit: IntroductionsQuestion.maxPromptLength, lines: 2...5)
            } header: {
                Text("Question")
            }

            Section {
                NumberField(title: "Longest answer", value: $question.maxLength,
                            range: IntroductionsQuestion.answerLengthRange, unit: "characters")
                Toggle("Required", isOn: $question.required)
                Toggle("Short field", isOn: $question.inline)
            } footer: {
                Text("A short field is shown side by side with the next one on the card. A member can type skip to leave an optional question empty.")
            }
        }
        .navigationTitle(question.label.isEmpty ? String(localized: "New question") : question.label)
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    @Previewable @State var question = IntroductionsQuestion(
        id: "about", label: "About me", prompt: "Tell us a little about yourself.", required: true)
    NavigationStack {
        IntroQuestionEditorView(question: $question)
    }
}
