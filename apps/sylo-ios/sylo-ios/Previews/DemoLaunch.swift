#if DEBUG
import SwiftUI
import SyloKit

/// Screenshot builds only (Debug): `-SyloDemo YES` starts the app signed in to a made-up Sylo that
/// answers from ``PreviewData``, and `-SyloDemoScreen <name>` opens one screen. The CI workflow
/// uses it to take screenshots in the simulator without a server or a sign-in.
///
///     xcrun simctl launch booted net.opland.sylo -SyloDemo YES -SyloDemoScreen overview
///
/// Screens: `servers`, `overview`, `modules`, `module` (a module's settings), `tickets`, `thread`,
/// `custom-commands`, `insights`, `embeds` (the embed message list) and `embed-editor`.
enum DemoLaunch {
    /// Where the app starts.
    struct Start {
        let server: ServerID?
        let tab: ServerView.ServerTab
        let path: NavigationPath
    }

    static var isActive: Bool { UserDefaults.standard.bool(forKey: "SyloDemo") }

    /// The screen to open; nil when this is not a demo launch.
    static var start: Start? {
        guard isActive else { return nil }
        let name = UserDefaults.standard.string(forKey: "SyloDemoScreen") ?? "servers"
        let demoServer: ServerID = "1"
        switch name {
        case "overview":
            return Start(server: demoServer, tab: .overview, path: NavigationPath())
        case "modules":
            return Start(server: demoServer, tab: .modules, path: NavigationPath())
        case "module":
            var path = NavigationPath()
            path.append(ModuleRoute(moduleID: "honeypot"))
            return Start(server: demoServer, tab: .modules, path: path)
        case "custom-commands", "insights":
            var path = NavigationPath()
            path.append(ModuleRoute(moduleID: name))
            return Start(server: demoServer, tab: .modules, path: path)
        case "embeds":
            var path = NavigationPath()
            path.append(ModuleRoute(moduleID: "messages"))
            return Start(server: demoServer, tab: .modules, path: path)
        case "embed-editor":
            var path = NavigationPath()
            path.append(ModuleRoute(moduleID: "messages"))
            path.append(EmbedMessageRoute(id: 7))
            return Start(server: demoServer, tab: .modules, path: path)
        case "tickets":
            return Start(server: demoServer, tab: .tickets, path: NavigationPath())
        case "thread":
            var path = NavigationPath()
            path.append(TicketRoute(id: 1, user: "member#0001"))
            return Start(server: demoServer, tab: .tickets, path: path)
        default:
            return Start(server: nil, tab: .overview, path: NavigationPath())
        }
    }

    /// A session that answers the demo screens' calls.
    static func session() -> AppSession {
        AppSession.preview(.signedIn, answer: PreviewData.demoAnswer)
    }
}
#endif
