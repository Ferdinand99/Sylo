import SwiftUI
import SyloKit

/// What's New: the Sylo server's release notes, newest first, ten releases at a time. Reached from
/// Settings when the server sends its changelog to the app (`changelog` in its features); older
/// servers open the dashboard's What's new page in the browser instead.
struct ChangelogView: View {
    @State private var model: ChangelogModel

    init(session: AppSession) {
        _model = State(initialValue: ChangelogModel(session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage, !model.releases.isEmpty {
                Section { StatusMessage(message, kind: .error) }
            }
            ForEach(model.visibleReleases) { release in
                ReleaseSection(release: release, isCurrent: model.isCurrent(release))
            }
            if model.hasOlderReleases {
                Section {
                    Button("Show Older Releases", action: showOlderReleases)
                }
            }
        }
        .overlay {
            ChangelogPlaceholder(model: model)
        }
        .navigationTitle("What's New")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    private func showOlderReleases() {
        withAnimation {
            model.showOlderReleases()
        }
    }
}

/// Shown over the empty list: loading, why it couldn't load, or that there are no notes yet.
private struct ChangelogPlaceholder: View {
    let model: ChangelogModel

    var body: some View {
        if model.releases.isEmpty {
            if !model.hasLoaded {
                ProgressView()
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load What's New", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again", action: retry)
                        .disabled(model.isLoading)
                }
            } else {
                ContentUnavailableView(
                    "Nothing Here Yet", systemImage: "sparkles",
                    description: Text("Release notes for this Sylo server will show here."))
            }
        }
    }

    private func retry() {
        Task { await model.load() }
    }
}

/// One release: its version and day as the header, then each group of changes.
private struct ReleaseSection: View {
    let release: ChangelogRelease
    let isCurrent: Bool

    var body: some View {
        Section {
            if release.sections.isEmpty {
                Text("No notes for this release.")
                    .foregroundStyle(.secondary)
            }
            ForEach(release.sections.indices, id: \.self) { index in
                let section = release.sections[index]
                KindLabel(section: section)
                ForEach(section.items.indices, id: \.self) { itemIndex in
                    ChangeRow(item: section.items[itemIndex])
                }
            }
        } header: {
            ReleaseHeader(release: release, isCurrent: isCurrent)
        }
        .headerProminence(.increased)
    }
}

/// "v4.6.0 · Oct 19, 2026", with "This version" on the release the server runs. Stacks at the
/// accessibility text sizes so nothing is cut off.
private struct ReleaseHeader: View {
    let release: ChangelogRelease
    let isCurrent: Bool

    @Environment(\.calendar) private var calendar
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        layout {
            Text(verbatim: "v\(release.version)")
                .accessibilityLabel("Version \(release.version)")
            // The day in the calendar it was read in, so it never shifts a day across time zones.
            if let day = release.day(in: calendar) {
                Text(day, format: dayFormat)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if isCurrent {
                ThisVersionBadge()
            }
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// "Oct 19, 2026", in the same calendar and time zone the day was read in.
    private var dayFormat: Date.FormatStyle {
        Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: calendar, timeZone: calendar.timeZone)
    }
}

/// "This version", in the same hairline capsule with an accent dot as Settings' "Public beta".
private struct ThisVersionBadge: View {
    @ScaledMetric(relativeTo: .caption) private var dot = 6.0

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(.tint)
                .frame(width: dot, height: dot)
            Text("This version")
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .overlay {
            Capsule().strokeBorder(.separator)
        }
    }
}

/// A group's label, such as "New" or "Fixes". Breaking changes are red and keep their own symbol,
/// so they never stand out by colour alone.
private struct KindLabel: View {
    let section: ChangelogSection

    var body: some View {
        Label {
            title
        } icon: {
            Image(systemName: symbol)
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(section.kind == .breaking ? Color.red : Color.secondary)
        .listRowSeparator(.hidden, edges: .bottom)
        .accessibilityAddTraits(.isHeader)
    }

    /// The server's own heading, or one for its kind when it sent none.
    private var title: Text {
        if !section.title.isEmpty { return Text(verbatim: section.title) }
        switch section.kind {
        case .features: return Text("New")
        case .fixes: return Text("Fixes")
        case .performance: return Text("Performance")
        case .breaking: return Text("Breaking Changes")
        case .other: return Text("Other Changes")
        }
    }

    private var symbol: String {
        switch section.kind {
        case .features: "sparkles"
        case .fixes: "wrench.and.screwdriver"
        case .performance: "bolt"
        case .breaking: "exclamationmark.triangle.fill"
        case .other: "ellipsis.circle"
        }
    }
}

/// One change: its scope, the text (inline Markdown: `code`, links, bold) and the issues behind
/// it. VoiceOver reads it as one element, with every link it holds as an action.
private struct ChangeRow: View {
    let scope: String?
    let text: AttributedString
    /// "#266, #270", each a link when the server sent an address.
    let refs: AttributedString?
    let links: [ChangeLink]

    @Environment(\.openURL) private var openURL

    init(item: ChangelogItem) {
        scope = item.scope
        let text = Self.markdown(item.text)
        self.text = text

        var refs = AttributedString()
        for (index, ref) in item.refs.enumerated() {
            if index > 0 { refs += AttributedString(", ") }
            var part = AttributedString(ref.label)
            part.link = ref.url
            refs += part
        }
        self.refs = item.refs.isEmpty ? nil : refs

        var links: [ChangeLink] = []
        for run in text.runs {
            guard let url = run.link else { continue }
            let link = ChangeLink(label: String(text[run.range].characters), url: url)
            if !links.contains(link) { links.append(link) }
        }
        for ref in item.refs {
            guard let url = ref.url else { continue }
            let link = ChangeLink(label: ref.label, url: url)
            if !links.contains(link) { links.append(link) }
        }
        self.links = links
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let scope {
                Text(verbatim: scope)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }
            Text(text)
            if let refs {
                Text(refs)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            ForEach(links, id: \.self) { link in
                Button("Open \(link.label)") { openURL(link.url) }
            }
        }
    }

    /// The server's inline Markdown, or the text as it is when it does not parse.
    private static func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

/// A link in a change, offered to VoiceOver as an action.
private struct ChangeLink: Hashable {
    let label: String
    let url: URL
}

#Preview {
    NavigationStack {
        ChangelogView(session: .preview(.signedIn))
    }
}
