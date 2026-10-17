import SwiftUI
import SyloKit

// Controls the module settings screens share. Ids are strings, "" meaning "none", the way the
// server stores them.

/// Picks one channel (or none). A channel that no longer exists stays selectable as "Deleted
/// channel" so opening the screen never changes the setting by itself.
struct ChannelPicker: View {
    let title: LocalizedStringKey
    @Binding var selection: String
    let channels: [ChannelOption]
    var noneTitle: LocalizedStringKey = "None"

    var body: some View {
        Picker(title, selection: $selection) {
            Text(noneTitle).tag("")
            ForEach(channels) { channel in
                Text(verbatim: "#\(channel.name)").tag(channel.id)
            }
            if !selection.isEmpty, !channels.contains(where: { $0.id == selection }) {
                Text("Deleted channel").tag(selection)
            }
        }
        .pickerStyle(.navigationLink)
    }
}

/// Picks one role (or none).
struct RolePicker: View {
    let title: LocalizedStringKey
    @Binding var selection: String
    let roles: [RoleOption]
    var noneTitle: LocalizedStringKey = "None"

    var body: some View {
        Picker(title, selection: $selection) {
            Text(noneTitle).tag("")
            ForEach(roles) { role in
                Text(verbatim: "@\(role.name)").tag(role.id)
            }
            if !selection.isEmpty, !roles.contains(where: { $0.id == selection }) {
                Text("Deleted role").tag(selection)
            }
        }
        .pickerStyle(.navigationLink)
    }
}

/// Picks any number of channels or roles: a row with a summary that opens a checklist.
struct MultiPicker<Option: NamedOption>: View {
    let title: LocalizedStringKey
    @Binding var selection: [String]
    let options: [Option]
    /// `#` for channels, `@` for roles.
    let prefix: String

    var body: some View {
        NavigationLink {
            MultiPickerList(title: title, selection: $selection, options: options, prefix: prefix)
        } label: {
            LabeledContent(title) {
                Text(summary)
            }
        }
    }

    private var summary: String {
        let names = selection.map { id in options.first { $0.id == id }.map { prefix + $0.name } ?? "deleted" }
        switch names.count {
        case 0: return String(localized: "None")
        case 1, 2: return ListFormatter.localizedString(byJoining: names)
        default: return String(localized: "\(names.count) selected")
        }
    }
}

private struct MultiPickerList<Option: NamedOption>: View {
    let title: LocalizedStringKey
    @Binding var selection: [String]
    let options: [Option]
    let prefix: String

    var body: some View {
        List {
            ForEach(options) { option in
                Button {
                    toggle(option.id)
                } label: {
                    HStack {
                        Text(verbatim: prefix + option.name)
                            .foregroundStyle(.primary)
                        Spacer()
                        if selection.contains(option.id) {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.tint)
                                .fontWeight(.semibold)
                        }
                    }
                }
                .accessibilityAddTraits(selection.contains(option.id) ? .isSelected : [])
            }
            // Selected ids the server no longer has: shown so they can be removed.
            let missing = selection.filter { id in !options.contains { $0.id == id } }
            if !missing.isEmpty {
                Section("No longer on the server") {
                    ForEach(missing, id: \.self) { id in
                        Button(role: .destructive) {
                            toggle(id)
                        } label: {
                            Label("Remove deleted item", systemImage: "minus.circle")
                        }
                    }
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if options.isEmpty {
                ContentUnavailableView("Nothing to Choose", systemImage: "list.bullet")
            }
        }
    }

    private func toggle(_ id: String) {
        if let index = selection.firstIndex(of: id) {
            selection.remove(at: index)
        } else {
            selection.append(id)
        }
    }
}

/// A whole number in a range, typed in, with a unit after it ("10 min"). Out-of-range values are
/// pulled back into the range when the field is left.
struct NumberField: View {
    let title: LocalizedStringKey
    @Binding var value: Int
    let range: ClosedRange<Int>
    var unit: LocalizedStringKey?

    @FocusState private var isFocused: Bool

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 4) {
                TextField(title, value: $value, format: .number)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
                    .focused($isFocused)
                    .fixedSize()
                if let unit {
                    Text(unit).foregroundStyle(.secondary)
                }
            }
        }
        .onChange(of: isFocused) {
            if !isFocused { value = min(max(value, range.lowerBound), range.upperBound) }
        }
    }
}

/// Several lines of text (a message, a template), with a character limit shown when it gets
/// close.
struct TextArea: View {
    let title: LocalizedStringKey
    @Binding var text: String
    var limit: Int?
    var lines: ClosedRange<Int> = 3...8

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField(title, text: $text, axis: .vertical)
                .lineLimit(lines)
            if let limit, text.count > limit * 3 / 4 {
                Text("\(text.count) of \(limit) characters")
                    .font(.caption)
                    .foregroundStyle(text.count > limit ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            }
        }
        .onChange(of: text) {
            if let limit, text.count > limit { text = String(text.prefix(limit)) }
        }
    }
}
