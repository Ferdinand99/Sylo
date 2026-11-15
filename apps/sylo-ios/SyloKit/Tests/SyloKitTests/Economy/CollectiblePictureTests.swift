import Foundation
import Testing
@testable import SyloKit

#if canImport(ImageIO)
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// The conversion of a phone photo into a picture the server takes: HEIC, JPEG and PNG go in, a JPEG
/// (or a PNG with transparency) of at most 1024 pixels and under 2 MB comes out. Runs with the system's
/// own image tools, so the pictures are made in the tests.
@Suite("Collectible picture")
struct CollectiblePictureTests {
    /// A picture of `width` x `height` pixels. `noisy` fills it with random pixels, which compress badly
    /// and force the shrinking steps; otherwise a smooth gradient. `alpha` makes the left half transparent.
    static func makeImage(width: Int, height: Int, noisy: Bool = false, alpha: Bool = false) throws -> CGImage {
        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 255, count: bytesPerRow * height)
        var generator = SystemRandomNumberGenerator()
        for y in 0..<height {
            for x in 0..<width {
                let i = y * bytesPerRow + x * 4
                if noisy {
                    pixels[i] = UInt8.random(in: 0...255, using: &generator)
                    pixels[i + 1] = UInt8.random(in: 0...255, using: &generator)
                    pixels[i + 2] = UInt8.random(in: 0...255, using: &generator)
                } else {
                    pixels[i] = UInt8(x * 255 / max(width - 1, 1))
                    pixels[i + 1] = UInt8(y * 255 / max(height - 1, 1))
                    pixels[i + 2] = 128
                }
                pixels[i + 3] = alpha && x < width / 2 ? 0 : 255
            }
        }
        let info = alpha ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast
        let provider = try #require(CGDataProvider(data: Data(pixels) as CFData))
        return try #require(CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: info.rawValue), provider: provider,
            decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    }

    static func encode(_ image: CGImage, as type: UTType, quality: Double? = nil) throws -> Data {
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil))
        var options: [CFString: Any] = [:]
        if let quality { options[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }

    static func isJPEG(_ data: Data) -> Bool { data.starts(with: [0xFF, 0xD8, 0xFF]) }
    static func isPNG(_ data: Data) -> Bool { data.starts(with: [0x89, 0x50, 0x4E, 0x47]) }

    /// The pixel size of encoded bytes.
    static func size(of data: Data) throws -> (width: Int, height: Int) {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let width = try #require((properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue)
        let height = try #require((properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue)
        return (width, height)
    }

    @Test("a big JPEG photo is shrunk to 1024 pixels on its long side and stays a JPEG under 2 MB")
    func bigJPEG() throws {
        let source = try Self.encode(try Self.makeImage(width: 3000, height: 2000), as: .jpeg, quality: 0.9)
        let picture = try CollectiblePicture.prepare(source)
        #expect(picture.mimeType == "image/jpeg")
        #expect(picture.filename == "picture.jpg")
        #expect(Self.isJPEG(picture.data))
        #expect(picture.data.count <= CollectiblePictureLimits.maxUploadBytes)
        #expect(picture.width == 1024)
        #expect(abs(picture.height - 683) <= 1)
        let size = try Self.size(of: picture.data)
        #expect(size.width == picture.width && size.height == picture.height)
    }

    @Test("a PNG without transparency becomes a JPEG; a tall one is limited on its height")
    func opaquePNG() throws {
        let source = try Self.encode(try Self.makeImage(width: 1500, height: 2400), as: .png)
        let picture = try CollectiblePicture.prepare(source)
        #expect(Self.isJPEG(picture.data))
        #expect(picture.height == 1024)
        #expect(abs(picture.width - 640) <= 1)
    }

    @Test("a small picture is not enlarged")
    func smallStaysSmall() throws {
        let source = try Self.encode(try Self.makeImage(width: 200, height: 100), as: .jpeg)
        let picture = try CollectiblePicture.prepare(source)
        #expect(picture.width == 200)
        #expect(picture.height == 100)
    }

    @Test("a picture with transparency stays a PNG with its transparency")
    func transparentPNG() throws {
        let source = try Self.encode(try Self.makeImage(width: 800, height: 600, alpha: true), as: .png)
        let picture = try CollectiblePicture.prepare(source)
        #expect(picture.mimeType == "image/png")
        #expect(picture.filename == "picture.png")
        #expect(Self.isPNG(picture.data))
        #expect(picture.data.count <= CollectiblePictureLimits.maxUploadBytes)
        let imageSource = try #require(CGImageSourceCreateWithData(picture.data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyHasAlpha] as? Bool == true)
    }

    @Test("a picture that does not compress is stepped down until it fits, and never goes over the limit")
    func noisyPhoto() throws {
        let source = try Self.encode(try Self.makeImage(width: 2000, height: 1500, noisy: true), as: .png)
        // A tight target forces more than one step.
        let picture = try CollectiblePicture.prepare(source, targetBytes: 450_000)
        #expect(picture.data.count <= 450_000)
        #expect(max(picture.width, picture.height) <= 1024)
        #expect(Self.isJPEG(picture.data))
    }

    @Test("a picture that cannot be made small enough is refused in words")
    func cannotShrink() throws {
        let source = try Self.encode(try Self.makeImage(width: 1200, height: 1200, noisy: true), as: .png)
        #expect(throws: CollectiblePictureError.cannotShrink) {
            try CollectiblePicture.prepare(source, targetBytes: 2_000)
        }
        #expect(!CollectiblePictureError.cannotShrink.message.isEmpty)
    }

    @Test("bytes that are not a picture, and nothing at all, are unreadable")
    func unreadable() {
        #expect(throws: CollectiblePictureError.unreadable) {
            try CollectiblePicture.prepare(Data("not a picture".utf8))
        }
        #expect(throws: CollectiblePictureError.unreadable) { try CollectiblePicture.prepare(Data()) }
        #expect(throws: CollectiblePictureError.unreadable) {
            // An SVG is text, not a picture the phone reads.
            try CollectiblePicture.prepare(Data("<svg xmlns='http://www.w3.org/2000/svg'/>".utf8))
        }
    }

    // MARK: Privacy and HEIC

    /// A 64 x 48 HEIC written by a phone-like tool with the metadata a photo carries: GPS (59 54' N, 10 44' E),
    /// a camera make and model, a lens and the time it was taken. Checked in as bytes, so it decodes on every
    /// runner whether or not the runner can *write* HEIC.
    static let heicWithMetadata = Data(base64Encoded: "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")!

    /// What a photo gives away, read back from encoded bytes: the entries of the GPS, EXIF and TIFF
    /// dictionaries that name a place, a time or a camera. Empty for a picture with none of it.
    static func sensitiveMetadata(in data: Data) throws -> [String] {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        var found: [String] = []
        if let gps = properties[kCGImagePropertyGPSDictionary] as? [CFString: Any], !gps.isEmpty {
            found.append(contentsOf: gps.keys.map { "GPS " + ($0 as String) })
        }
        if let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            for key in [kCGImagePropertyExifDateTimeOriginal, kCGImagePropertyExifDateTimeDigitized,
                        kCGImagePropertyExifLensModel, kCGImagePropertyExifLensMake,
                        kCGImagePropertyExifBodySerialNumber, kCGImagePropertyExifCameraOwnerName]
            where exif[key] != nil {
                found.append("Exif " + (key as String))
            }
        }
        if let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            for key in [kCGImagePropertyTIFFMake, kCGImagePropertyTIFFModel, kCGImagePropertyTIFFSoftware,
                        kCGImagePropertyTIFFDateTime, kCGImagePropertyTIFFArtist, kCGImagePropertyTIFFHostComputer]
            where tiff[key] != nil {
                found.append("TIFF " + (key as String))
            }
        }
        return found
    }

    /// Fails (does not pass quietly) when a source does not really carry the metadata the privacy tests are
    /// about: without it "nothing survived" would prove nothing.
    static func requireMetadata(in data: Data) throws {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let gps = try #require(properties[kCGImagePropertyGPSDictionary] as? [CFString: Any], "the source has no GPS")
        #expect(gps[kCGImagePropertyGPSLatitude] != nil)
        #expect(gps[kCGImagePropertyGPSLongitude] != nil)
        let exif = try #require(properties[kCGImagePropertyExifDictionary] as? [CFString: Any], "the source has no EXIF")
        #expect(exif[kCGImagePropertyExifDateTimeOriginal] != nil)
        let tiff = try #require(properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any], "the source has no TIFF")
        #expect(tiff[kCGImagePropertyTIFFMake] != nil)
        #expect(tiff[kCGImagePropertyTIFFModel] != nil)
    }

    @Test("a HEIC photo with GPS, EXIF and camera data becomes a JPEG that carries none of it")
    func heicPhotoIsStripped() throws {
        // The source really has what a phone photo has.
        try Self.requireMetadata(in: Self.heicWithMetadata)
        #expect(try Self.sensitiveMetadata(in: Self.heicWithMetadata).count >= 5)

        let picture = try CollectiblePicture.prepare(Self.heicWithMetadata)
        #expect(Self.isJPEG(picture.data))
        #expect(picture.width == 64 && picture.height == 48)
        #expect(picture.data.count <= CollectiblePictureLimits.maxUploadBytes)
        #expect(try Self.sensitiveMetadata(in: picture.data).isEmpty)
    }

    @Test("a JPEG with GPS, EXIF and camera data is stripped the same way")
    func jpegPhotoIsStripped() throws {
        let image = try Self.makeImage(width: 400, height: 300)
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        let gps: [CFString: Any] = [
            kCGImagePropertyGPSLatitude: 59.9, kCGImagePropertyGPSLatitudeRef: "N",
            kCGImagePropertyGPSLongitude: 10.7, kCGImagePropertyGPSLongitudeRef: "E",
        ]
        let exif: [CFString: Any] = [
            kCGImagePropertyExifDateTimeOriginal: "2026:11:01 12:00:00", kCGImagePropertyExifLensModel: "Lens X",
        ]
        let tiff: [CFString: Any] = [kCGImagePropertyTIFFMake: "Contoso", kCGImagePropertyTIFFModel: "Phone 9"]
        let properties: [CFString: Any] = [
            kCGImagePropertyGPSDictionary: gps, kCGImagePropertyExifDictionary: exif, kCGImagePropertyTIFFDictionary: tiff,
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let source = data as Data
        try Self.requireMetadata(in: source)

        let picture = try CollectiblePicture.prepare(source)
        #expect(try Self.sensitiveMetadata(in: picture.data).isEmpty)
    }

    /// Whether this runner can write HEIC (an Apple-silicon runner can, a virtual machine may not).
    static var canEncodeHEIC: Bool {
        CGImageDestinationCreateWithData(NSMutableData(), UTType.heic.identifier as CFString, 1, nil) != nil
    }

    @Test("a big HEIC made on the runner becomes a 1024 px JPEG", .enabled(if: CollectiblePictureTests.canEncodeHEIC, "this runner cannot write HEIC"))
    func bigHEIC() throws {
        let image = try Self.makeImage(width: 3000, height: 2250)
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.heic.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        let picture = try CollectiblePicture.prepare(data as Data)
        #expect(Self.isJPEG(picture.data))
        #expect(picture.width == 1024)
        #expect(picture.data.count <= CollectiblePictureLimits.maxUploadBytes)
    }

    @Test("the limits are the server's")
    func limits() {
        #expect(CollectiblePictureLimits.maxUploadBytes == 2 * 1024 * 1024)
        #expect(CollectiblePictureLimits.maxPicturesPerServer == 200)
        #expect(CollectiblePictureLimits.maxMegabytesPerServer == 25)
        #expect(CollectiblePictureLimits.maxSide <= 8192)
        #expect(CollectiblePictureLimits.maxSide * CollectiblePictureLimits.maxSide < 16_000_000)
    }
}
#endif

@Suite("Collectible picture errors")
struct CollectiblePictureErrorTests {
    @Test("every way a photo can fail has a sentence")
    func messages() {
        for error in [CollectiblePictureError.unreadable, .tooLargeToRead, .cannotShrink, .unavailable] {
            #expect(!error.message.isEmpty)
        }
    }
}
