import SwiftUI
import SyloKit

/// One question of an application form: what it asks, whether it is required, and the settings of its
/// type (answer length, options, roles to hand out). Changes go straight into the form's draft; Save is
/// on the form screen before this one.
struct ApplicationQuestionEditorView: View {
    @Binding var question: ApplicationQuestion
    let roles: [RoleOption]
    let shortTextMax: Int
    /// Owned here so the Edit button in the options header can switch the list to reordering.
    @State private var editMode = EditMode.inactive

    var body: some View {
        Form {
            Section {
                Picker("Type", selection: $question.type) {
                    ForEach(ApplicationQuestionType.choices, id: \.self) { type in
                        Text(type.title).tag(type)
                    }
                    if case .other(let raw) = question.type {
                        Text(verbatim: raw).tag(question.type)
                    }
                }
                LimitedTextField(title: "Question", text: $question.label,
                                 limit: ApplicationQuestion.maxLabelLength, lines: 1...3)
                LimitedTextField(title: "Help text (optional)", text: $question.help,
                                 limit: ApplicationQuestion.maxHelpLength, lines: 1...3)
                Toggle("Required", isOn: $question.required)
            } footer: {
                if question.isUnanswerable {
                    Text("A required question needs at least one option, or members could never answer it.")
                } else if question.hasNoLabel {
                    Text("A question without text is not kept.")
                }
            }

            switch question.type {
            case .text:
                textSection
            case .choice:
                choiceSection
                optionsSection
            case .role:
                roleSection
                choiceSection
            case .yesno, .other:
                EmptyView()
            }
        }
        .environment(\.editMode, $editMode)
        .navigationTitle(question.label.isEmpty ? String(localized: "New question") : question.label)
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Text

    private var textSection: some View {
        Section {
            Toggle("Long answer", isOn: $question.long)
            NumberField(title: "Shortest answer", value: $question.minLength,
                        range: 0...question.lengthCap(shortTextMax: shortTextMax), unit: "characters")
            NumberField(title: "Longest answer", value: $question.maxLength,
                        range: 1...question.lengthCap(shortTextMax: shortTextMax), unit: "characters")
        } header: {
            Text("Answer")
        } footer: {
            Text("A long answer is a text box instead of one line. A longest answer shorter than the shortest one is raised to it.")
        }
    }

    // MARK: - Choice and role

    /// How many answers a member may give.
    private var choiceSection: some View {
        Section {
            Toggle("Allow more than one", isOn: $question.multiple)
            if question.multiple {
                NumberField(title: "At least", value: $question.minChoices,
                            range: 0...max(question.options.count, 1), unit: "choices")
                NumberField(title: "At most", value: $question.maxChoices,
                            range: 1...max(question.options.count, 1), unit: "choices")
            }
        } header: {
            if question.type == .role {
                Text("Answers")
            }
        }
    }

    private var optionsSection: some View {
        Section {
            ForEach($question.options) { $option in
                LimitedTextField(title: "Option", text: $option.label, limit: ApplicationQuestion.maxOptionLabelLength)
            }
            .onMove { source, destination in
                question.moveOptions(fromOffsets: source, toOffset: destination)
            }
            .onDelete { offsets in
                question.options.remove(atOffsets: offsets)
            }
            Button("Add Option", systemImage: "plus") {
                question.addOption()
            }
            .disabled(question.options.count >= ApplicationQuestion.maxOptions)
        } header: {
            HStack {
                Text("Options")
                Spacer()
                if question.options.count > 1 {
                    EditButton().textCase(nil)
                }
            }
        } footer: {
            Text("Up to \(ApplicationQuestion.maxOptions) options. On Fluxer members answer with the option's number. An option without text is not kept.")
        }
    }

    private var roleSection: some View {
        Section {
            MultiPicker(title: "Roles to choose from", selection: roleSelection, options: roles, prefix: "@",
                        limit: ApplicationQuestion.maxOptions)
            Picker("Give the chosen roles", selection: $question.grant) {
                Text("Never (just a question)").tag(ApplicationGrantWhen.never)
                Text("When the application is submitted").tag(ApplicationGrantWhen.submit)
                Text("When the application is accepted").tag(ApplicationGrantWhen.accept)
                if case .other(let raw) = question.grant {
                    Text(verbatim: raw).tag(question.grant)
                }
            }
        } header: {
            Text("Roles")
        } footer: {
            Text("Up to \(ApplicationQuestion.maxOptions) roles. Sylo checks that it can manage them before a member starts.")
        }
    }

    private var roleSelection: Binding<[String]> {
        Binding(
            get: { question.roleIds },
            set: { question.setRoleOptions($0, roles: roles) })
    }
}

#Preview {
    @Previewable @State var question = ApplicationQuestion(
        id: "q1", type: .choice, label: "Timezone", required: true,
        options: [.init(id: "a", label: "Europe"), .init(id: "b", label: "America")])
    NavigationStack {
        ApplicationQuestionEditorView(question: $question, roles: [RoleOption(id: "r1", name: "Staff")], shortTextMax: 1024)
    }
}
