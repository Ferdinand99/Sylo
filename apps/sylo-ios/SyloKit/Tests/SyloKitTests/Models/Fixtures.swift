import Foundation

/// JSON as the Sylo server sends it, built from the route code (src/web/routes/mobile.js,
/// v2Api.js, lib/overviewSummary.js, lib/accountView.js), plus extra fields and enum values a
/// newer server might add.
enum Fixtures {
    static let info = """
    {
      "name": "Sylo",
      "version": "4.0.0",
      "apiVersion": 1,
      "login": true,
      "loginProviders": ["discord", "fluxer"],
      "platforms": ["discord", "matrix"],
      "features": ["app-login", "live-access", "time-travel"],
      "motd": { "text": "ignored" }
    }
    """

    static let infoOpenMode = """
    {"name":"Sylo","version":"4.0.0","apiVersion":1,"login":false,"loginProviders":[],"platforms":["discord"],"features":["app-login","live-access"]}
    """

    static let token = """
    {
      "token": "sylo_dGhpcyBpcyBub3QgYSByZWFsIHRva2VuIGF0IGFsbA",
      "expiresAt": 1799999999999,
      "account": {
        "name": "ferdi",
        "avatar": "https://cdn.discordapp.com/avatars/123/abc.png?size=128",
        "platforms": ["discord", "fluxer", "matrix"],
        "owner": false,
        "locale": "nb"
      },
      "scope": "all"
    }
    """

    static let tokenNoAvatar = """
    {"token":"sylo_x","expiresAt":1760000000000,"account":{"name":"ferdi","avatar":null,"platforms":["fluxer"],"owner":true}}
    """

    static let servers = """
    {
      "guilds": [
        { "id": "123456789012345678", "name": "Alpha", "icon": "https://cdn.discordapp.com/icons/123/a.png?size=32", "platform": "discord", "openTickets": 2, "unreadTickets": 1 },
        { "id": "fluxer:223456789012345678", "name": "Beta", "icon": null, "platform": "fluxer", "unread": 3 },
        { "id": "9", "name": "Gamma", "platform": "matrix" },
        { "id": "10", "platform": "discord" }
      ],
      "total": 4
    }
    """

    static let overview = """
    {
      "guild": { "id": "fluxer:223456789012345678", "name": "Beta", "icon": null, "memberCount": 42 },
      "openTickets": 2,
      "openAppeals": 1,
      "groups": [
        {
          "title": "Core",
          "cards": [
            {
              "kind": "link", "id": "general", "name": "Settings", "icon": "settings",
              "description": "Bot masters, mod-log channel, embed colour, backup.",
              "hasToggle": false, "enabled": null, "missingIntents": [], "status": "link",
              "href": "/guilds/fluxer:223456789012345678/settings",
              "lines": [ { "label": "Mod-log channel", "value": "not set", "state": "off" } ]
            },
            {
              "kind": "link", "id": "commands", "name": "Commands", "icon": "terminal",
              "description": "Enable, disable or restrict slash commands per server.",
              "hasToggle": false, "enabled": null, "missingIntents": [], "status": "link",
              "href": "/guilds/fluxer:223456789012345678/commands",
              "lines": [
                { "label": "Available", "value": "54", "state": "on" },
                { "label": "Disabled here", "value": "0", "state": "neutral" }
              ]
            },
            {
              "kind": "module", "id": "moderation", "name": "Moderation", "icon": "shield",
              "description": "Warn, timeout, kick and ban.",
              "hasToggle": true, "enabled": true, "beta": false, "missingIntents": [], "status": "on",
              "href": "/guilds/fluxer:223456789012345678/m/moderation",
              "lines": [
                { "label": "Warning thresholds", "value": "2 rules", "state": "on" },
                { "label": "DM on punishment", "value": "off", "state": "off" }
              ]
            }
          ]
        },
        {
          "title": "Engagement",
          "cards": [
            {
              "kind": "module", "id": "welcome", "name": "Welcome", "icon": "hand",
              "description": "Greets new members.",
              "hasToggle": true, "enabled": false, "beta": true, "missingIntents": ["GuildMembers"],
              "status": "blocked", "href": "/guilds/fluxer:223456789012345678/m/welcome",
              "lines": [ { "label": "Welcome message", "value": "#welcome", "state": "on" } ]
            },
            {
              "kind": "module", "id": "auto-react", "name": "Auto-react", "icon": "smile",
              "hasToggle": true, "enabled": true, "status": "paused",
              "lines": [ { "label": "Rules", "value": "3", "state": "warning" } ],
              "color": "#5865F2"
            },
            {
              "kind": "widget", "id": "chart", "name": "Activity", "icon": "activity",
              "hasToggle": false, "enabled": null, "status": "link", "lines": []
            },
            { "kind": "module", "id": "broken" }
          ]
        },
        { "title": "Social alerts", "cards": [] }
      ],
      "health": { "ignored": true }
    }
    """

    static let toggle = #"{"enabled":true}"#

    static let account = """
    {
      "open": false,
      "platforms": [
        {
          "platform": "discord", "label": "Discord", "connected": true, "username": "ferdi",
          "guildCount": 12, "connectHref": null, "canDisconnect": true
        },
        {
          "platform": "fluxer", "label": "Fluxer", "connected": false, "username": null,
          "guildCount": 0, "connectHref": "/auth/connect/fluxer", "canDisconnect": false,
          "beta": true
        }
      ],
      "devices": [
        {
          "id": "6f1c2a8e-0b7d-4a51-9a63-2d4e5f6a7b8c", "deviceName": "iPhone — Sylo app",
          "createdAt": 1760000000000, "lastUsedAt": 1760600000500, "current": true
        },
        {
          "id": "0a1b2c3d-0000-4000-8000-000000000000", "deviceName": "Sylo app",
          "createdAt": 1750000000000, "lastUsedAt": 1750000000000, "current": false, "os": "iOS"
        }
      ]
    }
    """

    static let accountOpenMode = #"{"open":true,"platforms":[],"devices":[]}"#

    static let ok = #"{"ok":true}"#

    static func data(_ json: String) -> Data { Data(json.utf8) }
}
