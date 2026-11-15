import Foundation
import Testing
@testable import SyloKit

@Suite("Unsaved edits")
struct UnsavedEditsTests {
    @Test("Nothing is lost when no screen has edits")
    func empty() {
        let edits = UnsavedEdits()
        #expect(!edits.wouldLoseEdits(changingServer: false))
        #expect(!edits.wouldLoseEdits(changingServer: true))
    }

    @Test("A dirty pushed screen is lost on any path replacement")
    func screenScope() {
        let edits = UnsavedEdits()
        let editor = UUID()
        edits.set(editor, dirty: true)
        #expect(edits.wouldLoseEdits(changingServer: false))
        #expect(edits.wouldLoseEdits(changingServer: true))
    }

    @Test("A server draft is lost only when another server is shown")
    func serverScope() {
        let edits = UnsavedEdits()
        edits.set(UUID(), dirty: true, scope: .server)
        #expect(!edits.wouldLoseEdits(changingServer: false))
        #expect(edits.wouldLoseEdits(changingServer: true))
    }

    @Test("Saving or discarding clears the screen, and so does closing it")
    func cleared() {
        let edits = UnsavedEdits()
        let saved = UUID()
        let closed = UUID()
        edits.set(saved, dirty: true)
        edits.set(closed, dirty: true)
        edits.set(saved, dirty: false)
        #expect(edits.wouldLoseEdits(changingServer: false))
        edits.remove(closed)
        #expect(!edits.wouldLoseEdits(changingServer: false))
    }

    @Test("Two dirty screens need both to be clean")
    func twoScreens() {
        let edits = UnsavedEdits()
        let first = UUID()
        let second = UUID()
        edits.set(first, dirty: true)
        edits.set(second, dirty: true)
        edits.set(first, dirty: false)
        #expect(edits.wouldLoseEdits(changingServer: false))
        edits.set(second, dirty: false)
        #expect(!edits.wouldLoseEdits(changingServer: false))
    }
}
