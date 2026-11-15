import PhotosUI
import SwiftUI
import SyloKit
import UIKit

/// The picture section of a collectible's form: choose a photo, see it, replace it, take it off.
///
/// A photo comes in through `PhotosPicker`, which needs no photo-library permission. It is read, turned
/// into a JPEG (or a PNG when it has transparency) and shrunk on the phone to fit the server's limits (2 MB,
/// 16 megapixels), then held in ``staged`` until the form is saved; the form uploads it. The server stores
/// at most 200 pictures and 25 MB per server, and decodes only a few at a time, so it can answer
/// "quota" or "busy": the problem is shown in words and the person decides when to try again.
struct CollectiblePicturePicker: View {
    /// The picture the item has on the server now (`/c/<id>.webp`), or nil.
    let currentPath: String?
    /// The photo chosen in this form, ready to upload; nil when none.
    @Binding var staged: PreparedPicture?
    /// Why the last upload or removal failed.
    let problem: ShopPictureProblem?
    /// A save or an upload is running.
    let isBusy: Bool
    /// The item exists, so a staged picture can be uploaded again on its own.
    let canRetry: Bool
    let onRetry: () -> Void
    /// Takes the picture off the item. nil while the item is new.
    let onRemove: (() -> Void)?

    @State private var selection: PhotosPickerItem?
    @State private var isPreparing = false
    @State private var prepareError: String?
    @State private var preview: UIImage?
    @State private var isAskingToRemove = false

    var body: some View {
        Section {
            HStack(spacing: 16) {
                picture
                    .frame(width: 112, height: 112)
                    .background(.quaternary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel(pictureLabel)
                    .onChange(of: staged) { _, picture in
                        preview = picture.flatMap { UIImage(data: $0.data) }
                    }
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: statusTitle)
                        .font(.subheadline.weight(.semibold))
                    if let staged {
                        Text(verbatim: "\(staged.width) × \(staged.height) · \(Self.size(staged.data.count))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
                Label(currentPath == nil && staged == nil ? "Choose a Photo" : "Replace Picture",
                      systemImage: "photo.on.rectangle")
            }
            .disabled(isPreparing || isBusy)
            // On one row only: a modifier on the section would be applied to every row of it.
            .onChange(of: selection) { _, item in
                guard let item else { return }
                Task { await prepare(item) }
            }
            if isPreparing {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Preparing the picture…").foregroundStyle(.secondary)
                }
            }
            if let prepareError {
                StatusMessage(prepareError, kind: .error)
            }
            if let problem {
                StatusMessage(problem.message, kind: .error)
                if canRetry, staged != nil, problem.offersRetry {
                    Button("Try Again", systemImage: "arrow.clockwise", action: onRetry)
                        .disabled(isBusy)
                }
            }
            if staged != nil {
                Button("Discard Chosen Photo", role: .destructive) {
                    staged = nil
                    prepareError = nil
                }
                .disabled(isBusy)
            }
            if currentPath != nil, staged == nil, let onRemove {
                Button("Remove Picture", role: .destructive) { isAskingToRemove = true }
                    .disabled(isBusy)
                    .confirmationDialog("Remove the picture?", isPresented: $isAskingToRemove, titleVisibility: .visible) {
                        Button("Remove Picture", role: .destructive, action: onRemove)
                    } message: {
                        Text("The item is not shown in the shop and cannot be bought until it has a picture again. Members who own it keep it, with the picture they have.")
                    }
            }
        } header: {
            Text("Picture")
        } footer: {
            Text("PNG, JPEG, WebP or a photo from your library. The app shrinks it to fit the 2 MB limit before it goes up, and Sylo stores it as a picture of at most 512 × 512 pixels, without the photo's metadata. An animation becomes its first frame. A server stores at most \(CollectiblePictureLimits.maxPicturesPerServer) pictures and \(CollectiblePictureLimits.maxMegabytesPerServer) MB. A collectible cannot be bought until it has a picture.")
        }
    }

    @ViewBuilder
    private var picture: some View {
        if let preview {
            Image(uiImage: preview)
                .resizable()
                .scaledToFit()
        } else if let currentPath, staged == nil {
            AuthenticatedImage(path: currentPath)
        } else {
            Image(systemName: "photo")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
        }
    }

    private var statusTitle: String {
        if staged != nil { return String(localized: "New picture, uploaded when you save") }
        if currentPath != nil { return String(localized: "This is the current picture") }
        return String(localized: "No picture yet")
    }

    private var pictureLabel: String {
        staged != nil ? String(localized: "The chosen picture") : String(localized: "The current picture")
    }

    private static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// Reads the photo, converts it and keeps it as the staged picture.
    private func prepare(_ item: PhotosPickerItem) async {
        isPreparing = true
        prepareError = nil
        defer {
            isPreparing = false
            selection = nil
        }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw CollectiblePictureError.unreadable
            }
            // Decoding and shrinking a 12 MP photo is real work: not on the main actor.
            let picture = try await Task.detached(priority: .userInitiated) {
                try CollectiblePicture.prepare(data)
            }.value
            staged = picture
        } catch is CancellationError {
            // The person left the screen.
        } catch let error as CollectiblePictureError {
            prepareError = error.message
        } catch {
            prepareError = CollectiblePictureError.unreadable.message
        }
    }
}
