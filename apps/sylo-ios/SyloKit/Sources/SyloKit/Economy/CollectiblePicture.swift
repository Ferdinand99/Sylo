import Foundation
#if canImport(ImageIO)
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
#endif

// The picture of a collectible (src/web/routes/v2Shop.js `/shop/items/:id/image`; the server side is
// src/lib/collectibleImage.js). The server takes a PNG, JPEG or WebP of at most 2 MB, at most 8192 pixels
// on a side and 16 megapixels, and stores a WebP of at most 512 x 512. A photo from the phone is often a
// HEIC of 3 to 12 MB, which the server refuses, so the app converts and shrinks it first.

/// What the server holds a picture to (`MAX_UPLOAD_BYTES`, `MAX_IMAGES_PER_GUILD` and
/// `MAX_IMAGE_BYTES_PER_GUILD` in the server's code).
public enum CollectiblePictureLimits {
    /// The most the server takes in one upload.
    public static let maxUploadBytes = 2 * 1024 * 1024
    /// What the app aims for: a little under the limit, so the form around the file fits too.
    public static let targetBytes = 1_900_000
    /// The longest side the app sends. The server keeps at most 512, so this is already generous.
    public static let maxSide = 1024
    /// The most pictures one server stores, and the most megabytes they use together.
    public static let maxPicturesPerServer = 200
    public static let maxMegabytesPerServer = 25
    /// The largest file the app is willing to read in before converting it.
    public static let maxInputBytes = 100 * 1024 * 1024
}

/// A picture ready to upload: a JPEG or PNG inside the server's limits.
public struct PreparedPicture: Sendable, Equatable {
    public let data: Data
    /// `image/jpeg` or `image/png`.
    public let mimeType: String
    /// `picture.jpg` or `picture.png`.
    public let filename: String
    public let width: Int
    public let height: Int

    public init(data: Data, mimeType: String, filename: String, width: Int, height: Int) {
        self.data = data
        self.mimeType = mimeType
        self.filename = filename
        self.width = width
        self.height = height
    }
}

/// Why a photo could not be turned into a picture.
public enum CollectiblePictureError: Error, Equatable, Sendable {
    /// Not an image the phone can read.
    case unreadable
    /// Too big in bytes to read in at all.
    case tooLargeToRead
    /// Still over 2 MB at the smallest size the app tries.
    case cannotShrink
    /// The system's image tools are missing (not on iOS or macOS).
    case unavailable

    public var message: String {
        switch self {
        case .unreadable: "That file isn't a picture the phone can read. Choose a photo or another image."
        case .tooLargeToRead: "That file is too large to use. Choose a smaller image."
        case .cannotShrink: "The picture could not be made small enough. Choose a simpler image."
        case .unavailable: "This device cannot prepare pictures."
        }
    }
}

public enum CollectiblePicture {
    /// Turns the bytes of a photo (HEIC, JPEG, PNG, WebP, GIF's first frame …) into a JPEG, or a PNG
    /// when the picture has transparency, that fits the server's limits: turned upright, at most
    /// `maxSide` pixels on the longest side (never enlarged), under `targetBytes`, and without the
    /// photo's metadata (location, camera). Steps down in quality, then in size, until it fits.
    ///
    /// This is CPU work for a big photo: call it off the main actor.
    public static func prepare(
        _ source: Data, maxSide: Int = CollectiblePictureLimits.maxSide,
        targetBytes: Int = CollectiblePictureLimits.targetBytes
    ) throws -> PreparedPicture {
        #if canImport(ImageIO)
        guard source.count <= CollectiblePictureLimits.maxInputBytes else { throw CollectiblePictureError.tooLargeToRead }
        let readOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let imageSource = CGImageSourceCreateWithData(source as CFData, readOptions),
              CGImageSourceGetCount(imageSource) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0
        else { throw CollectiblePictureError.unreadable }
        let hasAlpha = (properties[kCGImagePropertyHasAlpha] as? Bool) ?? false

        let longest = max(width, height)
        var sides: [Int] = []
        for side in [maxSide, 768, 512] {
            // Never larger than the photo itself, and never twice the same size.
            let size = min(side, longest)
            if size <= maxSide, !sides.contains(size) { sides.append(size) }
        }

        var smallest: CGImage?
        for side in sides {
            guard let image = thumbnail(of: imageSource, longestSide: side) else { throw CollectiblePictureError.unreadable }
            smallest = image
            if hasAlpha {
                if let data = encode(image, as: .png, quality: nil), data.count <= targetBytes {
                    return PreparedPicture(data: data, mimeType: "image/png", filename: "picture.png",
                                           width: image.width, height: image.height)
                }
            } else {
                for quality in [0.85, 0.7, 0.55] {
                    if let data = encode(image, as: .jpeg, quality: quality), data.count <= targetBytes {
                        return PreparedPicture(data: data, mimeType: "image/jpeg", filename: "picture.jpg",
                                               width: image.width, height: image.height)
                    }
                }
            }
        }
        // A transparent picture that is too big even as a small PNG becomes a JPEG on white.
        if hasAlpha, let smallest, let flat = flattened(smallest) {
            for quality in [0.8, 0.6] {
                if let data = encode(flat, as: .jpeg, quality: quality), data.count <= targetBytes {
                    return PreparedPicture(data: data, mimeType: "image/jpeg", filename: "picture.jpg",
                                           width: flat.width, height: flat.height)
                }
            }
        }
        throw CollectiblePictureError.cannotShrink
        #else
        throw CollectiblePictureError.unavailable
        #endif
    }

    #if canImport(ImageIO)
    private static func thumbnail(of source: CGImageSource, longestSide: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: longestSide,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private static func encode(_ image: CGImage, as type: UTType, quality: Double?) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
            return nil
        }
        var options: [CFString: Any] = [:]
        if let quality { options[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// The picture drawn on white, without an alpha channel.
    private static func flattened(_ image: CGImage) -> CGImage? {
        guard let context = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(rect)
        context.draw(image, in: rect)
        return context.makeImage()
    }
    #endif
}

/// Why an upload or removal of a picture failed, worded for the person. The server's own text is
/// kept where it has the numbers (the quota) or says something specific (busy, cannot process).
public enum ShopPictureProblem: Equatable, Sendable {
    /// Over 2 MB (413).
    case tooLarge
    /// Over 16 megapixels or 8192 pixels on a side.
    case tooManyPixels
    /// Not a PNG, JPEG or WebP.
    case unsupportedType
    /// Not an image at all.
    case notAnImage
    /// The server already stores its 200 pictures or 25 MB; carries the server's sentence.
    case quota(String?)
    /// The decode queue is full or the picture took too long (503); carries the server's sentence, which
    /// already says to try again.
    case busy(String?)
    /// The server cannot process pictures at all (its image tools are missing); carries its sentence.
    /// Trying again does not help.
    case cannotProcess(String?)
    /// The server did not understand the upload as a form (415). The server sends this only when the
    /// request is not multipart, which is a problem of the app or of something between it and the server,
    /// never of the picture; carries the server's sentence.
    case badUpload(String?)
    /// Too many uploads in a minute (429).
    case rateLimited
    /// The server has no pictures for collectibles (a server before Sylo 5.2).
    case notAvailable
    /// The item was deleted meanwhile, or is not a collectible.
    case itemGone
    case other(String)

    public init(_ error: NetworkError) {
        let text = error.serverMessage
        switch error {
        case .tooLarge:
            self = .tooLarge
        case .rateLimited:
            self = .rateLimited
        case .http(let status) where status.code == 415:
            self = .badUpload(text)
        case .server(let status) where status.code == 503:
            // "This server cannot process images right now." is permanent; "busy" and "took too long" pass.
            self = text?.lowercased().contains("cannot process") == true ? .cannotProcess(text) : .busy(text)
        case .notFound:
            // The server names a missing item; a missing route (a server before 5.2) has no words.
            self = text == nil ? .notAvailable : .itemGone
        case .badRequest:
            self = Self.fromWords(text) ?? .other(error.userMessage)
        default:
            self = .other(error.userMessage)
        }
    }

    private static func fromWords(_ text: String?) -> ShopPictureProblem? {
        guard let text else { return nil }
        let lower = text.lowercased()
        if lower.contains("already stores") || lower.contains("the most is") { return .quota(text) }
        if lower.contains("png, jpeg or webp") { return .unsupportedType }
        if lower.contains("megapixels") { return .tooManyPixels }
        if lower.contains("not a valid image") { return .notAnImage }
        if lower.contains("larger than 2 mb") { return .tooLarge }
        if lower.contains("only a collectible") { return .itemGone }
        return .other(text)
    }

    /// The sentence to show.
    public var message: String {
        switch self {
        case .tooLarge:
            "The picture is over 2 MB even after shrinking. Choose a simpler image."
        case .tooManyPixels:
            "The picture is too large in pixels (at most 16 megapixels)."
        case .unsupportedType:
            "Use a PNG, JPEG or WebP picture."
        case .notAnImage:
            "That file is not a valid picture."
        case .quota(let text):
            text ?? "This server already stores the most pictures it can (\(CollectiblePictureLimits.maxPicturesPerServer) pictures or \(CollectiblePictureLimits.maxMegabytesPerServer) MB). Remove pictures or items nobody owns to make room."
        case .busy(let text):
            // The server's busy sentences end in their own "try again": nothing is added to them.
            text ?? "The server is busy processing pictures. Try again in a moment."
        case .cannotProcess(let text):
            text ?? "This server cannot process pictures right now."
        case .badUpload(let text):
            "The server did not understand the upload. This is a problem with the app or the connection, not with your picture: update the app, or check for a proxy between you and the server." + (text.map { " It said: \($0)" } ?? "")
        case .rateLimited:
            "Too many uploads. Wait a minute and try again."
        case .notAvailable:
            "This server cannot store pictures for collectibles. It needs Sylo 5.2 or later."
        case .itemGone:
            "That collectible no longer exists. Refresh the shop."
        case .other(let text):
            text
        }
    }

    /// Whether trying the same picture again later can work (the person still has to tap).
    public var isWorthRetrying: Bool {
        switch self {
        case .busy, .rateLimited: true
        default: false
        }
    }

    /// Whether the form offers Try Again: for a busy server and a rate limit, for a full quota (once the
    /// person made room), and for a failure the app cannot name (a dropped connection). Not when the
    /// same picture can never go through, and not when the server cannot process pictures at all.
    public var offersRetry: Bool {
        switch self {
        case .busy, .rateLimited, .quota, .other: true
        case .tooLarge, .tooManyPixels, .unsupportedType, .notAnImage, .cannotProcess, .badUpload, .notAvailable,
             .itemGone: false
        }
    }
}
