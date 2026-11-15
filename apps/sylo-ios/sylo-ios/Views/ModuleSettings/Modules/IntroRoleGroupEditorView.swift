import SwiftUI
import SyloKit

/// One role group of the introductions card: a name, the roles it lists and whether it is left out of
/// a card that has none of them. Changes go straight into the settings draft; Save is on the screen
/// before this one.
struct IntroRoleGroupEditorView: View {
    @Binding var group: IntroductionsRoleGroup
    let roles: [RoleOption]

    var body: some View {
        Form {
            Section {
                LimitedTextField(title: "Name", text: $group.name, limit: IntroductionsRoleGroup.maxNameLength, lines: 1...2)
            } footer: {
                if group.cleanName.isEmpty {
                    Text("A group without a name is not kept.")
                } else {
                    Text("Braces are removed from the name. In the description, {rolegroup:\(group.cleanName)} inserts the member's roles from this group.")
                }
            }

            Section {
                MultiPicker(title: "Roles in this group", selection: $group.roleIds, options: roles, prefix: "@",
                            limit: IntroductionsSettings.maxRolesPerGroup)
                Toggle("Hide when empty", isOn: $group.hideWhenEmpty)
            } footer: {
                Text("A group lists the member's roles from this set as one field on the card, for example Country or Age. With Hide when empty the field is left out of a card that has none of them.")
            }
        }
        .navigationTitle(group.cleanName.isEmpty ? String(localized: "New group") : group.cleanName)
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    @Previewable @State var group = IntroductionsRoleGroup(name: "Country", roleIds: ["r1"], hideWhenEmpty: true)
    NavigationStack {
        IntroRoleGroupEditorView(group: $group, roles: [RoleOption(id: "r1", name: "Norway")])
    }
}
