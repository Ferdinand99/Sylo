import Charts
import SwiftUI
import SyloKit

/// Server insights: messages, joins, leaves and voice time over a range, as bento tiles and charts.
/// Nothing to set (the module only has its switch), so there is no Save. Mirrors
/// web-v2/src/pages/Insights.jsx.
struct InsightsView: View {
    @State private var model: InsightsModel

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: InsightsModel(server: server, session: session))
    }

    var body: some View {
        Group {
            if let page = model.page {
                InsightsContent(page: page, model: model)
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Insights", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") {
                        Task { await model.load() }
                    }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Server Insights")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if model.isRefreshing {
                    ProgressView()
                } else {
                    Button("Refresh Now", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                        .disabled(model.page == nil)
                }
            }
        }
        .task { if model.page == nil { await model.load() } }
    }
}

/// The loaded insights.
private struct InsightsContent: View {
    let page: InsightsPage
    let model: InsightsModel

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var perUnit: String { page.isHourly ? String(localized: "hour") : String(localized: "day") }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SyloSpacing.l) {
                RangePicker(selected: model.range) { range in
                    Task { await model.select(range) }
                }
                Text("These numbers update every 10 minutes. Refresh now counts the latest activity in.")
                    .font(.footnote)
                    .foregroundStyle(Color.syloMuted)

                if let message = model.errorMessage {
                    StatusMessage(message, kind: .error)
                        .padding(SyloSpacing.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .syloCard(radius: SyloRadius.row)
                }

                LazyVGrid(columns: tileColumns, spacing: SyloSpacing.tileGap) {
                    NumberTile(title: "Messages", systemImage: "bubble.left", value: page.totals.messages.formatted(), isLive: true)
                    NumberTile(title: "Net members", systemImage: "person.2", value: signed(page.totals.net))
                    NumberTile(title: "Joins", systemImage: "person.badge.plus", value: page.totals.joins.formatted())
                    NumberTile(title: "Leaves", systemImage: "person.badge.minus", value: page.totals.leaves.formatted())
                    NumberTile(title: "In voice", systemImage: "mic", value: duration(page.totals.voiceMinutes))
                    NumberTile(title: "Peak in voice", systemImage: "waveform", value: page.totals.voicePeak.formatted())
                }

                ChartTile(title: "Messages per \(perUnit)", systemImage: "chart.bar", summary: "\(page.totals.messages.formatted()) messages in total") {
                    Chart(Array(page.series.enumerated()), id: \.offset) { index, point in
                        BarMark(x: .value("Time", index), y: .value("Messages", point.messages))
                            .foregroundStyle(Color.syloCyan)
                    }
                    .chartXAxis(.hidden)
                }

                ChartTile(title: "Voice minutes per \(perUnit)", systemImage: "mic", summary: "\(page.totals.voiceMinutes.formatted()) minutes in total") {
                    Chart(Array(page.series.enumerated()), id: \.offset) { index, point in
                        BarMark(x: .value("Time", index), y: .value("Minutes", point.voiceMinutes))
                            .foregroundStyle(Color.syloBrand)
                    }
                    .chartXAxis(.hidden)
                }

                ChartTile(
                    title: "Member growth", systemImage: "chart.line.uptrend.xyaxis",
                    summary: "\(signed(page.memberGrowth.last ?? 0)) over the range"
                ) {
                    Chart(Array(page.memberGrowth.enumerated()), id: \.offset) { index, total in
                        LineMark(x: .value("Time", index), y: .value("Members", total))
                            .foregroundStyle(Color.syloCyan)
                            .interpolationMethod(.monotone)
                    }
                    .chartXAxis(.hidden)
                }

                ChartTile(title: "Joins and leaves", systemImage: "arrow.left.arrow.right", summary: "\(page.totals.joins) joins, \(page.totals.leaves) leaves") {
                    Chart {
                        ForEach(Array(page.series.enumerated()), id: \.offset) { index, point in
                            LineMark(x: .value("Time", index), y: .value("Count", point.joins), series: .value("Kind", "Joins"))
                                .foregroundStyle(by: .value("Kind", "Joins"))
                            LineMark(x: .value("Time", index), y: .value("Count", point.leaves), series: .value("Kind", "Leaves"))
                                .foregroundStyle(by: .value("Kind", "Leaves"))
                        }
                    }
                    .chartForegroundStyleScale(["Joins": Color.syloCyan, "Leaves": Color.syloWarn])
                    .chartXAxis(.hidden)
                    .chartLegend(position: .bottom)
                }

                RankingTile(
                    title: "Top channels", systemImage: "number", empty: "No message activity recorded yet.",
                    rows: page.topChannels.map { RankingRow(name: "#\($0.name)", amount: $0.amount, text: $0.amount.formatted()) })

                RankingTile(
                    title: "Top voice channels", systemImage: "mic", empty: "No voice activity recorded yet.",
                    rows: page.topVoice.map { RankingRow(name: $0.name, amount: $0.amount, text: duration($0.amount)) })
            }
            .padding(.horizontal, SyloSpacing.screen)
            .padding(.vertical, SyloSpacing.s)
        }
        .refreshable { await model.refresh() }
    }

    private var tileColumns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible(), spacing: SyloSpacing.tileGap)]
        }
        return [
            GridItem(.flexible(), spacing: SyloSpacing.tileGap), GridItem(.flexible(), spacing: SyloSpacing.tileGap),
        ]
    }

    private func signed(_ value: Int) -> String {
        value >= 0 ? "+\(value.formatted())" : "\u{2212}\(abs(value).formatted())"
    }

    /// "45 min", or "2 h 5 m"; from ten hours up whole hours only, so a long total never wraps.
    private func duration(_ minutes: Int) -> String {
        if minutes < 60 { return String(localized: "\(minutes) min") }
        if minutes >= 600 { return String(localized: "\(Int((Double(minutes) / 60).rounded())) h") }
        let rest = minutes % 60
        return rest == 0 ? String(localized: "\(minutes / 60) h") : String(localized: "\(minutes / 60) h \(rest) m")
    }
}

/// The range chips: a row of pills, one selected.
private struct RangePicker: View {
    let selected: InsightsRange
    let choose: (InsightsRange) -> Void

    var body: some View {
        FlowLayout(spacing: SyloSpacing.s) {
            Group {
                ForEach(InsightsRange.allCases.sorted { $0.hours < $1.hours }) { range in
                    let isOn = range == selected
                    Button {
                        choose(range)
                    } label: {
                        Text(range.title)
                            .font(.footnote.weight(.medium))
                            .padding(.horizontal, SyloSpacing.m + 2)
                            .frame(minHeight: 44)
                            .foregroundStyle(isOn ? Color.syloOnCyan : Color.syloText)
                            .background(isOn ? Color.syloCyan : Color.syloCard, in: Capsule())
                            .overlay { Capsule().strokeBorder(isOn ? Color.clear : Color.syloLine, lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Time range"))
    }
}

extension InsightsRange {
    /// The length of the range in hours, to put the shortest first.
    var hours: Int { isHourly ? rawValue : rawValue * 24 }

    var title: String {
        switch self {
        case .day: String(localized: "Last 24 hours")
        case .twoDays: String(localized: "Last 48 hours")
        case .week: String(localized: "Last 7 days")
        case .month: String(localized: "Last 30 days")
        case .quarter: String(localized: "Last 90 days")
        }
    }
}

/// A big number with its label.
private struct NumberTile: View {
    let title: LocalizedStringKey
    let systemImage: String
    let value: String
    var isLive = false

    @ScaledMetric(relativeTo: .title) private var numberSize: CGFloat = 30

    var body: some View {
        BentoTile(title: title, systemImage: systemImage, isLive: isLive) {
            Text(verbatim: value)
                .font(.system(size: numberSize, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.syloText)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .contentTransition(.numericText())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityValue(Text(verbatim: value))
    }
}

/// A chart in a card, with its title and a one line summary for VoiceOver.
private struct ChartTile<Content: View>: View {
    let title: String
    let systemImage: String
    let summary: String
    let content: Content

    init(title: String, systemImage: String, summary: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.summary = summary
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.s) {
            Label {
                Text(verbatim: title)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.syloMuted)
            } icon: {
                Image(systemName: systemImage)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.syloBrand)
            }
            content
                .frame(height: 130)
                .accessibilityHidden(true)
        }
        .padding(SyloSpacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .syloCard()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: title))
        .accessibilityValue(Text(verbatim: summary))
    }
}

/// One line of a ranking: a name, a bar and a figure.
private struct RankingRow: Identifiable {
    let name: String
    let amount: Int
    let text: String

    var id: String { name }
}

/// A ranking of channels, with bars relative to the biggest.
private struct RankingTile: View {
    let title: LocalizedStringKey
    let systemImage: String
    let empty: LocalizedStringKey
    let rows: [RankingRow]

    var body: some View {
        BentoTile(title: title, systemImage: systemImage) {
            if rows.isEmpty {
                Text(empty)
                    .font(.footnote)
                    .foregroundStyle(Color.syloMuted)
            } else {
                let most = max(rows.map(\.amount).max() ?? 1, 1)
                VStack(alignment: .leading, spacing: SyloSpacing.m) {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(verbatim: row.name)
                                    .font(.subheadline)
                                    .foregroundStyle(Color.syloText)
                                    .lineLimit(1)
                                Spacer(minLength: SyloSpacing.s)
                                Text(verbatim: row.text)
                                    .font(.syloNumber(.footnote, weight: .medium))
                                    .foregroundStyle(Color.syloMuted)
                            }
                            GeometryReader { proxy in
                                Capsule()
                                    .fill(Color.syloCyan)
                                    .frame(width: max(proxy.size.width * CGFloat(row.amount) / CGFloat(most), 6))
                            }
                            .frame(height: 6)
                            .background(Color.syloLine, in: Capsule())
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(verbatim: row.name))
                        .accessibilityValue(Text(verbatim: row.text))
                    }
                }
            }
        }
    }
}
