import Foundation
import Observation

// The setup wizard of Sylo 5.2 (src/web/routes/v2Setup.js, src/web/lib/setupWizard.js; web page
// web-v2/src/pages/SetupWizard.jsx, rules web-v2/src/setupModel.js). `GET .../setup/suggest` proposes what
// to set up from the server's channels and roles, `POST .../setup/apply` does the ticked items, one at a
// time, and answers a result per item. The server announces `setup-wizard`; a Sylo without it has no wizard,
// and the app asks for nothing then.
//
// Safety, the same as the dashboard's: nothing is created or changed unless the person ticked it. A
// channel or role is created only for an explicit `create: true`; a channel's permissions are changed
// only for an explicit `fix: true`; a module that is already set up is replaced only when ticked on.

extension ServerFeature {
    /// `GET .../setup/suggest` and `POST .../setup/apply`.
    public static let setupWizard = ServerFeature(rawValue: "setup-wizard")
}

/// A goal the person picks ("Welcome new members").
public struct SetupGoal: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    public let description: String

    public init(id: String, label: String, description: String = "") {
        self.id = id
        self.label = label
        self.description = description
    }

    private enum CodingKeys: String, CodingKey { case id, label, description }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? id
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
    }
}

/// Who can see a channel besides the admins and Sylo.
public struct SetupExposure: Decodable, Sendable, Hashable {
    public struct RoleRef: Decodable, Sendable, Hashable {
        public let id: String
        public let name: String
        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }
    }

    public let everyone: Bool
    public let roles: [RoleRef]

    public init(everyone: Bool = false, roles: [RoleRef] = []) {
        self.everyone = everyone
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey { case everyone, roles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        everyone = try c.decodeIfPresent(Bool.self, forKey: .everyone) ?? false
        roles = try c.decodeLossyArray(of: RoleRef.self, forKey: .roles)
    }
}

/// A text channel Sylo found. `problem` is why Sylo cannot post in it (shown where Sylo posts).
public struct SetupChannel: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let problem: String?
    /// Who can see it; nil when the proposal left it out (a very large server).
    public let exposure: SetupExposure?

    public init(id: String, name: String, problem: String? = nil, exposure: SetupExposure? = nil) {
        self.id = id
        self.name = name
        self.problem = problem
        self.exposure = exposure
    }

    private enum CodingKeys: String, CodingKey { case id, name, problem, exposure }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        problem = try c.decodeIfPresent(String.self, forKey: .problem)
        exposure = try? c.decodeIfPresent(SetupExposure.self, forKey: .exposure)
    }
}

/// A role Sylo found. `problem` is why Sylo cannot give it.
public struct SetupRole: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let problem: String?

    public init(id: String, name: String, problem: String? = nil) {
        self.id = id
        self.name = name
        self.problem = problem
    }

    private enum CodingKeys: String, CodingKey { case id, name, problem }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        problem = try c.decodeIfPresent(String.self, forKey: .problem)
    }
}

/// A channel or role found by name for a field, or one that exists but is not what the wizard promises
/// (`gap` says how it differs).
public struct SetupFound: Decodable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let gap: String?

    public init(id: String, name: String, gap: String? = nil) {
        self.id = id
        self.name = name
        self.gap = (gap?.isEmpty ?? true) ? nil : gap
    }

    private enum CodingKeys: String, CodingKey { case id, name, gap }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id),
                  name: try c.decodeIfPresent(String.self, forKey: .name) ?? "",
                  gap: try c.decodeIfPresent(String.self, forKey: .gap))
    }
}

/// What "Create" would make for a field.
public struct SetupCreate: Decodable, Sendable, Hashable {
    public let name: String
    public let isPrivate: Bool
    public let readOnly: Bool
    public let everyoneCanView: Bool
    /// A channel or role of that name is already there: "Create" would use it.
    public let existing: SetupFound?

    public init(name: String, isPrivate: Bool = false, readOnly: Bool = false, everyoneCanView: Bool = false,
                existing: SetupFound? = nil) {
        self.name = name
        self.isPrivate = isPrivate
        self.readOnly = readOnly
        self.everyoneCanView = everyoneCanView
        self.existing = existing
    }

    private enum CodingKeys: String, CodingKey {
        case name, isPrivate = "private", readOnly, everyoneCanView, existing
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(String.self, forKey: .name),
            isPrivate: try c.decodeIfPresent(Bool.self, forKey: .isPrivate) ?? false,
            readOnly: try c.decodeIfPresent(Bool.self, forKey: .readOnly) ?? false,
            everyoneCanView: try c.decodeIfPresent(Bool.self, forKey: .everyoneCanView) ?? false,
            existing: try? c.decodeIfPresent(SetupFound.self, forKey: .existing))
    }
}

/// One channel or role an item needs.
public struct SetupField: Decodable, Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable { case channel, role }

    public let key: String
    public let kind: Kind
    public let label: String
    public let isOptional: Bool
    /// Sylo posts in this channel, so a problem flagged on it matters.
    public let post: Bool
    /// Sylo gives this role, so a problem flagged on it matters.
    public let give: Bool
    public let match: SetupFound?
    /// A channel found by name that others can see although the field is for staff only.
    public let unsafeMatch: SetupFound?
    public let problem: String?
    /// The role that may see the channel the item makes.
    public let viewer: Bool
    public let viewerOnly: Bool
    public let staffOnly: Bool
    public let create: SetupCreate?

    public var id: String { key }

    public init(key: String, kind: Kind, label: String, isOptional: Bool = false, post: Bool = false,
                give: Bool = false, match: SetupFound? = nil, unsafeMatch: SetupFound? = nil,
                problem: String? = nil, viewer: Bool = false, viewerOnly: Bool = false, staffOnly: Bool = false,
                create: SetupCreate? = nil) {
        self.key = key
        self.kind = kind
        self.label = label
        self.isOptional = isOptional
        self.post = post
        self.give = give
        self.match = match
        self.unsafeMatch = unsafeMatch
        self.problem = problem
        self.viewer = viewer
        self.viewerOnly = viewerOnly
        self.staffOnly = staffOnly
        self.create = create
    }

    private enum CodingKeys: String, CodingKey {
        case key, kind, label, optional, post, give, match, unsafeMatch, problem, viewer, viewerOnly, staffOnly, create
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "channel"
        self.init(
            key: try c.decode(String.self, forKey: .key),
            kind: kind == "role" ? .role : .channel,
            label: try c.decodeIfPresent(String.self, forKey: .label) ?? "",
            isOptional: try c.decodeIfPresent(Bool.self, forKey: .optional) ?? false,
            post: try c.decodeIfPresent(Bool.self, forKey: .post) ?? false,
            give: try c.decodeIfPresent(Bool.self, forKey: .give) ?? false,
            match: try? c.decodeIfPresent(SetupFound.self, forKey: .match),
            unsafeMatch: try? c.decodeIfPresent(SetupFound.self, forKey: .unsafeMatch),
            problem: try c.decodeIfPresent(String.self, forKey: .problem),
            viewer: try c.decodeIfPresent(Bool.self, forKey: .viewer) ?? false,
            viewerOnly: try c.decodeIfPresent(Bool.self, forKey: .viewerOnly) ?? false,
            staffOnly: try c.decodeIfPresent(Bool.self, forKey: .staffOnly) ?? false,
            create: try? c.decodeIfPresent(SetupCreate.self, forKey: .create))
    }
}

/// One thing the wizard can set up (Welcome, Verification, Mod-log channel, ...).
public struct SetupItem: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let goal: String
    public let name: String
    /// What the item does, in a sentence.
    public let does: String
    /// Already set up: only replaced when the person ticks it.
    public let configured: Bool
    /// Why the module cannot run (a privileged permission only the bot owner can allow); empty when it can.
    public let blocked: [String]
    public let warnings: [String]
    public let fields: [SetupField]

    /// Can be switched on: nothing blocks the module.
    public var isUsable: Bool { blocked.isEmpty }

    public init(id: String, goal: String, name: String, does: String = "", configured: Bool = false,
                blocked: [String] = [], warnings: [String] = [], fields: [SetupField] = []) {
        self.id = id
        self.goal = goal
        self.name = name
        self.does = does
        self.configured = configured
        self.blocked = blocked
        self.warnings = warnings
        self.fields = fields
    }

    private enum CodingKeys: String, CodingKey { case id, goal, name, does, configured, blocked, warnings, fields }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            goal: try c.decodeIfPresent(String.self, forKey: .goal) ?? "",
            name: try c.decodeIfPresent(String.self, forKey: .name) ?? "",
            does: try c.decodeIfPresent(String.self, forKey: .does) ?? "",
            configured: try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false,
            blocked: (try? c.decodeIfPresent([String].self, forKey: .blocked)) ?? [],
            warnings: (try? c.decodeIfPresent([String].self, forKey: .warnings)) ?? [],
            fields: try c.decodeLossyArray(of: SetupField.self, forKey: .fields))
    }
}

/// The proposal: `GET /api/v2/guilds/:id/setup/suggest`.
public struct SetupProposal: Decodable, Sendable, Equatable {
    public let platform: Platform?
    public let channelCount: Int
    public let roleCount: Int
    public let memberCount: Int
    /// Whether Sylo can create channels and roles; nil when the platform cannot say (Fluxer): Sylo tries
    /// and reports what the platform answers.
    public let canCreateChannels: Bool?
    public let canCreateRoles: Bool?
    public let goals: [SetupGoal]
    public let channels: [SetupChannel]
    public let roles: [SetupRole]
    public let items: [SetupItem]

    public init(platform: Platform? = nil, channelCount: Int = 0, roleCount: Int = 0, memberCount: Int = 0,
                canCreateChannels: Bool? = nil, canCreateRoles: Bool? = nil, goals: [SetupGoal] = [],
                channels: [SetupChannel] = [], roles: [SetupRole] = [], items: [SetupItem] = []) {
        self.platform = platform
        self.channelCount = channelCount
        self.roleCount = roleCount
        self.memberCount = memberCount
        self.canCreateChannels = canCreateChannels
        self.canCreateRoles = canCreateRoles
        self.goals = goals
        self.channels = channels
        self.roles = roles
        self.items = items
    }

    private enum CodingKeys: String, CodingKey {
        case platform, inspected, botCan, goals, channels, roles, items
    }
    private enum InspectedKeys: String, CodingKey { case channels, roles, members }
    private enum BotCanKeys: String, CodingKey { case createChannels, createRoles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var channelCount = 0, roleCount = 0, memberCount = 0
        if let i = try? c.nestedContainer(keyedBy: InspectedKeys.self, forKey: .inspected) {
            channelCount = i.lenientCount(.channels)
            roleCount = i.lenientCount(.roles)
            memberCount = i.lenientCount(.members)
        }
        var createChannels: Bool?
        var createRoles: Bool?
        if let b = try? c.nestedContainer(keyedBy: BotCanKeys.self, forKey: .botCan) {
            createChannels = (try? b.decodeIfPresent(Bool.self, forKey: .createChannels)) ?? nil
            createRoles = (try? b.decodeIfPresent(Bool.self, forKey: .createRoles)) ?? nil
        }
        self.init(
            platform: try? c.decodeIfPresent(Platform.self, forKey: .platform),
            channelCount: channelCount, roleCount: roleCount, memberCount: memberCount,
            canCreateChannels: createChannels, canCreateRoles: createRoles,
            goals: try c.decodeLossyArray(of: SetupGoal.self, forKey: .goals),
            channels: try c.decodeLossyArray(of: SetupChannel.self, forKey: .channels),
            roles: try c.decodeLossyArray(of: SetupRole.self, forKey: .roles),
            items: try c.decodeLossyArray(of: SetupItem.self, forKey: .items))
    }
}

// MARK: - What the person chose

/// How one field is filled: the channel or role picked from the server, or created by Sylo.
public struct SetupFieldChoice: Sendable, Equatable {
    public enum Mode: Sendable, Equatable { case pick, create }
    public var mode: Mode
    public var id: String
    /// "Change its permissions" on the picked channel: Sylo changes who can see it, so it is what the
    /// wizard promises. Only offered where the wizard knows how.
    public var fix: Bool

    public init(mode: Mode = .pick, id: String = "", fix: Bool = false) {
        self.mode = mode
        self.id = id
        self.fix = fix
    }
}

public struct SetupItemChoice: Sendable, Equatable {
    public var isOn: Bool
    public var fields: [String: SetupFieldChoice]

    public init(isOn: Bool = false, fields: [String: SetupFieldChoice] = [:]) {
        self.isOn = isOn
        self.fields = fields
    }
}

/// What applying would do, for the review screen and its confirmation.
public struct SetupReview: Sendable, Equatable {
    public var itemCount = 0
    /// Items that are already set up and would be replaced.
    public var replacedCount = 0
    public var channelsToCreate: [String] = []
    public var rolesToCreate: [String] = []
    /// Channels whose permissions would change.
    public var channelsToChange: [String] = []
    /// Fields still empty or refused (Apply stays off while there are any).
    public var problemCount = 0
}

/// The wizard's rules, ported from the dashboard's setupModel.js: what is chosen first, what stops an item,
/// what applying creates, and the request body. The server has the last word.
public struct SetupDraft: Sendable, Equatable {
    public let proposal: SetupProposal
    public var goals: Set<String> = []
    public var choices: [String: SetupItemChoice]

    public init(proposal: SetupProposal) {
        self.proposal = proposal
        self.choices = Self.initialChoices(proposal)
    }

    /// A server with fewer modules set up than this is offered the wizard on its overview.
    public static let offerBelow = 3

    /// Whether the overview offers "Set up Sylo": fewer than three modules are on and without a problem.
    public static func shouldOffer(overview: ServerOverview) -> Bool {
        let problems = Set(overview.attention?.problems.map(\.id) ?? [])
        let healthy = overview.groups.flatMap(\.cards).filter { card in
            card.hasToggle && card.isEnabled == true && card.status == .on && !problems.contains(card.id)
        }
        return healthy.count < offerBelow
    }

    // MARK: Choices

    /// What was found by name, nothing created, no permission changed. An item is on unless it is already
    /// set up or cannot run; the person ticks a set-up item on to replace it. Only a channel that is what the
    /// wizard promises is picked for the person.
    public static func initialChoices(_ proposal: SetupProposal) -> [String: SetupItemChoice] {
        var out: [String: SetupItemChoice] = [:]
        for item in proposal.items {
            var fields: [String: SetupFieldChoice] = [:]
            for field in item.fields {
                let found = field.match?.id ?? field.create?.existing.flatMap { $0.gap == nil ? $0.id : nil } ?? ""
                fields[field.key] = SetupFieldChoice(mode: .pick, id: found, fix: false)
            }
            out[item.id] = SetupItemChoice(isOn: !item.configured && item.isUsable, fields: fields)
        }
        return out
    }

    public func items(ofGoal goal: String) -> [SetupItem] { proposal.items.filter { $0.goal == goal } }

    /// A goal is done when every usable item of it is already set up.
    public func isDone(goal: String) -> Bool {
        let usable = items(ofGoal: goal).filter(\.isUsable)
        return !usable.isEmpty && usable.allSatisfy(\.configured)
    }

    /// The items of the ticked goals that are switched on.
    public var activeItems: [SetupItem] {
        proposal.items.filter { goals.contains($0.goal) && choices[$0.id]?.isOn == true }
    }

    private struct PoolEntry {
        let id: String
        let problem: String?
    }

    private func pool(_ field: SetupField) -> [PoolEntry] {
        if field.kind == .channel {
            return proposal.channels.map { PoolEntry(id: $0.id, problem: $0.problem) }
        }
        return proposal.roles.map { PoolEntry(id: $0.id, problem: $0.problem) }
    }

    /// Why a channel picked for a staff-only field is not private, from who can see it: the staff role picked
    /// in the same item does not count. Nil when it is private, or when the proposal did not say.
    public func exposureGap(item: SetupItem, field: SetupField, channelID: String) -> String? {
        guard field.staffOnly, !channelID.isEmpty,
              let seen = proposal.channels.first(where: { $0.id == channelID })?.exposure else { return nil }
        if seen.everyone { return "Everyone can see it." }
        let viewerField = item.fields.first { $0.viewer }
        let viewer = viewerField.flatMap { choices[item.id]?.fields[$0.key]?.id } ?? ""
        let others = seen.roles.filter { $0.id != viewer }
        if others.isEmpty { return nil }
        let names = others.map(\.name).joined(separator: ", ")
        return "Members with the \(names) role\(others.count > 1 ? "s" : "") can see it."
    }

    /// The channel a field's "Change its permissions" tick is about, when it is picked: the one with the
    /// wanted name, or the one found by name that others can see, and only when it differs from what the wizard
    /// promises. Nil when there is nothing to change.
    public func fixableChannel(item: SetupItem, field: SetupField, channelID: String) -> SetupFound? {
        let known = [field.create?.existing, field.unsafeMatch].compactMap { $0 }.first { $0.gap != nil && $0.id == channelID }
        if let known { return known }
        guard field.create != nil, let gap = exposureGap(item: item, field: field, channelID: channelID) else { return nil }
        let name = proposal.channels.first { $0.id == channelID }?.name ?? channelID
        return SetupFound(id: channelID, name: name, gap: gap)
    }

    /// Whether a role that is only for who may see a channel does anything now: Sylo sets who sees a channel when
    /// it creates it, or when the person ticks the change of its permissions. With neither, the field is not used.
    public func viewerActive(_ item: SetupItem) -> Bool {
        item.fields.contains { field in
            guard field.kind == .channel, field.create != nil, let pick = choices[item.id]?.fields[field.key] else { return false }
            if pick.mode == .create, field.create?.existing == nil { return true }
            return pick.fix && fixableChannel(item: item, field: field, channelID: pick.id) != nil
        }
    }

    // MARK: Checks

    /// What stops one switched-on item from being applied, as sentences. Empty when it is ready.
    public func problems(for item: SetupItem) -> [String] {
        guard let choice = choices[item.id], choice.isOn else { return [] }
        var out: [String] = []
        for field in item.fields {
            let pick = choice.fields[field.key] ?? SetupFieldChoice()
            if pick.mode == .create, let create = field.create, create.existing == nil { continue }
            if pick.id.isEmpty {
                if !field.isOptional { out.append("\(field.label): pick one, or tick Create.") }
                continue
            }
            guard let found = pool(field).first(where: { $0.id == pick.id }) else {
                out.append("\(field.label): that \(field.kind == .channel ? "channel" : "role") is not on this server any more.")
                continue
            }
            // A problem flagged on a channel or role only matters where Sylo posts or gives.
            let matters = field.kind == .channel ? field.post : field.give
            if matters, let problem = found.problem {
                out.append("\(field.label): \(problem)")
            }
        }
        return out
    }

    /// Everything that stops "Apply", and what applying would create or change.
    public var review: SetupReview {
        var summary = SetupReview()
        var channels: [String] = []
        var roles: [String] = []
        var changed: [String] = []
        for item in activeItems {
            summary.problemCount += problems(for: item).count
            let viewerOn = viewerActive(item)
            for field in item.fields {
                guard let pick = choices[item.id]?.fields[field.key] else { continue }
                if field.viewerOnly && !viewerOn { continue }
                if pick.fix, let fixing = fixableChannel(item: item, field: field, channelID: pick.id) {
                    changed.append(fixing.name)
                }
                guard pick.mode == .create, let create = field.create, create.existing == nil else { continue }
                if field.kind == .channel {
                    if !channels.contains(create.name) { channels.append(create.name) }
                } else if !roles.contains(create.name) {
                    roles.append(create.name)
                }
            }
        }
        summary.itemCount = activeItems.count
        summary.replacedCount = activeItems.filter(\.configured).count
        summary.channelsToCreate = channels
        summary.rolesToCreate = roles
        var seen = Set<String>()
        summary.channelsToChange = changed.filter { seen.insert($0).inserted }
        return summary
    }

    /// The "Create" boxes that would fix an item with nothing picked, so one button can tick them all.
    public var missingCreates: [(item: String, field: String)] {
        var out: [(item: String, field: String)] = []
        for item in activeItems {
            for field in item.fields {
                guard let create = field.create, create.existing == nil, !field.isOptional,
                      let pick = choices[item.id]?.fields[field.key], pick.mode == .pick, pick.id.isEmpty else { continue }
                out.append((item.id, field.key))
            }
        }
        return out
    }

    /// Ticks Create for every field that has nothing picked: an explicit tap on "Tick Create for all of them".
    public mutating func tickAllCreates() {
        for (item, field) in missingCreates { choices[item]?.fields[field]?.mode = .create }
    }

    // MARK: The request

    /// The body of `POST .../setup/apply` for the switched-on items of the ticked goals.
    public var request: SetupApplyRequest {
        SetupApplyRequest(items: activeItems.map { item in
            let choice = choices[item.id]
            var fields: [String: SetupApplyPick] = [:]
            let viewerOn = viewerActive(item)
            for field in item.fields {
                let pick = choice?.fields[field.key] ?? SetupFieldChoice()
                // A role only for who may see a channel is sent only when it will be used.
                if field.viewerOnly && !viewerOn {
                    fields[field.key] = SetupApplyPick()
                } else if pick.mode == .create, let create = field.create, create.existing == nil {
                    fields[field.key] = SetupApplyPick(create: true)
                } else if pick.id.isEmpty {
                    fields[field.key] = SetupApplyPick()
                } else {
                    // A channel's permissions change only where the wizard knows how, and only when ticked.
                    let fix = pick.fix && fixableChannel(item: item, field: field, channelID: pick.id) != nil
                    fields[field.key] = SetupApplyPick(id: pick.id, fix: fix)
                }
            }
            // Only an item that is already set up is replaced, and only because the person switched it on.
            return SetupApplyItem(id: item.id, replace: item.configured, fields: fields)
        })
    }
}

// MARK: - Apply

public struct SetupApplyRequest: Encodable, Sendable, Equatable {
    public var items: [SetupApplyItem]
    public init(items: [SetupApplyItem]) { self.items = items }
}

public struct SetupApplyItem: Encodable, Sendable, Equatable {
    public var id: String
    public var replace: Bool
    public var fields: [String: SetupApplyPick]

    public init(id: String, replace: Bool = false, fields: [String: SetupApplyPick] = [:]) {
        self.id = id
        self.replace = replace
        self.fields = fields
    }
}

/// `{id}`, `{create: true}`, `{id, fix: true}` or `{}`: a key that is not set is not sent.
public struct SetupApplyPick: Encodable, Sendable, Equatable {
    public var id: String?
    public var create: Bool
    public var fix: Bool

    public init(id: String? = nil, create: Bool = false, fix: Bool = false) {
        self.id = id
        self.create = create
        self.fix = fix
    }

    private enum CodingKeys: String, CodingKey { case id, create, fix }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        if create { try c.encode(true, forKey: .create) }
        if fix { try c.encode(true, forKey: .fix) }
    }
}

public enum SetupResultStatus: Hashable, Sendable, RawRepresentable, Decodable {
    case applied
    case skipped
    case failed
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "applied": self = .applied
        case "skipped": self = .skipped
        case "failed": self = .failed
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .applied: "applied"
        case .skipped: "skipped"
        case .failed: "failed"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    /// The dashboard's words for it.
    public var label: String {
        switch self {
        case .applied: "Set up"
        case .skipped: "Left as it is"
        case .failed: "Not set up"
        case .other(let raw): raw
        }
    }
}

/// A channel or role the apply made, used or changed.
public struct SetupTouched: Decodable, Sendable, Hashable {
    public let kind: String
    public let name: String
    public let id: String

    public init(kind: String, name: String, id: String = "") {
        self.kind = kind
        self.name = name
        self.id = id
    }

    private enum CodingKeys: String, CodingKey { case kind, name, id }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(kind: try c.decodeIfPresent(String.self, forKey: .kind) ?? "",
                  name: try c.decodeIfPresent(String.self, forKey: .name) ?? "",
                  id: try c.decodeIfPresent(String.self, forKey: .id) ?? "")
    }
}

/// What happened to one item. Shown as the server returns it: reuse, partial results and warnings.
public struct SetupResult: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let status: SetupResultStatus
    public let message: String
    public let warnings: [String]
    public let created: [SetupTouched]
    /// An existing channel or role that was used instead of making another.
    public let reused: [SetupTouched]
    /// A channel whose permissions were changed.
    public let changed: [SetupTouched]

    public init(id: String, name: String = "", status: SetupResultStatus, message: String = "",
                warnings: [String] = [], created: [SetupTouched] = [], reused: [SetupTouched] = [],
                changed: [SetupTouched] = []) {
        self.id = id
        self.name = name
        self.status = status
        self.message = message
        self.warnings = warnings
        self.created = created
        self.reused = reused
        self.changed = changed
    }

    private enum CodingKeys: String, CodingKey { case id, name, status, message, warnings, created, reused, changed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        self.init(
            id: id,
            name: try c.decodeIfPresent(String.self, forKey: .name) ?? id,
            status: try c.decodeIfPresent(SetupResultStatus.self, forKey: .status) ?? .failed,
            message: try c.decodeIfPresent(String.self, forKey: .message) ?? "",
            warnings: (try? c.decodeIfPresent([String].self, forKey: .warnings)) ?? [],
            created: try c.decodeLossyArray(of: SetupTouched.self, forKey: .created),
            reused: try c.decodeLossyArray(of: SetupTouched.self, forKey: .reused),
            changed: try c.decodeLossyArray(of: SetupTouched.self, forKey: .changed))
    }
}

public struct SetupApplyAnswer: Decodable, Sendable, Equatable {
    public let results: [SetupResult]

    public init(results: [SetupResult] = []) { self.results = results }

    private enum CodingKeys: String, CodingKey { case results }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = try c.decodeLossyArray(of: SetupResult.self, forKey: .results)
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/setup/suggest`. Only a Sylo that announces `setup-wizard`.
    public struct SuggestSetup: APIEndpoint {
        public typealias Response = SetupProposal
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/setup/suggest" }
    }

    /// `POST /api/v2/guilds/:id/setup/apply`. Needs Edit; 6 a time per 10 minutes, 409 while one is
    /// already running, 400 for a body without items.
    public struct ApplySetup: APIEndpoint {
        public typealias Response = SetupApplyAnswer
        public let server: ServerID
        public let request: SetupApplyRequest
        public init(server: ServerID, request: SetupApplyRequest) {
            self.server = server
            self.request = request
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/setup/apply" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { request }
    }
}

// MARK: - The wizard

/// The wizard's four steps: look at the server, pick goals, review, done.
@MainActor
@Observable
public final class SetupWizardModel {
    public enum Step: Int, Sendable, Comparable {
        case look, goals, review, done
        public static func < (a: Step, b: Step) -> Bool { a.rawValue < b.rawValue }
    }

    public let server: ServerID
    public private(set) var draft: SetupDraft?
    public private(set) var step: Step = .look
    public private(set) var isLoading = false
    public private(set) var isApplying = false
    /// False once the server is known not to announce `setup-wizard`: nothing is asked of it then.
    public private(set) var isAvailable = true
    public var errorMessage: String?
    public private(set) var results: [SetupResult] = []

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Reads the proposal. The person's choices are kept when it is read again after an apply.
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        guard await session.supports(.setupWizard) else {
            isAvailable = false
            return
        }
        do {
            let proposal = try await session.send(Endpoints.SuggestSetup(server: server))
            draft = SetupDraft(proposal: proposal)
            errorMessage = nil
            isAvailable = true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized {
                errorMessage = error.userMessage
            }
        }
    }

    public func goToGoals() { if draft != nil { step = .goals } }
    public func goToReview() { if draft != nil, !(draft?.goals.isEmpty ?? true) { step = .review } }
    public func back() {
        switch step {
        case .goals: step = .look
        case .review: step = .goals
        case .look, .done: break
        }
    }

    /// Applying needs at least one item, and none with a field that is empty or refused.
    public var canApply: Bool {
        guard let draft, !isApplying else { return false }
        let review = draft.review
        return review.itemCount > 0 && review.problemCount == 0
    }

    public func setGoal(_ id: String, on: Bool) {
        if on { draft?.goals.insert(id) } else { draft?.goals.remove(id) }
    }

    public func update(_ change: (inout SetupDraft) -> Void) {
        guard var current = draft else { return }
        change(&current)
        draft = current
    }

    /// Applies the ticked items. The server answers a result per item (one can fail while the others go
    /// through); the screen shows them as they are. A refusal as a whole (busy, too many runs) is an
    /// ``errorMessage`` and leaves the review as it was.
    public func apply() async {
        guard let draft, canApply else { return }
        isApplying = true
        defer { isApplying = false }
        errorMessage = nil
        do {
            let answer = try await session.send(Endpoints.ApplySetup(server: server, request: draft.request))
            results = answer.results
            step = .done
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Starts over from a fresh proposal (after the done step, to set up more).
    public func restart() async {
        results = []
        step = .look
        await load()
    }
}
