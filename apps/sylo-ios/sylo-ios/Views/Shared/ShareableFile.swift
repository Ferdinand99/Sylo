import CoreTransferable
import QuickLook
import SwiftUI
import SyloKit

/// A downloaded file as something the share sheet can send: the file itself, under its own name
/// (``DownloadedFile/filename``), never a copy in memory. The file's extension sets its type, so
/// the share sheet offers the right apps (Numbers for a CSV).
nonisolated struct ShareableFile: Transferable, Sendable {
    let file: DownloadedFile

    init(_ file: DownloadedFile) {
        self.file = file
    }

    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation { item in item.file.fileURL }
    }
}

/// A share button for a downloaded file. The share sheet has no completion hook here: whoever owns
/// the file (usually a ``FileDownloadModel``) deletes it with `discard()` when its screen goes away.
struct FileShareLink: View {
    let file: DownloadedFile
    var title: LocalizedStringKey = "Share"

    var body: some View {
        ShareLink(item: file.fileURL, preview: SharePreview(file.filename)) {
            Label(title, systemImage: "square.and.arrow.up")
        }
    }
}

extension View {
    /// Shows a downloaded file in Quick Look while `file` is set (it has its own share button). Quick
    /// Look sets `file` back to nil when the person closes it, and then calls `onDismiss`, the place
    /// to delete the temporary file.
    func fileQuickLook(_ file: Binding<DownloadedFile?>, onDismiss: @escaping () -> Void = {}) -> some View {
        quickLookPreview(Binding<URL?>(
            get: { file.wrappedValue?.fileURL },
            set: { newValue in
                if newValue == nil {
                    file.wrappedValue = nil
                    onDismiss()
                }
            }))
    }
}

/// A button that downloads a file from the server and opens it in Quick Look, where the person
/// can read it or share it. Shows a spinner while it downloads and the server's message when it
/// fails. The temporary file is deleted when Quick Look closes.
///
/// ```swift
/// DownloadFileButton("Export Applications", systemImage: "square.and.arrow.down",
///                    endpoint: Endpoints.Resource(path: "..."), session: session)
/// ```
struct DownloadFileButton<Endpoint: APIEndpoint>: View where Endpoint.Response == EmptyResponse {
    let title: LocalizedStringKey
    let systemImage: String
    let endpoint: Endpoint

    @State private var model: FileDownloadModel
    @State private var previewed: DownloadedFile?

    init(_ title: LocalizedStringKey, systemImage: String, endpoint: Endpoint, session: AppSession) {
        self.title = title
        self.systemImage = systemImage
        self.endpoint = endpoint
        _model = State(initialValue: FileDownloadModel(session: session))
    }

    var body: some View {
        Button {
            Task {
                if await model.download(endpoint) { previewed = model.file }
            }
        } label: {
            if model.isDownloading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(title)
                }
            } else {
                Label(title, systemImage: systemImage)
            }
        }
        .disabled(model.isDownloading)
        .fileQuickLook($previewed) { model.clear() }
        .alert("Couldn't Download", isPresented: isShowingError, presenting: model.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    private var isShowingError: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } })
    }
}
