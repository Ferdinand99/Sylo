import XCTest

// Capture-only: this file lives on a branch that is never merged. Each test is one scene of the
// Sylo 5.2 sneak peek. It drives the app (started with the canned-server launch argument) at a calm
// pace while the workflow records the simulator; the markers it writes tell the workflow where the
// scene starts and ends in the recording.
final class SneakScenes: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // MARK: Scenes
    //
    // The simulator is slow: every lookup and tap costs a second or two on its own, and the screen
    // stays as it is meanwhile. The pauses below are therefore short.

    /// 1. The server list, then the overview with its module cards and Needs attention.
    @MainActor func testScene01Overview() throws {
        let app = launch()
        let harbor = find(app, "Pixel Harbor")
        XCTAssertTrue(harbor.waitForExistence(timeout: 30), "server list did not load")
        mark("01", "start")
        pause(0.8)
        harbor.tap()
        XCTAssertTrue(find(app, "open suggestions").waitForExistence(timeout: 20), "overview did not load")
        pause(1.0)
        scroll(app)
        pause(0.8)
        scroll(app)
        pause(1.4)
        mark("01", "end")
        pause(0.8)
    }

    /// 2. A health problem opened: the fix text, then the role picker's note.
    @MainActor func testScene02Health() throws {
        let app = launch()
        openPixelHarbor(app)
        let row = find(app, "do everything it needs")
        scrollTo(app, row)
        mark("02", "start")
        pause(0.6)
        row.tap()
        let banner = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "do everything this module needs")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 20), "module screen did not open")
        pause(0.4)
        banner.tap()
        pause(1.8)
        banner.tap()
        pause(2.2)
        mark("02", "end")
        pause(0.8)
        XCTAssertTrue(find(app, "give this role").exists, "the role note is missing")
    }

    /// 3. Change history: a diff and the Undo button.
    @MainActor func testScene03History() throws {
        let app = launch()
        openPixelHarbor(app)
        app.tabBars.buttons["Settings"].tap()
        let auditRow = find(app, "Audit Log")
        scrollTo(app, auditRow)
        mark("03", "start")
        pause(0.6)
        auditRow.tap()
        let show = app.buttons["Show Changes"].firstMatch
        XCTAssertTrue(show.waitForExistence(timeout: 20), "audit log did not load")
        pause(0.6)
        show.tap()
        let undo = app.buttons["Undo This Change"].firstMatch
        XCTAssertTrue(undo.waitForExistence(timeout: 20), "change did not load")
        pause(2.4)
        mark("03", "end")
        pause(0.8)
    }

    /// 4. Suggestions: quick Approve with the reason sheet.
    @MainActor func testScene04Suggestions() throws {
        let app = launch()
        openPixelHarbor(app)
        let module = app.staticTexts["Suggestions"].firstMatch
        scrollTo(app, module)
        module.tap()
        let approve = app.buttons["Approve"].firstMatch
        scrollTo(app, approve, swipes: 14)
        // One more drag when the suggestion sits at the bottom edge, so the whole card is in view.
        if approve.frame.midY > app.frame.height * 0.6 { scroll(app) }
        mark("04", "start")
        pause(0.6)
        approve.tap()
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10), "reason alert did not show")
        let field = alert.textFields.firstMatch
        // Typed a key at a time (typeText on a whole string shows it at once); the workflow thins this
        // stretch out, so it reads at about eleven characters a second. The tap that opens the keyboard
        // is part of it.
        let reason = "Great idea, let's start this Saturday."
        mark("04", "typestart")
        field.tap()
        for character in reason {
            field.typeText(String(character))
        }
        mark("04", "typeend", extra: String(reason.count))
        pause(0.8)
        alert.buttons["Approved"].tap()
        XCTAssertTrue(find(app, "Great idea").waitForExistence(timeout: 15), "decision did not show")
        pause(1.6)
        mark("04", "end")
        pause(0.8)
    }

    /// 5. The setup wizard's goals screen.
    @MainActor func testScene05Wizard() throws {
        let app = launch()
        openPixelHarbor(app)
        app.tabBars.buttons["Settings"].tap()
        let row = find(app, "Setup Wizard")
        scrollTo(app, row)
        mark("05", "start")
        pause(0.6)
        row.tap()
        let choose = app.buttons["Choose What to Set Up"]
        XCTAssertTrue(choose.waitForExistence(timeout: 20), "wizard did not load")
        pause(0.8)
        choose.tap()
        XCTAssertTrue(find(app, "Welcome new members").waitForExistence(timeout: 10), "goals did not show")
        pause(0.6)
        // The switch itself sits at the right edge of its row.
        let toggles = app.switches
        toggles.element(boundBy: 0).coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        pause(0.4)
        toggles.element(boundBy: 2).coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        pause(1.6)
        mark("05", "end")
        pause(0.8)
    }

    // MARK: Helpers

    @MainActor private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-SyloSneakDemo", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        return app
    }

    @MainActor private func openPixelHarbor(_ app: XCUIApplication) {
        let harbor = find(app, "Pixel Harbor")
        XCTAssertTrue(harbor.waitForExistence(timeout: 30), "server list did not load")
        harbor.tap()
        XCTAssertTrue(find(app, "open suggestions").waitForExistence(timeout: 20), "overview did not load")
        pause(0.8)
    }

    /// The first element whose label contains `text`.
    @MainActor private func find(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func pause(_ seconds: Double) {
        Thread.sleep(forTimeInterval: seconds)
    }

    /// One slow upward drag, like a thumb scrolling a list.
    @MainActor private func scroll(_ app: XCUIApplication) {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.38))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.15)
    }

    /// Scrolls until the element can be tapped, at most `swipes` times.
    @MainActor private func scrollTo(_ app: XCUIApplication, _ element: XCUIElement, swipes: Int = 10) {
        _ = element.waitForExistence(timeout: 20)
        var count = 0
        while !(element.exists && element.isHittable), count < swipes {
            scroll(app)
            count += 1
        }
        XCTAssertTrue(element.exists, "element not found after scrolling")
    }

    /// Tells the workflow when a scene starts and ends, as seconds since 1970.
    private func mark(_ scene: String, _ name: String, extra: String = "") {
        guard let folder = ProcessInfo.processInfo.environment["SNEAK_MARKER_DIR"] else { return }
        let line = "\(name) \(Date().timeIntervalSince1970) \(extra)\n"
        let url = URL(fileURLWithPath: folder).appendingPathComponent("\(scene).txt")
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: url)
        }
    }
}
