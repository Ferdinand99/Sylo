import Charts
import SwiftUI
import SyloKit

/// Server insights: messages, voice time, member growth, joins against leaves and the busiest
/// channels, for the last day or two by hour or the last weeks by day. Mirrors
/// web-v2/src/pages/Insights.jsx. Pull to refresh asks the bot to write what it has counted so far.
struct InsightsView: View {
    @State private var model: InsightsModel

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: InsightsModel(server: server, session: session))
    }

    var body: some View {
        Group {
            if let report = model.report {
                content(report)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Insights", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Insights")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if model.isRefreshing || (model.isLoading && model.report != nil) {
                    ProgressView()
                } else {
                    Button("Refresh Now", systemImage: "arrow.clockwise") {
                        Task { await model.refresh() }
                    }
                    .disabled(model.report == nil)
                }
            }
        }
        // Loads at once, and again whenever the range changes.
        .task(id: model.range) { await model.load() }
        .alert("Couldn't Refresh", isPresented: isShowingRefreshError, presenting: model.refreshError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    private func content(_ report: InsightsReport) -> some View {
        let utcDays = report.granularity == .day
        return List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                Picker("Time range", selection: $model.range) {
                    ForEach(InsightsRange.allCases) { range in
                        Text(Self.title(range)).tag(range)
                    }
                }
            } footer: {
                Text("These numbers update every 10 minutes. Refresh Now pulls in the latest activity.")
            }

            Section("Totals") {
                TotalRow("Messages", value: DateText.count(report.totals.messages), symbol: "text.bubble")
                TotalRow("Net members", value: Self.signed(report.totals.net), symbol: "person.2")
                TotalRow("Joins", value: DateText.count(report.totals.joins), symbol: "person.badge.plus")
                TotalRow("Leaves", value: DateText.count(report.totals.leaves), symbol: "person.badge.minus")
                TotalRow("In voice", value: InsightsFormat.shortDuration(minutes: report.totals.voiceMinutes),
                         symbol: "waveform")
                TotalRow("Peak in voice", value: DateText.count(report.totals.voicePeak), symbol: "person.wave.2")
            }

            let perBucket = report.granularity == .hour ? String(localized: "per hour") : String(localized: "per day")
            ChartSection(title: "Messages \(perBucket)") {
                Chart(report.datedSeries) { point in
                    BarMark(
                        x: .value("Time", point.date ?? .distantPast, unit: report.granularity.component),
                        y: .value("Messages", point.messages))
                    .foregroundStyle(.tint)
                }
            }
            ChartSection(title: "Voice minutes \(perBucket)") {
                Chart(report.datedSeries) { point in
                    BarMark(
                        x: .value("Time", point.date ?? .distantPast, unit: report.granularity.component),
                        y: .value("Minutes", point.voiceMinutes))
                    .foregroundStyle(.purple)
                }
            }
            ChartSection(title: "Member growth", note: "\(Self.signed(report.growth.last?.total ?? 0)) over the range") {
                Chart(report.growth) { point in
                    LineMark(x: .value("Time", point.date), y: .value("Members", point.total))
                        .foregroundStyle(.green)
                    AreaMark(x: .value("Time", point.date), y: .value("Members", point.total))
                        .foregroundStyle(.green.opacity(0.15))
                }
            }
            ChartSection(title: "Joins and leaves") {
                Chart {
                    ForEach(report.datedSeries) { point in
                        LineMark(
                            x: .value("Time", point.date ?? .distantPast), y: .value("Count", point.joins),
                            series: .value("Kind", "Joins"))
                        .foregroundStyle(by: .value("Kind", "Joins"))
                        LineMark(
                            x: .value("Time", point.date ?? .distantPast), y: .value("Count", point.leaves),
                            series: .value("Kind", "Leaves"))
                        .foregroundStyle(by: .value("Kind", "Leaves"))
                    }
                }
                .chartForegroundStyleScale(["Joins": Color.green, "Leaves": Color.red])
                .chartLegend(position: .bottom)
            }

            Section {
                if report.topChannels.isEmpty {
                    Text("No message activity recorded yet.").foregroundStyle(.secondary)
                } else {
                    TopChannelsChart(channels: report.topChannels, prefix: "#", tint: .accentColor, format: {
                        DateText.count($0)
                    })
                }
            } header: {
                Text("Top channels \(windowLabel(report))")
            }
            Section {
                if report.topVoice.isEmpty {
                    Text("No voice activity recorded yet.").foregroundStyle(.secondary)
                } else {
                    TopChannelsChart(channels: report.topVoice, prefix: "", tint: .purple, format: {
                        InsightsFormat.duration(minutes: $0)
                    })
                }
            } header: {
                Text("Top voice channels \(windowLabel(report))")
            }
        }
        .environment(\.timeZone, utcDays ? .gmt : .current)
        .environment(\.calendar, utcDays ? Self.utcCalendar : .current)
        .refreshable { await model.refresh() }
    }

    private func windowLabel(_ report: InsightsReport) -> String {
        // The channel lists are kept per day, so an hourly window falls back to the last day.
        report.granularity == .hour ? String(localized: "(last day)") : String(localized: "(last \(report.range) days)")
    }

    private var isShowingRefreshError: Binding<Bool> {
        Binding(get: { model.refreshError != nil }, set: { if !$0 { model.refreshError = nil } })
    }

    private static func title(_ range: InsightsRange) -> String {
        switch range {
        case .last24Hours: String(localized: "Last 24 hours")
        case .last48Hours: String(localized: "Last 48 hours")
        case .last7Days: String(localized: "Last 7 days")
        case .last30Days: String(localized: "Last 30 days")
        case .last90Days: String(localized: "Last 90 days")
        }
    }

    private static func signed(_ value: Int) -> String {
        (value >= 0 ? "+" : "\u{2212}") + DateText.count(abs(value))
    }

    private static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()
}

private extension InsightsGranularity {
    var component: Calendar.Component { self == .hour ? .hour : .day }
}

/// One figure of the totals.
private struct TotalRow: View {
    let title: LocalizedStringKey
    let value: String
    let symbol: String

    init(_ title: LocalizedStringKey, value: String, symbol: String) {
        self.title = title
        self.value = value
        self.symbol = symbol
    }

    var body: some View {
        LabeledContent {
            Text(value).monospacedDigit()
        } label: {
            Label(title, systemImage: symbol)
        }
    }
}

/// A titled chart row. The chart is described to VoiceOver by its title; the totals above carry
/// the figures.
private struct ChartSection<Content: View>: View {
    let title: String
    var note: String?
    @ViewBuilder let content: Content

    init(title: String, note: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.note = note
        self.content = content()
    }

    var body: some View {
        Section {
            content
                .frame(height: 160)
                .padding(.vertical, 4)
                .accessibilityLabel(title)
        } header: {
            Text(title)
        } footer: {
            if let note { Text(note) }
        }
    }
}

/// The busiest channels as horizontal bars with their figure.
private struct TopChannelsChart: View {
    let channels: [InsightsChannel]
    let prefix: String
    let tint: Color
    let format: (Int) -> String

    var body: some View {
        let top = max(channels.map(\.value).max() ?? 1, 1)
        ForEach(channels) { channel in
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(verbatim: prefix + channel.name)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    Text(format(channel.value))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                GeometryReader { proxy in
                    Capsule()
                        .fill(tint)
                        .frame(width: max(6, proxy.size.width * CGFloat(channel.value) / CGFloat(top)))
                }
                .frame(height: 6)
                .accessibilityHidden(true)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.Insights else { return nil }
        let points = (0..<30).map { index in
            InsightsPoint(
                label: "2026-10-\(String(format: "%02d", index + 1))", joins: index % 4, leaves: index % 3,
                messages: 40 + (index * 37) % 90, voiceMinutes: (index * 53) % 200)
        }
        return InsightsReport(
            range: 30, granularity: .day, series: points,
            totals: InsightsTotals(messages: 2400, joins: 38, leaves: 29, net: 9, peakActive: 31, voiceMinutes: 3100, voicePeak: 6),
            topChannels: [InsightsChannel(name: "general", value: 900), InsightsChannel(name: "memes", value: 400)],
            topVoice: [InsightsChannel(name: "Lounge", value: 1200)])
    }
    NavigationStack {
        InsightsView(server: "1", session: session)
    }
    .environment(session)
}
