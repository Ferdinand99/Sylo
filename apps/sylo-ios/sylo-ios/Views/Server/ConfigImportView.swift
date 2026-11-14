import SwiftUI
import SyloKit
import UniformTypeIdentifiers

/// Import configuration (Sylo 5.2): choose the file "Export Configuration" made, see what each module would
/// change, tick what to import and type the confirmation word. Nothing is written until the last step, and every
/// module goes through the same checks as saving its page (the server does the work). Channels and roles this
/// server does not have are left empty, and the preview says so. Mirrors web-v2/src/components/ConfigImport.jsx.
struct ConfigImportView: View {
    @State private var model: ConfigImportModel
    @State private var isChoosing = false
    @State private var isConfirming = false
    @Environment(\.dashboardAccess) private var access

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ConfigImportModel(server: server, session: session))
    }

    var body: some View {
        List {
            switch model.phase {
            case .idle:
                chooseSection
            case .reading:
                Section { HStack(spacing: 8) { ProgressView(); Text("Reading the file\u{2026}") } }
            case .review(let plan):
                reviewSections(plan)
            case .applying:
                Section { HStack(spacing: 8) { ProgressView(); Text("Importing\u{2026}") } }
            case .done(let results):
                doneSections(results)
            }
        }
        .navigationTitle("Import Configuration")
        .navigationBarTitleDisplayMode(.inline)
        .lockedBelow()
        .fileImporter(isPresented: $isChoosing, allowedContentTypes: [.json]) { result in
            handle(result)
        }
        .typedConfirmation(
            "Import \(model.picked.count) \(model.picked.count == 1 ? "Item" : "Items")?",
            message: "This replaces the settings of the ticked items on this server with the ones in the file. Each change is written to the audit log. The file can turn modules on, so check the list before you confirm.",
            word: model.plan?.confirmWord ?? ImportPlan.defaultConfirmWord, isPresented: $isConfirming,
            confirmTitle: "Import"
        ) {
            model.typedWord = model.plan?.confirmWord ?? ImportPlan.defaultConfirmWord
            Task { await model.apply() }
        }
    }

    // MARK: Choose

    private var chooseSection: some View {
        Section {
            Button("Choose File\u{2026}", systemImage: "doc") { isChoosing = true }
            if let message = model.errorMessage {
                StatusMessage(message, kind: .error)
            }
        } footer: {
            Text("Load a configuration file you exported from this or another server. You see what would change for each module before anything is written. Channels and roles that this server does not have are left empty.")
        }
    }

    private func handle(_ result: Result<URL, any Error>) {
        switch result {
        case .failure:
            model.errorMessage = "The file could not be opened."
        case .success(let url):
            let granted = url.startAccessingSecurityScopedResource()
            defer { if granted { url.stopAccessingSecurityScopedResource() } }
            // The server refuses more than 256 KB; saying so first saves reading a large file.
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > ConfigImportModel.maxFileBytes {
                model.errorMessage = "This file is larger than 256 KB, which is more than a Sylo export holds."
                return
            }
            guard let data = try? Data(contentsOf: url) else {
                model.errorMessage = "The file could not be read."
                return
            }
            Task { await model.preview(fileData: data) }
        }
    }

    // MARK: Review

    @ViewBuilder
    private func reviewSections(_ plan: ImportPlan) -> some View {
        Section {
            Text(sourceText(plan))
                .font(.subheadline)
            if !plan.notCarried.isEmpty {
                Text(verbatim: plan.notCarried)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let message = model.errorMessage {
                StatusMessage(message, kind: .error)
            }
        }
        Section {
            ForEach(plan.items) { item in
                ImportItemRow(item: item, isOn: Binding(
                    get: { model.picked.contains(item.key) },
                    set: { _ in model.toggle(item.key) }))
            }
        } header: {
            Text("What the file would change")
        }
        Section {
            Button("Tick All With Changes") { model.tickAll() }
            Button("Untick All") { model.untickAll() }
            Button {
                isConfirming = true
            } label: {
                Text("Import \(model.picked.count) \(model.picked.count == 1 ? "Item" : "Items")\u{2026}")
            }
            .disabled(model.picked.isEmpty)
            Button("Cancel", role: .cancel) { model.reset() }
        } footer: {
            Text("You are asked to type \(plan.confirmWord) before anything is written.")
        }
    }

    private func sourceText(_ plan: ImportPlan) -> String {
        var text = plan.source.sameServer ? "Exported from this server" : "Exported from another server"
        if !plan.source.sameServer, let id = plan.source.guildID, !id.isEmpty { text += " (\(id))" }
        if let when = plan.source.exportedAt, let date = ISO8601DateFormatter.fractional.date(from: when)
            ?? ISO8601DateFormatter().date(from: when) {
            text += ", \(DateText.day(date))"
        }
        let changes = plan.changes.count
        text += changes == 0
            ? ". Nothing in it would change this server."
            : ". \(changes) \(changes == 1 ? "item has" : "items have") changes."
        return text
    }

    // MARK: Done

    @ViewBuilder
    private func doneSections(_ results: [ImportResult]) -> some View {
        Section {
            ForEach(results) { result in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(verbatim: result.label)
                        Spacer()
                        StatusTag(result.ok ? "Imported" : "Not imported", tint: result.ok ? .green : .red)
                    }
                    if let error = result.error {
                        Text(verbatim: error)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Imported \(results.filter(\.ok).count) of \(results.count)")
        }
        Section {
            Button("Done") { model.reset() }
        }
    }
}

private extension ISO8601DateFormatter {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// One item of the preview: a tick, what it is, why it is as it is, and what it changes.
private struct ImportItemRow: View {
    let item: ImportItem
    @Binding var isOn: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: $isOn) {
                HStack {
                    Text(verbatim: item.label)
                    StatusTag(LocalizedStringKey(item.status.label), tint: item.status == .change ? .orange : .secondary)
                }
            }
            .disabled(item.status != .change)
            ForEach(item.notes, id: \.self) { note in
                Label {
                    Text(verbatim: note).font(.footnote)
                } icon: {
                    Image(systemName: item.status == .skip ? "info.circle" : "exclamationmark.triangle.fill")
                        .foregroundStyle(item.status == .skip ? Color.secondary : Color.orange)
                }
            }
            if let change = item.change {
                let diff = change.diff
                DisclosureGroup("Show What Changes") {
                    ForEach(diff.rows) { row in
                        DiffRowView(row: row, names: change.names)
                    }
                    if diff.more > 0 {
                        Text("and \(diff.more) more changed.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .font(.subheadline)
            }
        }
        .padding(.vertical, 2)
    }
}
