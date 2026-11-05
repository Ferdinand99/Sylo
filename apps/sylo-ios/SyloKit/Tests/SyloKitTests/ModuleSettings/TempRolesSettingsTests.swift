import Foundation
import Testing
@testable import SyloKit

@Suite("Temporary roles settings")
struct TempRolesSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/temp-roles/config`, shaped like src/web/routes/v2TempRoles.js.
    static let pageJSON = #"""
    {
      "config": {"staffRoles": ["111111111111111111"], "dmMember": true, "defaultDuration": "1d12h"},
      "roles": [{"id": "111111111111111111", "name": "Moderators"}, {"id": "444444444444444444", "name": "Trial"}],
      "list": {
        "total": 3,
        "matching": 3,
        "rows": [
          {"userId": "810000000000000001", "member": "Alex", "roleId": "444444444444444444", "role": "Trial",
           "expiresAt": 1794000000000, "createdAt": 1793000000000, "addedBy": "820000000000000001",
           "addedByName": "Sam", "reason": "Trial period"},
          {"userId": "810000000000000002", "member": "810000000000000002", "roleId": "444444444444444444",
           "role": "Trial", "expiresAt": 1794100000000, "createdAt": 1793000000000, "addedBy": null,
           "addedByName": null, "reason": ""}
        ]
      }
    }
    """#

    @Test("the page decodes settings, roles and the active list")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(TempRolesPage.self, from: Data(Self.pageJSON.utf8))
        #expect(TempRolesPage.moduleID == "temp-roles")
        #expect(page.settings == TempRolesSettings(staffRoles: ["111111111111111111"], dmMember: true,
                                                   defaultDuration: "1d12h"))
        #expect(page.roles.map(\.name) == ["Moderators", "Trial"])
        #expect(page.list.total == 3)
        #expect(page.list.rows.count == 2)
        let row = try #require(page.list.rows.first)
        #expect(row.member == "Alex")
        #expect(row.role == "Trial")
        #expect(row.addedByName == "Sam")
        #expect(row.reason == "Trial period")
        #expect(row.expiresDate == Date(timeIntervalSince1970: 1_794_000_000))
        #expect(page.list.rows.last?.addedByName == nil)
        #expect(row.id == "810000000000000001:444444444444444444")
    }

    @Test("missing fields fall back to the server's defaults: 7d, no DMs, empty list")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(TempRolesPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings == TempRolesSettings())
        #expect(page.settings.defaultDuration == "7d")
        #expect(page.list == TempRoleList())
    }

    @Test("saving sends exactly the fields the web form sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(TempRolesPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["staffRoles", "dmMember", "defaultDuration"])
        #expect(body["defaultDuration"] as? String == "1d12h")
        #expect(try JSONDecoder().decode(TempRolesSettings.self, from: data) == page.settings)
    }

    @Test("durations the server accepts have no problem", arguments: [
        "30m", "12h", "7d", "2w", "1d12h", "1D", " 2 w ", "1w2d3h4m", "365d", "1m", "8760h",
    ])
    func validDurations(text: String) {
        #expect(TempRolesSettings.durationProblem(text) == nil)
    }

    @Test("durations the server refuses are explained", arguments: [
        "", "   ", "7", "d", "soon", "1d1d", "0m", "0d", "366d", "9000h", "1.5h", "1d 2x", "1234567m",
    ])
    func invalidDurations(text: String) {
        #expect(TempRolesSettings.durationProblem(text) != nil)
    }

    @Test("the messages match the server's wording")
    func messages() {
        #expect(TempRolesSettings.durationProblem("0m")?.contains("shortest time is 1 minute") == true)
        #expect(TempRolesSettings.durationProblem("366d")?.contains("longest time is 365 days") == true)
        #expect(TempRolesSettings.durationProblem("1d1d")?.contains("each unit once") == true)
        #expect(TempRolesSettings(defaultDuration: "7d").durationProblem == nil)
        #expect(TempRolesSettings(defaultDuration: "nope").durationProblem != nil)
    }
}
