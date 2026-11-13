import Foundation
import Observation

// Application forms, the staff side (src/modules/lib/applicationsForm.js, `normaliseForm` and
// `normaliseQuestion`; routes in src/web/routes/v2Applications.js: `/applications/forms`,
// `/applications/forms/:id`, `/applications/forms/:id/delete`, `/applications/forms/reorder`; the web
// editor is web-v2/src/components/ApplicationsFormEditor.jsx).
//
// A form is a big nested object (questions with options, requirements, where the posts go, the roles it
// gives and takes, four messages). The dashboard saves one form at a time with every field in the body,
// and the server builds the stored form from exactly what it is sent, so the app sends every editor
// field too. What the server only reports (the form's version, its setup and role problems) is read and
// never sent.

// MARK: - Open enums

// Each of these keeps a value it does not know as `.other(raw)` and sends it back as it came, so a
// newer server's value is never rewritten by an older app (the server coerces what it does not
// know itself).

private func decodeRawString(_ decoder: any Decoder) throws -> String {
    try decoder.singleValueContainer().decode(String.self)
}

private func encodeRawString(_ value: String, to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(value)
}

extension ApplicationFillMode: Codable {
    public init(from decoder: any Decoder) throws { self.init(rawValue: try decodeRawString(decoder)) }
    public func encode(to encoder: any Encoder) throws { try encodeRawString(rawValue, to: encoder) }

    /// The modes the form offers, in the dashboard's order.
    public static let choices: [ApplicationFillMode] = [.both, .discord, .web]
}

/// What a question asks for.
public enum ApplicationQuestionType: Hashable, Sendable, RawRepresentable, Codable {
    case text
    case choice
    case role
    case yesno
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "text": self = .text
        case "choice": self = .choice
        case "role": self = .role
        case "yesno": self = .yesno
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .text: "text"
        case .choice: "choice"
        case .role: "role"
        case .yesno: "yesno"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws { self.init(rawValue: try decodeRawString(decoder)) }
    public func encode(to encoder: any Encoder) throws { try encodeRawString(rawValue, to: encoder) }

    /// The types the editor offers.
    public static let choices: [ApplicationQuestionType] = [.text, .choice, .role, .yesno]

    /// Whether the answer is one of a list of options (a choice, or roles).
    public var hasOptions: Bool { self == .choice || self == .role }
}

/// When a role question hands out the roles a member picked.
public enum ApplicationGrantWhen: Hashable, Sendable, RawRepresentable, Codable {
    case never
    case submit
    case accept
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "never": self = .never
        case "submit": self = .submit
        case "accept": self = .accept
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .never: "never"
        case .submit: "submit"
        case .accept: "accept"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws { self.init(rawValue: try decodeRawString(decoder)) }
    public func encode(to encoder: any Encoder) throws { try encodeRawString(rawValue, to: encoder) }

    public static let choices: [ApplicationGrantWhen] = [.never, .submit, .accept]
}

/// How many of a list of roles a member needs (or is turned away with).
public enum ApplicationRolesMode: Hashable, Sendable, RawRepresentable, Codable {
    case all
    case any
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "all": self = .all
        case "any": self = .any
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .all: "all"
        case .any: "any"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws { self.init(rawValue: try decodeRawString(decoder)) }
    public func encode(to encoder: any Encoder) throws { try encodeRawString(rawValue, to: encoder) }
}

/// What happens to the post of a decided application.
public enum ApplicationDecidedPost: Hashable, Sendable, RawRepresentable, Codable {
    case move
    case copy
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "move": self = .move
        case "copy": self = .copy
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .move: "move"
        case .copy: "copy"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws { self.init(rawValue: try decodeRawString(decoder)) }
    public func encode(to encoder: any Encoder) throws { try encodeRawString(rawValue, to: encoder) }
}

/// What happens to a waiting application when the applicant leaves the server.
public enum ApplicationOnLeave: Hashable, Sendable, RawRepresentable, Codable {
    case keep
    case deny
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "keep": self = .keep
        case "deny": self = .deny
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .keep: "keep"
        case .deny: "deny"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws { self.init(rawValue: try decodeRawString(decoder)) }
    public func encode(to encoder: any Encoder) throws { try encodeRawString(rawValue, to: encoder) }
}

// MARK: - Questions

/// One option of a choice question (its own id and label), or of a role question (the role's id, and
/// the role's name as the label).
public struct ApplicationQuestionOption: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    /// Fields of the option this version of the app does not model, sent back as they came.
    public var extras: [String: JSONValue]

    public init(id: String = ApplicationQuestionOption.newID(), label: String = "",
                extras: [String: JSONValue] = [:]) {
        self.id = id
        self.label = label
        self.extras = extras
    }

    /// A fresh id for a choice option. The server keeps any id of 1 to 24 letters, digits, `_` and
    /// `-` that is unique in the question, and makes its own when not.
    public static func newID() -> String { "o" + UUID().uuidString.prefix(8).lowercased() }

    private enum CodingKeys: String, CodingKey, CaseIterable { case id, label }
    static let knownKeys = Set(CodingKeys.allCases.map(\.rawValue))

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        self.init(
            id: id.isEmpty ? Self.newID() : id, label: try c.decode(forKey: .label, or: ""),
            extras: try Passthrough.read(decoder, excluding: Self.knownKeys))
    }

    public func encode(to encoder: any Encoder) throws {
        var extra = encoder.container(keyedBy: PassthroughKey.self)
        try Passthrough.write(extras, excluding: Self.knownKeys, to: &extra)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(label, forKey: .label)
    }
}

/// One question of a form. Sent back with every field, the way the web editor does.
public struct ApplicationQuestion: Codable, Sendable, Equatable, Identifiable {
    /// Answers are stored by this id. A question added in the app gets one here; the server keeps it.
    public var id: String
    /// Changing between a choice and a role question clears the options: a choice option is text, a role
    /// option is a role, and the server keeps only role ids on a role question.
    public var type: ApplicationQuestionType {
        didSet {
            let switched = (oldValue == .choice && type == .role) || (oldValue == .role && type == .choice)
            if switched { options = [] }
        }
    }
    public var label: String
    /// Smaller text under the question; "" for none.
    public var help: String
    public var required: Bool
    /// A text question with a text box instead of one line.
    public var long: Bool
    public var minLength: Int
    public var maxLength: Int
    public var options: [ApplicationQuestionOption]
    /// A choice or role question that allows more than one answer.
    public var multiple: Bool
    public var minChoices: Int
    public var maxChoices: Int
    /// A role question: when the picked roles are given.
    public var grant: ApplicationGrantWhen
    /// Fields of the question this version of the app does not model (a setting of a newer question
    /// type, say), sent back as they came so a save does not reset them.
    public var extras: [String: JSONValue]

    public init(
        id: String = ApplicationQuestion.newID(), type: ApplicationQuestionType = .text, label: String = "",
        help: String = "", required: Bool = false, long: Bool = false, minLength: Int = 0, maxLength: Int = 300,
        options: [ApplicationQuestionOption] = [], multiple: Bool = false, minChoices: Int = 0, maxChoices: Int = 1,
        grant: ApplicationGrantWhen = .never, extras: [String: JSONValue] = [:]
    ) {
        self.id = id
        self.type = type
        self.label = label
        self.help = help
        self.required = required
        self.long = long
        self.minLength = minLength
        self.maxLength = maxLength
        self.options = options
        self.multiple = multiple
        self.minChoices = minChoices
        self.maxChoices = maxChoices
        self.grant = grant
        self.extras = extras
    }

    /// The limits the server enforces (applicationsForm.js, LIMITS).
    public static let maxLabelLength = 100
    public static let maxHelpLength = 300
    public static let maxOptionLabelLength = 80
    public static let maxOptions = 10
    public static let maxLongText = 4000
    /// The longest short answer when the server does not say (`shortTextMax` on the page).
    public static let defaultMaxShortText = 1024

    /// A fresh id for a question.
    public static func newID() -> String { "q" + UUID().uuidString.prefix(8).lowercased() }

    /// The longest answer a text question can allow: a long answer has more room than a short one.
    public func lengthCap(shortTextMax: Int = ApplicationQuestion.defaultMaxShortText) -> Int {
        long ? Self.maxLongText : shortTextMax
    }

    /// Whether the label is empty. The server drops a question without a label, so the app refuses
    /// to save one instead of losing it silently.
    public var hasNoLabel: Bool { label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The options the server keeps: a choice needs a label, a role needs a role id (17 to 20 digits).
    public var usableOptionCount: Int {
        switch type {
        case .choice: options.filter { !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count
        case .role: options.filter { Self.isRoleID($0.id) }.count
        default: 0
        }
    }

    static func isRoleID(_ id: String) -> Bool {
        (17...20).contains(id.utf8.count) && id.utf8.allSatisfy { $0 >= 48 && $0 <= 57 }
    }

    /// A required choice or role question with nothing to choose from could never be answered, and
    /// the server refuses to save it.
    public var isUnanswerable: Bool { required && type.hasOptions && usableOptionCount == 0 }

    /// The roles a role question offers.
    public var roleIds: [String] { options.map(\.id) }

    /// Offers exactly these roles. A role that stays keeps its option, a new one is labelled with the
    /// role's name. At most ``maxOptions``.
    public mutating func setRoleOptions(_ ids: [String], roles: [RoleOption]) {
        var next: [ApplicationQuestionOption] = []
        for id in ids.prefix(Self.maxOptions) {
            if let kept = options.first(where: { $0.id == id }) {
                next.append(kept)
            } else {
                next.append(ApplicationQuestionOption(id: id, label: roles.first { $0.id == id }?.name ?? ""))
            }
        }
        options = next
    }

    public mutating func addOption() {
        guard options.count < Self.maxOptions else { return }
        options.append(ApplicationQuestionOption())
    }

    public mutating func moveOptions(fromOffsets source: IndexSet, toOffset destination: Int) {
        FormListOrder.move(&options, fromOffsets: source, toOffset: destination)
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, type, label, help, required, long, minLength, maxLength, options, multiple, minChoices
        case maxChoices, grant
    }
    /// The keys the app models, and `unanswerable`, which the server only reports.
    static let knownKeys = Set(CodingKeys.allCases.map(\.rawValue)).union(["unanswerable"])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        self.init(
            id: id.isEmpty ? Self.newID() : id,
            type: try c.decode(forKey: .type, or: .text),
            label: try c.decode(forKey: .label, or: ""),
            help: try c.decode(forKey: .help, or: ""),
            required: try c.decode(forKey: .required, or: false),
            long: try c.decode(forKey: .long, or: false),
            minLength: try c.decode(forKey: .minLength, or: 0),
            maxLength: try c.decode(forKey: .maxLength, or: 300),
            // Strict: an option that cannot be read makes the whole question unreadable, which stops the
            // form from being saved, instead of dropping the option.
            options: try c.decode(forKey: .options, or: []),
            multiple: try c.decode(forKey: .multiple, or: false),
            minChoices: try c.decode(forKey: .minChoices, or: 0),
            maxChoices: try c.decode(forKey: .maxChoices, or: 1),
            grant: try c.decode(forKey: .grant, or: .never),
            extras: try Passthrough.read(decoder, excluding: Self.knownKeys))
    }

    /// Every field `normaliseQuestion` reads, and the fields the app does not model.
    public func encode(to encoder: any Encoder) throws {
        var extra = encoder.container(keyedBy: PassthroughKey.self)
        try Passthrough.write(extras, excluding: Self.knownKeys, to: &extra)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(type, forKey: .type)
        try c.encode(label, forKey: .label)
        try c.encode(help, forKey: .help)
        try c.encode(required, forKey: .required)
        try c.encode(long, forKey: .long)
        try c.encode(minLength, forKey: .minLength)
        try c.encode(maxLength, forKey: .maxLength)
        try c.encode(options, forKey: .options)
        try c.encode(multiple, forKey: .multiple)
        try c.encode(minChoices, forKey: .minChoices)
        try c.encode(maxChoices, forKey: .maxChoices)
        try c.encode(grant, forKey: .grant)
    }
}

// MARK: - The form

/// The four messages Sylo sends the applicant by DM. An empty one sends nothing.
public struct ApplicationFormMessages: Codable, Sendable, Equatable {
    /// Before the first question.
    public var start: String
    /// After they submitted.
    public var completed: String
    public var accepted: String
    public var denied: String

    public init(start: String = "", completed: String = "", accepted: String = "", denied: String = "") {
        self.start = start
        self.completed = completed
        self.accepted = accepted
        self.denied = denied
    }

    public static let maxLength = 1000

    private enum CodingKeys: String, CodingKey { case start, completed, accepted, denied }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            start: try c.decode(forKey: .start, or: ""),
            completed: try c.decode(forKey: .completed, or: ""),
            accepted: try c.decode(forKey: .accepted, or: ""),
            denied: try c.decode(forKey: .denied, or: ""))
    }
}

/// One form with every field the editor changes.
public struct ApplicationForm: Codable, Sendable, Equatable, Identifiable {
    /// nil for a form that is not created yet.
    public var id: Int?
    public var name: String
    public var description: String
    /// Whether members can apply with it now.
    public var enabled: Bool
    public var fillMode: ApplicationFillMode
    /// Minutes the applicant has to answer in a DM.
    public var timeoutMinutes: Int
    public var questions: [ApplicationQuestion]

    public var requiredRoleIds: [String]
    public var requiredRolesMode: ApplicationRolesMode
    public var restrictedRoleIds: [String]
    public var restrictedRolesMode: ApplicationRolesMode
    public var minAccountDays: Int
    public var minServerDays: Int
    public var cooldownHours: Int

    public var pendingChannelId: String
    public var acceptedChannelId: String
    public var deniedChannelId: String
    public var decidedPost: ApplicationDecidedPost
    public var pingRoleIds: [String]
    public var managerRoleIds: [String]
    public var staffThread: Bool

    public var pendingRoleId: String
    public var removeOnSubmitRoleIds: [String]
    public var acceptAddRoleIds: [String]
    public var acceptRemoveRoleIds: [String]
    public var denyAddRoleIds: [String]
    public var denyRemoveRoleIds: [String]

    public var onLeave: ApplicationOnLeave
    public var messages: ApplicationFormMessages

    /// When the server last saved the form, in milliseconds (read only, never sent).
    public let version: Double?
    /// What still stops the form from taking applications (no questions, no channel); nil when ready.
    /// Read only.
    public let setupProblem: String?
    /// What is wrong with the roles the form hands out (Sylo cannot manage one); nil when fine. Read only.
    public let rolesProblem: String?
    /// How many questions the server sent that this version of the app cannot read. A save replaces the
    /// whole question list, so such a form is not saved here (see ``saveProblem``): it would delete them.
    public let unreadableQuestions: Int
    /// Fields of the form this version of the app does not model, sent back as they came so a save does
    /// not reset them.
    public var extras: [String: JSONValue]

    public init(
        id: Int? = nil, name: String = "", description: String = "", enabled: Bool = false,
        fillMode: ApplicationFillMode = .both, timeoutMinutes: Int = 30, questions: [ApplicationQuestion] = [],
        requiredRoleIds: [String] = [], requiredRolesMode: ApplicationRolesMode = .all,
        restrictedRoleIds: [String] = [], restrictedRolesMode: ApplicationRolesMode = .any,
        minAccountDays: Int = 0, minServerDays: Int = 0, cooldownHours: Int = 0,
        pendingChannelId: String = "", acceptedChannelId: String = "", deniedChannelId: String = "",
        decidedPost: ApplicationDecidedPost = .move, pingRoleIds: [String] = [], managerRoleIds: [String] = [],
        staffThread: Bool = false, pendingRoleId: String = "", removeOnSubmitRoleIds: [String] = [],
        acceptAddRoleIds: [String] = [], acceptRemoveRoleIds: [String] = [], denyAddRoleIds: [String] = [],
        denyRemoveRoleIds: [String] = [], onLeave: ApplicationOnLeave = .keep,
        messages: ApplicationFormMessages = ApplicationFormMessages(), version: Double? = nil,
        setupProblem: String? = nil, rolesProblem: String? = nil, unreadableQuestions: Int = 0,
        extras: [String: JSONValue] = [:]
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.enabled = enabled
        self.fillMode = fillMode
        self.timeoutMinutes = timeoutMinutes
        self.questions = questions
        self.requiredRoleIds = requiredRoleIds
        self.requiredRolesMode = requiredRolesMode
        self.restrictedRoleIds = restrictedRoleIds
        self.restrictedRolesMode = restrictedRolesMode
        self.minAccountDays = minAccountDays
        self.minServerDays = minServerDays
        self.cooldownHours = cooldownHours
        self.pendingChannelId = pendingChannelId
        self.acceptedChannelId = acceptedChannelId
        self.deniedChannelId = deniedChannelId
        self.decidedPost = decidedPost
        self.pingRoleIds = pingRoleIds
        self.managerRoleIds = managerRoleIds
        self.staffThread = staffThread
        self.pendingRoleId = pendingRoleId
        self.removeOnSubmitRoleIds = removeOnSubmitRoleIds
        self.acceptAddRoleIds = acceptAddRoleIds
        self.acceptRemoveRoleIds = acceptRemoveRoleIds
        self.denyAddRoleIds = denyAddRoleIds
        self.denyRemoveRoleIds = denyRemoveRoleIds
        self.onLeave = onLeave
        self.messages = messages
        self.version = version
        self.setupProblem = setupProblem
        self.rolesProblem = rolesProblem
        self.unreadableQuestions = unreadableQuestions
        self.extras = extras
    }

    /// A form to start from: closed, with the server's own message texts.
    public static func blank(messages: ApplicationFormMessages = ApplicationFormMessages()) -> ApplicationForm {
        ApplicationForm(messages: messages)
    }

    // MARK: Limits (applicationsForm.js, LIMITS)

    public static let maxQuestions = 25
    public static let maxNameLength = 60
    public static let maxDescriptionLength = 500
    public static let timeoutRange = 1...1440
    public static let ageDaysRange = 0...3650
    public static let cooldownHoursRange = 0...8760
    /// How many roles a role list holds, and how many the ping list does.
    public static let maxRoles = 25
    public static let maxPingRoles = 10

    // MARK: Reading

    public var isNew: Bool { id == nil }
    public var isEnabled: Bool { enabled }
    public var questionCount: Int { questions.count }

    // MARK: Editing

    public mutating func moveQuestions(fromOffsets source: IndexSet, toOffset destination: Int) {
        FormListOrder.move(&questions, fromOffsets: source, toOffset: destination)
    }

    /// Adds an empty question (up to ``maxQuestions``) and returns it, so a screen can open it.
    @discardableResult
    public mutating func addQuestion(type: ApplicationQuestionType = .text) -> ApplicationQuestion? {
        guard questions.count < Self.maxQuestions else { return nil }
        let question = ApplicationQuestion(type: type)
        questions.append(question)
        return question
    }

    // MARK: What stops a save

    /// What a form needs before it can take applications, in the server's words (`formSetupProblem`).
    public var clientSetupProblem: String? {
        if questions.isEmpty { return "The form has no questions." }
        if pendingChannelId.isEmpty { return "No channel is set for new applications." }
        return nil
    }

    /// Why the form cannot be saved yet, worded like the server's refusal, so the person sees it before
    /// a round trip; nil when it can. The server refuses a form without a name, a required choice or
    /// role question with nothing to choose, and an open form that is not ready. It drops a question
    /// without a label without a word, which this refuses too so nothing is lost silently.
    public var saveProblem: String? {
        if unreadableQuestions > 0 {
            return unreadableQuestions == 1
                ? "This form has a question this version of the app cannot read, so saving it here would delete it. Update the app to edit this form."
                : "This form has \(unreadableQuestions) questions this version of the app cannot read, so saving it here would delete them. Update the app to edit this form."
        }
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Give the form a name." }
        if questions.contains(where: \.hasNoLabel) { return "Give every question some text." }
        if let stuck = questions.first(where: \.isUnanswerable) {
            return "The question \"\(stuck.label)\" is required but has no options."
        }
        if enabled, let problem = clientSetupProblem {
            return "The form cannot be enabled yet: \(problem)"
        }
        return nil
    }

    // MARK: Coding

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, name, description, enabled, fillMode, timeoutMinutes, questions
        case requiredRoleIds, requiredRolesMode, restrictedRoleIds, restrictedRolesMode
        case minAccountDays, minServerDays, cooldownHours
        case pendingChannelId, acceptedChannelId, deniedChannelId, decidedPost, pingRoleIds, managerRoleIds
        case staffThread, pendingRoleId, removeOnSubmitRoleIds, acceptAddRoleIds, acceptRemoveRoleIds
        case denyAddRoleIds, denyRemoveRoleIds, onLeave, messages
        case version, problems
    }

    private enum ProblemKeys: String, CodingKey { case setup, roles }

    /// The keys the app models, and the ones the server only reports (the web editor drops these too).
    static let knownKeys = Set(CodingKeys.allCases.map(\.rawValue)).union(["createdAt", "guildId", "sortOrder", "updatedAt"])

    /// One question of the list, read on its own so one that fails does not take the rest with it.
    private struct QuestionSlot: Decodable {
        let question: ApplicationQuestion?
        init(from decoder: any Decoder) throws { question = try? ApplicationQuestion(from: decoder) }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var setup: String?
        var roles: String?
        if c.contains(.problems), let problems = try? c.nestedContainer(keyedBy: ProblemKeys.self, forKey: .problems) {
            setup = try? problems.decodeIfPresent(String.self, forKey: .setup)
            roles = try? problems.decodeIfPresent(String.self, forKey: .roles)
        }
        let slots = try c.decodeIfPresent([QuestionSlot].self, forKey: .questions) ?? []
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            name: try c.decode(forKey: .name, or: ""),
            description: try c.decode(forKey: .description, or: ""),
            enabled: try c.decode(forKey: .enabled, or: false),
            fillMode: try c.decode(forKey: .fillMode, or: .both),
            timeoutMinutes: try c.decode(forKey: .timeoutMinutes, or: 30),
            questions: slots.compactMap(\.question),
            requiredRoleIds: try c.decode(forKey: .requiredRoleIds, or: []),
            requiredRolesMode: try c.decode(forKey: .requiredRolesMode, or: .all),
            restrictedRoleIds: try c.decode(forKey: .restrictedRoleIds, or: []),
            restrictedRolesMode: try c.decode(forKey: .restrictedRolesMode, or: .any),
            minAccountDays: try c.decode(forKey: .minAccountDays, or: 0),
            minServerDays: try c.decode(forKey: .minServerDays, or: 0),
            cooldownHours: try c.decode(forKey: .cooldownHours, or: 0),
            pendingChannelId: try c.decode(forKey: .pendingChannelId, or: ""),
            acceptedChannelId: try c.decode(forKey: .acceptedChannelId, or: ""),
            deniedChannelId: try c.decode(forKey: .deniedChannelId, or: ""),
            decidedPost: try c.decode(forKey: .decidedPost, or: .move),
            pingRoleIds: try c.decode(forKey: .pingRoleIds, or: []),
            managerRoleIds: try c.decode(forKey: .managerRoleIds, or: []),
            staffThread: try c.decode(forKey: .staffThread, or: false),
            pendingRoleId: try c.decode(forKey: .pendingRoleId, or: ""),
            removeOnSubmitRoleIds: try c.decode(forKey: .removeOnSubmitRoleIds, or: []),
            acceptAddRoleIds: try c.decode(forKey: .acceptAddRoleIds, or: []),
            acceptRemoveRoleIds: try c.decode(forKey: .acceptRemoveRoleIds, or: []),
            denyAddRoleIds: try c.decode(forKey: .denyAddRoleIds, or: []),
            denyRemoveRoleIds: try c.decode(forKey: .denyRemoveRoleIds, or: []),
            onLeave: try c.decode(forKey: .onLeave, or: .keep),
            messages: try c.decode(forKey: .messages, or: ApplicationFormMessages()),
            version: try c.decodeIfPresent(Double.self, forKey: .version),
            setupProblem: setup?.isEmpty == false ? setup : nil,
            rolesProblem: roles?.isEmpty == false ? roles : nil,
            unreadableQuestions: slots.filter { $0.question == nil }.count,
            extras: try Passthrough.read(decoder, excluding: Self.knownKeys))
    }

    /// Every field `normaliseForm` reads and the fields the app does not model, but not the id (it is in
    /// the path), the version or the problems.
    public func encode(to encoder: any Encoder) throws {
        var extra = encoder.container(keyedBy: PassthroughKey.self)
        try Passthrough.write(extras, excluding: Self.knownKeys, to: &extra)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(description, forKey: .description)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(fillMode, forKey: .fillMode)
        try c.encode(timeoutMinutes, forKey: .timeoutMinutes)
        try c.encode(questions, forKey: .questions)
        try c.encode(requiredRoleIds, forKey: .requiredRoleIds)
        try c.encode(requiredRolesMode, forKey: .requiredRolesMode)
        try c.encode(restrictedRoleIds, forKey: .restrictedRoleIds)
        try c.encode(restrictedRolesMode, forKey: .restrictedRolesMode)
        try c.encode(minAccountDays, forKey: .minAccountDays)
        try c.encode(minServerDays, forKey: .minServerDays)
        try c.encode(cooldownHours, forKey: .cooldownHours)
        try c.encode(pendingChannelId, forKey: .pendingChannelId)
        try c.encode(acceptedChannelId, forKey: .acceptedChannelId)
        try c.encode(deniedChannelId, forKey: .deniedChannelId)
        try c.encode(decidedPost, forKey: .decidedPost)
        try c.encode(pingRoleIds, forKey: .pingRoleIds)
        try c.encode(managerRoleIds, forKey: .managerRoleIds)
        try c.encode(staffThread, forKey: .staffThread)
        try c.encode(pendingRoleId, forKey: .pendingRoleId)
        try c.encode(removeOnSubmitRoleIds, forKey: .removeOnSubmitRoleIds)
        try c.encode(acceptAddRoleIds, forKey: .acceptAddRoleIds)
        try c.encode(acceptRemoveRoleIds, forKey: .acceptRemoveRoleIds)
        try c.encode(denyAddRoleIds, forKey: .denyAddRoleIds)
        try c.encode(denyRemoveRoleIds, forKey: .denyRemoveRoleIds)
        try c.encode(onLeave, forKey: .onLeave)
        try c.encode(messages, forKey: .messages)
    }
}

/// The answer to saving a form: the form as the server stored it (normalised, with a new question's id).
public struct ApplicationFormSaved: Decodable, Sendable, Equatable {
    public let form: ApplicationForm
}

/// The answer to reordering the forms: all of them in their new order.
public struct ApplicationFormList: Decodable, Sendable, Equatable {
    public let forms: [ApplicationForm]

    private enum CodingKeys: String, CodingKey { case forms }

    public init(forms: [ApplicationForm] = []) { self.forms = forms }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        forms = try c.decodeLossyArray(of: ApplicationForm.self, forKey: .forms)
    }
}

// MARK: - Reordering

/// Moving entries of a list the way SwiftUI's `onMove` reports it (the entries end up before the entry
/// that was at `destination`). SwiftUI has its own `move(fromOffsets:toOffset:)`, but SyloKit does not
/// import SwiftUI.
enum FormListOrder {
    static func move<Element>(_ items: inout [Element], fromOffsets source: IndexSet, toOffset destination: Int) {
        let sorted = source.sorted()
        guard !sorted.isEmpty, sorted.allSatisfy({ items.indices.contains($0) }) else { return }
        let target = min(max(destination, 0), items.count)
        let moving = sorted.map { items[$0] }
        let removedBefore = sorted.filter { $0 < target }.count
        for index in sorted.reversed() { items.remove(at: index) }
        items.insert(contentsOf: moving, at: target - removedBefore)
    }
}

// MARK: - Models

/// The form editor's state: a draft of one form, saving and deleting it.
@MainActor
@Observable
public final class ApplicationFormEditorModel {
    public let server: ServerID
    /// What the editor changes.
    public var draft: ApplicationForm
    /// The form as last loaded or saved, to tell whether the draft changed.
    public private(set) var original: ApplicationForm
    public private(set) var isSaving = false
    public private(set) var isDeleting = false
    /// Why the last save or delete did not go through (the draft is kept).
    public var errorMessage: String?
    /// Goes up with every successful save, for a haptic and for the list to refresh.
    public private(set) var saveCount = 0
    /// Whether the form was deleted here.
    public private(set) var wasDeleted = false

    private let session: AppSession

    public init(server: ServerID, form: ApplicationForm, session: AppSession) {
        self.server = server
        self.draft = form
        self.original = form
        self.session = session
    }

    public var isNew: Bool { draft.isNew }
    public var hasChanges: Bool { draft != original }
    public var isBusy: Bool { isSaving || isDeleting }
    /// Why Save is off; nil when the draft can be saved.
    public var problem: String? { draft.saveProblem }

    /// Saves the draft. The server's answer (normalised) becomes both draft and original.
    /// - Returns: Whether the form is saved. On failure ``errorMessage`` says why.
    @discardableResult
    public func save() async -> Bool {
        guard !isBusy, problem == nil else { return false }
        isSaving = true
        defer { isSaving = false }
        errorMessage = nil
        do {
            let saved = try await session.send(Endpoints.SaveApplicationForm(server: server, form: draft)).form
            draft = saved
            original = saved
            saveCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized {
                // A 403 here is the server refusing a role the person may not hand out, not "no access".
                errorMessage = EditorFailure.message(
                    for: error,
                    forbidden: "You can't give or take one of the roles on this form. Pick roles below your own highest role, or ask someone with Manage Roles.")
            }
            return false
        }
    }

    /// Deletes the form. Applications already received stay and can still be decided.
    @discardableResult
    public func delete() async -> Bool {
        guard !isBusy, let id = original.id else { return false }
        isDeleting = true
        defer { isDeleting = false }
        errorMessage = nil
        do {
            _ = try await session.send(Endpoints.DeleteApplicationForm(server: server, id: id))
            wasDeleted = true
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = EditorFailure.message(for: error) }
            return false
        }
    }

    public func discardChanges() {
        draft = original
    }
}

/// The forms in the dashboard's order, which a person can reorder (the endpoint exists though the
/// web dashboard has no control for it).
@MainActor
@Observable
public final class ApplicationFormOrderModel {
    public let server: ServerID
    public private(set) var forms: [ApplicationForm]
    public private(set) var isSaving = false
    /// Why the last move did not go through (the list is put back).
    public var errorMessage: String?

    private let session: AppSession

    public init(server: ServerID, forms: [ApplicationForm], session: AppSession) {
        self.server = server
        self.forms = forms
        self.session = session
    }

    /// Takes the forms of a freshly loaded page, unless a move is on its way.
    public func sync(_ forms: [ApplicationForm]) {
        guard !isSaving else { return }
        self.forms = forms
    }

    /// Moves forms the way `onMove` reports it and tells the server. A failure puts the old order back.
    public func move(fromOffsets source: IndexSet, toOffset destination: Int) async {
        guard !isSaving else { return }
        let before = forms
        FormListOrder.move(&forms, fromOffsets: source, toOffset: destination)
        guard forms.map(\.id) != before.map(\.id) else { return }
        isSaving = true
        defer { isSaving = false }
        errorMessage = nil
        do {
            let ids = forms.compactMap(\.id)
            _ = try await session.send(Endpoints.ReorderApplicationForms(server: server, ids: ids))
        } catch {
            forms = before
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = EditorFailure.message(for: error) }
        }
    }
}

// MARK: - Error words

/// The sentence for a failed staff action. The server explains a refusal in its `error` field, for
/// example which permission Sylo lacks in a channel or which role the person may not hand out, whatever
/// the status, and that text is far more useful than any canned one: it always comes first.
enum EditorFailure {
    /// The server's own words for an error: its text, never a machine code or a stock phrase.
    static func serverText(of error: NetworkError) -> String? {
        error.serverMessage
    }

    /// - Parameters:
    ///   - serverFailure: What to say for a 502 when the server sent no text of its own (the platform
    ///     refused a delete). Only for the call that can fail that way.
    ///   - forbidden: What to say for a 403 when the server sent no text of its own, where a 403 means
    ///     something specific (a role the person may not hand out) and not "no access to the server".
    ///
    /// None of the staff routes of Applications and Introductions answers with a machine code, so
    /// `serverCode` has nothing to map here; a code falls through to the app's own words.
    static func message(for error: NetworkError, serverFailure: String? = nil, forbidden: String? = nil) -> String {
        if let text = serverText(of: error) { return text }
        if case .server(let status) = error, status.code == 502, let serverFailure { return serverFailure }
        if case .forbidden = error, let forbidden { return forbidden }
        return error.userMessage
    }
}
