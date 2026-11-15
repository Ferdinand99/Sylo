import Foundation
import Testing
@testable import SyloKit

/// The server counts text limits in UTF-16 units (JavaScript's `.length`), so a flag emoji is four.
/// These pin the places that used to count `Character`s.
@MainActor
@Suite("Text limits count UTF-16 units")
struct Utf16TextLimitTests {
    private let flag = "\u{1F1F3}\u{1F1F4}"

    @Test("A reason is cut at the server's limit in UTF-16 units, between characters")
    func reasonsAreCut() {
        let cleaned = MemberForget.cleanedReason(String(repeating: flag, count: 200))
        #expect(cleaned.utf16.count <= MemberForget.reasonLength)
        #expect(cleaned.utf16.count == 500)
        #expect(cleaned.count == 125)

        let note = MemberInventoryModel.clean(String(repeating: flag, count: 100))
        #expect(note.utf16.count <= MemberInventoryModel.maxReasonLength)
    }

    @Test("A roadmap suggestion title is measured in UTF-16 units")
    func suggestionTitle() {
        // 26 flags are 26 characters but 104 units: over the server's 100.
        let title = String(repeating: flag, count: 26)
        #expect(RoadmapModel.suggestionProblem(title: title, description: "x") != nil)
        #expect(RoadmapModel.suggestionProblem(title: String(repeating: flag, count: 25), description: "x") == nil)
        // One flag is a single character but four units, so it is long enough.
        #expect(RoadmapModel.suggestionProblem(title: flag, description: "x") == nil)
    }

    @Test("A roadmap suggestion description is measured in UTF-16 units")
    func suggestionDescription() {
        let over = String(repeating: flag, count: 501)
        #expect(RoadmapModel.suggestionProblem(title: "abc", description: over) != nil)
        #expect(RoadmapModel.suggestionProblem(title: "abc", description: String(repeating: flag, count: 500)) == nil)
    }

    @Test("A roadmap post title and description are measured in UTF-16 units")
    func adminPost() {
        #expect(RoadmapAdminModel.problem(title: String(repeating: flag, count: 26), description: "x") != nil)
        #expect(RoadmapAdminModel.problem(title: String(repeating: flag, count: 25), description: "x") == nil)
        #expect(RoadmapAdminModel.problem(title: "abc", description: String(repeating: flag, count: 501)) != nil)
    }
}
